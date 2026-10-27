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
import { fcmAccessToken, sendToToken, type ServiceAccount } from "../_shared/fcm.ts";
import { holdsArea } from "../_shared/adminAreas.ts";

// deno-lint-ignore no-explicit-any
export interface Deps { admin: any; asUser: any }

/** Everyone the announcement reaches, decided by the database
 *  (announcement_recipients(), the same rule that decides who may read it),
 *  so push never reaches someone the inbox would hide it from. */
// deno-lint-ignore no-explicit-any
async function recipientProfileIds(admin: any, announcementId: string): Promise<string[]> {
  const { data, error } = await admin.rpc("announcement_recipients", { p_announcement_id: announcementId });
  if (error) throw new Error(error.message);
  return (data ?? []) as string[];
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

  const { data: caller } = await admin.from("profiles").select("id, role, tenant_id").eq("id", user.id).maybeSingle();
  // other staff send notices with the communication area (20261031000000)
  const allowed = caller?.role === "super_admin"
    || (caller?.tenant_id === announcement.tenant_id && (caller?.role === "school_admin" || caller?.role === "teacher"))
    || (!!caller && await holdsArea(admin, caller, announcement.tenant_id, "communication"));
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

    const profileIds = await recipientProfileIds(admin, announcement.id);
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
