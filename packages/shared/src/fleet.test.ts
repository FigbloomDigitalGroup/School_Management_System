import { describe, expect, it } from "vitest";
import { arrangeRiders, breakdownAffected, distanceM, fmtDistance, fmtEta, isLive, locationPingRow, riderMarkRow, roughEta, routeProgress, type TripRider } from "./fleet";

// Three stops roughly 1.5-3km apart along a line, Nakuru-ish.
const STOPS = [
  { lat: -0.2833, lng: 36.0667 },
  { lat: -0.2833, lng: 36.0800 },
  { lat: -0.2833, lng: 36.1000 },
];

describe("distanceM", () => {
  it("is zero for the same point and ~111km for a degree of latitude", () => {
    expect(distanceM(STOPS[0]!, STOPS[0]!)).toBe(0);
    expect(distanceM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeGreaterThan(110_000);
    expect(distanceM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeLessThan(112_000);
  });
});

describe("routeProgress", () => {
  it("is at a stop when within 150m, heading to the one after", () => {
    expect(routeProgress(STOPS, { lat: -0.2834, lng: 36.0801 })).toEqual({ atIndex: 1, nextIndex: 2, offRouteM: null });
  });

  it("has no next stop when at the last one", () => {
    expect(routeProgress(STOPS, STOPS[2]!)).toEqual({ atIndex: 2, nextIndex: null, offRouteM: null });
  });

  it("between stops 0 and 1, closer to 0, is heading to 1 (0 is behind it)", () => {
    expect(routeProgress(STOPS, { lat: -0.2833, lng: 36.0700 })).toEqual({ atIndex: null, nextIndex: 1, offRouteM: null });
  });

  it("between stops 1 and 2, just past 1, is heading to 2", () => {
    expect(routeProgress(STOPS, { lat: -0.2833, lng: 36.0830 })).toEqual({ atIndex: null, nextIndex: 2, offRouteM: null });
  });

  it("before the first stop, within 1.5km, is heading to it", () => {
    expect(routeProgress(STOPS, { lat: -0.2833, lng: 36.0560 })).toEqual({ atIndex: null, nextIndex: 0, offRouteM: null });
  });

  it("far from every stop is off route, heading for the first stop", () => {
    const far = routeProgress(STOPS, { lat: -1.3187, lng: 36.865 });
    expect(far.nextIndex).toBe(0);
    expect(far.atIndex).toBeNull();
    expect(far.offRouteM).toBeGreaterThan(100_000);
  });

  it("has nothing to say about a route with no stops", () => {
    expect(routeProgress([], STOPS[0]!)).toEqual({ atIndex: null, nextIndex: null, offRouteM: null });
  });
});

describe("fmtDistance", () => {
  it("uses metres under a kilometre and km above", () => {
    expect(fmtDistance(820)).toBe("800 m");
    expect(fmtDistance(2440)).toBe("2.4 km");
    expect(fmtDistance(143204)).toBe("143 km");
  });
});

describe("roughEta", () => {
  it("takes road distance as 1.3x the straight line, at 25 km/h", () => {
    // 0.045 degrees of longitude on the equator is ~5.0 km straight, ~6.5 km by road, ~15.6 min.
    const eta = roughEta({ lat: 0, lng: 0 }, { lat: 0, lng: 0.045 });
    expect(eta.km).toBeCloseTo(6.5, 1);
    expect(eta.minutes).toBe(16);
    expect(eta.estimated).toBe(true);
  });

  it("never says zero minutes, even standing at the stop", () => {
    expect(roughEta(STOPS[0]!, STOPS[0]!).minutes).toBe(1);
  });
});

describe("fmtEta", () => {
  it("marks a guess with a ~, leaves a road time bare, and shows a dash for none", () => {
    expect(fmtEta({ minutes: 16, km: 6.5, estimated: true })).toBe("~16 min");
    expect(fmtEta({ minutes: 9, km: 3.1, estimated: false })).toBe("9 min");
    expect(fmtEta(null)).toBe("—");
  });
});

describe("isLive", () => {
  const now = Date.parse("2026-10-07T08:00:00Z");
  it("is live within two minutes of the last ping, not after", () => {
    expect(isLive("2026-10-07T07:59:00Z", now)).toBe(true);
    expect(isLive("2026-10-07T07:57:00Z", now)).toBe(false);
    expect(isLive(null, now)).toBe(false);
  });
});

describe("locationPingRow", () => {
  const base = { tenantId: "t1", vehicleId: "v1", tripId: "trip1", lat: -0.28, lng: 36.07 };

  it("carries a passed recordedAt through as recorded_at, for a ping that might be queued", () => {
    const row = locationPingRow({ ...base, recordedAt: "2026-10-07T07:40:00.000Z" });
    expect(row.recorded_at).toBe("2026-10-07T07:40:00.000Z");
  });

  it("omits recorded_at for an always-live ping, so the column default (insert time) applies", () => {
    const row = locationPingRow(base);
    expect(row).not.toHaveProperty("recorded_at");
  });

  it("defaults speed and heading to null when not reported", () => {
    const row = locationPingRow(base);
    expect(row.speed_kmh).toBeNull();
    expect(row.heading).toBeNull();
  });
});

function rider(name: string, fields: Partial<TripRider> = {}): TripRider {
  return { student_id: name, full_name: name, stop_id: null, status: "expected", boarded_at: null, alighted_at: null, absent_from_class: false, ...fields };
}

describe("arrangeRiders", () => {
  it("puts children on the bus first, then those waiting in stop order, then the greyed-out rest", () => {
    const list = arrangeRiders([
      rider("Dropped", { status: "alighted", stop_id: "s1" }),
      rider("Wanjiru", { stop_id: "s2" }),
      rider("Absent", { absent_from_class: true, stop_id: "s1" }),
      rider("Amani", { stop_id: "s1" }),
      rider("Onboard", { status: "boarded", stop_id: "s2" }),
      rider("NotHere", { status: "absent" }),
      rider("NoStop"),
    ], ["s1", "s2"]);
    expect(list.map((r) => r.full_name)).toEqual(["Onboard", "Amani", "Wanjiru", "NoStop", "Dropped", "NotHere", "Absent"]);
    expect(list.map((r) => r.faded)).toEqual([false, false, false, false, true, true, true]);
    expect(list.filter((r) => r.struck).map((r) => r.full_name)).toEqual(["Absent"]);
  });

  it("treats a child absent from class who got on anyway as on the bus", () => {
    const [r] = arrangeRiders([rider("Amani", { status: "boarded", absent_from_class: true })], []);
    expect(r!.place).toBe("on_bus");
    expect(r!.struck).toBe(false);
  });
});

describe("breakdownAffected", () => {
  it("is everyone on the bus or still waiting, not those dropped off, not here or absent from class", () => {
    const affected = breakdownAffected([
      rider("Onboard", { status: "boarded" }),
      rider("Waiting"),
      rider("Dropped", { status: "alighted" }),
      rider("NotHere", { status: "absent" }),
      rider("Absent", { absent_from_class: true }),
    ]);
    expect(affected.map((r) => r.full_name)).toEqual(["Onboard", "Waiting"]);
  });
});

describe("riderMarkRow", () => {
  const base = { tenantId: "t1", tripId: "trip1", studentId: "s1", stopId: "stop1", markedAt: "2026-10-27T12:31:00.000Z" };

  it("stamps the tap time on the matching column, so a queued mark keeps its real time", () => {
    expect(riderMarkRow({ ...base, status: "boarded" }).boarded_at).toBe(base.markedAt);
    expect(riderMarkRow({ ...base, status: "alighted" }).alighted_at).toBe(base.markedAt);
  });

  it("sends no time for not-here or an undo back to expected", () => {
    expect(riderMarkRow({ ...base, status: "absent" })).not.toHaveProperty("boarded_at");
    expect(riderMarkRow({ ...base, status: "expected" })).not.toHaveProperty("alighted_at");
  });
});
