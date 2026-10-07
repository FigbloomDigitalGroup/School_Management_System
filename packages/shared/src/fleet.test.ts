import { describe, expect, it } from "vitest";
import { distanceM, fmtDistance, isLive, routeProgress } from "./fleet";

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

describe("isLive", () => {
  const now = Date.parse("2026-10-07T08:00:00Z");
  it("is live within two minutes of the last ping, not after", () => {
    expect(isLive("2026-10-07T07:59:00Z", now)).toBe(true);
    expect(isLive("2026-10-07T07:57:00Z", now)).toBe(false);
    expect(isLive(null, now)).toBe(false);
  });
});
