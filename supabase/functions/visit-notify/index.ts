/**
 * Pushes a visitor to the phones of whoever needs to know: the member of
 * staff they came to see, and every school admin once the visit is
 * escalated (20261027010001_gate_reception.sql). Called by the visitor log
 * (whoever holds the visitors admin area, 20261031000000) and the office right
 * after they record a visit or escalate one, the same way the announcement
 * composer calls send-push.
 *
 * Deploy: supabase functions deploy visit-notify
 * Needs the FCM_SERVICE_ACCOUNT_JSON_B64 secret, same as send-push. Without
 * it nothing is pushed (and nothing is marked pushed); the consoles still
 * show the visit live.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { fcmAccessToken, sendToToken, serviceAccountFromEnv, type ServiceAccount } from "../_shared/fcm.ts";
import { plan, type VisitRow } from "./plan.ts";
import { holdsArea } from "../_shared/adminAreas.ts";

// deno-lint-ignore no-explicit-any
export interface Deps { admin: any; asUser: any; account?: ServiceAccount | null }

/** Who may ask for a visit's pushes: the school's office, and whoever holds the visitors area (is_front_desk()). */
// deno-lint-ignore no-explicit-any
export async function mayNotify(admin: any, caller: { id: string; role: string; tenant_id: string | null }, tenantId: string): Promise<boolean> {
  if (caller.tenant_id !== tenantId) return false;
  return caller.role === "school_admin" || await holdsArea(admin, caller, tenantId, "visitors");
}

export async function handle(req: Request, { admin, asUser, account = serviceAccountFromEnv() }: Deps, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = req.headers.get("Authorization");
  if (!auth) return json({ error: "Unauthorized" }, 401);
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: { visit_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }
  if (!body.visit_id) return json({ error: "visit_id is required" }, 400);

  const { data: visit } = await admin
    .from("visits")
    .select("id, tenant_id, visitor_name, purpose, host_kind, host_id, student_name, escalated, status, host_pushed_at, escalation_pushed_at")
    .eq("id", body.visit_id).maybeSingle();
  if (!visit) return json({ error: "That visit could not be found." }, 404);

  const { data: caller } = await admin.from("profiles").select("id, role, tenant_id").eq("id", user.id).maybeSingle();
  if (!caller || !(await mayNotify(admin, caller, visit.tenant_id))) {
    return json({ error: "Only whoever keeps the school's visitor log, or the office, can send this." }, 403);
  }

  if (!account) return json({ sent: 0, failed: 0, skipped: "push is not configured on this project" });

  const { data: adminRows } = await admin.from("profiles").select("id").eq("tenant_id", visit.tenant_id).eq("role", "school_admin");
  const pushes = plan(visit as VisitRow, ((adminRows ?? []) as { id: string }[]).map((a) => a.id));
  if (!pushes.length) return json({ sent: 0, failed: 0 });

  let sent = 0;
  let failed = 0;
  const stale: string[] = [];
  try {
    let accessToken: string | null = null;
    for (const p of pushes) {
      // Claimed before sending: two calls racing for the same visit push it once.
      const { data: claimed } = await admin.from("visits")
        .update({ [p.marker]: new Date().toISOString() }).eq("id", visit.id).is(p.marker, null).select("id");
      if (!claimed?.length) continue;
      const { data: tokenRows } = await admin.from("device_tokens").select("id, token").in("profile_id", p.profileIds);
      const tokens = (tokenRows ?? []) as { id: string; token: string }[];
      if (!tokens.length) continue;
      accessToken ??= await fcmAccessToken(account, fetchImpl);
      for (const t of tokens) {
        // a tap opens the teacher's visitors list
        const r = await sendToToken(fetchImpl, account.project_id, accessToken, t.token, p.title, p.body, {
          tag: `visit-${visit.id}`, data: { type: "visit", visit_id: String(visit.id) },
        });
        if (r.ok) sent++;
        else {
          failed++;
          if (r.invalid) stale.push(t.id);
        }
      }
    }
    if (stale.length) await admin.from("device_tokens").delete().in("id", stale);
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
