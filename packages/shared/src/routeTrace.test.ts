import { describe, expect, it } from "vitest";
import { distanceM } from "./fleet";
import { endsAtRoute, isUsableTrace, pickRouteTrace, simplifyPath, TRACE_RULES, type PathPoint } from "./routeTrace";

// A route about 5.5 km long, with a road that is not straight: east along -1.300, then north-east.
const A: PathPoint = { lat: -1.3, lng: 36.7 };
const CORNER: PathPoint = { lat: -1.3, lng: 36.73 };
const B: PathPoint = { lat: -1.27, lng: 36.75 };
const STOPS = [A, B];

/** `n + 1` evenly spaced points from a to b. */
function line(a: PathPoint, b: PathPoint, n: number): PathPoint[] {
  return Array.from({ length: n + 1 }, (_, i) => ({ lat: a.lat + ((b.lat - a.lat) * i) / n, lng: a.lng + ((b.lng - a.lng) * i) / n }));
}
/** A whole trip down the bent road: pings about 100 m apart. */
const ROAD = [...line(A, CORNER, 33), ...line(CORNER, B, 35).slice(1)];

describe("simplifyPath", () => {
  it("keeps just the ends of a straight line", () => {
    const straight = line(A, CORNER, 40);
    expect(simplifyPath(straight, 10)).toEqual([straight[0], straight[40]]);
  });

  it("keeps the corner of a bent road, and loses the pings on the straight parts", () => {
    const out = simplifyPath(ROAD, 10);
    expect(out.length).toBeLessThan(6);
    expect(out[0]).toEqual(A);
    expect(out[out.length - 1]).toEqual(B);
    expect(out.some((p) => distanceM(p, CORNER) < 150)).toBe(true);
  });

  it("drops a wobble smaller than the tolerance, but keeps one bigger than it", () => {
    const wobble = (m: number) => [A, { lat: A.lat + m / 110_540, lng: 36.705 }, { lat: A.lat, lng: 36.71 }];
    expect(simplifyPath(wobble(5), 12)).toHaveLength(2);
    expect(simplifyPath(wobble(40), 12)).toHaveLength(3);
  });

  it("leaves short input alone and does not change what it was given", () => {
    expect(simplifyPath([], 10)).toEqual([]);
    expect(simplifyPath([A], 10)).toEqual([A]);
    expect(simplifyPath([A, B], 10)).toEqual([A, B]);
    const copy = ROAD.map((p) => ({ ...p }));
    simplifyPath(ROAD, 10);
    expect(ROAD).toEqual(copy);
  });

  it("handles a bus that sat still (identical points) without dividing by zero", () => {
    const parked = [A, A, A, A, B];
    expect(() => simplifyPath(parked, 10)).not.toThrow();
    expect(simplifyPath(parked, 10)[0]).toEqual(A);
  });
});

describe("endsAtRoute", () => {
  it("accepts a trace from the first stop to the last, or the other way round", () => {
    expect(endsAtRoute(ROAD, STOPS)).toBe(true);
    expect(endsAtRoute([...ROAD].reverse(), STOPS)).toBe(true);
  });

  it("rejects one that stopped halfway, or that is nowhere near the route", () => {
    expect(endsAtRoute(ROAD.slice(0, 30), STOPS)).toBe(false);
    expect(endsAtRoute(line({ lat: 0, lng: 0 }, { lat: 0, lng: 0.05 }, 20), STOPS)).toBe(false);
  });

  it("needs at least two stops and two points", () => {
    expect(endsAtRoute(ROAD, [A])).toBe(false);
    expect(endsAtRoute([A], STOPS)).toBe(false);
  });
});

describe("isUsableTrace", () => {
  it("accepts a trip driven the whole way", () => {
    expect(isUsableTrace(ROAD, STOPS)).toBe(true);
  });

  it("rejects a trip with too few pings, even when every ping is close to the last", () => {
    // A short route (about 650 m) driven with five pings: ends line up, no gaps, nothing wrong but how little there is.
    const shortEnd: PathPoint = { lat: A.lat, lng: A.lng + 0.006 };
    const fewPings = line(A, shortEnd, 4);
    expect(fewPings.length).toBeLessThan(TRACE_RULES.minPoints);
    expect(isUsableTrace(fewPings, [A, shortEnd])).toBe(false);
    expect(isUsableTrace(line(A, shortEnd, TRACE_RULES.minPoints), [A, shortEnd])).toBe(true);
  });

  it("rejects a trip with a signal dropout, which would draw a straight line across the gap", () => {
    const dropout = [...line(A, CORNER, 10), ...line(B, B, 8)]; // jumps from the corner-ish to B with ~4 km unreported
    expect(isUsableTrace(dropout, STOPS)).toBe(false);
  });

  it("rejects a trip that never came near a stop on the way, and allows a stop a little off the road", () => {
    // Same trip, same ends, same ping spacing: the only difference is where the middle stop is.
    const onTheRoad: PathPoint = { lat: -1.3, lng: 36.72 };
    const nearby: PathPoint = { lat: -1.3 + 300 / 110_540, lng: 36.72 }; // 300 m off the road
    const faroff: PathPoint = { lat: -1.3 + 1_500 / 110_540, lng: 36.72 }; // 1.5 km off it: the bus went another way
    expect(isUsableTrace(ROAD, [A, onTheRoad, B])).toBe(true);
    expect(isUsableTrace(ROAD, [A, nearby, B])).toBe(true);
    expect(isUsableTrace(ROAD, [A, faroff, B])).toBe(false);
  });
});

describe("pickRouteTrace", () => {
  it("takes the newest trip that was driven the whole way, skipping a newer one that was not", () => {
    const aborted = ROAD.slice(0, 20); // the latest trip was ended early
    const picked = pickRouteTrace([aborted, ROAD], STOPS);
    expect(picked).not.toBeNull();
    expect(picked![0]).toEqual(A);
    expect(picked![picked!.length - 1]).toEqual(B);
  });

  it("returns the path simplified, not every ping", () => {
    const picked = pickRouteTrace([ROAD], STOPS)!;
    expect(picked.length).toBeLessThan(ROAD.length / 5);
  });

  it("returns null when no trip qualifies, and when there are none", () => {
    expect(pickRouteTrace([ROAD.slice(0, 20)], STOPS)).toBeNull();
    expect(pickRouteTrace([], STOPS)).toBeNull();
  });

  it("ignores pings with a missing or broken position", () => {
    const noisy = [{ lat: NaN, lng: 36.7 }, ...ROAD.slice(0, 40), { lat: 91, lng: Infinity }, ...ROAD.slice(40)];
    const picked = pickRouteTrace([noisy], STOPS);
    expect(picked).not.toBeNull();
    expect(picked!.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))).toBe(true);
  });
});
