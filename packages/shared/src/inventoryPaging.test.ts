import { describe, expect, it } from "vitest";
import {
  categoriesMatching, flagCountsByStore, flagSize, groupFlags, isoWeekStart, isSmallClinicChange, perHeadSeries, registerFilter, searchTerm,
  severityCounts, sortFlagsBySize, spendIncreases,
} from "./inventoryPaging";
import type { ConsumptionFlag } from "./inventoryStock";

function flag(over: Partial<ConsumptionFlag> = {}): ConsumptionFlag {
  return {
    kind: "usage_up", item_id: "i", item_name: "Rice", category: "kitchen", unit: "kg", purpose: "Lunch", occurred_on: "2026-11-17",
    period_from: null, expected: 19.8, actual: 25, headcount: 1073, baseline_headcount: 1082, visitors: 0, severity: "high", explained: false,
    reason: "25 kg of Rice", ...over,
  };
}

describe("search terms", () => {
  it("strips what would break a PostgREST or=() filter", () => {
    expect(searchTerm('  rice, (pishori) "x"*%: ')).toBe("rice pishori x");
    expect(searchTerm("")).toBe("");
  });
  it("matches category labels", () => {
    expect(categoriesMatching("unif")).toEqual(["uniforms"]);
    expect(categoriesMatching("")).toEqual([]);
  });
  it("builds the register filter with quoted wildcards", () => {
    expect(registerFilter("ruler")).toBe('name.ilike."*ruler*",asset_tag.ilike."*ruler*",location.ilike."*ruler*"');
    expect(registerFilter("Uniforms")).toContain("category.in.(uniforms)");
    expect(registerFilter("   ")).toBeNull();
  });
});

describe("clinic noise", () => {
  it("treats a clinic use change under 10 units both sides as small", () => {
    expect(isSmallClinicChange(flag({ category: "medical", expected: 4, actual: 8 }))).toBe(true);
    expect(isSmallClinicChange(flag({ category: "medical", expected: 4, actual: 12 }))).toBe(false);
    expect(isSmallClinicChange(flag({ category: "kitchen", expected: 4, actual: 8 }))).toBe(false);
    expect(isSmallClinicChange(flag({ category: "medical", kind: "run_out", expected: 1, actual: 2 }))).toBe(false);
  });

  it("groups alarms, small changes and explained rises, biggest first within severity", () => {
    const flags = [
      flag({ item_id: "a", severity: "medium", expected: 10, actual: 30 }),
      flag({ item_id: "b", severity: "high", expected: 20, actual: 25 }),
      flag({ item_id: "c", severity: "high", expected: 10, actual: 40 }),
      flag({ item_id: "d", category: "medical", severity: "high", expected: 4, actual: 8 }),
      flag({ item_id: "e", explained: true }),
    ];
    const g = groupFlags(flags);
    expect(g.alarms.map((f) => f.item_id)).toEqual(["c", "b", "a"]);
    expect(g.small.map((f) => f.item_id)).toEqual(["d"]);
    expect(g.explained.map((f) => f.item_id)).toEqual(["e"]);
  });

  it("sizes flags by the change, or the amount alone", () => {
    expect(flagSize({ expected: 10, actual: 4 })).toBe(6);
    expect(flagSize({ expected: null, actual: 7 })).toBe(7);
    expect(sortFlagsBySize([flag({ severity: "low", expected: 0, actual: 100 }), flag({ severity: "high", expected: 0, actual: 1 })])[0]!.severity).toBe("high");
  });

  it("counts by store and severity, leaving out small and explained", () => {
    const counts = flagCountsByStore([
      flag(), flag({ severity: "medium" }), flag({ category: "medical", expected: 2, actual: 5 }), flag({ explained: true }),
      flag({ category: "stationery", severity: "high" }),
    ]);
    expect(counts).toEqual([
      { store: "kitchen", counts: { high: 1, medium: 1, low: 0 }, total: 2 },
      { store: "stationery", counts: { high: 1, medium: 0, low: 0 }, total: 1 },
    ]);
    expect(severityCounts([flag(), flag({ severity: "low" })])).toEqual({ high: 1, medium: 0, low: 1 });
  });
});

describe("trends", () => {
  it("finds the Monday of a week", () => {
    expect(isoWeekStart("2026-11-19")).toBe("2026-11-16");
    expect(isoWeekStart("2026-11-16")).toBe("2026-11-16");
    expect(isoWeekStart("2026-11-22")).toBe("2026-11-16");
  });

  it("puts use next to headcount per day, with no per-head figure when nobody was in", () => {
    const pts = perHeadSeries(
      [{ period_start: "2026-11-17", used: 25 }, { period_start: "2026-11-18", used: 20 }],
      [{ day: "2026-11-17", learners: 1000, staff: 73, visitors: 0, total: 1073 }, { day: "2026-11-18", learners: 0, staff: 0, visitors: 0, total: 0 }],
      "day",
    );
    expect(pts).toEqual([
      { period: "2026-11-17", used: 25, heads: 1073, perHead: 25 / 1073 },
      { period: "2026-11-18", used: 20, heads: 0, perHead: null },
    ]);
  });

  it("averages a week's headcount for weekly use", () => {
    const pts = perHeadSeries(
      [{ period_start: "2026-11-16", used: 10 }],
      [{ day: "2026-11-16", learners: 90, staff: 10, visitors: 0, total: 100 }, { day: "2026-11-17", learners: 290, staff: 10, visitors: 0, total: 300 }],
      "week",
    );
    expect(pts).toEqual([{ period: "2026-11-16", used: 10, heads: 200, perHead: 0.05 }]);
  });

  it("lists only rises in spend, biggest first", () => {
    const r = spendIncreases([
      { item_id: "a", period_start: "2026-10-01", spend_cents: 100 }, { item_id: "a", period_start: "2026-11-01", spend_cents: 500 },
      { item_id: "b", period_start: "2026-10-01", spend_cents: 900 }, { item_id: "b", period_start: "2026-11-01", spend_cents: 100 },
      { item_id: "c", period_start: "2026-11-01", spend_cents: 1000 },
    ], "2026-11-01", "2026-10-01");
    expect(r.map((x) => [x.item_id, x.rise])).toEqual([["c", 1000], ["a", 400]]);
  });
});
