import { replaceRouteStops } from "./fleet";
import { supabase } from "./supabase";
import type { RouteStop } from "./types";

/**
 * Planning bus routes from where learners live (students.home_lat/home_lng,
 * see 20261025020000_bus_riders_and_homes.sql and
 * 20261025050000_learner_address_health.sql).
 *
 * Two jobs, both pure and tested, with the database writes at the bottom:
 *  - suggestRouteForHome: a new learner's home -> the route and stop they
 *    should ride. An existing stop within walking distance if there is one,
 *    otherwise a new stop on whichever route it costs the least extra driving
 *    to reach (cheapest insertion).
 *  - rebuildStopsFromHomes: a route's riders' homes -> a fresh, ordered stop
 *    list. Homes close together share a stop; stops are ordered from the
 *    school end by nearest neighbour, then untangled with 2-opt.
 *
 * Distances are straight-line (haversine), not road distance: good enough to
 * choose between routes and order a few dozen stops, and free. The office
 * sees a preview and can change anything before it's saved.
 */

export interface LatLngPoint { lat: number; lng: number }

/** A walk a parent will accept to a stop. */
export const WALK_RADIUS_M = 400;
/** Homes this close together share one stop when a route is rebuilt. */
export const CLUSTER_RADIUS_M = 300;
/** A rebuilt stop this close to an existing one keeps that stop's identity (and name). */
const SAME_STOP_M = 150;

/** Metres between two points (haversine). */
export function haversineM(a: LatLngPoint, b: LatLngPoint): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A name for a stop made from a learner's home: the landmark, else the first part of the address. */
export function stopNameFor(landmark: string | null | undefined, address: string | null | undefined, fallback = "New stop"): string {
  const fromLandmark = landmark?.trim();
  const fromAddress = address?.split(/[,\n]/).map((p) => p.trim()).find((p) => p.length > 0);
  const name = fromLandmark || fromAddress || fallback;
  return name.length > 60 ? `${name.slice(0, 57).trimEnd()}…` : name;
}

// ---------------------------------------------------------------- one home -> a route

export interface PlanStop extends LatLngPoint { id?: string; name: string; sequence?: number }
/** A route as planning sees it: stops in sequence order, sequence 1 being the school end. */
export interface PlanRoute { id: string; name: string; stops: PlanStop[] }

export type RouteSuggestion =
  | { kind: "join"; routeId: string; routeName: string; stopId: string; stopName: string; distanceM: number }
  | {
      kind: "new_stop"; routeId: string; routeName: string;
      /** The sequence the new stop takes; the stops from there on move down one. */
      position: number;
      stopName: string; lat: number; lng: number;
      /** Extra driving the new stop adds to the route. */
      addedM: number;
      /** How far the nearest existing stop on any route is, for "nearest stop is 1.2 km away". */
      nearestStopM: number | null;
    };

/**
 * Where a learner living at `home` should get on. Joins the nearest existing
 * stop within `walkRadiusM`; failing that, slots a new stop into the route
 * where it adds the least distance. Never before a route's first stop: that's
 * the school end. A route with no stops yet is only chosen when no route has
 * any (it costs the distance from the school when `school` is known).
 */
export function suggestRouteForHome(
  home: LatLngPoint,
  routes: PlanRoute[],
  opts: { walkRadiusM?: number; stopName?: string; school?: LatLngPoint | null } = {},
): RouteSuggestion | null {
  const walk = opts.walkRadiusM ?? WALK_RADIUS_M;
  let nearest: { route: PlanRoute; stop: PlanStop; d: number } | null = null;
  for (const route of routes) {
    for (const stop of route.stops) {
      const d = haversineM(home, stop);
      if (!nearest || d < nearest.d) nearest = { route, stop, d };
    }
  }
  if (nearest && nearest.d <= walk && nearest.stop.id) {
    return { kind: "join", routeId: nearest.route.id, routeName: nearest.route.name, stopId: nearest.stop.id, stopName: nearest.stop.name, distanceM: nearest.d };
  }

  let best: { route: PlanRoute; index: number; cost: number } | null = null;
  for (const route of routes) {
    const ins = cheapestInsertion(route.stops, home, opts.school ?? null);
    if (ins && (!best || ins.cost < best.cost)) best = { route, index: ins.index, cost: ins.cost };
  }
  if (!best) return null;
  const stops = best.route.stops;
  const at = stops[best.index];
  const last = stops[stops.length - 1];
  const position = at ? (at.sequence ?? best.index + 1) : last ? (last.sequence ?? stops.length) + 1 : 1;
  return {
    kind: "new_stop", routeId: best.route.id, routeName: best.route.name, position,
    stopName: opts.stopName ?? "New stop", lat: home.lat, lng: home.lng,
    addedM: stops.length || opts.school ? best.cost : 0, nearestStopM: nearest?.d ?? null,
  };
}

/** Where in `stops` a new point goes (the index it takes) and what it adds. Index 0 is never offered. */
export function cheapestInsertion(stops: LatLngPoint[], p: LatLngPoint, school: LatLngPoint | null = null): { index: number; cost: number } | null {
  if (!stops.length) return { index: 0, cost: school ? haversineM(school, p) : Number.MAX_SAFE_INTEGER / 2 };
  let best: { index: number; cost: number } | null = null;
  for (let i = 1; i <= stops.length; i++) {
    const a = stops[i - 1]!;
    const b = stops[i];
    const cost = b ? haversineM(a, p) + haversineM(p, b) - haversineM(a, b) : haversineM(a, p);
    if (!best || cost < best.cost) best = { index: i, cost };
  }
  return best;
}

// ---------------------------------------------------------------- many homes -> a route's stops

export interface RiderHome extends LatLngPoint { studentId: string; landmark?: string | null; address?: string | null }

export interface PlannedStop extends LatLngPoint {
  /** An existing stop this one keeps (its riders stay on it), when one was this close. */
  id?: string;
  name: string;
  studentIds: string[];
}

/**
 * A fresh stop list for a route from its riders' homes. `anchor` is the school
 * end (the route's current first stop, or the school itself): it's kept as
 * stop 1 with no riders. Existing stops a new one lands on keep their id and
 * name, so saving doesn't take anyone off a stop that's still there.
 */
export function rebuildStopsFromHomes(
  homes: RiderHome[],
  opts: { anchor?: PlanStop | null; existing?: PlanStop[]; clusterRadiusM?: number } = {},
): PlannedStop[] {
  const radius = opts.clusterRadiusM ?? CLUSTER_RADIUS_M;
  const clusters = clusterHomes(homes, radius);
  const existing = (opts.existing ?? []).filter((s) => s.id && s.id !== opts.anchor?.id);
  const used = new Set<string>();

  const planned: PlannedStop[] = clusters.map((c, i) => {
    const centre = centroid(c);
    // the closest unused existing stop, if it's practically the same place
    let match: PlanStop | null = null;
    for (const s of existing) {
      if (used.has(s.id!)) continue;
      const d = haversineM(centre, s);
      if (d <= SAME_STOP_M && (!match || d < haversineM(centre, match))) match = s;
    }
    if (match) used.add(match.id!);
    return {
      ...(match ? { id: match.id, lat: match.lat, lng: match.lng } : { lat: centre.lat, lng: centre.lng }),
      name: match?.name ?? clusterName(c, `Stop ${i + 1}`),
      studentIds: c.map((h) => h.studentId),
    };
  });

  const ordered = orderStops(planned, opts.anchor ?? null);
  return opts.anchor ? [{ id: opts.anchor.id, name: opts.anchor.name, lat: opts.anchor.lat, lng: opts.anchor.lng, studentIds: [] }, ...ordered] : ordered;
}

/**
 * Greedy clustering: each home joins the nearest group whose centre is within
 * `radiusM`, or starts its own; then every home moves to its nearest centre
 * once, so the result doesn't depend much on the order homes came in.
 */
export function clusterHomes<T extends LatLngPoint>(homes: T[], radiusM = CLUSTER_RADIUS_M): T[][] {
  const sorted = [...homes].sort((a, b) => a.lat - b.lat || a.lng - b.lng);
  const groups: { members: T[]; centre: LatLngPoint }[] = [];
  for (const h of sorted) {
    let best: { g: (typeof groups)[number]; d: number } | null = null;
    for (const g of groups) {
      const d = haversineM(g.centre, h);
      if (d <= radiusM && (!best || d < best.d)) best = { g, d };
    }
    if (best) {
      best.g.members.push(h);
      best.g.centre = centroid(best.g.members);
    } else {
      groups.push({ members: [h], centre: { lat: h.lat, lng: h.lng } });
    }
  }
  // one settling pass
  const centres = groups.map((g) => g.centre);
  const settled: T[][] = centres.map(() => []);
  for (const h of sorted) {
    let bi = 0;
    for (let i = 1; i < centres.length; i++) if (haversineM(h, centres[i]!) < haversineM(h, centres[bi]!)) bi = i;
    settled[bi]!.push(h);
  }
  return settled.filter((g) => g.length > 0);
}

export function centroid(points: LatLngPoint[]): LatLngPoint {
  const n = points.length || 1;
  return { lat: points.reduce((s, p) => s + p.lat, 0) / n, lng: points.reduce((s, p) => s + p.lng, 0) / n };
}

/** The landmark (or address) most of a group's homes share, else the first one given. */
function clusterName(group: RiderHome[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const h of group) {
    const n = stopNameFor(h.landmark, h.address, "");
    if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  let best: [string, number] | null = null;
  for (const e of counts) if (!best || e[1] > best[1]) best = e;
  return best?.[0] ?? fallback;
}

/**
 * Stops in driving order. From `start` (the school end) when given, otherwise
 * from the stop furthest from the middle of them all (one end of the line).
 * Nearest neighbour first, then 2-opt until no swap shortens the path.
 */
export function orderStops<T extends LatLngPoint>(stops: T[], start: LatLngPoint | null): T[] {
  if (stops.length < 2) return [...stops];
  const rest = [...stops];
  const path: T[] = [];
  let at: LatLngPoint;
  if (start) {
    at = start;
  } else {
    const mid = centroid(stops);
    let fi = 0;
    for (let i = 1; i < rest.length; i++) if (haversineM(mid, rest[i]!) > haversineM(mid, rest[fi]!)) fi = i;
    at = rest[fi]!;
    path.push(rest.splice(fi, 1)[0]!);
  }
  while (rest.length) {
    let ni = 0;
    for (let i = 1; i < rest.length; i++) if (haversineM(at, rest[i]!) < haversineM(at, rest[ni]!)) ni = i;
    at = rest[ni]!;
    path.push(rest.splice(ni, 1)[0]!);
  }
  return twoOpt(path, start);
}

/** Total length of a path in metres, from `start` when given. */
export function pathLengthM(points: LatLngPoint[], start: LatLngPoint | null = null): number {
  const all = start ? [start, ...points] : points;
  let m = 0;
  for (let i = 1; i < all.length; i++) m += haversineM(all[i - 1]!, all[i]!);
  return m;
}

/** Reverse any stretch of an open path that makes it shorter. The start stays put. */
function twoOpt<T extends LatLngPoint>(path: T[], start: LatLngPoint | null): T[] {
  // With a fixed start outside the list every stop may move; without one, the first stop is the start.
  const pts: LatLngPoint[] = start ? [start, ...path] : [...path];
  const d = (i: number, j: number) => haversineM(pts[i]!, pts[j]!);
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    for (let i = 1; i < pts.length - 1; i++) {
      for (let k = i + 1; k < pts.length; k++) {
        const before = d(i - 1, i) + (k + 1 < pts.length ? d(k, k + 1) : 0);
        const after = d(i - 1, k) + (k + 1 < pts.length ? d(i, k + 1) : 0);
        if (after + 0.01 < before) {
          const seg = pts.slice(i, k + 1).reverse();
          pts.splice(i, seg.length, ...seg);
          improved = true;
        }
      }
    }
  }
  return (start ? pts.slice(1) : pts) as T[];
}

// ---------------------------------------------------------------- database

export interface LearnerHome { lat: number | null; lng: number | null; landmark: string | null; address: string | null }

/** Set a learner's home (admins: any learner; guardians: their own child). Address null leaves it as it is; "" clears it. */
export async function setLearnerHome(studentId: string, home: LearnerHome): Promise<void> {
  const { error } = await supabase().rpc("set_child_home", {
    p_student_id: studentId, p_lat: home.lat, p_lng: home.lng, p_landmark: home.landmark, p_address: home.address,
  });
  if (error) throw error;
}

/** Every route with its stops in order: what suggestRouteForHome plans against. */
export async function listRoutesWithStops(tenantId: string): Promise<(PlanRoute & { stops: (PlanStop & { id: string; sequence: number })[] })[]> {
  const { data, error } = await supabase().from("routes")
    .select("id, name, active, route_stops(id, name, lat, lng, sequence)")
    .eq("tenant_id", tenantId).order("name")
    .returns<{ id: string; name: string; active: boolean; route_stops: RouteStop[] }[]>();
  if (error) throw error;
  return (data ?? []).filter((r) => r.active).map((r) => ({
    id: r.id, name: r.name,
    stops: [...r.route_stops].sort((a, b) => a.sequence - b.sequence).map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng, sequence: s.sequence })),
  }));
}

/** suggestRouteForHome against this school's routes as they are now. */
export async function suggestRouteForLearnerHome(tenantId: string, home: LatLngPoint, stopName?: string): Promise<RouteSuggestion | null> {
  return suggestRouteForHome(home, await listRoutesWithStops(tenantId), { stopName });
}

/**
 * Put a learner on a route: at an existing stop, at a new stop slotted into
 * the route, or (routeId null) off the bus. Returns their stop id.
 */
export async function assignStudentToRoute(input: {
  studentId: string;
  routeId: string | null;
  stopId?: string | null;
  newStop?: { name: string; lat: number; lng: number; position: number } | null;
}): Promise<string | null> {
  const { data, error } = await supabase().rpc("assign_learner_bus", {
    p_student_id: input.studentId, p_route_id: input.routeId,
    p_stop_id: input.stopId ?? null, p_new_stop: input.newStop ?? null,
  });
  if (error) throw error;
  return (data as string | null) ?? null;
}

/** Act on a suggestion: join its stop, or add its new stop and join that. */
export async function applyRouteSuggestion(studentId: string, s: RouteSuggestion): Promise<string | null> {
  return s.kind === "join"
    ? assignStudentToRoute({ studentId, routeId: s.routeId, stopId: s.stopId })
    : assignStudentToRoute({ studentId, routeId: s.routeId, newStop: { name: s.stopName, lat: s.lat, lng: s.lng, position: s.position } });
}

/** "Joins Route B at Kahawa stop (250 m)" / "New stop on Route B: Kahawa (adds 1.2 km)" */
export function describeSuggestion(s: RouteSuggestion): string {
  const m = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(x / 10) * 10)} m`);
  return s.kind === "join"
    ? `Joins ${s.routeName} at ${s.stopName} (${m(s.distanceM)} away)`
    : `New stop on ${s.routeName}: ${s.stopName} (adds about ${m(s.addedM)} to the route)`;
}

export interface RouteRider {
  studentId: string;
  fullName: string;
  /** Their photo, if the school has added one. */
  avatarUrl?: string | null;
  stopId: string | null;
  home: (LatLngPoint & { landmark: string | null; address: string | null }) | null;
  /** home_landmark/home_address without a pin: needs placing on the map before it can plan anything */
  addressOnly: string | null;
}

/** Who rides a route, with their homes. Active learners only. */
export async function listRouteRiders(routeId: string): Promise<RouteRider[]> {
  const { data, error } = await supabase().from("student_transport")
    .select("student_id, stop_id, student:students(full_name, avatar_url, active, home_lat, home_lng, home_landmark, home_address)")
    .eq("route_id", routeId)
    .returns<{ student_id: string; stop_id: string | null; student: { full_name: string; avatar_url: string | null; active: boolean; home_lat: number | null; home_lng: number | null; home_landmark: string | null; home_address: string | null } | null }[]>();
  if (error) throw error;
  return (data ?? []).filter((r) => r.student?.active).map((r) => {
    const s = r.student!;
    const hasPin = s.home_lat != null && s.home_lng != null;
    return {
      studentId: r.student_id, fullName: s.full_name, avatarUrl: s.avatar_url, stopId: r.stop_id,
      home: hasPin ? { lat: s.home_lat!, lng: s.home_lng!, landmark: s.home_landmark, address: s.home_address } : null,
      addressOnly: !hasPin ? (s.home_address ?? s.home_landmark) : null,
    };
  }).sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/**
 * Save a rebuilt stop list and put each rider on their stop. Stops are saved
 * in place by id (replaceRouteStops), so riders with no home pin keep their
 * stop if it's still on the route.
 */
export async function saveRebuiltStops(routeId: string, planned: PlannedStop[]): Promise<void> {
  await replaceRouteStops("", routeId, planned);
  const saved = await supabase().from("route_stops").select("id, sequence").eq("route_id", routeId).order("sequence")
    .returns<{ id: string; sequence: number }[]>();
  if (saved.error) throw saved.error;
  const ids = (saved.data ?? []).map((s) => s.id);
  for (let i = 0; i < planned.length; i++) {
    const stopId = ids[i];
    const riders = planned[i]!.studentIds;
    if (!stopId || !riders.length) continue;
    const { error } = await supabase().from("student_transport").update({ stop_id: stopId }).eq("route_id", routeId).in("student_id", riders);
    if (error) throw error;
  }
}
