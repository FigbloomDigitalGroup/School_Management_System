import { describe, expect, it } from "vitest";
import { feeBandOf, groupFeeItems, termFigures } from "./feesPaging";
import type { FeeItem } from "./types";

function item(over: Partial<FeeItem> = {}): FeeItem {
  return { id: Math.random().toString(36), tenant_id: "t", term_id: "x", name: "Tuition", amount_cents: 1000, applies_to: "form_level", form_level: 1, level: "primary", ...over } as FeeItem;
}

describe("fee items by band", () => {
  it("puts grades in threes, pre-primary years on their own and school-wide items first", () => {
    expect(feeBandOf(item({ applies_to: "all", form_level: null })).key).toBe("everyone");
    expect(feeBandOf(item({ level: "pre_primary", form_level: 1 })).label).toBe("PP1");
  });

  it("groups and totals each band, youngest first", () => {
    const bands = groupFeeItems([
      item({ applies_to: "boarders", form_level: null, amount_cents: 500 }),
      item({ level: "pre_primary", form_level: 2, amount_cents: 200 }),
      item({ level: "pre_primary", form_level: 1, amount_cents: 100 }),
    ]);
    expect(bands.map((b) => [b.label, b.totalCents])).toEqual([["Every learner, boarders and day scholars", 500], ["PP1", 100], ["PP2", 200]]);
  });
});

describe("term figures", () => {
  it("counts paid, part paid, nothing paid and overdue from status and amounts", () => {
    const f = termFigures([
      { total_cents: 100, paid_cents: 100, status: "paid" },
      { total_cents: 100, paid_cents: 40, status: "part_paid" },
      { total_cents: 100, paid_cents: 0, status: "overdue" },
      { total_cents: 100, paid_cents: 120, status: "paid" },
    ]);
    expect(f).toMatchObject({ invoices: 4, billed: 400, collected: 260, outstanding: 160, collectedPct: 65, paid: 2, partPaid: 1, nothingPaid: 1, owing: 2, overdue: 1 });
  });
});
