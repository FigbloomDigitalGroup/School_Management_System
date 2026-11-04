/**
 * Fakes a driver's live GPS trip for demos — loops the seeded route's bus
 * (KDA 214B) back and forth between its first and last stop, writing real
 * vehicle_locations rows + vehicles.last_lat/lng updates exactly like a
 * driver's phone would (see pingLocation() in packages/shared/src/fleet.ts).
 * That's what lets the admin Fleet map and parent Bus map pick it up live,
 * over the same Realtime subscription — no code path is faked, only the
 * GPS source.
 *
 * Each leg is fetched from the Google Directions API (using the same key as
 * VITE_GOOGLE_MAPS_API_KEY) and resampled to evenly spaced points along the
 * real driving path, so the marker follows actual roads instead of a straight
 * line between stops. Falls back to straight-line interpolation for a leg if
 * no key is set or the API call fails.
 *
 * Run after `npm run db:seed` (needs the seeded vehicle/route/driver):
 *
 *   npm run db:simulate-trip            # loops forever, alternating direction
 *   REVERSE=1 npm run db:simulate-trip  # start with the return leg instead
 *   ONE=1 npm run db:simulate-trip      # just one lap, then stop
 *   SCHOOL=kijani-ridge PLATE="KDK 482M" npm run db:simulate-trip   # another school's bus
 *
 * It also does the driver's rider marks: on the way home every child gets on
 * at school and off at their own stop; on the way to school each child gets
 * on at their stop and off at school, and now and then one isn't at the
 * pickup (ABSENT_PCT, default 5). The trip_riders trigger turns each mark into
 * the family's update ("Amani got on the bus at 15:31"), exactly as the
 * driver's app does; phone pushes need a driver's session, so the simulator's
 * marks reach the in-app feed and the admin's live riders, not phones.
 *
 * Leave it running and open the admin Fleet screen or the parent Bus screen
 * in another tab — the bus marker moves every few seconds. Ctrl+C stops it
 * after the current tick (a second Ctrl+C quits immediately). Uses the
 * service role key, so it bypasses RLS — never point this at a remote project.
 */

import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required (supabase status shows it)");
if (url.includes("supabase.co") && !process.env.ALLOW_REMOTE_SEED) {
  throw new Error("Refusing to run against a remote project. Set ALLOW_REMOTE_SEED=1 if you really mean it.");
}

const mapsKey = process.env.GOOGLE_MAPS_API_KEY ?? process.env.VITE_GOOGLE_MAPS_API_KEY;

const db = createClient(url, key, { auth: { persistSession: false } });

/** Which school's bus to drive — the Alliance demo bus unless told otherwise. */
const SCHOOL = process.env.SCHOOL ?? "alliance";
const PLATE = process.env.PLATE ?? "KDA 214B";

const TICK_MS = 4_000;
/**
 * How far the bus moves per tick, along the road. Short enough that the
 * map's straight slide between two positions stays on the road through a
 * bend (a fixed number of steps per leg made long legs jump 100m+ and cut
 * corners); 50m every 4s is about 45 km/h.
 */
const STEP_M = 50;

type LatLng = { lat: number; lng: number };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function bearing(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Standard Google encoded-polyline decoder (precision 5) — same format the Maps JS API draws directly. */
function decodePolyline(encoded: string): LatLng[] {
  let index = 0, lat = 0, lng = 0;
  const points: LatLng[] = [];
  while (index < encoded.length) {
    let shift = 0, result = 0, byte: number;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0; result = 0;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

/** Real driving path between two points via the Directions API, or null if unavailable — caller falls back to a straight line. */
async function fetchRoutePolyline(origin: LatLng, destination: LatLng): Promise<LatLng[] | null> {
  if (!mapsKey) return null;
  try {
    const params = new URLSearchParams({
      origin: `${origin.lat},${origin.lng}`, destination: `${destination.lat},${destination.lng}`,
      mode: "driving", key: mapsKey,
    });
    const res = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params}`);
    const json = await res.json() as {
      status: string; error_message?: string;
      routes: { overview_polyline: { points: string }; legs: { steps: { polyline: { points: string } }[] }[] }[];
    };
    if (json.status !== "OK" || !json.routes.length) {
      console.warn(`  ! Directions API: ${json.status}${json.error_message ? ` — ${json.error_message}` : ""}. Falling back to a straight line.`);
      return null;
    }
    // Every turn of every step: the overview polyline is simplified and cuts across bends.
    const detailed = json.routes[0]!.legs.flatMap((leg) => leg.steps.flatMap((step) => decodePolyline(step.polyline.points)));
    return detailed.length >= 2 ? detailed : decodePolyline(json.routes[0]!.overview_polyline.points);
  } catch (err) {
    console.warn(`  ! Directions API request failed: ${err instanceof Error ? err.message : err}. Falling back to a straight line.`);
    return null;
  }
}

/** Resamples a path (real polyline, or just [from, to]) to `steps + 1` evenly-distance-spaced points. */
function resamplePath(points: LatLng[], steps: number): LatLng[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1]! + haversineKm(points[i - 1]!, points[i]!));
  const total = cum[cum.length - 1]!;

  const out: LatLng[] = [];
  for (let s = 0; s <= steps; s++) {
    const target = total * (s / steps);
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1]! < target) i++;
    const segLen = cum[i + 1]! - cum[i]!;
    const t = segLen > 0 ? (target - cum[i]!) / segLen : 0;
    const a = points[i]!, b = points[i + 1]!;
    out.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
  }
  return out;
}

async function main() {
  const { data: tenant, error: tErr } = await db.from("tenants").select("id, name").eq("slug", SCHOOL).single();
  if (tErr || !tenant) throw new Error(`Could not find the "${SCHOOL}" school — run its seed first. ${tErr?.message ?? ""}`);

  const { data: vehicle, error: vErr } = await db.from("vehicles").select("id, plate_number").eq("tenant_id", tenant.id).eq("plate_number", PLATE).single();
  if (vErr || !vehicle) throw new Error(`Could not find bus ${PLATE} at ${tenant.name}. ${vErr?.message ?? ""}`);

  const { data: assignment, error: aErr } = await db
    .from("vehicle_assignments").select("driver_id, route_id").eq("vehicle_id", vehicle.id).eq("active", true).single();
  if (aErr || !assignment?.route_id) throw new Error(`Could not find an active route assignment for ${vehicle.plate_number}. ${aErr?.message ?? ""}`);

  const { data: stopsAsc, error: sErr } = await db
    .from("route_stops").select("id, name, lat, lng, sequence").eq("route_id", assignment.route_id).order("sequence");
  if (sErr || !stopsAsc?.length) throw new Error(`Could not load stops for this route. ${sErr?.message ?? ""}`);

  if (!mapsKey) console.log("No GOOGLE_MAPS_API_KEY/VITE_GOOGLE_MAPS_API_KEY set — every leg will be a straight line.\n");

  // End any stale active trip for this vehicle first — only one may be active at a time.
  await db.from("trips").update({ status: "completed", ended_at: new Date().toISOString() }).eq("vehicle_id", vehicle.id).eq("status", "active");

  console.log(`Looping ${vehicle.plate_number} back and forth: ${stopsAsc[0]!.name} <-> ${stopsAsc[stopsAsc.length - 1]!.name}.`);
  console.log("Open the admin Fleet screen or the parent Bus screen now — Ctrl+C to stop after the current tick.\n");

  let stopRequested = false;
  process.on("SIGINT", () => {
    if (stopRequested) process.exit(1); // second Ctrl+C: bail immediately, current trip stays "active"
    stopRequested = true;
    console.log("\nStopping after this leg finishes (Ctrl+C again to quit immediately)…");
  });

  // ONE=1 runs a single lap instead of looping forever — handy for a quick one-off demo.
  const singleLap = process.env.ONE === "1";
  let reverse = process.env.REVERSE === "1";

  // START_DELAY_MIN=5 holds the bus at school before its first trip, so a second bus on the
  // same road can be started together with the first and still leave a few minutes behind it.
  const delayMin = Number(process.env.START_DELAY_MIN ?? 0);
  if (delayMin > 0) {
    console.log(`Waiting ${delayMin} min at ${stopsAsc[0]!.name} before leaving…`);
    for (let waited = 0; waited < delayMin * 60_000 && !stopRequested; waited += TICK_MS) await sleep(TICK_MS);
  }

  while (!stopRequested) {
    const stops = reverse ? [...stopsAsc].reverse() : stopsAsc;

    const { data: trip, error: tripErr } = await db.from("trips").insert({
      tenant_id: tenant.id, vehicle_id: vehicle.id, route_id: assignment.route_id,
      driver_id: assignment.driver_id, direction: reverse ? "to_school" : "from_school",
    }).select("id").single();
    if (tripErr || !trip) throw new Error(`Could not start a trip. ${tripErr?.message}`);
    console.log(`Trip ${trip.id}: ${stops[0]!.name} -> ${stops[stops.length - 1]!.name}`);

    // The route's children, put on the trip by the trip_seed_riders trigger.
    const { data: riderRows } = await db.from("trip_riders").select("student_id, stop_id").eq("trip_id", trip.id);
    const riders = (riderRows ?? []) as { student_id: string; stop_id: string | null }[];
    const onBus = new Set<string>();
    const toSchool = reverse;
    async function mark(ids: string[], status: "boarded" | "alighted" | "absent") {
      if (!ids.length) return;
      const { error } = await db.from("trip_riders")
        .update({ status, ...(status === "boarded" ? { boarded_at: new Date().toISOString() } : status === "alighted" ? { alighted_at: new Date().toISOString() } : {}) })
        .eq("trip_id", trip!.id).in("student_id", ids);
      if (error) { console.log(`    !! could not mark ${ids.length} rider(s) ${status}: ${error.message}`); return; }
      for (const id of ids) (status === "boarded" ? onBus.add(id) : onBus.delete(id));
      console.log(`    -> ${ids.length} rider(s) ${status === "boarded" ? "got on" : status === "alighted" ? "got off" : "not at the pickup"}`);
    }
    const absentPct = Number(process.env.ABSENT_PCT ?? 5);
    /** What the driver does at a stop: the school end boards or drops everyone, a home stop its own children. */
    async function atStop(stop: { id: string }, first: boolean, last: boolean) {
      if (!toSchool && first) {
        await mark(riders.map((r) => r.student_id), "boarded");
      } else if (!toSchool) {
        await mark(riders.filter((r) => (last || r.stop_id === stop.id) && onBus.has(r.student_id)).map((r) => r.student_id), "alighted");
      } else if (last) {
        await mark([...onBus], "alighted");
      } else {
        const here = riders.filter((r) => r.stop_id === stop.id || (first && r.stop_id === null));
        const missing = here.filter(() => Math.random() * 100 < absentPct);
        await mark(missing.map((r) => r.student_id), "absent");
        await mark(here.filter((r) => !missing.includes(r)).map((r) => r.student_id), "boarded");
      }
    }
    await atStop(stops[0]!, true, false);

    for (let leg = 0; leg < stops.length - 1 && !stopRequested; leg++) {
      const from = stops[leg]!;
      const to = stops[leg + 1]!;

      const realPath = await fetchRoutePolyline(from, to);
      const path = realPath && realPath.length >= 2 ? realPath : [from, to];
      let pathKm = 0;
      for (let i = 1; i < path.length; i++) pathKm += haversineKm(path[i - 1]!, path[i]!);
      const waypoints = resamplePath(path, Math.max(2, Math.ceil((pathKm * 1000) / STEP_M)));
      console.log(`  ${from.name} -> ${to.name}${realPath ? " (real road route)" : " (straight line)"}`);

      for (let step = 0; step < waypoints.length && !stopRequested; step++) {
        const { lat, lng } = waypoints[step]!;
        const heading = bearing(waypoints[step]!, waypoints[Math.min(step + 1, waypoints.length - 1)]!);
        const speedKmh = 30 + Math.round(Math.random() * 15);

        const { error: insertErr } = await db.from("vehicle_locations").insert({
          tenant_id: tenant.id, vehicle_id: vehicle.id, trip_id: trip.id,
          lat, lng, speed_kmh: speedKmh, heading,
        });
        if (insertErr) throw insertErr;
        const { error: updateErr } = await db.from("vehicles").update({
          last_lat: lat, last_lng: lng, last_ping_at: new Date().toISOString(),
        }).eq("id", vehicle.id);
        if (updateErr) throw updateErr;
        // Families' bus updates, exactly as a real driver's app triggers them.
        const tick = await fetch(`${url}/functions/v1/bus-tick`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ trip_id: trip.id }),
        }).then((r) => r.json()).catch(() => null) as { updates?: number } | null;
        if (tick?.updates) console.log(`    -> ${tick.updates} family update(s) sent`);

        console.log(`    ${Math.round((step / (waypoints.length - 1)) * 100)}% · ${lat.toFixed(5)}, ${lng.toFixed(5)} · ${speedKmh} km/h`);
        await sleep(TICK_MS);
      }
      if (!stopRequested) {
        await atStop(to, false, leg + 1 === stops.length - 1);
        // a short wait at the stop while children get on or off
        await sleep(TICK_MS * 2);
      }
    }

    await db.from("trips").update({ status: "completed", ended_at: new Date().toISOString() }).eq("id", trip.id);
    if (singleLap) break;
    reverse = !reverse;
  }

  console.log("\nStopped.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
