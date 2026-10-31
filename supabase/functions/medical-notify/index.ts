/**
 * Pushes a sick bay visit's notices to guardians' phones: "Amani visited the
 * sick bay ... and is being sent home". The database writes the notices
 * itself when the nurse sets the visit's outcome, if the school's setting
 * covers it (medical_notices, 20261101300000_medical.sql), so they already
 * reach the parent's Health page; this only sends the push. The sick bay
 * screen calls it after saving an outcome, fire and forget.
 *
 * A notice names the outcome (and the hospital, for a referral), never the
 * complaint or the nurse's assessment: a push shows on a locked screen.
 * Notices are claimed (pushed_at set) before sending, so two calls racing
 * never push the same one twice.
 *
 * Deploy: supabase functions deploy medical-notify
 * Needs the FCM_SERVICE_ACCOUNT_JSON_B64 secret, same as send-push. Without
 * it nothing is pushed (and nothing is marked pushed); parents still see the
 * notice in the app.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { failure } from "../_shared/failure.ts";
import { fcmAccessToken, sendToToken, serviceAccountFromEnv, type ServiceAccount } from "../_shared/fcm.ts";
import { holdsArea } from "../_shared/adminAreas.ts";

/** Older unpushed notices are stale news: yesterday's "sent home" helps nobody now. */
const FRESH_MS = 6 * 3_600_000;

// deno-lint-ignore no-explicit-any
export interface Deps { admin: any; asUser: any; account?: ServiceAccount | null }

/** Who may ask for a visit's pushes: the school's office, and whoever holds the medical area. */
// deno-lint-ignore no-explicit-any
export async function mayNotify(admin: any, caller: { id: string; role: string; tenant_id: string | null }, tenantId: string): Promise<boolean> {
  if (caller.tenant_id !== tenantId) return false;
  return caller.role === "school_admin" || await holdsArea(admin, caller, tenantId, "medical");
}

interface Notice { id: string; profile_id: string; student_id: string; title: string; body: string }

export async function handle(req: Request, { admin, asUser, account = serviceAccountFromEnv() }: Deps, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = req.headers.get("Authorization");
  if (!auth) return json({ error: "Unauthorized" }, 401);
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: { visit_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }
  if (!body.visit_id) return json({ error: "visit_id is required" }, 400);

  const { data: visit } = await admin.from("sick_bay_visits").select("id, tenant_id").eq("id", body.visit_id).maybeSingle();
  if (!visit) return json({ error: "That visit could not be found." }, 404);

  const { data: caller } = await admin.from("profiles").select("id, role, tenant_id").eq("id", user.id).maybeSingle();
  if (!caller || !(await mayNotify(admin, caller, visit.tenant_id))) {
    return json({ error: "Only the school's nurse, or the office, can send this." }, 403);
  }

  if (!account) return json({ sent: 0, failed: 0, skipped: "push is not configured on this project" });

  const { data: claimed, error } = await admin.from("medical_notices")
    .update({ pushed_at: now.toISOString() })
    .eq("visit_id", visit.id).is("pushed_at", null)
    .gte("created_at", new Date(now.getTime() - FRESH_MS).toISOString())
    .select("id, profile_id, student_id, title, body");
  if (error) return json(failure("medical-notify", "read the notices to send", error), 500);
  const notices = (claimed ?? []) as Notice[];
  if (!notices.length) return json({ sent: 0, failed: 0 });

  const { data: tokenRows } = await admin.from("device_tokens").select("id, token, profile_id")
    .in("profile_id", [...new Set(notices.map((n) => n.profile_id))]);
  const tokens = (tokenRows ?? []) as { id: string; token: string; profile_id: string }[];
  if (!tokens.length) return json({ sent: 0, failed: 0 });

  let sent = 0;
  let failed = 0;
  const stale: string[] = [];
  try {
    const accessToken = await fcmAccessToken(account, fetchImpl);
    for (const n of notices) {
      for (const t of tokens.filter((t) => t.profile_id === n.profile_id)) {
        // one notification per visit: "resting" is replaced by "sent home"
        // a tap opens the parent's Health screen, on the child the notice is about
        const r = await sendToToken(fetchImpl, account.project_id, accessToken, t.token, n.title, n.body, {
          tag: `sick-bay-${visit.id}`, data: { type: "health", visit_id: String(visit.id), student_id: String(n.student_id) },
        });
        if (r.ok) sent++;
        else {
          failed++;
          if (r.invalid) stale.push(t.id);
        }
      }
    }
    if (stale.length) await admin.from("device_tokens").delete().in("id", [...new Set(stale)]);
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
