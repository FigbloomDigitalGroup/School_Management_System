import { NotOnApiError } from "../capabilities";
import type {
  AlertRow, AssignmentRow, BusOnRoute, DriverOption, DriverProfile, LocationPingInput, RiderMarkInput, RiderStatus, TripPoint, TripRider, TripRow,
} from "../fleet";
import type { Route, Trip, TripDirection, TripStatus, Vehicle, VehicleAlert } from "../types";
import { apiClient } from "./client";
import { staffDirectory } from "./directoryApi";
import { isApiError } from "./errors";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import { activeTenantId } from "./peopleApi";
import { POLL_MS, startPolling } from "./poll";
import { settlePool } from "./pool";
import type { components } from "./schema";

/**
 * Buses, fleet and the driver's trip on apps/api: the API side of fleet.ts.
 *
 * What the API has: vehicles and routes (list and add), stops (add only), an assignment of a driver to a vehicle (make only),
 * trips (list; start, finish and cancel; events; a driver's own start, position and finish), a vehicle's recorded positions,
 * incidents of a trip, and a guardian's own `me/transport`. What it does not have, and so what this file cannot give the screens
 * (each is a flag in `fleetCapabilities()` or a `NotOnApiError`):
 *  - a read of a route's stops, so no stops on the maps and no stop editor; the driver's list of children carries the stop
 *    names of the trip's manifest and nothing else;
 *  - a read of who drives which vehicle (the office sees it only for a bus on a trip: the trip names its driver and route);
 *  - a vehicle's last position in the vehicle list (it is one read per vehicle: `GET /vehicles/{id}/locations`);
 *  - speeding and off-route alerts; a breakdown is an `incident` on the trip, which the office reads trip by trip;
 *  - a way to take a trip event back (a child marked on the bus stays on it), and a time for an event (the server stamps it).
 *
 * Several answers are untyped in the OpenAPI file (`additionalProperties: true`), so they are read defensively here
 * (docs/WEB_ON_THE_NEW_API.md, finding 35).
 */

type ApiVehicle = components["schemas"]["Vehicle"];
type ApiRoute = components["schemas"]["TransportRoute"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

// ---------------------------------------------------------------- vehicles and routes

export function vehicleFromApi(v: ApiVehicle): Vehicle {
  // The vehicle list carries no position: it is read per vehicle (apiLatestLocation) where a screen needs it.
  return {
    id: v.id, tenant_id: v.tenant_id, plate_number: v.plate_number, make_model: v.make_model ?? null, capacity: v.capacity ?? null,
    active: v.active, last_lat: null, last_lng: null, last_ping_at: null, created_at: v.created_at,
  };
}

export function routeFromApi(r: ApiRoute): Route {
  return { id: r.id, tenant_id: r.tenant_id, name: r.name, description: r.description || null, active: r.active };
}

/** The school's active vehicles (the API lists no inactive one). */
export async function apiListVehicles(tenantId: string): Promise<Vehicle[]> {
  const list = await listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/vehicles", { path: { tenantId }, query: { limit: API_PAGE_LIMIT, cursor }, tenantId });
    return { items: r.vehicles, page: r.page };
  });
  return list.map(vehicleFromApi);
}

export async function apiCreateVehicle(input: { tenantId: string; plateNumber: string; makeModel?: string; capacity?: number }): Promise<Vehicle> {
  const r = await apiClient().post("/v1/tenants/{tenantId}/vehicles", {
    path: { tenantId: input.tenantId },
    body: { plate_number: input.plateNumber, make_model: input.makeModel ?? null, capacity: input.capacity ?? null },
    tenantId: input.tenantId,
  });
  return vehicleFromApi(r.vehicle);
}

export async function apiListRoutes(tenantId: string): Promise<Route[]> {
  const list = await listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/transport-routes", { path: { tenantId }, query: { limit: API_PAGE_LIMIT, cursor }, tenantId });
    return { items: r.routes, page: r.page };
  });
  return list.map(routeFromApi);
}

export async function apiCreateRoute(input: { tenantId: string; name: string; description?: string }): Promise<Route> {
  const r = await apiClient().post("/v1/tenants/{tenantId}/transport-routes", {
    path: { tenantId: input.tenantId },
    body: { name: input.name, ...(input.description ? { description: input.description } : {}) },
    tenantId: input.tenantId,
  });
  return routeFromApi(r.route);
}

/** The school's drivers who have an account, from the staff directory. Empty for a person who may not read it (finding 36). */
export async function apiListDrivers(tenantId: string): Promise<DriverOption[]> {
  const directory = await staffDirectory(tenantId);
  if (!directory) return [];
  return [...directory.values()]
    .filter((p) => p.role === "driver" && p.active)
    .map((p) => ({ id: p.userId, full_name: p.name }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

/** Puts a driver on a vehicle; the vehicle's earlier assignment ends. */
export async function apiAssignDriver(input: { tenantId: string; vehicleId: string; driverId: string; routeId: string | null }): Promise<void> {
  await apiClient().post("/v1/tenants/{tenantId}/vehicles/{vehicleId}/assignments", {
    path: { tenantId: input.tenantId, vehicleId: input.vehicleId },
    body: { driver_user_id: input.driverId, route_id: input.routeId },
    tenantId: input.tenantId,
  });
}

// ---------------------------------------------------------------- trips

const DIRECTIONS: readonly TripDirection[] = ["to_school", "from_school"];
const STATUSES: readonly TripStatus[] = ["active", "completed", "cancelled"];

/** A trip as the API answers it (`GET /trips`, a trip's detail) in the shape the screens use. A row without an id is dropped. */
export function tripFromApi(raw: unknown, tenantId: string, driverId?: string | null): Trip | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const vehicleId = str(raw.vehicle_id);
  if (!id || !vehicleId) return null;
  const direction = DIRECTIONS.find((d) => d === raw.direction) ?? "to_school";
  const status = STATUSES.find((s) => s === raw.status) ?? "active";
  return {
    id, tenant_id: str(raw.tenant_id) ?? tenantId, vehicle_id: vehicleId, route_id: str(raw.route_id), driver_id: str(raw.driver_user_id) ?? driverId ?? "",
    direction, status, started_at: str(raw.started_at) ?? new Date().toISOString(), ended_at: str(raw.ended_at),
  };
}

interface TripsPage { trips: Trip[]; next: string | null }

async function readTripsPage(tenantId: string, q: { status?: TripStatus; limit: number; cursor?: string }): Promise<TripsPage> {
  const r = await apiClient().get("/v1/tenants/{tenantId}/trips", {
    path: { tenantId }, query: { limit: q.limit, cursor: q.cursor, status: q.status }, tenantId,
  });
  const trips = rows((r as Record<string, unknown>).trips).map((t) => tripFromApi(t, tenantId)).filter((t): t is Trip => t !== null);
  return { trips, next: r.page?.next_cursor ?? null };
}

/** The trips on the road now. */
export async function apiListActiveTrips(tenantId: string): Promise<Trip[]> {
  const all: Trip[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await readTripsPage(tenantId, { status: "active", limit: API_PAGE_LIMIT, cursor });
    all.push(...page.trips);
    if (!page.next) break;
    cursor = page.next;
  }
  return all;
}

/** Active trips' directions by vehicle (the live maps ask every 15 s to notice a bus turning round). */
export async function apiActiveDirections(): Promise<Map<string, TripDirection>> {
  const trips = await apiListActiveTrips(activeTenantId());
  return new Map(trips.map((t) => [t.vehicle_id, t.direction]));
}

/**
 * The newest trips with the plate, driver and route named. The API cannot filter by vehicle, so a vehicle's history is read
 * page by page (up to 5 pages) and filtered here. Driver names need the staff list; without it the column shows "—".
 */
export async function apiListTrips(tenantId: string, vehicleId: string | undefined, limitTo: number): Promise<TripRow[]> {
  const picked: Trip[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < (vehicleId ? 5 : 1) && picked.length < limitTo; i++) {
    const page = await readTripsPage(tenantId, { limit: vehicleId ? API_PAGE_LIMIT : Math.min(limitTo, API_PAGE_LIMIT), cursor });
    picked.push(...(vehicleId ? page.trips.filter((t) => t.vehicle_id === vehicleId) : page.trips));
    if (!page.next) break;
    cursor = page.next;
  }
  const [vehicles, routes, directory] = await Promise.all([apiListVehicles(tenantId), apiListRoutes(tenantId), staffDirectory(tenantId)]);
  return picked.slice(0, limitTo).map((t) => {
    const plate = vehicles.find((v) => v.id === t.vehicle_id)?.plate_number;
    const route = routes.find((r) => r.id === t.route_id)?.name;
    const driver = directory?.get(t.driver_id)?.name;
    return { ...t, vehicle: plate ? { plate_number: plate } : null, driver: driver ? { full_name: driver } : null, route: route ? { name: route } : null, alertCount: 0 };
  });
}

// ---------------------------------------------------------------- the office's live view

interface Fix { lat: number; lng: number; recorded_at: string; trip_id: string | null; speed_kmh: number | null }

/** A recorded position as `GET .../locations` answers it (the OpenAPI file leaves the items untyped); null when it has no point or no time. */
export function fixFromApi(raw: unknown): Fix | null {
  if (!isRecord(raw)) return null;
  const lat = num(raw.lat);
  const lng = num(raw.lng);
  const at = str(raw.recorded_at);
  return lat !== null && lng !== null && at ? { lat, lng, recorded_at: at, trip_id: str(raw.trip_id), speed_kmh: num(raw.speed_kmh) } : null;
}

/** A vehicle's newest recorded position, or null when it has none. Needs the Transport area (a driver may not read it). */
export async function apiLatestLocation(tenantId: string, vehicleId: string): Promise<Fix | null> {
  const r = await apiClient().get("/v1/tenants/{tenantId}/vehicles/{vehicleId}/locations", { path: { tenantId, vehicleId }, query: { limit: 1 }, tenantId });
  return fixFromApi(r.locations[0]);
}

const POSITION_READS = 4;

/**
 * Every active vehicle with the trip it is on (its driver, route and direction) and its last position. No stops (the API cannot
 * list them). A bus with no trip has no driver or route here: the API does not say who is assigned to it.
 */
export async function apiListBusesOnRoutes(tenantId: string): Promise<BusOnRoute[]> {
  const [vehicles, routes, trips, directory] = await Promise.all([
    apiListVehicles(tenantId), apiListRoutes(tenantId), apiListActiveTrips(tenantId), staffDirectory(tenantId),
  ]);
  const active = vehicles.filter((v) => v.active);
  const fixes = await settlePool(active, POSITION_READS, (v) => apiLatestLocation(tenantId, v.id));
  const tripOf = new Map(trips.map((t) => [t.vehicle_id, t]));
  return active.map((vehicle, i): BusOnRoute => {
    const fix = fixes[i]!.ok ? fixes[i]!.value : null;
    const trip = tripOf.get(vehicle.id) ?? null;
    const person = trip ? directory?.get(trip.driver_id) : undefined;
    const driver: DriverProfile | null = person ? { id: person.userId, name: person.name, avatarUrl: null, title: person.title } : null;
    const route = trip?.route_id ? routes.find((r) => r.id === trip.route_id) : undefined;
    return {
      vehicle: fix ? { ...vehicle, last_lat: fix.lat, last_lng: fix.lng, last_ping_at: fix.recorded_at } : vehicle,
      driverName: driver?.name ?? null,
      driver,
      route: route ? { id: route.id, name: route.name } : null,
      stops: [],
      direction: trip?.direction ?? null,
    };
  });
}

/**
 * Live positions in place of Realtime: every `POLL_MS.live`, the newest position of each vehicle on a trip, handed to `onUpdate`
 * when it is new. A person who may not read the fleet (a driver, a parent) gets a 403 and polling stops. Returns the stop function.
 */
export function apiPollVehiclePositions(tenantId: string, onUpdate: (vehicle: Vehicle) => void): () => void {
  let vehicles: Map<string, Vehicle> | null = null;
  const seen = new Map<string, string>();
  const stop = startPolling(async (signal) => {
    const [trips, list] = await Promise.all([apiListActiveTrips(tenantId), vehicles ? Promise.resolve(null) : apiListVehicles(tenantId)]);
    if (list) vehicles = new Map(list.map((v) => [v.id, v]));
    if (signal.aborted) return;
    const ids = [...new Set(trips.map((t) => t.vehicle_id))];
    const fixes = await settlePool(ids, POSITION_READS, (id) => apiLatestLocation(tenantId, id));
    if (signal.aborted) return;
    ids.forEach((id, i) => {
      const f = fixes[i]!;
      const vehicle = vehicles?.get(id);
      if (!f.ok || !f.value || !vehicle || seen.get(id) === f.value.recorded_at) return;
      seen.set(id, f.value.recorded_at);
      onUpdate({ ...vehicle, last_lat: f.value.lat, last_lng: f.value.lng, last_ping_at: f.value.recorded_at });
    });
  }, {
    intervalMs: POLL_MS.live,
    onError: (err) => { if (isApiError(err) && err.status === 403) stop(); },
  });
  return stop;
}

// ---------------------------------------------------------------- the manifest of a trip

const RIDER_STATUS: Record<string, RiderStatus> = { waiting: "expected", boarded: "boarded", dropped_off: "alighted", not_boarded: "absent" };

/**
 * Everyone assigned to the trip's route, with where they stand, from `GET /trips/{id}` (its manifest and its events). The
 * manifest is in stop order, and each child carries their stop's name: the API gives no other read of a route's stops.
 */
export async function apiListTripRiders(tripId: string): Promise<TripRider[]> {
  const tenantId = activeTenantId();
  const r = await apiClient().get("/v1/tenants/{tenantId}/trips/{tripId}", { path: { tenantId, tripId }, tenantId });
  const body = r as Record<string, unknown>;
  const at = new Map<string, string>();
  for (const e of rows(body.events)) {
    const learner = str(e.learner_id);
    const type = str(e.event_type);
    const when = str(e.occurred_at);
    if (learner && type && when && !at.has(`${type}|${learner}`)) at.set(`${type}|${learner}`, when);
  }
  const out: TripRider[] = [];
  for (const m of rows(body.manifest)) {
    const id = str(m.learner_id);
    if (!id) continue;
    out.push({
      student_id: id, full_name: str(m.full_name) ?? "", stop_id: str(m.stop_id), stop_name: str(m.stop_name),
      status: RIDER_STATUS[str(m.status) ?? "waiting"] ?? "expected",
      boarded_at: at.get(`learner_boarded|${id}`) ?? null, alighted_at: at.get(`learner_alighted|${id}`) ?? null,
      avatar_url: null, absent_from_class: false,
    });
  }
  return out;
}

type MarkEventType = "learner_boarded" | "learner_alighted" | "learner_not_boarded";

const MARK_EVENT: Partial<Record<RiderStatus, MarkEventType>> = { boarded: "learner_boarded", alighted: "learner_alighted", absent: "learner_not_boarded" };

/** The body of the trip event a child's mark becomes: what is held in the queue and what is sent. Throws for taking a mark back. */
export function riderMarkEventBody(input: Pick<RiderMarkInput, "studentId" | "stopId" | "status">): { event_type: MarkEventType; learner_id: string; stop_id: string | null } {
  const type = MARK_EVENT[input.status];
  if (!type) throw new NotOnApiError("Taking a child's mark back");
  return { event_type: type, learner_id: input.studentId, stop_id: input.stopId };
}

/**
 * Marks a child on, off or not here. The server keeps one of each event per child per trip, so a mark sent twice is one mark
 * (it answers 200 with `replayed`); a mark cannot be taken back, and its time is the server's, not the tap's.
 */
export async function apiMarkRider(input: RiderMarkInput): Promise<void> {
  await apiClient().post("/v1/tenants/{tenantId}/trips/{tripId}/events", {
    path: { tenantId: input.tenantId, tripId: input.tripId },
    body: riderMarkEventBody(input),
    tenantId: input.tenantId,
  });
}

/**
 * Tells the office the bus has broken down: an `incident` event on the trip, which the office reads as an alert. The API tells no
 * family (an incident is "recorded only": the office escalates it and chooses to notify), so 0 families are told. An incident is
 * NOT deduplicated by the server: sent twice it is two incidents (finding 33), so it is never held in the offline queue.
 */
export async function apiReportBreakdown(input: { tripId: string; note: string; lat: number | null; lng: number | null }): Promise<number> {
  const tenantId = activeTenantId();
  const where = input.lat != null && input.lng != null ? ` Near ${input.lat.toFixed(5)}, ${input.lng.toFixed(5)}.` : "";
  const note = `Bus broken down.${input.note.trim() ? ` ${input.note.trim()}` : ""}${where}`.slice(0, 500);
  await apiClient().post("/v1/tenants/{tenantId}/trips/{tripId}/events", {
    path: { tenantId, tripId: input.tripId }, body: { event_type: "incident", note }, tenantId,
  });
  return 0;
}

// ---------------------------------------------------------------- the driver's own trip

async function readDriverAssignments(tenantId: string): Promise<Record<string, unknown>> {
  return (await apiClient().get("/v1/tenants/{tenantId}/driver/assignments", { path: { tenantId }, tenantId })) as Record<string, unknown>;
}

/** The driver's own assignment: the vehicle and route they drive. With more than one, the one that has a trip running, else the first. */
export async function apiMyAssignment(driverId: string): Promise<AssignmentRow | null> {
  const tenantId = activeTenantId();
  const r = await readDriverAssignments(tenantId);
  const running = new Set(rows(r.active_trips).map((t) => str(t.vehicle_id)));
  const list = rows(r.assignments).filter((a) => str(a.vehicle_id));
  const a = list.find((x) => running.has(str(x.vehicle_id))) ?? list[0];
  if (!a) return null;
  const routeId = str(a.route_id);
  return {
    id: str(a.id) ?? "", tenant_id: tenantId, vehicle_id: str(a.vehicle_id)!, driver_id: driverId, route_id: routeId, active: true,
    vehicle: { plate_number: str(a.plate_number) ?? "" }, driver: null, route: routeId ? { name: str(a.route_name) ?? "" } : null,
  };
}

/** The trip this driver has running, if any (resumed after a reload). */
export async function apiMyActiveTrip(driverId: string): Promise<Trip | null> {
  const tenantId = activeTenantId();
  const t = rows((await readDriverAssignments(tenantId)).active_trips)[0];
  return t ? tripFromApi(t, tenantId, driverId) : null;
}

/** A driver starts a trip on their own vehicle; the route is the vehicle's assigned one. Answers the trip as the server has it. */
export async function apiStartTrip(input: { tenantId: string; vehicleId: string; routeId: string | null; driverId: string; direction: TripDirection }): Promise<Trip> {
  const r = await apiClient().post("/v1/tenants/{tenantId}/driver/trips", {
    path: { tenantId: input.tenantId }, body: { vehicle_id: input.vehicleId, direction: input.direction }, tenantId: input.tenantId,
  });
  // The answer is only `{ id, status, route_id }`: the vehicle and direction are the ones asked for.
  const raw = (r as Record<string, unknown>).trip;
  const made = isRecord(raw) ? tripFromApi({ vehicle_id: input.vehicleId, direction: input.direction, ...raw }, input.tenantId, input.driverId) : null;
  // The answer has no start time or direction: read the running trip back so the clock starts where the server's did.
  const running = await apiMyActiveTrip(input.driverId).catch(() => null);
  if (running && (!made || running.id === made.id)) return running;
  if (!made) throw new Error("The trip was started but the server did not say which one.");
  return { ...made, vehicle_id: input.vehicleId, direction: input.direction, driver_id: input.driverId };
}

/** Thrown when the server will not finish an afternoon trip while boarded children have no drop-off. Ask the driver, then finish with `acknowledgeOpenRiders`. */
export class OpenRidersError extends Error {
  constructor(readonly count: number) {
    super(`${count} ${count === 1 ? "child is" : "children are"} still marked on the bus.`);
    this.name = "OpenRidersError";
  }
}

export function isOpenRidersError(err: unknown): err is OpenRidersError {
  return err instanceof OpenRidersError;
}

/** Ends the trip (`/finish`: `/complete` needs the office's permission, a driver has only `drive`). */
export async function apiEndTrip(tripId: string, opts: { acknowledgeOpenRiders?: boolean } = {}): Promise<void> {
  const tenantId = activeTenantId();
  try {
    await apiClient().post("/v1/tenants/{tenantId}/trips/{tripId}/finish", {
      path: { tenantId, tripId }, body: opts.acknowledgeOpenRiders ? { acknowledge_open_learners: true } : {}, tenantId,
    });
  } catch (err) {
    const open = isApiError(err) && err.code === "conflict" ? /^(\d+) boarded learner/.exec(err.message) : null;
    if (open) throw new OpenRidersError(Number(open[1]));
    throw err;
  }
}

/** The body of a position report: the fix and the time it was taken (the server refuses a fix older than 10 minutes or older than one it has). */
export function locationBody(input: Pick<LocationPingInput, "lat" | "lng" | "speedKmh" | "heading" | "recordedAt">): {
  lat: number; lng: number; speed_kmh: number | null; heading: number | null; recorded_at: string;
} {
  return {
    lat: input.lat, lng: input.lng,
    speed_kmh: input.speedKmh != null ? Math.min(250, Math.max(0, input.speedKmh)) : null,
    heading: input.heading != null ? Math.min(360, Math.max(0, input.heading)) : null,
    recorded_at: input.recordedAt ?? new Date().toISOString(),
  };
}

/** One GPS reading from the driver of the running trip. The server answers 200 `replayed` for an exact resend. */
export async function apiPingLocation(input: LocationPingInput): Promise<void> {
  await apiClient().post("/v1/tenants/{tenantId}/trips/{tripId}/driver-location", {
    path: { tenantId: input.tenantId, tripId: input.tripId }, body: locationBody(input), tenantId: input.tenantId,
  });
}

// ---------------------------------------------------------------- trip replay

const PATH_PAGES = 25;

/** The recorded path of a trip, oldest first: the vehicle's positions (newest first, 200 a page) back to the trip's start, kept if they carry this trip's id. */
export async function apiFetchTripPath(tripId: string): Promise<TripPoint[]> {
  const tenantId = activeTenantId();
  const detail = (await apiClient().get("/v1/tenants/{tenantId}/trips/{tripId}", { path: { tenantId, tripId }, tenantId })) as Record<string, unknown>;
  const trip = isRecord(detail.trip) ? detail.trip : null;
  const vehicleId = str(trip?.vehicle_id);
  const startedAt = str(trip?.started_at);
  if (!vehicleId || !startedAt) return [];
  const from = new Date(startedAt).getTime();
  const points: TripPoint[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < PATH_PAGES; i++) {
    const r = await apiClient().get("/v1/tenants/{tenantId}/vehicles/{vehicleId}/locations", {
      path: { tenantId, vehicleId }, query: { limit: API_PAGE_LIMIT, cursor }, tenantId,
    });
    let reachedStart = false;
    for (const raw of r.locations) {
      const l = fixFromApi(raw);
      if (!l) continue;
      if (new Date(l.recorded_at).getTime() < from) { reachedStart = true; break; }
      if (l.trip_id === tripId) points.push({ lat: l.lat, lng: l.lng, speed_kmh: l.speed_kmh, recorded_at: l.recorded_at });
    }
    const next = r.page.next_cursor;
    if (reachedStart || !next) break;
    cursor = next;
  }
  return points.reverse();
}

// ---------------------------------------------------------------- alerts: a trip's incidents

interface IncidentRow { id: string; trip_id: string; severity: string; summary: string; status: string; created_at: string; acknowledged_by: string | null; acknowledged_at: string | null }

function incidentFromApi(raw: Record<string, unknown>, tripId: string): IncidentRow | null {
  const id = str(raw.id);
  if (!id) return null;
  return {
    id, trip_id: str(raw.trip_id) ?? tripId, severity: str(raw.severity) ?? "medium", summary: str(raw.summary) ?? "Transport incident reported", status: str(raw.status) ?? "open",
    created_at: str(raw.created_at) ?? new Date().toISOString(), acknowledged_by: str(raw.acknowledged_by), acknowledged_at: str(raw.acknowledged_at),
  };
}

async function tripIncidents(tenantId: string, tripId: string): Promise<IncidentRow[]> {
  const r = (await apiClient().get("/v1/tenants/{tenantId}/trips/{tripId}/incidents", { path: { tenantId, tripId }, tenantId })) as Record<string, unknown>;
  return rows(r.incidents).map((i) => incidentFromApi(i, tripId)).filter((i): i is IncidentRow => i !== null);
}

const DAY_MS = 24 * 60 * 60_000;
const INCIDENT_TRIPS = 20;

/** An incident as the Fleet page's alert: a bus that broke down (`kind: "breakdown"`), with the vehicle's plate. */
function alertFromIncident(i: IncidentRow, trip: Trip, plate: string | null): AlertRow {
  const alert: VehicleAlert = {
    id: i.id, tenant_id: trip.tenant_id, vehicle_id: trip.vehicle_id, trip_id: trip.id, kind: "breakdown", detail: i.summary,
    lat: 0, lng: 0, acknowledged_at: i.status === "open" ? null : (i.acknowledged_at ?? i.created_at), acknowledged_by: i.acknowledged_by, created_at: i.created_at,
  };
  return { ...alert, vehicle: plate ? { plate_number: plate } : null };
}

/**
 * The drivers' breakdown reports still waiting for the office: open incidents of trips on the road and of trips started in the
 * last day (up to 20), newest first. There is no school-wide list of incidents, so this reads each trip's own.
 */
export async function apiListAlerts(tenantId: string, onlyOpen: boolean): Promise<AlertRow[]> {
  const [recent, vehicles] = await Promise.all([readTripsPage(tenantId, { limit: INCIDENT_TRIPS }), apiListVehicles(tenantId)]);
  const since = Date.now() - DAY_MS;
  const trips = recent.trips.filter((t) => t.status === "active" || new Date(t.started_at).getTime() >= since);
  const found = await settlePool(trips, POSITION_READS, async (t) => (await tripIncidents(tenantId, t.id)).map((i) => alertFromIncident(i, t, vehicles.find((v) => v.id === t.vehicle_id)?.plate_number ?? null)));
  return found.flatMap((f) => (f.ok ? f.value : []))
    .filter((a) => !onlyOpen || a.acknowledged_at === null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** The office has seen it: the incident becomes "acknowledged" (it is the trip's own incident, so the trip is needed). */
export async function apiAcknowledgeAlert(alertId: string, tripId: string | undefined): Promise<void> {
  if (!tripId) throw new Error("This alert does not say which trip it is on.");
  const tenantId = activeTenantId();
  await apiClient().post("/v1/tenants/{tenantId}/trips/{tripId}/incidents/{incidentId}/acknowledge", {
    path: { tenantId, tripId, incidentId: alertId }, body: {}, tenantId,
  });
}

/** New breakdown reports as they are made, in place of Realtime: the open incidents of recent trips, every 30 s. */
export function apiPollAlerts(tenantId: string, onInsert: (alert: VehicleAlert) => void): () => void {
  const seen = new Set<string>();
  let primed = false;
  const stop = startPolling(async (signal) => {
    const found = await apiListAlerts(tenantId, true);
    if (signal.aborted) return;
    for (const a of found) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      if (primed) onInsert(a);
    }
    primed = true;
  }, { intervalMs: POLL_MS.list, immediate: true, onError: (err) => { if (isApiError(err) && err.status === 403) stop(); } });
  return stop;
}
