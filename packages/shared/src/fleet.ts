import { supabase } from "./supabase";
import type { Route, RouteStop, Trip, TripDirection, Vehicle, VehicleAlert, VehicleAssignment } from "./types";

/**
 * Fleet tracking, phase 1 (see supabase/migrations/20260903000003_fleet.sql
 * for the schema/RLS this sits on top of). A driver's phone reports location
 * through a plain browser page — it only reports while that page is open and
 * in the foreground, there is no background/native tracking.
 */

// ---------------------------------------------------------------- vehicles

export async function listVehicles(tenantId: string): Promise<Vehicle[]> {
  const { data, error } = await supabase().from("vehicles").select("*").eq("tenant_id", tenantId).order("plate_number");
  if (error) throw error;
  return (data ?? []) as Vehicle[];
}

/**
 * Live position updates for every vehicle in the caller's tenant, via
 * Supabase Realtime (see supabase/migrations/20260903000006_fleet_realtime.sql
 * — `vehicles` is the only table added to the realtime publication).
 * Realtime enforces the same `vehicles_read` RLS policy per subscriber, so
 * this never needs its own access check. Returns an unsubscribe function —
 * call it on unmount.
 */
export function subscribeVehiclePositions(tenantId: string, onUpdate: (vehicle: Vehicle) => void): () => void {
  const channel = supabase()
    .channel(`fleet-positions-${tenantId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "vehicles", filter: `tenant_id=eq.${tenantId}` },
      (payload) => onUpdate(payload.new as Vehicle),
    )
    .subscribe();
  return () => { void supabase().removeChannel(channel); };
}

export async function createVehicle(input: {
  tenantId: string; plateNumber: string; makeModel?: string; capacity?: number;
}): Promise<Vehicle> {
  const { data, error } = await supabase().from("vehicles").insert({
    tenant_id: input.tenantId, plate_number: input.plateNumber,
    make_model: input.makeModel ?? null, capacity: input.capacity ?? null,
  }).select("*").single<Vehicle>();
  if (error) throw error;
  return data;
}

export async function setVehicleActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase().from("vehicles").update({ active }).eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------- routes + stops

export async function listRoutes(tenantId: string): Promise<Route[]> {
  const { data, error } = await supabase().from("routes").select("*").eq("tenant_id", tenantId).order("name");
  if (error) throw error;
  return (data ?? []) as Route[];
}

export async function createRoute(input: { tenantId: string; name: string; description?: string }): Promise<Route> {
  const { data, error } = await supabase().from("routes").insert({
    tenant_id: input.tenantId, name: input.name, description: input.description ?? null,
  }).select("*").single<Route>();
  if (error) throw error;
  return data;
}

export async function listRouteStops(routeId: string): Promise<RouteStop[]> {
  const { data, error } = await supabase().from("route_stops").select("*").eq("route_id", routeId).order("sequence");
  if (error) throw error;
  return (data ?? []) as RouteStop[];
}

/** Replaces every stop on a route with this new ordered list — simplest correct model for a short stop list. */
export async function replaceRouteStops(
  tenantId: string,
  routeId: string,
  stops: { name: string; lat: number; lng: number }[],
): Promise<void> {
  const { error: delErr } = await supabase().from("route_stops").delete().eq("route_id", routeId);
  if (delErr) throw delErr;
  if (!stops.length) return;
  const { error } = await supabase().from("route_stops").insert(
    stops.map((s, i) => ({ tenant_id: tenantId, route_id: routeId, name: s.name, lat: s.lat, lng: s.lng, sequence: i + 1 })),
  );
  if (error) throw error;
}

// ---------------------------------------------------------------- drivers + assignments

export interface DriverOption { id: string; full_name: string }

export async function listDrivers(tenantId: string): Promise<DriverOption[]> {
  const { data, error } = await supabase().from("profiles").select("id, full_name").eq("tenant_id", tenantId).eq("role", "driver").order("full_name");
  if (error) throw error;
  return (data ?? []) as DriverOption[];
}

export interface AssignmentRow extends VehicleAssignment {
  vehicle: Pick<Vehicle, "plate_number"> | null;
  driver: DriverOption | null;
  route: Pick<Route, "name"> | null;
}

export async function listAssignments(tenantId: string): Promise<AssignmentRow[]> {
  const { data, error } = await supabase()
    .from("vehicle_assignments")
    .select("*, vehicle:vehicles(plate_number), driver:profiles(id, full_name), route:routes(name)")
    .eq("tenant_id", tenantId).eq("active", true);
  if (error) throw error;
  return (data ?? []) as unknown as AssignmentRow[];
}

/** A vehicle may have only one active assignment (enforced by a DB constraint) — this replaces it. */
export async function assignDriver(input: {
  tenantId: string; vehicleId: string; driverId: string; routeId: string | null;
}): Promise<void> {
  const { error: deactivateErr } = await supabase()
    .from("vehicle_assignments").update({ active: false }).eq("vehicle_id", input.vehicleId).eq("active", true);
  if (deactivateErr) throw deactivateErr;
  const { error } = await supabase().from("vehicle_assignments").insert({
    tenant_id: input.tenantId, vehicle_id: input.vehicleId, driver_id: input.driverId, route_id: input.routeId,
  });
  if (error) throw error;
}

// ---------------------------------------------------------------- driver trip lifecycle

/** The vehicle+route a signed-in driver is currently assigned to, if any. */
export async function myAssignment(driverId: string): Promise<AssignmentRow | null> {
  const { data, error } = await supabase()
    .from("vehicle_assignments")
    .select("*, vehicle:vehicles(plate_number), driver:profiles(id, full_name), route:routes(name)")
    .eq("driver_id", driverId).eq("active", true).maybeSingle();
  if (error) throw error;
  return data as unknown as AssignmentRow | null;
}

export async function myActiveTrip(driverId: string): Promise<Trip | null> {
  const { data, error } = await supabase().from("trips").select("*").eq("driver_id", driverId).eq("status", "active").maybeSingle<Trip>();
  if (error) throw error;
  return data;
}

export async function startTrip(input: {
  tenantId: string; vehicleId: string; routeId: string | null; driverId: string; direction: TripDirection;
}): Promise<Trip> {
  const { data, error } = await supabase().from("trips").insert({
    tenant_id: input.tenantId, vehicle_id: input.vehicleId, route_id: input.routeId,
    driver_id: input.driverId, direction: input.direction,
  }).select("*").single<Trip>();
  if (error) throw error;
  return data;
}

export async function endTrip(tripId: string): Promise<void> {
  const { error } = await supabase().from("trips").update({ status: "completed", ended_at: new Date().toISOString() }).eq("id", tripId);
  if (error) throw error;
}

export interface LocationPingInput {
  tenantId: string; vehicleId: string; tripId: string; lat: number; lng: number; speedKmh?: number; heading?: number;
}

/** The exact `vehicle_locations` row shape — shared with the offline queue (lib/queue.ts) so a
 *  ping written while offline lands in the same shape as one sent live. */
export function locationPingRow(input: LocationPingInput) {
  return {
    tenant_id: input.tenantId, vehicle_id: input.vehicleId, trip_id: input.tripId,
    lat: input.lat, lng: input.lng, speed_kmh: input.speedKmh ?? null, heading: input.heading ?? null,
  };
}

/** One GPS reading: recorded to history and mirrored onto vehicles.last_lat/last_lng for a cheap "where is it now" read. */
export async function pingLocation(input: LocationPingInput): Promise<void> {
  const { error: insertErr } = await supabase().from("vehicle_locations").insert(locationPingRow(input));
  if (insertErr) throw insertErr;
  const { error: updateErr } = await supabase().from("vehicles").update({
    last_lat: input.lat, last_lng: input.lng, last_ping_at: new Date().toISOString(),
  }).eq("id", input.vehicleId);
  if (updateErr) throw updateErr;
  // Families' "1 km away" / "running late" updates are worked out server-side
  // from this new position (supabase/functions/bus-tick). Fire and forget: a
  // missed tick only delays an update to the next ping, never the ping itself.
  void supabase().functions.invoke("bus-tick", { body: { trip_id: input.tripId } }).catch(() => {});
}

// ---------------------------------------------------------------- bus updates

/** One update a family gets about their child's bus (see 20261007020000_bus_updates.sql). */
export interface BusUpdate {
  id: string;
  trip_id: string;
  vehicle_id: string;
  stop_id: string;
  student_ids: string[];
  kind: "trip_started" | "distance" | "arrived" | "delay";
  /** Starts "Bus ...", so it reads as "Amani's bus ..." with personaliseBusTitle. */
  title: string;
  body: string;
  distance_m: number | null;
  eta_at: string | null;
  created_at: string;
}

/** Today's updates for these children, newest first. RLS limits a family to their own. */
export async function listBusUpdates(studentIds: string[], since: Date): Promise<BusUpdate[]> {
  if (!studentIds.length) return [];
  const { data, error } = await supabase().from("bus_updates").select("*")
    .overlaps("student_ids", studentIds).gte("created_at", since.toISOString())
    .order("created_at", { ascending: false }).limit(50).returns<BusUpdate[]>();
  if (error) throw error;
  return data ?? [];
}

/** New updates as they're written. Realtime applies the same RLS, so only the family's own arrive. */
export function subscribeBusUpdates(tenantId: string, onInsert: (u: BusUpdate) => void): () => void {
  const channel = supabase()
    .channel(`bus-updates-${tenantId}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "bus_updates", filter: `tenant_id=eq.${tenantId}` },
      (payload) => onInsert(payload.new as BusUpdate),
    )
    .subscribe();
  return () => { void supabase().removeChannel(channel); };
}

/** "Bus is 1 km away" -> "Amani's bus is 1 km away" (bus-tick's personalise, client side). */
export function personaliseBusTitle(title: string, names: string[]): string {
  if (!names.length) return title;
  const who = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return title.replace(/^Bus\b/, `${who}'s bus`);
}

// ---------------------------------------------------------------- live route maps

/** One bus as the live maps draw it: where it is, who drives it, and its route's stops in order. */
export interface BusOnRoute {
  vehicle: Vehicle;
  driverName: string | null;
  /** Who's driving, as a family may see them: name, photo, title. Never contact details. */
  driver: DriverProfile | null;
  route: { id: string; name: string } | null;
  /** Ordered by sequence; empty when the bus has no route. */
  stops: RouteStop[];
  /** The running trip's direction, when one is running and the viewer may see it. */
  direction: TripDirection | null;
}

export interface DriverProfile { id: string; name: string; avatarUrl: string | null; title: string | null }

/**
 * Drivers by id, for anyone in the school -- via driver_profiles() (see
 * 20261007000000_driver_profiles.sql), since parents and students can't read a
 * driver's profile row directly. Name, photo and title only.
 */
async function driverProfiles(ids: string[]): Promise<Map<string, DriverProfile>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const { data, error } = await supabase().rpc("driver_profiles", { driver_ids: unique });
  if (error) throw error;
  const rows = (data ?? []) as { id: string; full_name: string; avatar_url: string | null; staff_title: string | null }[];
  return new Map(rows.map((d) => [d.id, { id: d.id, name: d.full_name, avatarUrl: d.avatar_url, title: d.staff_title }]));
}

/**
 * Active trips' directions by vehicle — RLS limits a family to their own
 * child's route. trips isn't in the realtime publication, so live maps poll
 * this to notice a bus turning round.
 */
export async function activeDirections(): Promise<Map<string, TripDirection>> {
  const { data } = await supabase().from("trips").select("vehicle_id, direction").eq("status", "active")
    .returns<{ vehicle_id: string; direction: TripDirection }[]>();
  return new Map((data ?? []).map((t) => [t.vehicle_id, t.direction]));
}

/**
 * Stops in the order the bus will reach them. Sequence 1 is the school end of
 * a route (see the seeds), so a trip from school runs in sequence order and a
 * trip to school runs it backwards. Unknown direction: sequence order.
 */
export function stopsInTravelOrder<T extends { sequence: number }>(stops: T[], direction: TripDirection | null): T[] {
  const sorted = [...stops].sort((a, b) => a.sequence - b.sequence);
  return direction === "to_school" ? sorted.reverse() : sorted;
}

/** Every active vehicle in the school with its current assignment — the admin and teacher fleet maps. */
export async function listBusesOnRoutes(tenantId: string): Promise<BusOnRoute[]> {
  const [vehicles, directions, { data: assignments, error }] = await Promise.all([
    listVehicles(tenantId),
    activeDirections(),
    supabase()
      .from("vehicle_assignments")
      .select("vehicle_id, driver_id, route:routes(id, name, route_stops(*))")
      .eq("tenant_id", tenantId).eq("active", true)
      .returns<{ vehicle_id: string; driver_id: string; route: { id: string; name: string; route_stops: RouteStop[] } | null }[]>(),
  ]);
  if (error) throw error;
  const drivers = await driverProfiles((assignments ?? []).map((a) => a.driver_id));
  const byVehicle = new Map((assignments ?? []).map((a) => [a.vehicle_id, a]));
  return vehicles.filter((v) => v.active).map((vehicle) => {
    const a = byVehicle.get(vehicle.id);
    return {
      vehicle,
      driverName: (a && drivers.get(a.driver_id)?.name) ?? null,
      driver: (a && drivers.get(a.driver_id)) ?? null,
      route: a?.route ? { id: a.route.id, name: a.route.name } : null,
      stops: [...(a?.route?.route_stops ?? [])].sort((x, y) => x.sequence - y.sequence),
      direction: directions.get(vehicle.id) ?? null,
    };
  });
}

/** Metres between two points (haversine) — good to a few metres at bus-route scale. */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Within this many metres of a stop counts as being at it. */
export const AT_STOP_M = 150;

/** Further than this from every stop is off route -- the same 1500m the off-route alert trigger uses. */
export const OFF_ROUTE_M = 1500;

/**
 * Where a bus is along its ordered stops, from position alone: the stop it's
 * at (within AT_STOP_M) or the one it's heading to. A bus between stops i and
 * i+1 is closer to i+1 than i is, which is what decides "passed i". Only
 * discrete stops are stored (no path), so this is a good guess, not a fact.
 */
export function routeProgress(
  stops: { lat: number; lng: number }[],
  pos: { lat: number; lng: number },
): { atIndex: number | null; nextIndex: number | null; offRouteM: number | null } {
  if (!stops.length) return { atIndex: null, nextIndex: null, offRouteM: null };
  let c = 0;
  for (let i = 1; i < stops.length; i++) if (distanceM(pos, stops[i]!) < distanceM(pos, stops[c]!)) c = i;
  const nearest = distanceM(pos, stops[c]!);
  // Nowhere near the route (still at the depot, or a detour): head for its first stop.
  if (nearest > OFF_ROUTE_M) return { atIndex: null, nextIndex: 0, offRouteM: nearest };
  if (nearest <= AT_STOP_M) {
    return { atIndex: c, nextIndex: c + 1 < stops.length ? c + 1 : null, offRouteM: null };
  }
  const next = stops[c + 1];
  const passed = next != null && distanceM(pos, next) < distanceM(stops[c]!, next);
  return { atIndex: null, nextIndex: passed ? c + 1 : c, offRouteM: null };
}

/** "2.4 km" / "800 m" */
export function fmtDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10_000 ? 0 : 1)} km` : `${Math.round(m / 50) * 50} m`;
}

/** A position this recent means the bus is on the road right now. */
export const LIVE_WITHIN_MS = 2 * 60_000;

export function isLive(lastPingAt: string | null, now = Date.now()): boolean {
  return lastPingAt != null && now - new Date(lastPingAt).getTime() <= LIVE_WITHIN_MS;
}

// ---------------------------------------------------------------- family view

/** The child's bus (as a BusOnRoute) and their own stop, via student_transport — null if not on a route. */
export async function myChildBus(studentId: string): Promise<{
  routeName: string; driverName: string | null; vehicle: Vehicle | null;
  stop: { id: string; name: string; lat: number; lng: number } | null;
  bus: BusOnRoute | null;
} | null> {
  const { data: link, error: linkErr } = await supabase()
    .from("student_transport")
    .select("route_id, stop_id, routes(name), route_stops(id, name, lat, lng)")
    .eq("student_id", studentId)
    .maybeSingle<{ route_id: string; stop_id: string | null; routes: { name: string } | null; route_stops: { id: string; name: string; lat: number; lng: number } | null }>();
  if (linkErr) throw linkErr;
  if (!link) return null;

  const [{ data: assignments }, stops, directions] = await Promise.all([
    supabase()
      .from("vehicle_assignments")
      .select("driver_id, vehicle:vehicles(*)")
      .eq("route_id", link.route_id).eq("active", true)
      .returns<{ driver_id: string; vehicle: Vehicle | null }[]>(),
    listRouteStops(link.route_id),
    activeDirections(),
  ]);

  const routeName = link.routes?.name ?? "Route";
  // A route can have more than one bus on it (a big route, a spare): follow the one most recently on the road.
  const assignment = [...(assignments ?? [])].sort((a, b) =>
    (b.vehicle?.last_ping_at ?? "").localeCompare(a.vehicle?.last_ping_at ?? ""))[0];
  const vehicle = assignment?.vehicle ?? null;
  const driver = assignment ? ((await driverProfiles([assignment.driver_id])).get(assignment.driver_id) ?? null) : null;
  const driverName = driver?.name ?? null;
  return {
    routeName, driverName, vehicle,
    stop: link.route_stops,
    bus: vehicle
      ? { vehicle, driverName, driver, route: { id: link.route_id, name: routeName }, stops, direction: directions.get(vehicle.id) ?? null }
      : null,
  };
}

// ---------------------------------------------------------------- alerts (phase 5)

export interface AlertRow extends VehicleAlert {
  vehicle: Pick<Vehicle, "plate_number"> | null;
}

/** Speeding or off-route alerts raised by the vehicle_locations trigger — see the fleet_alerts migration. */
export async function listAlerts(tenantId: string, onlyOpen = true): Promise<AlertRow[]> {
  let query = supabase().from("vehicle_alerts").select("*, vehicle:vehicles(plate_number)").eq("tenant_id", tenantId).order("created_at", { ascending: false });
  if (onlyOpen) query = query.is("acknowledged_at", null);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as AlertRow[];
}

export async function acknowledgeAlert(alertId: string, byProfileId: string): Promise<void> {
  const { error } = await supabase()
    .from("vehicle_alerts")
    .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: byProfileId })
    .eq("id", alertId);
  if (error) throw error;
}

export function subscribeVehicleAlerts(tenantId: string, onInsert: (alert: VehicleAlert) => void): () => void {
  const channel = supabase()
    .channel(`fleet-alerts-${tenantId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "vehicle_alerts", filter: `tenant_id=eq.${tenantId}` },
      (payload) => onInsert(payload.new as VehicleAlert),
    )
    .subscribe();
  return () => { void supabase().removeChannel(channel); };
}

// ---------------------------------------------------------------- trip history / replay

export interface TripRow extends Trip {
  vehicle: Pick<Vehicle, "plate_number"> | null;
  driver: Pick<DriverOption, "full_name"> | null;
  route: Pick<Route, "name"> | null;
}

/** Most recent trips first, across the whole fleet or just one vehicle. */
export async function listTrips(tenantId: string, vehicleId?: string, limitTo = 50): Promise<TripRow[]> {
  let query = supabase()
    .from("trips")
    .select("*, vehicle:vehicles(plate_number), driver:profiles(full_name), route:routes(name)")
    .eq("tenant_id", tenantId)
    .order("started_at", { ascending: false })
    .limit(limitTo);
  if (vehicleId) query = query.eq("vehicle_id", vehicleId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as TripRow[];
}

export interface TripPoint { lat: number; lng: number; speed_kmh: number | null; recorded_at: string }

/** The recorded path for one trip, oldest first — what a replay scrubs across. */
export async function fetchTripPath(tripId: string): Promise<TripPoint[]> {
  const { data, error } = await supabase()
    .from("vehicle_locations").select("lat,lng,speed_kmh,recorded_at").eq("trip_id", tripId)
    .order("recorded_at", { ascending: true }).returns<TripPoint[]>();
  if (error) throw error;
  return data ?? [];
}
