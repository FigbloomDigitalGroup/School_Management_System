import { describe, expect, it } from "vitest";
import {
  cheapestInsertion, clusterHomes, describeSuggestion, haversineM, orderStops, pathLengthM,
  rebuildStopsFromHomes, stopNameFor, suggestRouteForHome, type PlanRoute,
} from "./routePlanning";

// Around Nairobi: 0.001 deg of latitude is ~111 m.
const SCHOOL = { lat: -1.2000, lng: 36.9000 };
const north = (m: number, from = SCHOOL) => ({ lat: from.lat + m / 111_195, lng: from.lng });
const east = (m: number, from = SCHOOL) => ({ lat: from.lat, lng: from.lng + m / (111_195 * Math.cos((from.lat * Math.PI) / 180)) });

describe("haversineM", () => {
  it("measures short distances to within a metre or so", () => {
    expect(haversineM(SCHOOL, north(1000))).toBeCloseTo(1000, -1);
    expect(haversineM(SCHOOL, east(500))).toBeCloseTo(500, -1);
    expect(haversineM(SCHOOL, SCHOOL)).toBe(0);
  });
});

describe("stopNameFor", () => {
  it("prefers the landmark, then the first part of the address", () => {
    expect(stopNameFor(" Opposite Naivas ", "Plot 4, Kahawa")).toBe("Opposite Naivas");
    expect(stopNameFor("", "Plot 4, Kahawa Sukari")).toBe("Plot 4");
    expect(stopNameFor(null, null)).toBe("New stop");
    expect(stopNameFor("x".repeat(80), null).length).toBeLessThanOrEqual(60);
  });
});

const routeA: PlanRoute = {
  id: "A", name: "Route A",
  stops: [
    { id: "a1", name: "School", ...SCHOOL, sequence: 1 },
    { id: "a2", name: "Kahawa", ...north(2000), sequence: 2 },
    { id: "a3", name: "Githurai", ...north(4000), sequence: 3 },
  ],
};
const routeB: PlanRoute = {
  id: "B", name: "Route B",
  stops: [
    { id: "b1", name: "School", ...SCHOOL, sequence: 1 },
    { id: "b2", name: "Ruiru Rd", ...east(2000), sequence: 2 },
    { id: "b3", name: "Membley", ...east(4000), sequence: 3 },
  ],
};

describe("suggestRouteForHome", () => {
  it("joins an existing stop within walking distance", () => {
    const s = suggestRouteForHome(north(250, routeA.stops[1]!), [routeA, routeB]);
    expect(s).toMatchObject({ kind: "join", routeId: "A", stopId: "a2", stopName: "Kahawa" });
    expect(s?.kind === "join" && s.distanceM).toBeCloseTo(250, -1);
    expect(describeSuggestion(s!)).toBe("Joins Route A at Kahawa (250 m away)");
  });

  it("adds a stop between two stops on the route it's cheapest to detour", () => {
    // 3 km east, 600 m north of the line: between Ruiru Rd and Membley on B
    const home = north(600, east(3000));
    const s = suggestRouteForHome(home, [routeA, routeB], { stopName: "Near Total" });
    expect(s).toMatchObject({ kind: "new_stop", routeId: "B", position: 3, stopName: "Near Total" });
  });

  it("adds a stop at the end of a route for a home past its last stop", () => {
    const s = suggestRouteForHome(north(5500), [routeA, routeB]);
    expect(s).toMatchObject({ kind: "new_stop", routeId: "A", position: 4 });
    expect(s?.kind === "new_stop" && s.addedM).toBeCloseTo(1500, -1);
  });

  it("never puts a new stop before the school end", () => {
    const s = suggestRouteForHome(north(-800), [routeA]);
    expect(s?.kind === "new_stop" && s.position).toBeGreaterThan(1);
  });

  it("respects a custom walk radius", () => {
    const s = suggestRouteForHome(north(250, routeA.stops[1]!), [routeA], { walkRadiusM: 100 });
    expect(s?.kind).toBe("new_stop");
  });

  it("uses an empty route only when nothing else exists", () => {
    const empty: PlanRoute = { id: "E", name: "Route E", stops: [] };
    expect(suggestRouteForHome(north(3000), [empty, routeA])?.routeId).toBe("A");
    expect(suggestRouteForHome(north(3000), [empty])).toMatchObject({ kind: "new_stop", routeId: "E", position: 1, addedM: 0 });
    expect(suggestRouteForHome(north(3000), [])).toBeNull();
  });
});

describe("cheapestInsertion", () => {
  it("slots a point into the middle of a straight line for free", () => {
    const line = [SCHOOL, north(1000), north(2000)];
    const r = cheapestInsertion(line, north(1500));
    expect(r?.index).toBe(2);
    expect(r?.cost).toBeLessThan(1);
  });
});

describe("clusterHomes", () => {
  it("groups homes within the radius and keeps far ones apart", () => {
    const homes = [north(1000), north(1100), east(80, north(1050)), north(3000), north(3150)].map((p, i) => ({ ...p, id: i }));
    const groups = clusterHomes(homes, 300);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.length).sort()).toEqual([2, 3]);
  });

  it("gives each home its own stop when they're spread out", () => {
    expect(clusterHomes([north(0), north(1000), north(2000)], 300)).toHaveLength(3);
  });
});

describe("orderStops", () => {
  it("drives outward from the school without doubling back", () => {
    const shuffled = [north(3000), north(1000), north(4000), north(2000)];
    const ordered = orderStops(shuffled, SCHOOL);
    expect(ordered.map((p) => Math.round(haversineM(SCHOOL, p) / 1000))).toEqual([1, 2, 3, 4]);
  });

  it("untangles a crossing nearest-neighbour leaves behind", () => {
    // A zig-zag where greedy picks a poor order; 2-opt should not be longer than greedy.
    const pts = [east(1000), north(1200, east(200)), east(2000), north(1200, east(2200)), east(3000)];
    const ordered = orderStops(pts, SCHOOL);
    const naive = pathLengthM(pts, SCHOOL);
    expect(pathLengthM(ordered, SCHOOL)).toBeLessThanOrEqual(naive + 1);
    expect(ordered).toHaveLength(pts.length);
  });

  it("starts from one end of the line when there's no school", () => {
    const ordered = orderStops([north(2000), north(0), north(4000), north(1000)], null);
    const km = ordered.map((p) => Math.round(haversineM(SCHOOL, p) / 1000));
    expect(km[0] === 0 || km[0] === 4).toBe(true);
    expect(pathLengthM(ordered)).toBeCloseTo(4000, -1);
  });
});

describe("rebuildStopsFromHomes", () => {
  const anchor = { id: "a1", name: "School", ...SCHOOL };
  const homes = [
    { studentId: "s1", ...north(2050), landmark: "Kahawa stage" },
    { studentId: "s2", ...north(1950), landmark: "Kahawa stage" },
    { studentId: "s3", ...north(3990), address: "Githurai 45, off Thika Rd" },
    { studentId: "s4", ...east(150, north(1000)), landmark: null },
  ];

  it("keeps the school end first, clusters, orders and names the stops", () => {
    const planned = rebuildStopsFromHomes(homes, { anchor });
    expect(planned[0]).toMatchObject({ id: "a1", name: "School", studentIds: [] });
    expect(planned.slice(1).map((p) => p.studentIds.sort())).toEqual([["s4"], ["s1", "s2"], ["s3"]]);
    expect(planned[2]!.name).toBe("Kahawa stage");
    expect(planned[3]!.name).toBe("Githurai 45");
    expect(planned[1]!.name).toBe("Stop 1");
  });

  it("reuses an existing stop that's practically the same place", () => {
    const existing = [anchor, { id: "a2", name: "Kahawa", ...north(2000) }];
    const planned = rebuildStopsFromHomes(homes, { anchor, existing });
    const kahawa = planned.find((p) => p.studentIds.includes("s1"))!;
    expect(kahawa).toMatchObject({ id: "a2", name: "Kahawa" });
    expect(planned.filter((p) => p.id === "a2")).toHaveLength(1);
  });

  it("works with no anchor and no homes", () => {
    expect(rebuildStopsFromHomes([], {})).toEqual([]);
    expect(rebuildStopsFromHomes([], { anchor })).toHaveLength(1);
  });
});
