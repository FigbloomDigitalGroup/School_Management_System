import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertRow, BusOnRoute, TripRow } from "./fleet";
import type { Vehicle } from "./types";

// The fleet as one answer: the readers it is made of are the ones the web's Fleet screen uses, so they are stood in for here.
const readers = vi.hoisted(() => ({ listBusesOnRoutes: vi.fn(), listAlerts: vi.fn(), listTrips: vi.fn() }));
vi.mock("./fleet", async (importOriginal) => ({ ...(await importOriginal<typeof import("./fleet")>()), ...readers }));

import { busesLiveFirst, busStatusLine, fetchFleetNow, FLEET_ALERT_LABEL, fleetDateTime, RECENT_TRIPS, tripLine, tripTimes, withPosition } from "./adminFleet";

const NOW = Date.parse("2026-11-07T08:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const vehicle = (id: string, plate: string, ping: string | null, over: Partial<Vehicle> = {}): Vehicle => ({
  id, tenant_id: "school-1", plate_number: plate, make_model: null, capacity: 40, active: true, last_lat: -1.29, last_lng: 36.82, last_ping_at: ping, speed_limit_kmh: 80, created_at: "x", ...over,
});
const bus = (id: string, plate: string, ping: string | null): BusOnRoute => ({ vehicle: vehicle(id, plate, ping), driverName: null, driver: null, route: null, stops: [], direction: null });

beforeEach(() => {
  Object.values(readers).forEach((r) => r.mockReset());
  readers.listBusesOnRoutes.mockResolvedValue([]);
  readers.listAlerts.mockResolvedValue([]);
  readers.listTrips.mockResolvedValue([]);
});

describe("the fleet, as one answer", () => {
  it("reads the buses, the open alerts and the latest trips for the school", async () => {
    const buses = [bus("v1", "KDA 001A", null)];
    const alerts = [{ id: "a1" }] as AlertRow[];
    const trips = [{ id: "t1" }] as TripRow[];
    readers.listBusesOnRoutes.mockResolvedValue(buses);
    readers.listAlerts.mockResolvedValue(alerts);
    readers.listTrips.mockResolvedValue(trips);
    expect(await fetchFleetNow("school-1")).toEqual({ buses, alerts, trips });
    expect(readers.listBusesOnRoutes).toHaveBeenCalledWith("school-1");
    expect(readers.listAlerts).toHaveBeenCalledWith("school-1");
    // across the whole fleet (no vehicle), the latest few
    expect(readers.listTrips).toHaveBeenCalledWith("school-1", undefined, RECENT_TRIPS);
    expect(RECENT_TRIPS).toBe(20);
  });

  it("says what a reader said when one of them fails, instead of an answer with a hole in it", async () => {
    readers.listAlerts.mockRejectedValue(new Error("permission denied for table vehicle_alerts"));
    await expect(fetchFleetNow("school-1")).rejects.toThrow("permission denied for table vehicle_alerts");
  });
});

describe("a bus on the move", () => {
  it("is laid over the same bus only, with where it is and when it said so", () => {
    const buses = [bus("v1", "KDA 001A", ago(600_000)), bus("v2", "KDA 002B", ago(600_000))];
    const moved = withPosition(buses, { id: "v2", last_lat: -1.3, last_lng: 36.9, last_ping_at: ago(5_000) });
    expect(moved[0]).toBe(buses[0]);
    expect(moved[1]!.vehicle).toMatchObject({ plate_number: "KDA 002B", last_lat: -1.3, last_lng: 36.9, last_ping_at: ago(5_000), capacity: 40 });
    expect(buses[1]!.vehicle.last_lat).toBe(-1.29);
  });

  it("leaves the buses as they are for a position from a bus that is not on the list", () => {
    const buses = [bus("v1", "KDA 001A", null)];
    expect(withPosition(buses, { id: "other", last_lat: 1, last_lng: 1, last_ping_at: ago(0) })).toEqual(buses);
  });

  it("lists the buses on the road first, then the rest, each by number plate", () => {
    const sorted = busesLiveFirst([bus("a", "KDA 004D", null), bus("b", "KDA 003C", ago(30_000)), bus("c", "KDA 001A", ago(3_600_000)), bus("d", "KDA 002B", ago(60_000))], NOW);
    expect(sorted.map((b) => b.vehicle.plate_number)).toEqual(["KDA 002B", "KDA 003C", "KDA 001A", "KDA 004D"]);
  });

  it("counts a position more than two minutes old as not on the road", () => {
    const sorted = busesLiveFirst([bus("a", "AAA", ago(2 * 60_000 + 1)), bus("b", "BBB", ago(2 * 60_000))], NOW);
    expect(sorted.map((b) => b.vehicle.plate_number)).toEqual(["BBB", "AAA"]);
  });
});

describe("where a bus stands", () => {
  it("says on the road now, and how fresh the position is", () => {
    expect(busStatusLine({ last_ping_at: ago(10_000) }, NOW)).toBe("On the road now · updated just now");
    expect(busStatusLine({ last_ping_at: ago(90_000) }, NOW)).toBe("On the road now · updated 1 min ago");
    expect(busStatusLine({ last_ping_at: ago(120_000) }, NOW)).toBe("On the road now · updated 2 min ago");
  });

  it("says when it was last seen, once it has stopped reporting", () => {
    const status = busStatusLine({ last_ping_at: "2026-11-05T14:05:00" }, NOW);
    expect(status).toBe(`Last seen ${fleetDateTime("2026-11-05T14:05:00")}`);
    expect(status).toMatch(/^Last seen .*Nov/);
  });

  it("says it has not reported when it never has", () => {
    expect(busStatusLine({ last_ping_at: null }, NOW)).toBe("Not reporting yet");
  });
});

describe("what a trip was", () => {
  const trip = (over: Partial<TripRow> = {}): Pick<TripRow, "direction" | "route" | "driver" | "started_at" | "ended_at" | "status"> => ({
    direction: "to_school", route: { name: "Route A" }, driver: { full_name: "Joseph Kamau" }, started_at: new Date(2026, 10, 7, 6, 40).toISOString(), ended_at: new Date(2026, 10, 7, 7, 35).toISOString(), status: "completed", ...over,
  });

  it("says which way, on which route, and who drove", () => {
    expect(tripLine(trip())).toBe("To school · Route A · Joseph Kamau");
    expect(tripLine(trip({ direction: "from_school" }))).toBe("From school · Route A · Joseph Kamau");
    expect(tripLine(trip({ route: null, driver: null }))).toBe("To school · No route · A driver");
  });

  it("says when it started and ended, on this device's clock", () => {
    expect(tripTimes(trip())).toBe("06:40 – 07:35");
  });

  it("says it is on the road while it has not ended, and that a cancelled trip was cancelled", () => {
    expect(tripTimes(trip({ ended_at: null, status: "active" }))).toBe("06:40 – on the road");
    expect(tripTimes(trip({ ended_at: null, status: "cancelled" }))).toBe("06:40 · Cancelled");
  });
});

describe("what an alert says", () => {
  it("names each kind the database raises", () => {
    expect(FLEET_ALERT_LABEL).toEqual({ speed: "Speeding", geofence: "Off route", rider: "Children still on the bus", breakdown: "Bus broken down" });
  });
});
