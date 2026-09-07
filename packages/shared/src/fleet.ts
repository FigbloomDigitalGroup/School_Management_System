import { supabase } from "./supabase";
import type { Route, RouteStop, Trip, TripDirection, Vehicle, VehicleAlert, VehicleAssignment } from "./types";

/**
 * Fleet tracking, phase 1 (see supabase/migrations/20260903000003_fleet.sql
 * for the schema/RLS this sits on top of). A driver's phone reports location
 * through a plain browser page — it only reports while that page is open and
 * in the foreground, there is no background/native tracking.
 */

// ---------------------------------------------------------------- vehicles

export async function listVehicles(): Promise<Vehicle[]> {
  const { data, error } = await supabase().from("vehicles").select("*").order("plate_number");
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

export async function listRoutes(): Promise<Route[]> {
  const { data, error } = await supabase().from("routes").select("*").order("name");
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

export async function listDrivers(): Promise<DriverOption[]> {
  const { data, error } = await supabase().from("profiles").select("id, full_name").eq("role", "driver").order("full_name");
  if (error) throw error;
  return (data ?? []) as DriverOption[];
}

export interface AssignmentRow extends VehicleAssignment {
  vehicle: Pick<Vehicle, "plate_number"> | null;
  driver: DriverOption | null;
  route: Pick<Route, "name"> | null;
}

export async function listAssignments(): Promise<AssignmentRow[]> {
  const { data, error } = await supabase()
    .from("vehicle_assignments")
    .select("*, vehicle:vehicles(plate_number), driver:profiles(id, full_name), route:routes(name)")
    .eq("active", true);
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
}

// ---------------------------------------------------------------- family view

/** The route+driver+vehicle+the child's own stop, via student_transport — null if not on a route. */
export async function myChildBus(studentId: string): Promise<{
  routeName: string; driverName: string | null; vehicle: Vehicle | null;
  stop: { name: string; lat: number; lng: number } | null;
} | null> {
  const { data: link, error: linkErr } = await supabase()
    .from("student_transport")
    .select("route_id, stop_id, routes(name), route_stops(name, lat, lng)")
    .eq("student_id", studentId)
    .maybeSingle<{ route_id: string; stop_id: string | null; routes: { name: string } | null; route_stops: { name: string; lat: number; lng: number } | null }>();
  if (linkErr) throw linkErr;
  if (!link) return null;

  const { data: assignment } = await supabase()
    .from("vehicle_assignments")
    .select("vehicle:vehicles(*), driver:profiles(full_name)")
    .eq("route_id", link.route_id).eq("active", true)
    .maybeSingle<{ vehicle: Vehicle | null; driver: { full_name: string } | null }>();

  return {
    routeName: link.routes?.name ?? "Route",
    driverName: assignment?.driver?.full_name ?? null,
    vehicle: assignment?.vehicle ?? null,
    stop: link.route_stops,
  };
}

// ---------------------------------------------------------------- alerts (phase 5)

export interface AlertRow extends VehicleAlert {
  vehicle: Pick<Vehicle, "plate_number"> | null;
}

/** Speeding or off-route alerts raised by the vehicle_locations trigger — see the fleet_alerts migration. */
export async function listAlerts(onlyOpen = true): Promise<AlertRow[]> {
  let query = supabase().from("vehicle_alerts").select("*, vehicle:vehicles(plate_number)").order("created_at", { ascending: false });
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
export async function listTrips(vehicleId?: string, limitTo = 50): Promise<TripRow[]> {
  let query = supabase()
    .from("trips")
    .select("*, vehicle:vehicles(plate_number), driver:profiles(full_name), route:routes(name)")
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
