/**
 * Everything in-app calls and live classes need from the server: decides
 * who may join which LiveKit room, and hands back a short-lived token for
 * it. The browser connects to LiveKit Cloud directly with that token; no
 * audio or video passes through here.
 *
 *   call            { callee_id, video }      ring someone: creates the calls row,
 *                                             pushes their phone, token for the caller
 *   join_call       { call_id }               token for an answered call (or the caller's own ringing one)
 *   start_class     { class_id, subject_id?, title, learners_may_publish? }
 *                                             a teacher goes live (or rejoins their running class)
 *   join_class      { live_class_id }         token for a learner, parent or teacher
 *   mute_all        { live_class_id }         the teacher mutes every learner's mic
 *   learners_may_publish { live_class_id, allow }  the teacher lets learners speak / turn on cameras, or not
 *   end_class       { live_class_id }         the teacher ends it; everyone is disconnected
 *
 * Deploy: supabase functions deploy call-token
 * Needs LIVEKIT_URL (wss://<project>.livekit.cloud), LIVEKIT_API_KEY and
 * LIVEKIT_API_SECRET from the LiveKit Cloud project's Settings -> Keys.
 * Without them every action answers a clear 503. Push for incoming calls
 * reuses FCM_SERVICE_ACCOUNT_JSON_B64 (see send-push) and is skipped
 * without it: the call still rings in the open app.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { fcmAccessToken, sendToToken, serviceAccountFromEnv, type ServiceAccount } from "../_shared/fcm.ts";
import {
  accessToken, deleteRoom, isAudioTrack, listParticipants, liveKitConfigFromEnv, muteTrack, setParticipantPublish,
  type LiveKitConfig,
} from "./livekit.ts";

// deno-lint-ignore no-explicit-any
export interface Deps { admin: any; asUser: any; liveKit: LiveKitConfig | null; push?: ServiceAccount | null }

type ClassRole = "host" | "learner" | "family";

const callRoom = (id: string) => `call-${id}`;
const classRoom = (id: string) => `class-${id}`;

// deno-lint-ignore no-explicit-any
type Body = Record<string, any>;

export async function handle(req: Request, deps: Deps, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!req.headers.get("Authorization")) return json({ error: "Unauthorized" }, 401);
  const { data: { user } } = await deps.asUser.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }

  if (!deps.liveKit) return json({ error: "Calls are not set up for this school yet (LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are not set)." }, 503);

  const { data: me } = await deps.admin.from("profiles").select("id, full_name, role, tenant_id").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) return json({ error: "Only people in a school can make calls." }, 403);

  try {
    switch (body.action) {
      case "call": return await startCall(deps, me, body, fetchImpl);
      case "join_call": return await joinCall(deps, me, body);
      case "start_class": return await startClass(deps, me, body);
      case "join_class": return await joinClass(deps, me, body);
      case "mute_all": return await muteAll(deps, body, fetchImpl);
      case "learners_may_publish": return await learnersMayPublish(deps, body, fetchImpl);
      case "end_class": return await endClass(deps, body, fetchImpl);
      default: return json({ error: "Unknown action" }, 400);
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Something went wrong." }, 502);
  }
}

// deno-lint-ignore no-explicit-any
type Me = { id: string; full_name: string; role: string; tenant_id: string } & Record<string, any>;

async function tokenFor(deps: Deps, me: Me, room: string, grant: { canPublish: boolean; roomAdmin?: boolean }, role: string) {
  return await accessToken(
    deps.liveKit!,
    { identity: me.id, name: me.full_name, metadata: JSON.stringify({ role }) },
    { room, roomJoin: true, canSubscribe: true, canPublishData: true, canPublish: grant.canPublish, roomAdmin: grant.roomAdmin },
  );
}

// ---------------------------------------------------------------- 1:1 calls

async function startCall(deps: Deps, me: Me, body: Body, fetchImpl: typeof fetch): Promise<Response> {
  const calleeId = typeof body.callee_id === "string" ? body.callee_id : "";
  if (!calleeId) return json({ error: "callee_id is required" }, 400);
  if (calleeId === me.id) return json({ error: "You cannot call yourself." }, 400);

  const { data: callee } = await deps.admin.from("profiles").select("id, full_name, tenant_id").eq("id", calleeId).maybeSingle();
  if (!callee || callee.tenant_id !== me.tenant_id) return json({ error: "That person could not be found." }, 404);

  // Asked as the service role: may_contact() answers for anyone then.
  const { data: allowed, error: ruleErr } = await deps.admin.rpc("may_contact", { a: me.id, b: calleeId });
  if (ruleErr) throw new Error(ruleErr.message);
  if (!allowed) return json({ error: `You cannot call ${callee.full_name} in the app.` }, 403);

  const { data: call, error } = await deps.admin.from("calls").insert({
    tenant_id: me.tenant_id, caller_id: me.id, callee_id: calleeId,
    caller_name: me.full_name, callee_name: callee.full_name, video: body.video === true,
  }).select("*").single();
  if (error || !call) throw new Error(error?.message ?? "Could not start the call.");

  // Best effort: the call already rings in any open tab over Realtime.
  if (deps.push) {
    await pushIncomingCall(deps.admin, deps.push, calleeId, me.full_name, call.video, call.id, fetchImpl).catch(() => {});
  }

  return json({ call, url: deps.liveKit!.url, token: await tokenFor(deps, me, callRoom(call.id), { canPublish: true }, "caller") });
}

async function joinCall(deps: Deps, me: Me, body: Body): Promise<Response> {
  if (typeof body.call_id !== "string") return json({ error: "call_id is required" }, 400);
  const { data: call } = await deps.admin.from("calls").select("*").eq("id", body.call_id).maybeSingle();
  if (!call || (call.caller_id !== me.id && call.callee_id !== me.id)) return json({ error: "That call could not be found." }, 404);
  const open = call.status === "accepted" || (call.status === "ringing" && call.caller_id === me.id);
  if (!open) return json({ error: "That call has ended." }, 410);
  return json({ call, url: deps.liveKit!.url, token: await tokenFor(deps, me, callRoom(call.id), { canPublish: true }, "caller") });
}

// deno-lint-ignore no-explicit-any
async function pushIncomingCall(admin: any, account: ServiceAccount, calleeId: string, callerName: string, video: boolean, callId: string, fetchImpl: typeof fetch) {
  const { data: rows } = await admin.from("device_tokens").select("id, token").eq("profile_id", calleeId);
  const tokens = (rows ?? []) as { id: string; token: string }[];
  if (!tokens.length) return;
  const accessTokenFcm = await fcmAccessToken(account, fetchImpl);
  const stale: string[] = [];
  for (const t of tokens) {
    const r = await sendToToken(fetchImpl, account.project_id, accessTokenFcm, t.token,
      `${callerName} is calling`, video ? "Video call on Figbloom. Open the app to answer." : "Voice call on Figbloom. Open the app to answer.",
      { tag: `call-${callId}` });
    if (r.invalid) stale.push(t.id);
  }
  if (stale.length) await admin.from("device_tokens").delete().in("id", stale);
}

// ---------------------------------------------------------------- live classes

async function startClass(deps: Deps, me: Me, body: Body): Promise<Response> {
  const classId = typeof body.class_id === "string" ? body.class_id : "";
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 160) : "";
  if (!classId || !title) return json({ error: "class_id and title are required" }, 400);

  // Asked as the teacher: may_host_class() reads auth.uid().
  const { data: mayHost, error: ruleErr } = await deps.asUser.rpc("may_host_class", { p_class_id: classId });
  if (ruleErr) throw new Error(ruleErr.message);
  if (!mayHost) return json({ error: "Only a teacher of this class can start its live class." }, 403);

  // Already running (another tab, or a dropped connection): rejoin it.
  const { data: running } = await deps.admin.from("live_classes").select("*").eq("class_id", classId).is("ended_at", null).maybeSingle();
  let live = running;
  if (!live) {
    const { data: cls } = await deps.admin.from("classes").select("tenant_id").eq("id", classId).maybeSingle();
    const { data, error } = await deps.admin.from("live_classes").insert({
      tenant_id: cls?.tenant_id ?? me.tenant_id, class_id: classId,
      subject_id: typeof body.subject_id === "string" ? body.subject_id : null,
      title, started_by: me.id, learners_may_publish: body.learners_may_publish === true,
    }).select("*").single();
    if (error || !data) throw new Error(error?.message ?? "Could not start the live class.");
    live = data;
  }
  return json({ live_class: live, role: "host", url: deps.liveKit!.url, token: await tokenFor(deps, me, classRoom(live.id), { canPublish: true, roomAdmin: true }, "host") });
}

/** The running class and the caller's part in it, or a response saying why not. */
async function liveClassFor(deps: Deps, body: Body): Promise<{ live: Body; role: ClassRole } | Response> {
  if (typeof body.live_class_id !== "string") return json({ error: "live_class_id is required" }, 400);
  const { data: live } = await deps.admin.from("live_classes").select("*").eq("id", body.live_class_id).maybeSingle();
  if (!live) return json({ error: "That live class could not be found." }, 404);
  const { data: role, error } = await deps.asUser.rpc("live_class_role", { p_live_class_id: live.id });
  if (error) throw new Error(error.message);
  if (!role) return json({ error: "This live class is for another class." }, 403);
  if (live.ended_at) return json({ error: "This live class has ended." }, 410);
  return { live, role: role as ClassRole };
}

async function joinClass(deps: Deps, me: Me, body: Body): Promise<Response> {
  const found = await liveClassFor(deps, body);
  if (found instanceof Response) return found;
  const { live, role } = found;
  const canPublish = role === "host" || (role === "learner" && live.learners_may_publish === true);
  return json({
    live_class: live, role, url: deps.liveKit!.url,
    token: await tokenFor(deps, me, classRoom(live.id), { canPublish, roomAdmin: role === "host" }, role),
  });
}

async function hostOnly(deps: Deps, body: Body): Promise<{ live: Body } | Response> {
  const found = await liveClassFor(deps, body);
  if (found instanceof Response) return found;
  if (found.role !== "host") return json({ error: "Only the teacher can do that." }, 403);
  return { live: found.live };
}

/** Whether a participant joined as a host, by what their token said they were. */
function isHost(metadata?: string): boolean {
  try { return JSON.parse(metadata ?? "{}").role === "host"; } catch { return false; }
}

async function muteAll(deps: Deps, body: Body, fetchImpl: typeof fetch): Promise<Response> {
  const found = await hostOnly(deps, body);
  if (found instanceof Response) return found;
  const room = classRoom(found.live.id);
  let muted = 0;
  for (const p of await listParticipants(deps.liveKit!, room, fetchImpl)) {
    if (isHost(p.metadata)) continue;
    for (const t of p.tracks ?? []) {
      if (!isAudioTrack(t) || t.muted) continue;
      await muteTrack(deps.liveKit!, room, p.identity, t.sid, fetchImpl);
      muted++;
    }
  }
  return json({ muted });
}

async function learnersMayPublish(deps: Deps, body: Body, fetchImpl: typeof fetch): Promise<Response> {
  const found = await hostOnly(deps, body);
  if (found instanceof Response) return found;
  const allow = body.allow === true;
  const { error } = await deps.admin.from("live_classes").update({ learners_may_publish: allow }).eq("id", found.live.id);
  if (error) throw new Error(error.message);
  // Learners already in the room get the change now; anyone joining later gets it in their token.
  const room = classRoom(found.live.id);
  for (const p of await listParticipants(deps.liveKit!, room, fetchImpl)) {
    let role = "";
    try { role = JSON.parse(p.metadata ?? "{}").role; } catch { /* no metadata: leave them be */ }
    if (role === "learner") await setParticipantPublish(deps.liveKit!, room, p.identity, allow, fetchImpl);
  }
  return json({ learners_may_publish: allow });
}

async function endClass(deps: Deps, body: Body, fetchImpl: typeof fetch): Promise<Response> {
  const found = await hostOnly(deps, body);
  if (found instanceof Response) return found;
  // The row first: once it's ended nobody can get a new token, even if closing the room fails.
  const { error } = await deps.admin.from("live_classes").update({ ended_at: new Date().toISOString() }).eq("id", found.live.id);
  if (error) throw new Error(error.message);
  await deleteRoom(deps.liveKit!, classRoom(found.live.id), fetchImpl);
  return json({ ended: true });
}

if (import.meta.main) {
  Deno.serve((req) => {
    const auth = req.headers.get("Authorization") ?? "";
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    let push: ServiceAccount | null = null;
    try { push = serviceAccountFromEnv(); } catch { /* a malformed push secret mustn't stop calls */ }
    return handle(req, { admin, asUser, liveKit: liveKitConfigFromEnv(), push });
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
