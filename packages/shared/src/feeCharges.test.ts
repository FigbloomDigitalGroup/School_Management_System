import { describe, expect, it } from "vitest";
import { feesOnlyCents, standingCharges, suggestedCharge } from "./feeCharges";

describe("suggestedCharge", () => {
  it("starts from the register's cost for every copy, with a reason the family will understand", () => {
    expect(suggestedCharge({ status: "lost", quantity: 2, itemName: "KLB Biology Form 2", unitCostCents: 85_000 }))
      .toEqual({ amountCents: 170_000, reason: "Lost: KLB Biology Form 2 (2 copies)" });
    expect(suggestedCharge({ status: "damaged", quantity: 1, itemName: "Microscope", unitCostCents: 2_400_000 }))
      .toEqual({ amountCents: 2_400_000, reason: "Damaged: Microscope" });
  });

  it("leaves the amount empty when the register has no cost", () => {
    expect(suggestedCharge({ status: "lost", quantity: 1, itemName: "Hockey stick", unitCostCents: null }).amountCents).toBeNull();
  });

  it("keeps the reason within what the database takes", () => {
    expect(suggestedCharge({ status: "lost", quantity: 1, itemName: "x".repeat(300), unitCostCents: 100 }).reason).toHaveLength(200);
  });
});

describe("feesOnlyCents", () => {
  it("takes the charges back out of the invoice total", () => {
    expect(feesOnlyCents({ total_cents: 4_620_000, charges_cents: 120_000 })).toBe(4_500_000);
    expect(feesOnlyCents({ total_cents: 4_500_000 })).toBe(4_500_000);
  });
});

describe("standingCharges", () => {
  it("drops cancelled charges", () => {
    expect(standingCharges([{ voidedAt: null }, { voidedAt: "2026-10-28T10:00:00Z" }])).toEqual([{ voidedAt: null }]);
  });
});
