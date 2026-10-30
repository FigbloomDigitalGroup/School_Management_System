import { distanceM, fetchTripPath } from "./fleet";
import { supabase } from "./supabase";

/**
 * The road a bus takes, for drawing on a map.
 *
 * Routes are stored as stops only (see MAPS.md): no path between them. The web
 * map asks Google's Directions for one in the browser. A phone has no key it
 * may safely use for that, but it does not need one: a trip the bus has
 * already driven is the road path, to the metre, and a family may read the
 * pings of trips on their own child's route (RLS: trips_read_family and
 * vehicle_locations_read_family). So the path comes from the newest finished
 * trip that covers the whole route. A brand-new route has no such trip yet and
 * is drawn as the straight line through its stops until one has run.
 */

export interface PathPoint { lat: number; lng: number }

/** Metres from `p` to the segment a-b, flat-earth, which is exact enough at route scale. */
function distanceToSegmentM(p: PathPoint, a: PathPoint, b: PathPoint): number {
  const k = Math.cos((a.lat * Math.PI) / 180);
  const px = (p.lng - a.lng) * k * 111_320;
  const py = (p.lat - a.lat) * 110_540;
  const bx = (b.lng - a.lng) * k * 111_320;
  const by = (b.lat - a.lat) * 110_540;
  const len2 = bx * bx + by * by;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return Math.hypot(px - t * bx, py - t * by);
}

/**
 * Drops the points that lie within `toleranceM` of the line their neighbours
 * make (Douglas-Peucker), keeping the first and last. A trip is a ping every
 * few seconds; a line that bends where the road bends needs a fraction of them.
 */
export function simplifyPath<T extends PathPoint>(points: T[], toleranceM: number): T[] {
  if (points.length <= 2) return points.slice();
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const pending: [number, number][] = [[0, points.length - 1]];
  while (pending.length) {
    const [lo, hi] = pending.pop()!;
    let worst = -1;
    let worstM = toleranceM;
    for (let i = lo + 1; i < hi; i++) {
      const d = distanceToSegmentM(points[i]!, points[lo]!, points[hi]!);
      if (d > worstM) { worstM = d; worst = i; }
    }
    if (worst !== -1) {
      keep[worst] = true;
      pending.push([lo, worst], [worst, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** What a finished trip must look like before it stands in for the route's road. */
export interface TraceRules {
  /** The trace starts and ends this close to the route's two end stops (either way round). */
  endM: number;
  /** Every stop has a ping at least this close: the bus really drove the whole route. */
  stopM: number;
  /** No two pings further apart than this: a signal dropout would draw a straight line across it. */
  maxGapM: number;
  /** Fewer pings than this is a trip that was started and stopped, not driven. */
  minPoints: number;
}
export const TRACE_RULES: TraceRules = { endM: 400, stopM: 500, maxGapM: 1_500, minPoints: 8 };

/** Does this path start and end at the route's two end stops, in either direction? */
export function endsAtRoute(path: PathPoint[], stops: PathPoint[], endM = TRACE_RULES.endM): boolean {
  if (path.length < 2 || stops.length < 2) return false;
  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  const start = path[0]!;
  const end = path[path.length - 1]!;
  return (
    (distanceM(start, first) <= endM && distanceM(end, last) <= endM) ||
    (distanceM(start, last) <= endM && distanceM(end, first) <= endM)
  );
}

/** Was this trip driven all the way along the route, with a ping often enough to trust the line between pings? */
export function isUsableTrace(trace: PathPoint[], stops: PathPoint[], rules: TraceRules = TRACE_RULES): boolean {
  if (trace.length < rules.minPoints || !endsAtRoute(trace, stops, rules.endM)) return false;
  for (let i = 1; i < trace.length; i++) if (distanceM(trace[i - 1]!, trace[i]!) > rules.maxGapM) return false;
  return stops.every((stop) => trace.some((p) => distanceM(p, stop) <= rules.stopM));
}

const isFinitePoint = (p: PathPoint) => Number.isFinite(p.lat) && Number.isFinite(p.lng);

/**
 * The first of `candidates` (newest trip first) that was driven the whole way,
 * simplified for drawing, or null when none was. `stops` are in route order.
 */
export function pickRouteTrace(candidates: PathPoint[][], stops: PathPoint[], rules: TraceRules = TRACE_RULES, toleranceM = 12): PathPoint[] | null {
  for (const raw of candidates) {
    const trace = raw.filter(isFinitePoint).map((p) => ({ lat: p.lat, lng: p.lng }));
    if (isUsableTrace(trace, stops, rules)) return simplifyPath(trace, toleranceM);
  }
  return null;
}

/** How many of the route's recent finished trips to look through for one that was driven the whole way. */
const TRIPS_TO_TRY = 6;

/**
 * The road path for a route, from the newest finished trip that covers it, or
 * null when no trip has yet (the caller falls back to a straight line). One
 * small query for the trips, then the pings of one trip at a time, newest
 * first, stopping at the first that will do.
 */
export async function fetchRouteTrace(routeId: string, stops: PathPoint[]): Promise<PathPoint[] | null> {
  const { data, error } = await supabase()
    .from("trips").select("id").eq("route_id", routeId).eq("status", "completed")
    .order("started_at", { ascending: false }).limit(TRIPS_TO_TRY)
    .returns<{ id: string }[]>();
  if (error) throw error;
  for (const trip of data ?? []) {
    const picked = pickRouteTrace([await fetchTripPath(trip.id)], stops);
    if (picked) return picked;
  }
  return null;
}
