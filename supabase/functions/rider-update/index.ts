/**
 * Pushes the driver's rider updates to families' phones: "Amani got on the
 * bus at 15:31", "... got off at Imara Daima", "... was not at the pickup",
 * and "Amani's bus has broken down". The database writes those bus_updates
 * rows itself (trip_rider_announce and report_breakdown, see
 * 20261025020000_bus_riders_and_homes.sql and
 * 20261027000000_bus_rider_list_breakdowns.sql), so they already reach the
 * in-app feed over Realtime; this only sends the push. The driver's screen
 * calls it after each mark or report (packages/shared markRider and
 * reportBreakdown), fire and forget.
 *
 * Every unpushed update on the trip goes out, not just the latest: a mark
 * made in a dead zone is pushed by the next call after it syncs. Rows are
 * claimed (pushed_at set) before sending, so two calls racing never push the
 * same update twice.
 *
 * Secrets: FCM_SERVICE_ACCOUNT_JSON_B64 (without it updates still reach the in-app feed).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { failure } from "../_shared/failure.ts";
import { fcmAccessToken, sendToToken, serviceAccountFromEnv, type ServiceAccount } from "../_shared/fcm.ts";
import { personalise } from "../bus-tick/plan.ts";

const RIDER_KINDS = ["boarded", "alighted", "absent", "breakdown"];
/** Older unpushed updates are stale news: a "got on the bus" from yesterday helps nobody. */
const FRESH_MS = 3 * 3_600_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

// deno-lint-ignore no-explicit-any
export interface Deps { admin: any; asUser: any; account: ServiceAccount | null }

interface Update { id: string; student_ids: string[]; kind: string; title: string; body: string }

export async function handle(req: Request, deps: Deps, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const { admin, asUser } = deps;

  if (!req.headers.get("Authorization")) return json({ error: "Unauthorized" }, 401);
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: { trip_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }
  if (!body.trip_id) return json({ error: "trip_id is required" }, 400);

  const { data: trip } = await admin.from("trips").select("id, driver_id").eq("id", body.trip_id).maybeSingle();
  if (!trip) return json({ error: "Trip not found" }, 404);
  // Only this trip's own driver: anyone else could otherwise push to its families.
  if (user.id !== trip.driver_id) return json({ error: "Not your trip" }, 403);
  if (!deps.account) return json({ pushed: 0, skipped: "push is not configured" });

  const { data: claimed, error } = await admin.from("bus_updates")
    .update({ pushed_at: now.toISOString() })
    .eq("trip_id", trip.id).is("pushed_at", null).in("kind", RIDER_KINDS)
    .gte("created_at", new Date(now.getTime() - FRESH_MS).toISOString())
    .select("id, student_ids, kind, title, body");
  if (error) return json(failure("rider-update", "read the updates to send", error), 500);
  const updates = (claimed ?? []) as Update[];
  if (!updates.length) return json({ pushed: 0 });

  return json({ pushed: await pushToGuardians(admin, fetchImpl, deps.account, trip.id, updates) });
}

/** Each update to the phones of its children's guardians, named for their own children. */
async function pushToGuardians(
  // deno-lint-ignore no-explicit-any
  admin: any, fetchImpl: typeof fetch, account: ServiceAccount, tripId: string, updates: Update[],
): Promise<number> {
  const studentIds = [...new Set(updates.flatMap((u) => u.student_ids))];
  const [{ data: guardianRows }, { data: studentRows }] = await Promise.all([
    admin.from("guardians").select("profile_id, student_id").in("student_id", studentIds),
    admin.from("students").select("id, full_name").in("id", studentIds),
  ]);
  const guardians = (guardianRows ?? []) as { profile_id: string; student_id: string }[];
  if (!guardians.length) return 0;
  const first = new Map(((studentRows ?? []) as { id: string; full_name: string }[])
    .map((s) => [s.id, String(s.full_name ?? "").trim().split(" ")[0] || "Your child"]));
  const { data: tokenRows } = await admin.from("device_tokens").select("id, token, profile_id").in("profile_id", [...new Set(guardians.map((g) => g.profile_id))]);
  const tokens = (tokenRows ?? []) as { id: string; token: string; profile_id: string }[];
  if (!tokens.length) return 0;

  try {
    const accessToken = await fcmAccessToken(account, fetchImpl);
    let pushed = 0;
    const stale: string[] = [];
    for (const u of updates) {
      for (const t of tokens) {
        const mine = guardians.filter((g) => g.profile_id === t.profile_id && u.student_ids.includes(g.student_id)).map((g) => g.student_id);
        if (!mine.length) continue;
        // A rider update already names its one child; a breakdown starts "Bus ..." and is named here.
        const title = personalise(u.title, mine.map((id) => first.get(id) ?? "Your child"));
        // One notification per child per trip: "got off" replaces "got on". A breakdown stands on its own.
        const tag = u.kind === "breakdown" ? `bus-${tripId}-breakdown` : `bus-${tripId}-${mine.join("-")}`;
        const r = await sendToToken(fetchImpl, account.project_id, accessToken, t.token, title, u.body, { tag });
        if (r.ok) pushed++;
        else if (r.invalid) stale.push(t.id);
      }
    }
    if (stale.length) await admin.from("device_tokens").delete().in("id", [...new Set(stale)]);
    return pushed;
  } catch (err) {
    console.error("rider-update: push failed", err);
    return 0;
  }
}

if (import.meta.main) {
  Deno.serve((req) => {
    const auth = req.headers.get("Authorization") ?? "";
    const url = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
    return handle(req, { admin, asUser, account: serviceAccountFromEnv() });
  });
}
