import { describe, expect, it } from "vitest";
import {
  formatQty, inStore, monthsBack, movementDelta, movementProblem, periodRange, sortFlags, spendByMonthFor, stockOverview, stockStatus, stockTakeDelta,
  storeOf, summariseStores, usageByItem,
  type ConsumptionFlag, type SpendRow, type StockLevel, type UsageRow,
} from "./inventoryStock";

const NOW = new Date(2026, 10, 24, 10, 0); // Tue 24 Nov 2026, local

describe("movementDelta", () => {
  it("adds deliveries, takes away use and waste, and keeps a stock-take's sign", () => {
    expect(movementDelta({ kind: "received", quantity: 50 })).toBe(50);
    expect(movementDelta({ kind: "used", quantity: 20 })).toBe(-20);
    expect(movementDelta({ kind: "wasted", quantity: 3 })).toBe(-3);
    expect(movementDelta({ kind: "adjusted", quantity: -8 })).toBe(-8);
    expect(movementDelta({ kind: "adjusted", quantity: 2 })).toBe(2);
  });
});

describe("formatQty", () => {
  it("writes the unit, singular for one", () => {
    expect(formatQty(25, "kg")).toBe("25 kg");
    expect(formatQty(1, "bags")).toBe("1 bag");
    expect(formatQty(1, "litres")).toBe("1 litre");
    expect(formatQty(1, "boxes")).toBe("1 box");
    expect(formatQty(1, "kg")).toBe("1 kg");
    expect(formatQty(1200, "kg")).toBe("1,200 kg");
    expect(formatQty(6.96, "kg")).toBe("7 kg");
    expect(formatQty(12, null)).toBe("12");
  });
});

describe("stockStatus", () => {
  it("is out at zero, low at or below the reorder level, else fine", () => {
    expect(stockStatus({ quantity: 0, reorder_level: null })).toBe("out");
    expect(stockStatus({ quantity: 100, reorder_level: 100 })).toBe("low");
    expect(stockStatus({ quantity: 101, reorder_level: 100 })).toBe("ok");
    expect(stockStatus({ quantity: 5, reorder_level: null })).toBe("ok");
  });
});

describe("movementProblem", () => {
  const ok = { kind: "used" as const, quantity: 20, occurredOn: "2026-11-24" };
  it("accepts a sensible movement", () => {
    expect(movementProblem(ok, 100, NOW)).toBeNull();
    expect(movementProblem({ ...ok, kind: "adjusted", quantity: -8 }, 100, NOW)).toBeNull();
    expect(movementProblem({ ...ok, kind: "received", quantity: 500, unitCostCents: 9000 }, 0, NOW)).toBeNull();
  });
  it("refuses taking out more than is in stock, as the database does", () => {
    expect(movementProblem({ ...ok, quantity: 120 }, 100, NOW)).toBe("Only 100 in stock.");
    expect(movementProblem({ ...ok, kind: "adjusted", quantity: -101 }, 100, NOW)).toBe("Only 100 in stock.");
  });
  it("holds the sign rules: only a stock-take may be negative, nothing may be zero or a fraction", () => {
    expect(movementProblem({ ...ok, quantity: -5 }, 100, NOW)).toMatch(/positive/);
    expect(movementProblem({ ...ok, kind: "received", quantity: -5 }, 100, NOW)).toMatch(/positive/);
    expect(movementProblem({ ...ok, quantity: 0 }, 100, NOW)).toMatch(/whole number/);
    expect(movementProblem({ ...ok, quantity: 2.5 }, 100, NOW)).toMatch(/whole number/);
  });
  it("refuses a future date, a bad price and a bad meal count", () => {
    expect(movementProblem({ ...ok, occurredOn: "2026-11-25" }, 100, NOW)).toMatch(/future/);
    expect(movementProblem({ ...ok, occurredOn: "" }, 100, NOW)).toMatch(/date/);
    expect(movementProblem({ ...ok, kind: "received", unitCostCents: -1 }, 100, NOW)).toMatch(/price/);
    expect(movementProblem({ ...ok, mealsServed: -3 }, 100, NOW)).toMatch(/Meals/);
  });
});

describe("stockTakeDelta", () => {
  it("is what was counted less what the register says", () => {
    expect(stockTakeDelta(50, 42)).toBe(-8);
    expect(stockTakeDelta(50, 53)).toBe(3);
  });
});

describe("periodRange", () => {
  it("runs from Monday for the week, the 1st for the month, 1 Jan for the year, to today", () => {
    expect(periodRange("week", NOW)).toEqual({ from: "2026-11-23", to: "2026-11-24" });
    expect(periodRange("month", NOW)).toEqual({ from: "2026-11-01", to: "2026-11-24" });
    expect(periodRange("year", NOW)).toEqual({ from: "2026-01-01", to: "2026-11-24" });
  });
  it("a Sunday's week started the Monday before", () => {
    expect(periodRange("week", new Date(2026, 10, 29))).toEqual({ from: "2026-11-23", to: "2026-11-29" });
  });
  it("uses the current term, cut at today, and falls back to the year with no term", () => {
    expect(periodRange("term", NOW, { starts_on: "2026-08-31", ends_on: "2026-12-04" })).toEqual({ from: "2026-08-31", to: "2026-11-24" });
    expect(periodRange("term", NOW, { starts_on: "2026-05-04", ends_on: "2026-08-07" })).toEqual({ from: "2026-05-04", to: "2026-08-07" });
    expect(periodRange("term", NOW, null)).toEqual({ from: "2026-01-01", to: "2026-11-24" });
  });
  it("monthsBack gives the first of an earlier month", () => {
    expect(monthsBack(0, NOW)).toBe("2026-11-01");
    expect(monthsBack(5, NOW)).toBe("2026-06-01");
    expect(monthsBack(11, NOW)).toBe("2025-12-01");
  });
});

const flag = (over: Partial<ConsumptionFlag>): ConsumptionFlag => ({
  kind: "usage_up", item_id: "rice", item_name: "Rice", category: "kitchen", unit: "kg", purpose: "Lunch", occurred_on: "2026-11-17", period_from: null,
  expected: 20, actual: 25, headcount: 1066, baseline_headcount: 1064, visitors: 2, severity: "medium", explained: false, reason: "", ...over,
});

describe("sortFlags", () => {
  it("puts alarms first, most serious then newest, and explained rises last", () => {
    const sorted = sortFlags([
      flag({ reason: "explained", explained: true, severity: "low", occurred_on: "2026-11-20" }),
      flag({ reason: "medium-old", severity: "medium", occurred_on: "2026-11-02" }),
      flag({ reason: "high", severity: "high", occurred_on: "2026-11-01" }),
      flag({ reason: "medium-new", severity: "medium", occurred_on: "2026-11-18" }),
    ]);
    expect(sorted.map((f) => f.reason)).toEqual(["high", "medium-new", "medium-old", "explained"]);
  });
});

describe("usageByItem", () => {
  it("adds each item's periods and puts the costliest first", () => {
    const row = (item_id: string, used: number, cost: number, over: Partial<UsageRow> = {}): UsageRow => ({
      item_id, period_start: "2026-11-01", used, wasted: 0, received: 0, shrinkage: 0, spend_cents: 0, used_cost_cents: cost, ...over,
    });
    const out = usageByItem([row("salt", 5, 1000), row("rice", 400, 3_600_000), row("rice", 420, 3_780_000, { period_start: "2026-11-09", wasted: 2, shrinkage: 8 })]);
    expect(out.map((u) => u.item_id)).toEqual(["rice", "salt"]);
    expect(out[0]).toMatchObject({ used: 820, wasted: 2, shrinkage: 8, used_cost_cents: 7_380_000 });
  });
});

describe("stockOverview", () => {
  const level = (over: Partial<StockLevel>): StockLevel => ({
    item_id: "x", name: "Rice", category: "kitchen", unit: "kg", consumable: true, quantity: 100, reorder_level: null, unit_cost_cents: 9000,
    value_cents: 900_000, used_28d: 0, wasted_28d: 0, avg_daily_use: null, days_of_cover: null, low: false, last_received_on: null, next_delivery_on: null,
    ...over,
  });
  const spend: SpendRow[] = [
    { month: "2026-10-01", category: "kitchen", spend_cents: 2_000_000, deliveries: 4 },
    { month: "2026-11-01", category: "kitchen", spend_cents: 2_500_000, deliveries: 5 },
  ];
  it("adds the value, compares this month's spend with last month's, and counts low stock and short cover", () => {
    const o = stockOverview([level({}), level({ value_cents: 100_000, low: true }), level({ quantity: 0, value_cents: 0 }), level({ days_of_cover: 3 })], spend, NOW);
    expect(o).toEqual({ valueCents: 1_900_000, spendThisMonthCents: 2_500_000, spendLastMonthCents: 2_000_000, spendChangePct: 25, lowCount: 2, shortCoverCount: 1 });
  });
  it("has no change to show with nothing spent last month", () => {
    expect(stockOverview([], [spend[1]!], NOW).spendChangePct).toBeNull();
  });
});

describe("stores", () => {
  it("groups the register's categories the way a school runs its stores", () => {
    expect(storeOf("kitchen")).toBe("kitchen");
    expect(storeOf("stationery")).toBe("stationery");
    expect(storeOf("lab_equipment")).toBe("lab");
    expect(storeOf("medical")).toBe("clinic");
    expect(storeOf("uniforms")).toBe("uniforms");
    expect(storeOf("sports")).toBe("other");
    expect(storeOf(undefined)).toBe("other");
    expect(inStore("medical", "all")).toBe(true);
    expect(inStore("medical", "kitchen")).toBe(false);
  });

  it("adds a store's deliveries per month", () => {
    const rows = [
      { month: "2026-11-01", category: "kitchen", spend_cents: 100, deliveries: 1 },
      { month: "2026-10-01", category: "medical", spend_cents: 50, deliveries: 1 },
      { month: "2026-11-01", category: "medical", spend_cents: 30, deliveries: 2 },
    ];
    expect(spendByMonthFor(rows, "clinic")).toEqual([{ month: "2026-10-01", spend_cents: 50, deliveries: 1 }, { month: "2026-11-01", spend_cents: 30, deliveries: 2 }]);
    expect(spendByMonthFor(rows, "all").find((r) => r.month === "2026-11-01")).toEqual({ month: "2026-11-01", spend_cents: 130, deliveries: 3 });
  });

  it("summarises each store: items, value, use in the period and low lines, in store order", () => {
    const level = (category: string, value_cents: number, low = false): StockLevel => ({
      item_id: category, name: category, category, unit: null, consumable: true, quantity: 5, reorder_level: null, unit_cost_cents: null,
      value_cents, used_28d: 0, wasted_28d: 0, avg_daily_use: null, days_of_cover: null, low, last_received_on: null, next_delivery_on: null,
    });
    const out = summariseStores([level("medical", 300, true), level("kitchen", 1000), level("sports", 5)],
      [{ item_id: "medical", used: 60, wasted: 0, received: 0, shrinkage: 0, spend_cents: 0, used_cost_cents: 120 }], (id) => id);
    expect(out.map((s) => [s.label, s.items, s.valueCents, s.usedCostCents, s.low])).toEqual([
      ["Kitchen", 1, 1000, 0, 0], ["Clinic", 1, 300, 120, 1], ["Other", 1, 5, 0, 0],
    ]);
  });
});
