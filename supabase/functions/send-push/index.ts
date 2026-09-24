/**
 * Sends a push notification to everyone an announcement's audience resolves
 * to, via FCM's HTTP v1 API. Android only for now — iOS has no push
 * credentials yet (FIG-293). Called by the web console right after an
 * announcement with "push" in its channels is published.
 *
 * Deploy: supabase functions deploy send-push
 * Needs the FCM_SERVICE_ACCOUNT_JSON_B64 secret — a Firebase service-account
 * key JSON file, base64-encoded (`base64 -w0 key.json`), so shell/dotenv
 * quoting of the embedded multi-line PEM can never mangle it. Without it,
 * this returns a clear 500 rather than silently doing nothing.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";

interface Audience {
  kind: "whole_school" | "role" | "class" | "form_level";
  role?: string;
  class_id?: string;
  form_level?: number;
  /** Omitted on announcements sent before levels were recorded: every class with that form_level. */
  level?: string;
}

// deno-lint-ignore no-explicit-any
export interface Deps { admin: any; asUser: any }

/** Mirrors the audience filtering packages/shared/src/{parentData,studentData}.ts
 *  do client-side, but resolved to profile ids for the send side. */
// deno-lint-ignore no-explicit-any
async function resolveAudienceProfileIds(admin: any, tenantId: string, audience: Audience): Promise<string[]> {
  if (audience.kind === "whole_school") {
    const { data } = await admin.from("profiles").select("id").eq("tenant_id", tenantId);
    // deno-lint-ignore no-explicit-any
    return (data ?? []).map((r: any) => r.id as string);
  }
  if (audience.kind === "role") {
    const { data } = await admin.from("profiles").select("id").eq("tenant_id", tenantId).eq("role", audience.role);
    // deno-lint-ignore no-explicit-any
    return (data ?? []).map((r: any) => r.id as string);
  }

  const { data: students } = await admin
    .from("students")
    .select("id, profile_id, class_id, classes(form_level, level)")
    .eq("tenant_id", tenantId)
    .eq("active", true);
  // deno-lint-ignore no-explicit-any
  const matched = (students ?? []).filter((s: any) =>
    audience.kind === "class"
      ? s.class_id === audience.class_id
      // Grade 1 and Form 1 are both form_level 1 — the level tells them apart.
      : s.classes?.form_level === audience.form_level && (!audience.level || s.classes?.level === audience.level)
  );
  // deno-lint-ignore no-explicit-any
  const studentIds = matched.map((s: any) => s.id as string);
  // deno-lint-ignore no-explicit-any
  const studentProfileIds = matched.filter((s: any) => s.profile_id).map((s: any) => s.profile_id as string);

  const { data: guardianRows } = studentIds.length
    ? await admin.from("guardians").select("profile_id").in("student_id", studentIds)
    : { data: [] };
  // deno-lint-ignore no-explicit-any
  const parentProfileIds = (guardianRows ?? []).map((g: any) => g.profile_id as string);

  return [...new Set([...studentProfileIds, ...parentProfileIds])];
}

// ---------------------------------------------------------- FCM HTTP v1 ----
// Authenticated via a service-account JWT bearer flow (Web Crypto, no SDK —
// same hand-rolled-OAuth approach mpesa-stk-push already uses for Daraja).

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

interface ServiceAccount { project_id: string; client_email: string; private_key: string }

async function fcmAccessToken(account: ServiceAccount, fetchImpl: typeof fetch): Promise<string> {
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const unsigned = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    "pkcs8", pemToPkcs8(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;

  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error(`Could not authenticate with FCM: ${await res.text()}`);
  const out = await res.json();
  return out.access_token as string;
}

async function sendToToken(
  fetchImpl: typeof fetch, projectId: string, accessToken: string, token: string, title: string, body: string,
): Promise<{ ok: boolean; invalid: boolean }> {
  const res = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { token, notification: { title, body } } }),
  });
  if (res.ok) return { ok: true, invalid: false };
  const text = await res.text();
  const invalid = res.status === 404 || /UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT/.test(text);
  return { ok: false, invalid };
}

export async function handle(req: Request, { admin, asUser }: Deps, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = req.headers.get("Authorization");
  if (!auth) return json({ error: "Unauthorized" }, 401);
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: { announcement_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }
  if (!body.announcement_id) return json({ error: "announcement_id is required" }, 400);

  const { data: announcement } = await admin
    .from("announcements").select("id, tenant_id, subject, body, audience, channels")
    .eq("id", body.announcement_id).maybeSingle();
  if (!announcement) return json({ error: "That announcement could not be found." }, 404);

  const { data: caller } = await admin.from("profiles").select("role, tenant_id").eq("id", user.id).maybeSingle();
  const allowed = caller?.role === "super_admin"
    || (caller?.tenant_id === announcement.tenant_id && (caller?.role === "school_admin" || caller?.role === "teacher"));
  if (!allowed) return json({ error: "You cannot send push for this announcement." }, 403);

  if (!(announcement.channels ?? []).includes("push")) {
    return json({ sent: 0, failed: 0, skipped: "push is not one of this announcement's channels" });
  }

  // Base64, not raw JSON: a multi-line PEM inside a JSON string is exactly
  // the kind of secret value that shell/dotenv quoting mangles silently —
  // base64 has no characters either of those treats specially.
  const serviceAccountB64 = Deno.env.get("FCM_SERVICE_ACCOUNT_JSON_B64");
  if (!serviceAccountB64) return json({ error: "Push is not configured on this project (FCM_SERVICE_ACCOUNT_JSON_B64 not set)." }, 500);

  try {
    const serviceAccount = JSON.parse(atob(serviceAccountB64)) as ServiceAccount;

    const profileIds = await resolveAudienceProfileIds(admin, announcement.tenant_id, announcement.audience as Audience);
    if (profileIds.length === 0) return json({ sent: 0, failed: 0 });

    const { data: tokenRows } = await admin.from("device_tokens").select("id, token").in("profile_id", profileIds);
    const tokens = (tokenRows ?? []) as { id: string; token: string }[];
    if (tokens.length === 0) return json({ sent: 0, failed: 0 });

    const accessToken = await fcmAccessToken(serviceAccount, fetchImpl);
    let sent = 0;
    let failed = 0;
    const staleIds: string[] = [];
    for (const t of tokens) {
      const result = await sendToToken(fetchImpl, serviceAccount.project_id, accessToken, t.token, announcement.subject, announcement.body);
      if (result.ok) sent++;
      else {
        failed++;
        if (result.invalid) staleIds.push(t.id);
      }
    }
    if (staleIds.length) await admin.from("device_tokens").delete().in("id", staleIds);

    return json({ sent, failed });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Could not send push notifications." }, 502);
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
