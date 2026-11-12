/**
 * Tells a learner's parents, on their phones, that the learner was signed out early (20261106000000_early_sign_out.sql, FIG-1513).
 * Called by the web console right after the office or the class teacher records a sign-out, the same way the visitor log calls
 * visit-notify. The sign-out is already recorded and shown in the parent app before this runs, so a push that fails never fails it.
 *
 * Who may ask: the person who recorded the sign-out, the school's admin, or whoever holds the attendance area at that school. The
 * push says who, when and who collected the learner (name and relationship); never the collector's ID number or phone.
 * An SMS to the parent is NOT sent from here: no SMS provider exists yet (FIG-1513 stays open for it).
 *
 * Deploy: supabase functions deploy early-sign-out-notify
 * Needs the FCM_SERVICE_ACCOUNT_JSON_B64 secret, same as send-push. Without it nothing is pushed (and nothing is marked pushed).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { fcmAccessToken, sendToToken, serviceAccountFromEnv, type ServiceAccount } from "../_shared/fcm.ts";
import { holdsArea } from "../_shared/adminAreas.ts";
import { pushFor, type SignOutRow } from "./plan.ts";

// deno-lint-ignore no-explicit-any
export interface Deps { admin: any; asUser: any; account?: ServiceAccount | null }

/** Who may ask for a sign-out's push: whoever recorded it, the school's admin, and the attendance area (the people who may record one). */
// deno-lint-ignore no-explicit-any
export async function mayNotify(admin: any, caller: { id: string; role: string; tenant_id: string | null }, signOut: { tenant_id: string; recorded_by: string | null }): Promise<boolean> {
  if (signOut.recorded_by && signOut.recorded_by === caller.id) return true;
  if (!caller.tenant_id || caller.tenant_id !== signOut.tenant_id) return false;
  return caller.role === "school_admin" || await holdsArea(admin, caller, signOut.tenant_id, "attendance");
}

export async function handle(req: Request, { admin, asUser, account = serviceAccountFromEnv() }: Deps, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = req.headers.get("Authorization");
  if (!auth) return json({ error: "Unauthorized" }, 401);
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: { sign_out_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }
  if (!body.sign_out_id) return json({ error: "sign_out_id is required" }, 400);

  const { data: row } = await admin
    .from("early_sign_outs")
    .select("id, tenant_id, student_id, student_name, signed_out_local, collected_by_name, collected_by_relationship, recorded_by, voided_at, parent_pushed_at")
    .eq("id", body.sign_out_id).maybeSingle();
  const signOut = row as SignOutRow | null;

  // An id that does not exist and one the caller may not use get the same answer, so a caller cannot probe which sign-out ids exist.
  const { data: caller } = await admin.from("profiles").select("id, role, tenant_id").eq("id", user.id).maybeSingle();
  if (!signOut || !caller || !(await mayNotify(admin, caller, signOut))) {
    return json({ error: "Only whoever recorded this sign-out, or the school's attendance office, can send this." }, 403);
  }

  const push = pushFor(signOut);
  if (!push) return json({ sent: 0, failed: 0, skipped: signOut.voided_at ? "this sign-out was voided" : "the parents were already told" });
  if (!account) return json({ sent: 0, failed: 0, skipped: "push is not configured on this project" });

  const { data: guardianRows } = await admin.from("guardians").select("profile_id").eq("student_id", signOut.student_id);
  const profileIds = ((guardianRows ?? []) as { profile_id: string }[]).map((g) => g.profile_id);
  const { data: tokenRows } = profileIds.length
    ? await admin.from("device_tokens").select("id, token").in("profile_id", profileIds)
    : { data: [] };
  const tokens = (tokenRows ?? []) as { id: string; token: string }[];
  // Nobody to tell yet: leave it unmarked, so a parent who installs the app later is not sent a stale push by a later call.
  if (!tokens.length) return json({ sent: 0, failed: 0, skipped: "no parent has the app on a phone" });

  // Claimed before sending: two calls racing for the same sign-out push it once.
  const { data: claimed } = await admin.from("early_sign_outs")
    .update({ parent_pushed_at: new Date().toISOString() }).eq("id", signOut.id).is("parent_pushed_at", null).select("id");
  if (!claimed?.length) return json({ sent: 0, failed: 0, skipped: "the parents were already told" });

  // The marker was set before sending so that racing calls push once. If nothing reached a phone it is cleared again, so a later call can retry.
  const release = async () => {
    const { error } = await admin.from("early_sign_outs").update({ parent_pushed_at: null }).eq("id", signOut.id);
    // If this fails the sign-out stays marked and a later call will not retry: say so in the server log (ids only, nothing personal).
    if (error) console.error(`early-sign-out-notify: could not clear the push marker for ${signOut.id}`);
  };

  let sent = 0;
  let failed = 0;
  const stale: string[] = [];
  try {
    const accessToken = await fcmAccessToken(account, fetchImpl);
    for (const t of tokens) {
      const r = await sendToToken(fetchImpl, account.project_id, accessToken, t.token, push.title, push.body, {
        tag: `early-sign-out-${signOut.id}`, data: { type: "early_sign_out", sign_out_id: String(signOut.id), student_id: String(signOut.student_id) },
      });
      if (r.ok) sent++;
      else {
        failed++;
        if (r.invalid) stale.push(t.id);
      }
    }
    if (stale.length) await admin.from("device_tokens").delete().in("id", stale);
    if (sent === 0) await release();
    return json({ sent, failed });
  } catch (err) {
    await release();
    // Logged on the server only: the caller gets a sentence, never the provider's raw message.
    console.error("early-sign-out-notify: push failed:", err instanceof Error ? err.message : "unknown error");
    return json({ error: "Could not send push notifications." }, 502);
  }
}

if (import.meta.main) {
  Deno.serve((req) => {
    const auth = req.headers.get("Authorization") ?? "";
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    return handle(req, { admin, asUser });
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
