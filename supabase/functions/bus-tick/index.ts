/**
 * Uber-style bus updates for families. The driver's app calls this after
 * each location ping (packages/shared pingLocation; supabase/simulate-trip.ts
 * too); it works out where the bus is against every stop that has riders,
 * records any new update in bus_updates (families' in-app feed, via
 * Realtime) and pushes it to their guardians' phones.
 *
 * Arrival times come from Google's Routes API with live traffic, asked at
 * most every ETA_EVERY_MS per trip (one matrix call for all its stops), or
 * sooner when an update is about to go out with a stale time. Without
 * GOOGLE_MAPS_SERVER_KEY, or if Google fails, times are estimated from
 * distance and marked "about".
 *
 * Secrets: GOOGLE_MAPS_SERVER_KEY (Routes API), FCM_SERVICE_ACCOUNT_JSON_B64
 * (push; without it updates still reach the in-app feed).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { fcmAccessToken, sendToToken, serviceAccountFromEnv } from "../_shared/fcm.ts";
import { inTravelOrder, personalise, plan, routeProgress, type Direction, type Eta, type Stop, type StopState } from "./plan.ts";

const ETA_EVERY_MS = 120_000;
const ETA_FRESH_MS = 45_000;
/** Fallback speed for estimated times: Nairobi school-run pace, stops included. */
const ESTIMATE_KMH = 22;
const TIME_ZONE = "Africa/Nairobi";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

// deno-lint-ignore no-explicit-any
export interface Deps { admin: any; asUser: any; serviceKey: string; googleKey: string | null }

/** Live-traffic arrival at each destination, one Routes API matrix call. */
async function trafficEtas(
  fetchImpl: typeof fetch, key: string, origin: { lat: number; lng: number }, dests: Stop[], now: Date,
): Promise<Map<string, Eta>> {
  const point = (p: { lat: number; lng: number }) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
  const res = await fetchImpl("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "destinationIndex,duration,staticDuration,condition" },
    body: JSON.stringify({ origins: [point(origin)], destinations: dests.map(point), travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE" }),
  });
  if (!res.ok) throw new Error(`Routes API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const rows = (await res.json()) as { destinationIndex?: number; duration?: string; staticDuration?: string; condition?: string }[];
  const out = new Map<string, Eta>();
  for (const r of rows) {
    if (r.condition !== "ROUTE_EXISTS" || !r.duration) continue;
    const sec = parseInt(r.duration, 10);
    const normal = r.staticDuration ? parseInt(r.staticDuration, 10) : sec;
    out.set(dests[r.destinationIndex ?? 0]!.id, {
      at: new Date(now.getTime() + sec * 1000), trafficMin: Math.max(0, (sec - normal) / 60), estimated: false,
    });
  }
  return out;
}

export async function handle(req: Request, deps: Deps, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const { admin, asUser } = deps;

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Unauthorized" }, 401);
  let callerId: string | null = null; // null = service role (the trip simulator)
  if (token !== deps.serviceKey) {
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);
    callerId = user.id;
  }

  let body: { trip_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }
  if (!body.trip_id) return json({ error: "trip_id is required" }, 400);

  const { data: trip } = await admin.from("trips")
    .select("id, tenant_id, vehicle_id, route_id, driver_id, direction, status, vehicle:vehicles(last_lat, last_lng)")
    .eq("id", body.trip_id).maybeSingle();
  if (!trip) return json({ error: "Trip not found" }, 404);
  // Only this trip's own driver: anyone else could otherwise spam its families.
  if (callerId && callerId !== trip.driver_id) return json({ error: "Not your trip" }, 403);
  if (trip.status !== "active" || !trip.route_id) return json({ skipped: "trip not running on a route" });
  const pos = trip.vehicle?.last_lat != null ? { lat: trip.vehicle.last_lat as number, lng: trip.vehicle.last_lng as number } : null;
  if (!pos) return json({ skipped: "no position yet" });

  const [{ data: stopRows }, { data: riderRows }, { data: saidRows }, { data: progressRows }] = await Promise.all([
    admin.from("route_stops").select("id, name, lat, lng, sequence").eq("route_id", trip.route_id),
    admin.from("student_transport").select("student_id, stop_id, student:students(full_name, active)").eq("route_id", trip.route_id),
    admin.from("bus_updates").select("stop_id, dedupe_key").eq("trip_id", trip.id),
    admin.from("bus_stop_progress").select("*").eq("trip_id", trip.id),
  ]);
  const direction = trip.direction as Direction;
  const stops = inTravelOrder((stopRows ?? []) as Stop[], direction);

  // Riders by stop, active learners only.
  const riders = new Map<string, { id: string; first: string }[]>();
  // deno-lint-ignore no-explicit-any
  for (const r of (riderRows ?? []) as any[]) {
    if (!r.stop_id || r.student?.active === false) continue;
    const list = riders.get(r.stop_id) ?? [];
    list.push({ id: r.student_id, first: String(r.student?.full_name ?? "").split(" ")[0] || "Your child" });
    riders.set(r.stop_id, list);
  }
  if (!riders.size) return json({ skipped: "no riders on this route" });

  // deno-lint-ignore no-explicit-any
  const progress = new Map<string, any>((progressRows ?? []).map((p: any) => [p.stop_id, p]));
  const state = new Map<string, StopState>();
  for (const s of stops) {
    const p = progress.get(s.id);
    state.set(s.id, {
      said: new Set(), baselineEta: p?.baseline_eta ? new Date(p.baseline_eta) : null,
      lateNotifiedMin: p?.late_notified_min ?? 0, latePendingMin: p?.late_pending_min ?? null,
    });
  }
  // deno-lint-ignore no-explicit-any
  for (const r of (saidRows ?? []) as any[]) state.get(r.stop_id)?.said.add(r.dedupe_key);

  // First pass without fresh times: does anything need announcing, and to which stops?
  const riderStopIds = new Set(riders.keys());
  const base = { direction, stops, pos, riderStopIds, state, now, timeZone: TIME_ZONE };
  const draft = plan({ ...base, etas: new Map() });
  const ahead = draft.filter((p) => p.distanceM > 0).map((p) => stops[p.index]!);
  const lastChecked = Math.min(...draft.map((p) => progress.get(p.stopId)?.last_checked_at ? Date.parse(progress.get(p.stopId).last_checked_at) : 0));
  const sinceCheck = now.getTime() - (Number.isFinite(lastChecked) ? lastChecked : 0);
  const wantEta = ahead.length > 0 && (sinceCheck >= ETA_EVERY_MS || (draft.some((p) => p.updates.length) && sinceCheck >= ETA_FRESH_MS));

  let etas = new Map<string, Eta>();
  let fetched = false;
  if (wantEta && deps.googleKey) {
    try { etas = await trafficEtas(fetchImpl, deps.googleKey, pos, ahead, now); fetched = true; }
    catch (err) { console.error("bus-tick: Routes API failed, estimating", err); }
  }
  // Fill gaps: last known time if recent, else a distance-based estimate.
  for (const p of draft) {
    if (etas.has(p.stopId) || p.distanceM === 0) continue;
    const prev = progress.get(p.stopId);
    if (!fetched && prev?.last_eta && prev.last_checked_at && now.getTime() - Date.parse(prev.last_checked_at) < ETA_EVERY_MS) {
      etas.set(p.stopId, { at: new Date(prev.last_eta), trafficMin: 0, estimated: false });
    } else {
      etas.set(p.stopId, { at: new Date(now.getTime() + (p.distanceM / 1000 / ESTIMATE_KMH) * 3_600_000), trafficMin: 0, estimated: true });
    }
  }
  const final = plan({ ...base, etas, fresh: fetched });

  // Remember the times: the first one is the promise "running late" is measured against.
  const progressUpserts = final.filter((p) => etas.has(p.stopId)).map((p) => {
    const eta = etas.get(p.stopId)!;
    const prev = progress.get(p.stopId);
    return {
      trip_id: trip.id, stop_id: p.stopId,
      baseline_eta: prev?.baseline_eta ?? (eta.estimated ? null : eta.at.toISOString()),
      last_eta: eta.estimated ? (prev?.last_eta ?? null) : eta.at.toISOString(),
      last_checked_at: fetched ? now.toISOString() : (prev?.last_checked_at ?? null),
      late_notified_min: p.lateNotifiedMin ?? prev?.late_notified_min ?? 0,
      late_pending_min: p.latePendingMin === undefined ? (prev?.late_pending_min ?? null) : p.latePendingMin,
    };
  });
  if (progressUpserts.length) await admin.from("bus_stop_progress").upsert(progressUpserts);

  // Record each update; the unique key drops any a racing tick already sent.
  const sent: { stopId: string; title: string; body: string }[] = [];
  for (const u of final.flatMap((p) => p.updates)) {
    const { error } = await admin.from("bus_updates").insert({
      tenant_id: trip.tenant_id, trip_id: trip.id, vehicle_id: trip.vehicle_id, stop_id: u.stopId,
      student_ids: riders.get(u.stopId)!.map((r) => r.id), kind: u.kind, title: u.title, body: u.body,
      distance_m: u.distanceM, eta_at: u.etaAt?.toISOString() ?? null, dedupe_key: u.key,
    });
    if (error) { if (error.code !== "23505") console.error("bus-tick: insert failed", error); continue; }
    sent.push({ stopId: u.stopId, title: u.title, body: u.body });
  }

  const pushed = sent.length ? await pushToGuardians(admin, fetchImpl, trip.id, sent, riders) : 0;
  return json({ updates: sent.length, pushed, eta: fetched ? "traffic" : "estimate", stopsAhead: ahead.length, at: routeProgress(stops, pos) });
}

/** Each update to the phones of the guardians of that stop's riders, named for their own children. */
async function pushToGuardians(
  // deno-lint-ignore no-explicit-any
  admin: any, fetchImpl: typeof fetch, tripId: string,
  sent: { stopId: string; title: string; body: string }[], riders: Map<string, { id: string; first: string }[]>,
): Promise<number> {
  const account = serviceAccountFromEnv();
  if (!account) return 0;
  const studentIds = [...new Set(sent.flatMap((s) => riders.get(s.stopId)!.map((r) => r.id)))];
  const { data: guardianRows } = await admin.from("guardians").select("profile_id, student_id").in("student_id", studentIds);
  const guardians = (guardianRows ?? []) as { profile_id: string; student_id: string }[];
  if (!guardians.length) return 0;
  const { data: tokenRows } = await admin.from("device_tokens").select("id, token, profile_id").in("profile_id", [...new Set(guardians.map((g) => g.profile_id))]);
  const tokens = (tokenRows ?? []) as { id: string; token: string; profile_id: string }[];
  if (!tokens.length) return 0;

  try {
    const accessToken = await fcmAccessToken(account, fetchImpl);
    let pushed = 0;
    const stale: string[] = [];
    for (const s of sent) {
      const here = riders.get(s.stopId)!;
      for (const t of tokens) {
        const mine = guardians.filter((g) => g.profile_id === t.profile_id).map((g) => g.student_id);
        const names = here.filter((r) => mine.includes(r.id)).map((r) => r.first);
        if (!names.length) continue;
        // One live notification per child's stop: each update replaces the last.
        const r = await sendToToken(fetchImpl, account.project_id, accessToken, t.token, personalise(s.title, names), s.body, { tag: `bus-${tripId}-${s.stopId}` });
        if (r.ok) pushed++;
        else if (r.invalid) stale.push(t.id);
      }
    }
    if (stale.length) await admin.from("device_tokens").delete().in("id", [...new Set(stale)]);
    return pushed;
  } catch (err) {
    console.error("bus-tick: push failed", err);
    return 0;
  }
}

if (import.meta.main) {
  Deno.serve((req) => {
    const auth = req.headers.get("Authorization") ?? "";
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
    return handle(req, { admin, asUser, serviceKey, googleKey: Deno.env.get("GOOGLE_MAPS_SERVER_KEY") ?? null });
  });
}
