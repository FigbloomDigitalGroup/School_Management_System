import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { fleetCapabilities, NotOnApiError } from "../capabilities";
import {
  acknowledgeAlert, activeDirections, assignDriver, busFromAssignment, createRoute, createVehicle, endTrip, enqueueLocationPing, enqueueRiderMark,
  fetchTripPath, listActiveTrips, listAlerts, listAssignments, listBusesOnRoutes, listDrivers, listRouteStops, listRoutes, listTrips, listTripRiders,
  listVehicles, markRider, myActiveTrip, myAssignment, pingLocation, replaceRouteStops, reportBreakdown, setVehicleActive, startTrip, stopsOfRiders,
  subscribeVehiclePositions,
} from "../fleet";
import { isRetryable, WriteQueue, type QueuedWrite } from "../queue";
import { sendQueuedWrite } from "../queueSend";
import { assignStudentToRoute, listRouteRiders, listRoutesWithStops, saveRebuiltStops, setLearnerHome } from "../routePlanning";
import { fetchRouteTrace } from "../routeTrace";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { resetDirectory } from "./directoryApi";
import { fixFromApi, isOpenRidersError, locationBody, riderMarkEventBody, tripFromApi, vehicleFromApi } from "./fleetApi";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const DRIVER = "d1111111-1111-4111-8111-111111111111";
const V1 = "v1111111-1111-4111-8111-111111111111";
const V2 = "v2222222-2222-4222-8222-222222222222";
const R1 = "a1111111-1111-4111-8111-111111111111";
const TRIP = "e1111111-1111-4111-8111-111111111111";
const TRIP2 = "e2222222-2222-4222-8222-222222222222";
const L1 = "51111111-1111-4111-8111-111111111111";
const L2 = "52222222-2222-4222-8222-222222222222";
const S1 = "b1111111-1111-4111-8111-111111111111";

const P = `/v1/tenants/${T}`;
const stamp = { created_at: "2026-11-20T08:00:00Z" };
const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const list = (key: string, items: unknown[], next: string | null = null): FakeReply => ({ body: { [key]: items, page: page(next) } });
const refused = (code: string, status: number, message = "no") => ({ status, body: { error: { code, message } } });

const apiVehicle = (o: Record<string, unknown> = {}) => ({ id: V1, tenant_id: T, plate_number: "KDA 214B", make_model: "Toyota Hiace", capacity: 33, active: true, ...stamp, ...o });
const apiRoute = (o: Record<string, unknown> = {}) => ({ id: R1, tenant_id: T, name: "Route A - Thika Road", description: "", active: true, ...stamp, ...o });
const apiTrip = (o: Record<string, unknown> = {}) => ({
  id: TRIP, tenant_id: T, vehicle_id: V1, route_id: R1, driver_user_id: DRIVER, direction: "to_school", status: "active",
  started_at: "2026-11-24T05:30:00Z", ended_at: null, cancel_reason: null, ...o,
});
const apiStaff = (o: Record<string, unknown> = {}) => ({
  id: "81111111-1111-4111-8111-111111111111", tenantId: T, full_name: "James Mwangi", staff_title: "Driver", classification: "driver",
  phone: null, email: null, userId: DRIVER, active: true, archived_at: null, ...stamp, updated_at: stamp.created_at, ...o,
});
const apiFix = (o: Record<string, unknown> = {}) => ({
  id: "f1", tenant_id: T, vehicle_id: V1, trip_id: TRIP, lat: -1.2, lng: 36.8, speed_kmh: 30, heading: 90, recorded_at: "2026-11-24T05:40:00Z", expires_at: "2026-12-24T05:40:00Z", ...o,
});

let api: FakeApi;

function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  resetDirectory();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: DRIVER }));
  setApiActiveTenant(T);
  return api;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetApiClient();
  resetDirectory();
  initBackend({ kind: "supabase" });
});

describe("capabilities and mappers", () => {
  it("offers everything on Supabase and hides what the API cannot read or undo", () => {
    initBackend({ kind: "supabase" });
    expect(fleetCapabilities()).toEqual({
      routeStops: true, routeRiders: true, assignments: true, speedAlerts: true, tripIncidents: false, undoRiderMark: true,
      breakdownTellsFamilies: true, driverLiveFeed: true, tripAlertCounts: true,
    });
    initBackend({ kind: "api", apiUrl: BASE });
    expect(fleetCapabilities()).toEqual({
      routeStops: false, routeRiders: false, assignments: false, speedAlerts: false, tripIncidents: true, undoRiderMark: false,
      breakdownTellsFamilies: false, driverLiveFeed: false, tripAlertCounts: false,
    });
  });

  it("maps a vehicle with no position, and a trip with the driver's user id", () => {
    expect(vehicleFromApi(apiVehicle() as never)).toMatchObject({ id: V1, plate_number: "KDA 214B", make_model: "Toyota Hiace", capacity: 33, last_lat: null, last_ping_at: null });
    expect(tripFromApi(apiTrip(), T)).toMatchObject({ id: TRIP, vehicle_id: V1, route_id: R1, driver_id: DRIVER, direction: "to_school", status: "active" });
    // a driver's own active trip has no tenant or driver in it: they come from the caller
    expect(tripFromApi({ id: TRIP, vehicle_id: V1, route_id: null, direction: "from_school", status: "active", started_at: "2026-11-24T12:00:00Z" }, T, DRIVER))
      .toMatchObject({ tenant_id: T, driver_id: DRIVER, route_id: null, direction: "from_school" });
    expect(tripFromApi({ vehicle_id: V1 }, T)).toBeNull();
    expect(tripFromApi("nope", T)).toBeNull();
  });

  it("reads a recorded position defensively and shapes a position report", () => {
    expect(fixFromApi(apiFix())).toMatchObject({ lat: -1.2, lng: 36.8, trip_id: TRIP, speed_kmh: 30 });
    expect(fixFromApi({ lat: "x", lng: 1, recorded_at: "2026-11-24T05:40:00Z" })).toBeNull();
    expect(fixFromApi({ lat: 1, lng: 1 })).toBeNull();
    const body = locationBody({ lat: -1.2, lng: 36.8, speedKmh: 300, heading: -4, recordedAt: "2026-11-24T05:40:00.000Z" });
    expect(body).toEqual({ lat: -1.2, lng: 36.8, speed_kmh: 250, heading: 0, recorded_at: "2026-11-24T05:40:00.000Z" });
    expect(locationBody({ lat: 1, lng: 2 })).toMatchObject({ speed_kmh: null, heading: null, recorded_at: expect.stringMatching(/Z$/) });
  });

  it("turns a child's mark into the trip event the API has, and refuses to take one back", () => {
    expect(riderMarkEventBody({ studentId: L1, stopId: S1, status: "boarded" })).toEqual({ event_type: "learner_boarded", learner_id: L1, stop_id: S1 });
    expect(riderMarkEventBody({ studentId: L1, stopId: null, status: "alighted" })).toEqual({ event_type: "learner_alighted", learner_id: L1, stop_id: null });
    expect(riderMarkEventBody({ studentId: L1, stopId: null, status: "absent" }).event_type).toBe("learner_not_boarded");
    expect(() => riderMarkEventBody({ studentId: L1, stopId: null, status: "expected" })).toThrow(NotOnApiError);
  });
});

describe("what the API cannot do throws NotOnApiError, and nothing is asked", () => {
  it("stops, assignments, a vehicle's active flag, a learner's route", async () => {
    boot({});
    await expect(listRouteStops(R1)).rejects.toBeInstanceOf(NotOnApiError);
    await expect(replaceRouteStops(T, R1, [])).rejects.toBeInstanceOf(NotOnApiError);
    await expect(listAssignments(T)).rejects.toBeInstanceOf(NotOnApiError);
    await expect(setVehicleActive(V1, false)).rejects.toBeInstanceOf(NotOnApiError);
    await expect(setLearnerHome(L1, { lat: 1, lng: 2, landmark: null, address: null })).rejects.toBeInstanceOf(NotOnApiError);
    await expect(listRoutesWithStops(T)).rejects.toBeInstanceOf(NotOnApiError);
    await expect(assignStudentToRoute({ studentId: L1, routeId: R1 })).rejects.toBeInstanceOf(NotOnApiError);
    await expect(listRouteRiders(R1)).rejects.toBeInstanceOf(NotOnApiError);
    await expect(saveRebuiltStops(R1, [])).rejects.toBeInstanceOf(NotOnApiError);
    await expect(markRider({ tenantId: T, tripId: TRIP, studentId: L1, stopId: null, status: "expected", markedAt: "2026-11-24T06:00:00Z" })).rejects.toBeInstanceOf(NotOnApiError);
    expect(api.calls).toHaveLength(0);
  });

  it("draws the straight line for a route's trace, without asking", async () => {
    boot({});
    expect(await fetchRouteTrace(R1, [])).toBeNull();
    expect(api.calls).toHaveLength(0);
  });
});

describe("vehicles, routes, drivers and assignments", () => {
  it("lists every page of vehicles and routes and maps them", async () => {
    boot({
      [`GET ${P}/vehicles`]: (c) => (c.query.get("cursor") ? list("vehicles", [apiVehicle({ id: V2, plate_number: "KDB 100A" })]) : list("vehicles", [apiVehicle()], "next-1")),
      [`GET ${P}/transport-routes`]: list("routes", [apiRoute({ description: "Via Kasarani" })]),
    });
    const vehicles = await listVehicles(T);
    expect(vehicles.map((v) => v.plate_number)).toEqual(["KDA 214B", "KDB 100A"]);
    expect(api.callsTo(`GET ${P}/vehicles`)[0]!.query.get("limit")).toBe("200");
    expect(await listRoutes(T)).toEqual([{ id: R1, tenant_id: T, name: "Route A - Thika Road", description: "Via Kasarani", active: true }]);
  });

  it("adds a vehicle and a route", async () => {
    boot({
      [`POST ${P}/vehicles`]: { status: 201, body: { vehicle: apiVehicle({ capacity: null, make_model: null }) } },
      [`POST ${P}/transport-routes`]: { status: 201, body: { route: apiRoute() } },
    });
    const v = await createVehicle({ tenantId: T, plateNumber: "KDA 214B" });
    expect(v.plate_number).toBe("KDA 214B");
    expect(api.callsTo(`POST ${P}/vehicles`)[0]!.body).toEqual({ plate_number: "KDA 214B", make_model: null, capacity: null });
    await createRoute({ tenantId: T, name: "Route A - Thika Road" });
    expect(api.callsTo(`POST ${P}/transport-routes`)[0]!.body).toEqual({ name: "Route A - Thika Road" });
  });

  it("lists the active drivers who have an account, from the staff directory", async () => {
    boot({
      [`GET ${P}/staff`]: list("staff", [
        apiStaff(),
        apiStaff({ id: "x2", userId: null, full_name: "No Account" }),
        apiStaff({ id: "x3", userId: "u3", full_name: "A Teacher", classification: "teacher" }),
        apiStaff({ id: "x4", userId: "u4", full_name: "Left School", active: false }),
      ]),
    });
    expect(await listDrivers(T)).toEqual([{ id: DRIVER, full_name: "James Mwangi" }]);
  });

  it("has no drivers to offer a person who may not read the staff list", async () => {
    boot({ [`GET ${P}/staff`]: refused("forbidden", 403, "Forbidden") });
    expect(await listDrivers(T)).toEqual([]);
  });

  it("assigns a driver to a vehicle with an optional route", async () => {
    boot({ [`POST ${P}/vehicles/${V1}/assignments`]: { status: 204 } });
    await assignDriver({ tenantId: T, vehicleId: V1, driverId: DRIVER, routeId: null });
    expect(api.callsTo(`POST ${P}/vehicles/${V1}/assignments`)[0]!.body).toEqual({ driver_user_id: DRIVER, route_id: null });
  });
});

describe("trips and the office's live view", () => {
  it("lists the trips on the road across pages, and their directions by vehicle", async () => {
    boot({
      [`GET ${P}/trips`]: (c) => (c.query.get("cursor")
        ? { body: { trips: [apiTrip({ id: TRIP2, vehicle_id: V2, direction: "from_school" })], page: page() } }
        : { body: { trips: [apiTrip()], page: page("c2") } }),
    });
    const trips = await listActiveTrips(T);
    expect(trips.map((t) => t.id)).toEqual([TRIP, TRIP2]);
    expect(api.callsTo(`GET ${P}/trips`)[0]!.query.get("status")).toBe("active");
    expect([...(await activeDirections())]).toEqual([[V1, "to_school"], [V2, "from_school"]]);
  });

  it("names the buses: driver and route from the running trip, position from the newest fix, no stops", async () => {
    boot({
      [`GET ${P}/vehicles`]: list("vehicles", [apiVehicle(), apiVehicle({ id: V2, plate_number: "KDB 100A" })]),
      [`GET ${P}/transport-routes`]: list("routes", [apiRoute()]),
      [`GET ${P}/trips`]: { body: { trips: [apiTrip()], page: page() } },
      [`GET ${P}/staff`]: list("staff", [apiStaff()]),
      [`GET ${P}/vehicles/${V1}/locations`]: { body: { locations: [apiFix()], page: page() } },
      [`GET ${P}/vehicles/${V2}/locations`]: { body: { locations: [], page: page() } },
    });
    const buses = await listBusesOnRoutes(T);
    expect(buses).toHaveLength(2);
    expect(buses[0]).toMatchObject({
      vehicle: { id: V1, last_lat: -1.2, last_lng: 36.8, last_ping_at: "2026-11-24T05:40:00Z" },
      driverName: "James Mwangi", route: { id: R1, name: "Route A - Thika Road" }, direction: "to_school", stops: [],
    });
    expect(buses[0]!.driver).toEqual({ id: DRIVER, name: "James Mwangi", avatarUrl: null, title: "Driver" });
    // not on a trip: the API does not say who is assigned to it
    expect(buses[1]).toMatchObject({ vehicle: { id: V2, last_lat: null, last_ping_at: null }, driverName: null, route: null, direction: null, stops: [] });
    expect(api.callsTo(`GET ${P}/vehicles/${V1}/locations`)[0]!.query.get("limit")).toBe("1");
  });

  it("shows the buses with no names when the staff list is closed to the reader", async () => {
    boot({
      [`GET ${P}/vehicles`]: list("vehicles", [apiVehicle()]),
      [`GET ${P}/transport-routes`]: list("routes", [apiRoute()]),
      [`GET ${P}/trips`]: { body: { trips: [apiTrip()], page: page() } },
      [`GET ${P}/staff`]: refused("forbidden", 403),
      [`GET ${P}/vehicles/${V1}/locations`]: { body: { locations: [], page: page() } },
    });
    const [bus] = await listBusesOnRoutes(T);
    expect(bus).toMatchObject({ driverName: null, driver: null, route: { name: "Route A - Thika Road" }, direction: "to_school" });
  });

  it("names the trip history with plate, driver and route, newest first", async () => {
    boot({
      [`GET ${P}/trips`]: { body: { trips: [apiTrip({ status: "completed", ended_at: "2026-11-24T06:10:00Z" }), apiTrip({ id: TRIP2, vehicle_id: V2 })], page: page() } },
      [`GET ${P}/vehicles`]: list("vehicles", [apiVehicle()]),
      [`GET ${P}/transport-routes`]: list("routes", [apiRoute()]),
      [`GET ${P}/staff`]: list("staff", [apiStaff()]),
    });
    const rows = await listTrips(T, undefined, 50);
    expect(rows[0]).toMatchObject({ id: TRIP, status: "completed", vehicle: { plate_number: "KDA 214B" }, driver: { full_name: "James Mwangi" }, route: { name: "Route A - Thika Road" }, alertCount: 0 });
    expect(rows[1]).toMatchObject({ id: TRIP2, vehicle: null });
    expect(api.callsTo(`GET ${P}/trips`)[0]!.query.get("limit")).toBe("50");
  });

  it("filters one vehicle's history here, because the API cannot", async () => {
    boot({
      [`GET ${P}/trips`]: { body: { trips: [apiTrip(), apiTrip({ id: TRIP2, vehicle_id: V2 })], page: page() } },
      [`GET ${P}/vehicles`]: list("vehicles", [apiVehicle(), apiVehicle({ id: V2 })]),
      [`GET ${P}/transport-routes`]: list("routes", []),
      [`GET ${P}/staff`]: refused("forbidden", 403),
    });
    const rows = await listTrips(T, V2, 50);
    expect(rows.map((r) => r.id)).toEqual([TRIP2]);
    expect(rows[0]!.driver).toBeNull();
  });
});

describe("live positions by polling", () => {
  it("hands over each new position of a bus on a trip about every 10 s, and stops when told", async () => {
    vi.useFakeTimers();
    let fix = apiFix();
    boot({
      [`GET ${P}/trips`]: { body: { trips: [apiTrip()], page: page() } },
      [`GET ${P}/vehicles`]: list("vehicles", [apiVehicle()]),
      [`GET ${P}/vehicles/${V1}/locations`]: () => ({ body: { locations: [fix], page: page() } }),
    });
    const seen: { id: string; lat: number | null; at: string | null }[] = [];
    const stop = subscribeVehiclePositions(T, (v) => seen.push({ id: v.id, lat: v.last_lat, at: v.last_ping_at }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen).toEqual([{ id: V1, lat: -1.2, at: "2026-11-24T05:40:00Z" }]);
    // the same fix again is not news
    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen).toHaveLength(1);
    fix = apiFix({ lat: -1.3, recorded_at: "2026-11-24T05:40:10Z" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen.map((s) => s.lat)).toEqual([-1.2, -1.3]);
    stop();
    const before = api.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.calls).toHaveLength(before);
  });

  it("stops asking when the reader may not read the fleet (a driver, a parent)", async () => {
    vi.useFakeTimers();
    boot({ [`GET ${P}/trips`]: refused("forbidden", 403) });
    const stop = subscribeVehiclePositions(T, () => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.callsTo(`GET ${P}/trips`)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.callsTo(`GET ${P}/trips`)).toHaveLength(1);
    stop();
  });
});

describe("the list of children on a trip", () => {
  const detail = {
    trip: apiTrip(),
    manifest: [
      { learner_id: L1, full_name: "Amina Ochieng", stop_id: S1, stop_name: "Kahawa", status: "boarded" },
      { learner_id: L2, full_name: "Brian Otieno", stop_id: null, stop_name: null, status: "waiting" },
      { learner_id: "53333333-3333-4333-8333-333333333333", full_name: "Cate Wanjiru", stop_id: S1, stop_name: "Kahawa", status: "dropped_off" },
      { learner_id: "54444444-4444-4444-8444-444444444444", full_name: "Dan Kioko", stop_id: S1, stop_name: "Kahawa", status: "not_boarded" },
    ],
    events: [
      { event_type: "learner_boarded", learner_id: L1, occurred_at: "2026-11-24T05:50:00Z" },
      { event_type: "learner_boarded", learner_id: "53333333-3333-4333-8333-333333333333", occurred_at: "2026-11-24T05:52:00Z" },
      { event_type: "learner_alighted", learner_id: "53333333-3333-4333-8333-333333333333", occurred_at: "2026-11-24T06:10:00Z" },
      { event_type: "stop_arrived", learner_id: null, occurred_at: "2026-11-24T05:49:00Z" },
    ],
  };

  it("reads the manifest and the times of boarding and getting off", async () => {
    boot({ [`GET ${P}/trips/${TRIP}`]: { body: detail } });
    const riders = await listTripRiders(TRIP);
    expect(riders.map((r) => [r.full_name, r.status])).toEqual([
      ["Amina Ochieng", "boarded"], ["Brian Otieno", "expected"], ["Cate Wanjiru", "alighted"], ["Dan Kioko", "absent"],
    ]);
    expect(riders[0]).toMatchObject({ student_id: L1, stop_id: S1, stop_name: "Kahawa", boarded_at: "2026-11-24T05:50:00Z", alighted_at: null, absent_from_class: false });
    expect(riders[2]).toMatchObject({ boarded_at: "2026-11-24T05:52:00Z", alighted_at: "2026-11-24T06:10:00Z" });
    expect(riders[1]).toMatchObject({ stop_id: null, boarded_at: null });
  });

  it("takes the stops from the manifest, in the order the trip reaches them", async () => {
    boot({ [`GET ${P}/trips/${TRIP}`]: { body: { ...detail, manifest: [
      { learner_id: L1, full_name: "A", stop_id: "s1", stop_name: "School end", status: "waiting" },
      { learner_id: L2, full_name: "B", stop_id: "s2", stop_name: "Middle", status: "waiting" },
      { learner_id: "x", full_name: "C", stop_id: "s2", stop_name: "Middle", status: "waiting" },
      { learner_id: "y", full_name: "D", stop_id: "s3", stop_name: "Far end", status: "waiting" },
    ] } } });
    const riders = await listTripRiders(TRIP);
    expect(stopsOfRiders(riders, "from_school").map((s) => s.name)).toEqual(["School end", "Middle", "Far end"]);
    expect(stopsOfRiders(riders, "to_school").map((s) => s.name)).toEqual(["Far end", "Middle", "School end"]);
  });

  it("sends a mark as a trip event, once, and accepts the server's 'already have it'", async () => {
    boot({ [`POST ${P}/trips/${TRIP}/events`]: (c) => (api.callsTo(`POST ${P}/trips/${TRIP}/events`).length > 1 ? { status: 200, body: { event: {}, replayed: true } } : { status: 201, body: { event: {}, replayed: false } }) });
    const input = { tenantId: T, tripId: TRIP, studentId: L1, stopId: S1, status: "boarded" as const, markedAt: "2026-11-24T05:50:00Z" };
    await markRider(input);
    await markRider(input);
    const calls = api.callsTo(`POST ${P}/trips/${TRIP}/events`);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toEqual({ event_type: "learner_boarded", learner_id: L1, stop_id: S1 });
  });

  it("reports a breakdown as an incident with the place in the note, and tells no family", async () => {
    boot({ [`POST ${P}/trips/${TRIP}/events`]: { status: 201, body: { event: {}, replayed: false } } });
    const told = await reportBreakdown({ tripId: TRIP, note: "Flat tyre", lat: -1.28333, lng: 36.81667 });
    expect(told).toBe(0);
    expect(api.callsTo(`POST ${P}/trips/${TRIP}/events`)[0]!.body).toEqual({ event_type: "incident", note: "Bus broken down. Flat tyre Near -1.28333, 36.81667." });
    await reportBreakdown({ tripId: TRIP, note: "", lat: null, lng: null });
    expect(api.callsTo(`POST ${P}/trips/${TRIP}/events`)[1]!.body).toEqual({ event_type: "incident", note: "Bus broken down." });
  });
});

describe("the driver's own trip", () => {
  const assignments = {
    assignments: [
      { id: "as1", vehicle_id: V2, plate_number: "KDB 100A", route_id: null, route_name: null },
      { id: "as2", vehicle_id: V1, plate_number: "KDA 214B", route_id: R1, route_name: "Route A - Thika Road" },
    ],
    active_trips: [{ id: TRIP, vehicle_id: V1, route_id: R1, direction: "from_school", status: "active", started_at: "2026-11-24T12:00:00Z" }],
  };

  it("finds the vehicle and route they drive, preferring the one with a trip running", async () => {
    boot({ [`GET ${P}/driver/assignments`]: { body: assignments } });
    expect(await myAssignment(DRIVER)).toMatchObject({
      vehicle_id: V1, route_id: R1, driver_id: DRIVER, vehicle: { plate_number: "KDA 214B" }, route: { name: "Route A - Thika Road" },
    });
    expect(await myActiveTrip(DRIVER)).toMatchObject({ id: TRIP, tenant_id: T, driver_id: DRIVER, direction: "from_school", started_at: "2026-11-24T12:00:00Z" });
  });

  it("answers null when there is no assignment or no trip", async () => {
    boot({ [`GET ${P}/driver/assignments`]: { body: { assignments: [], active_trips: [] } } });
    expect(await myAssignment(DRIVER)).toBeNull();
    expect(await myActiveTrip(DRIVER)).toBeNull();
  });

  it("starts a trip on their own vehicle and reads it back for its start time", async () => {
    let started = false;
    boot({
      [`POST ${P}/driver/trips`]: () => { started = true; return { status: 201, body: { trip: { id: TRIP, status: "active", route_id: R1 } } }; },
      [`GET ${P}/driver/assignments`]: () => ({ body: { assignments: [], active_trips: started ? [{ id: TRIP, vehicle_id: V1, route_id: R1, direction: "to_school", status: "active", started_at: "2026-11-24T05:30:00Z" }] : [] } }),
    });
    const trip = await startTrip({ tenantId: T, vehicleId: V1, routeId: R1, driverId: DRIVER, direction: "to_school" });
    expect(api.callsTo(`POST ${P}/driver/trips`)[0]!.body).toEqual({ vehicle_id: V1, direction: "to_school" });
    expect(trip).toMatchObject({ id: TRIP, started_at: "2026-11-24T05:30:00Z", driver_id: DRIVER, direction: "to_school" });
  });

  it("still has the trip when the read-back fails", async () => {
    boot({
      [`POST ${P}/driver/trips`]: { status: 201, body: { trip: { id: TRIP, status: "active", route_id: R1 } } },
      [`GET ${P}/driver/assignments`]: refused("internal_error", 500),
    });
    expect(await startTrip({ tenantId: T, vehicleId: V1, routeId: R1, driverId: DRIVER, direction: "from_school" })).toMatchObject({ id: TRIP, vehicle_id: V1, direction: "from_school" });
  });

  it("ends a trip with /finish (a driver has no permission for /complete)", async () => {
    boot({ [`POST ${P}/trips/${TRIP}/finish`]: { status: 204 } });
    await endTrip(TRIP);
    const call = api.callsTo(`POST ${P}/trips/${TRIP}/finish`)[0]!;
    expect(call.body).toEqual({});
    expect(api.callsTo(`POST ${P}/trips/${TRIP}/complete`)).toHaveLength(0);
  });

  it("asks before ending an afternoon trip with children still on the bus, then sends the acknowledgement", async () => {
    boot({
      [`POST ${P}/trips/${TRIP}/finish`]: (c) => ((c.body as { acknowledge_open_learners?: boolean }).acknowledge_open_learners
        ? { status: 204 }
        : refused("conflict", 409, "3 boarded learner(s) have no drop-off event; record drop-offs or acknowledge before completing")),
    });
    const err = await endTrip(TRIP).catch((e: unknown) => e);
    expect(isOpenRidersError(err)).toBe(true);
    expect((err as { count: number }).count).toBe(3);
    await endTrip(TRIP, { acknowledgeOpenRiders: true });
    expect(api.callsTo(`POST ${P}/trips/${TRIP}/finish`)[1]!.body).toEqual({ acknowledge_open_learners: true });
  });

  it("passes any other refusal on as it is", async () => {
    boot({ [`POST ${P}/trips/${TRIP}/finish`]: refused("conflict", 409, "The trip is not active") });
    const err = await endTrip(TRIP).catch((e: unknown) => e);
    expect(isOpenRidersError(err)).toBe(false);
    expect((err as Error).message).toBe("The trip is not active");
  });

  it("reports a position with the time of the fix", async () => {
    boot({ [`POST ${P}/trips/${TRIP}/driver-location`]: { status: 201, body: { location: {}, replayed: false } } });
    await pingLocation({ tenantId: T, vehicleId: V1, tripId: TRIP, lat: -1.2, lng: 36.8, speedKmh: 28.4, heading: 91, recordedAt: "2026-11-24T05:40:00.000Z" });
    expect(api.callsTo(`POST ${P}/trips/${TRIP}/driver-location`)[0]!.body).toEqual({ lat: -1.2, lng: 36.8, speed_kmh: 28.4, heading: 91, recorded_at: "2026-11-24T05:40:00.000Z" });
  });
});

describe("a trip's recorded path", () => {
  it("pages back to the trip's start, keeps this trip's fixes, and answers oldest first", async () => {
    const at = (m: number) => `2026-11-24T05:${String(m).padStart(2, "0")}:00Z`;
    boot({
      [`GET ${P}/trips/${TRIP}`]: { body: { trip: apiTrip({ started_at: at(30) }), manifest: [], events: [] } },
      [`GET ${P}/vehicles/${V1}/locations`]: (c) => (c.query.get("cursor")
        ? { body: { locations: [apiFix({ lat: 2, recorded_at: at(31) }), apiFix({ lat: 1, recorded_at: at(29), trip_id: "earlier-trip" })], page: page() } }
        : { body: { locations: [apiFix({ lat: 4, recorded_at: at(40) }), apiFix({ lat: 3, recorded_at: at(35), trip_id: "other" })], page: page("c2") } }),
    });
    const path = await fetchTripPath(TRIP);
    expect(path.map((p) => p.lat)).toEqual([2, 4]);
    expect(path[0]).toMatchObject({ speed_kmh: 30, recorded_at: at(31) });
    // it stopped at the first fix before the start, so the cursor was followed once
    expect(api.callsTo(`GET ${P}/vehicles/${V1}/locations`)).toHaveLength(2);
  });

  it("answers nothing for a trip with no vehicle", async () => {
    boot({ [`GET ${P}/trips/${TRIP}`]: { body: {} } });
    expect(await fetchTripPath(TRIP)).toEqual([]);
  });
});

describe("alerts are the drivers' breakdown reports", () => {
  const incident = (o: Record<string, unknown> = {}) => ({
    id: "i1", trip_id: TRIP, event_id: "ev1", severity: "medium", summary: "Bus broken down. Flat tyre", status: "open", created_at: "2026-11-24T06:00:00Z",
    acknowledged_by: null, acknowledged_at: null, ...o,
  });

  it("lists the open incidents of trips on the road and of the last day, newest first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-24T08:00:00Z"));
    boot({
      [`GET ${P}/trips`]: { body: { trips: [
        apiTrip(),
        apiTrip({ id: TRIP2, vehicle_id: V2, status: "completed", started_at: "2026-11-24T05:00:00Z" }),
        apiTrip({ id: "old", started_at: "2026-11-20T05:00:00Z", status: "completed" }),
      ], page: page() } },
      [`GET ${P}/vehicles`]: list("vehicles", [apiVehicle(), apiVehicle({ id: V2, plate_number: "KDB 100A" })]),
      [`GET ${P}/trips/${TRIP}/incidents`]: { body: { incidents: [incident()] } },
      [`GET ${P}/trips/${TRIP2}/incidents`]: { body: { incidents: [incident({ id: "i2", trip_id: TRIP2, created_at: "2026-11-24T07:00:00Z" }), incident({ id: "i3", trip_id: TRIP2, status: "acknowledged", acknowledged_at: "2026-11-24T07:05:00Z" })] } },
    });
    const open = await listAlerts(T);
    expect(open.map((a) => a.id)).toEqual(["i2", "i1"]);
    expect(open[1]).toMatchObject({ kind: "breakdown", detail: "Bus broken down. Flat tyre", trip_id: TRIP, vehicle: { plate_number: "KDA 214B" }, acknowledged_at: null });
    expect((await listAlerts(T, false)).map((a) => a.id)).toEqual(["i2", "i3", "i1"]);
    expect(api.callsTo(`GET ${P}/trips/old/incidents`)).toHaveLength(0);
  });

  it("acknowledges an incident on its own trip", async () => {
    boot({ [`POST ${P}/trips/${TRIP}/incidents/i1/acknowledge`]: { body: { incident: incident({ status: "acknowledged" }) } } });
    await acknowledgeAlert("i1", "someone", TRIP);
    expect(api.calls).toHaveLength(1);
    await expect(acknowledgeAlert("i1", "someone")).rejects.toThrow(/which trip/);
  });
});

describe("what the driver's screen holds for later", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
  };

  it("holds a position and a mark as calls with their own keys on the API, and as rows on Supabase", async () => {
    const q = new WriteQueue(memory(), sendQueuedWrite);
    q.setUser(DRIVER);
    initBackend({ kind: "api", apiUrl: BASE });
    await enqueueLocationPing(q, { tenantId: T, vehicleId: V1, tripId: TRIP, lat: -1.2, lng: 36.8, recordedAt: "2026-11-24T05:40:00.000Z" });
    await enqueueRiderMark(q, { tenantId: T, tripId: TRIP, studentId: L1, stopId: S1, status: "boarded", markedAt: "2026-11-24T05:50:00Z" });
    const held = await q.pending();
    expect(held.map((w) => [w.table, w.rows, w.api?.op])).toEqual([["vehicle_locations", [], "driver-location"], ["trip_riders", [], "trip-event"]]);
    expect(held[0]!.api).toMatchObject({ params: { tenantId: T, tripId: TRIP }, body: { lat: -1.2, lng: 36.8, recorded_at: "2026-11-24T05:40:00.000Z" } });
    expect(held[1]!.api!.body).toEqual({ event_type: "learner_boarded", learner_id: L1, stop_id: S1 });
    expect(held[0]!.api!.idempotencyKey).not.toBe(held[1]!.api!.idempotencyKey);
    expect(held[0]!.api!.idempotencyKey).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
    expect((await q.pendingFor("vehicle_locations")).length).toBe(1);

    initBackend({ kind: "supabase" });
    await enqueueLocationPing(q, { tenantId: T, vehicleId: V1, tripId: TRIP, lat: 1, lng: 2 });
    const rows = (await q.pending()).at(-1)!;
    expect(rows.api).toBeUndefined();
    expect(rows.rows).toHaveLength(1);
  });

  it("will not hold a mark taken back", async () => {
    const q = new WriteQueue(memory(), sendQueuedWrite);
    initBackend({ kind: "api", apiUrl: BASE });
    await expect(enqueueRiderMark(q, { tenantId: T, tripId: TRIP, studentId: L1, stopId: null, status: "expected", markedAt: "2026-11-24T05:50:00Z" })).rejects.toBeInstanceOf(NotOnApiError);
    expect(await q.pending()).toHaveLength(0);
  });

  const held = (api_: QueuedWrite["api"], extra: Partial<QueuedWrite> = {}): QueuedWrite => ({ id: "w1", table: "trip_riders", rows: [], queuedAt: "2026-11-24T05:50:00Z", attempts: 0, api: api_, ...extra });
  const event = { op: "trip-event", params: { tenantId: T, tripId: TRIP }, body: { event_type: "learner_boarded", learner_id: L1, stop_id: null }, idempotencyKey: "key-aaaaaaaa-1" };

  it("sends a held mark with its idempotency key, and counts the server's 200 'replayed' as sent", async () => {
    boot({ [`POST ${P}/trips/${TRIP}/events`]: { status: 200, body: { event: {}, replayed: true } } });
    await sendQueuedWrite(held(event));
    const call = api.callsTo(`POST ${P}/trips/${TRIP}/events`)[0]!;
    expect(call.headers["idempotency-key"]).toBe("key-aaaaaaaa-1");
    expect(call.body).toEqual(event.body);
  });

  it("sends a held position to its trip", async () => {
    boot({ [`POST ${P}/trips/${TRIP}/driver-location`]: { status: 201, body: { location: {}, replayed: false } } });
    await sendQueuedWrite(held({ op: "driver-location", params: { tenantId: T, tripId: TRIP }, body: { lat: 1, lng: 2, recorded_at: "2026-11-24T05:40:00.000Z" }, idempotencyKey: "key-bbbbbbbb-2" }, { table: "vehicle_locations" }));
    expect(api.callsTo(`POST ${P}/trips/${TRIP}/driver-location`)[0]!.headers["idempotency-key"]).toBe("key-bbbbbbbb-2");
  });

  it("waits for no answer and a server in trouble, and sets aside what the server refused", async () => {
    boot({ [`POST ${P}/trips/${TRIP}/events`]: { networkError: true } });
    expect(isRetryable(await sendQueuedWrite(held(event)).catch((e: unknown) => e))).toBe(true);
    api.on(`POST ${P}/trips/${TRIP}/events`, refused("service_unavailable", 503));
    expect(isRetryable(await sendQueuedWrite(held(event)).catch((e: unknown) => e))).toBe(true);
    api.on(`POST ${P}/trips/${TRIP}/events`, refused("conflict", 409, "The trip is not active"));
    const refusedErr = await sendQueuedWrite(held(event)).catch((e: unknown) => e);
    expect(isRetryable(refusedErr)).toBe(false);
    expect((refusedErr as Error).message).toBe("The trip is not active");
    api.on(`POST ${P}/trips/${TRIP}/events`, refused("validation_error", 400, "stale"));
    expect(isRetryable(await sendQueuedWrite(held(event)).catch((e: unknown) => e))).toBe(false);
  });

  it("sets aside a write held for Supabase and one it cannot place, without asking the server", async () => {
    boot({});
    const legacy = await sendQueuedWrite(held(undefined, { table: "attendance", rows: [{}] })).catch((e: unknown) => e);
    expect(isRetryable(legacy)).toBe(false);
    const unknown = await sendQueuedWrite(held({ ...event, op: "teleport" })).catch((e: unknown) => e);
    expect(isRetryable(unknown)).toBe(false);
    const noTrip = await sendQueuedWrite(held({ ...event, params: { tenantId: T } })).catch((e: unknown) => e);
    expect(isRetryable(noTrip)).toBe(false);
    expect(api.calls).toHaveLength(0);
  });

  it("drains the queue in order: a refusal is set aside, a failure to reach the server stops the run", async () => {
    boot({});
    const q = new WriteQueue(memory(), sendQueuedWrite);
    q.setUser(DRIVER);
    await q.enqueueApi("trip_riders", { op: event.op, params: event.params, body: event.body });
    await q.enqueueApi("trip_riders", { op: event.op, params: event.params, body: { ...event.body, event_type: "learner_alighted" } });
    await q.enqueueApi("trip_riders", { op: event.op, params: event.params, body: { ...event.body, learner_id: L2 } });
    let n = 0;
    api.on(`POST ${P}/trips/${TRIP}/events`, () => {
      n += 1;
      if (n === 1) return refused("conflict", 409, "The learner was already recorded as not boarded");
      if (n === 2) return { networkError: true };
      return { status: 201, body: { event: {}, replayed: false } };
    });
    expect(await q.flush()).toEqual({ sent: 0, remaining: 2 });
    expect((await q.rejected()).map((w) => w.rejected?.message)).toEqual(["The learner was already recorded as not boarded"]);
    expect(await q.flush()).toEqual({ sent: 2, remaining: 0 });
    expect(api.callsTo(`POST ${P}/trips/${TRIP}/events`)).toHaveLength(4);
  });
});

describe("a bus from the driver's own assignment", () => {
  it("has the vehicle and route and nothing the driver may not read", () => {
    const bus = busFromAssignment({
      id: "as", tenant_id: T, vehicle_id: V1, driver_id: DRIVER, route_id: R1, active: true, vehicle: { plate_number: "KDA 214B" }, driver: null, route: { name: "Route A" },
    }, "to_school");
    expect(bus).toMatchObject({ vehicle: { id: V1, plate_number: "KDA 214B", last_lat: null }, route: { id: R1, name: "Route A" }, stops: [], direction: "to_school", driver: null });
    expect(busFromAssignment({ id: "as", tenant_id: T, vehicle_id: V1, driver_id: DRIVER, route_id: null, active: true, vehicle: null, driver: null, route: null }, null).route).toBeNull();
  });
});
