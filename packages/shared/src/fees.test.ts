import { describe, expect, it } from "vitest";
import {
  balanceCents, invoiceStatus, itemsForStudent, KES, normaliseMsisdn, payableSuggestions, totalCents,
} from "./fees";
import type { FeeInvoice, FeeItem } from "./types";

describe("KES", () => {
  it("formats cents as whole-shilling KSh with thousands separators", () => {
    expect(KES(150000)).toBe("KSh 1,500");
    expect(KES(0)).toBe("KSh 0");
  });
});

const invoice = (over: Partial<FeeInvoice> = {}): FeeInvoice => ({
  id: "inv-1", tenant_id: "t1", student_id: "s1", term_id: "term-1",
  total_cents: 10000, paid_cents: 0, due_on: "2026-01-01", status: "unpaid",
  ...over,
});

describe("balanceCents", () => {
  it("is total minus paid", () => {
    expect(balanceCents(invoice({ total_cents: 10000, paid_cents: 4000 }))).toBe(6000);
  });
  it("never goes negative on an overpayment", () => {
    expect(balanceCents(invoice({ total_cents: 10000, paid_cents: 15000 }))).toBe(0);
  });
});

describe("invoiceStatus", () => {
  const today = new Date("2026-06-01");
  it("is paid once the balance is zero, even if overdue", () => {
    const i = invoice({ total_cents: 10000, paid_cents: 10000, due_on: "2026-01-01" });
    expect(invoiceStatus(i, today)).toBe("paid");
  });
  it("is overdue when unpaid past the due date", () => {
    const i = invoice({ total_cents: 10000, paid_cents: 0, due_on: "2026-01-01" });
    expect(invoiceStatus(i, today)).toBe("overdue");
  });
  it("is part_paid when something has been paid but not overdue", () => {
    const i = invoice({ total_cents: 10000, paid_cents: 4000, due_on: "2026-12-01" });
    expect(invoiceStatus(i, today)).toBe("part_paid");
  });
  it("is unpaid when nothing has been paid and not yet due", () => {
    const i = invoice({ total_cents: 10000, paid_cents: 0, due_on: "2026-12-01" });
    expect(invoiceStatus(i, today)).toBe("unpaid");
  });
});

const item = (over: Partial<FeeItem> = {}): FeeItem => ({
  id: "fi-1", tenant_id: "t1", term_id: "term-1", name: "Tuition", amount_cents: 5000,
  applies_to: "all", form_level: null,
  ...over,
});

describe("itemsForStudent", () => {
  const items = [
    item({ id: "all", applies_to: "all" }),
    item({ id: "boarders", applies_to: "boarders" }),
    item({ id: "day", applies_to: "day" }),
    item({ id: "form2", applies_to: "form_level", form_level: 2 }),
    item({ id: "form3", applies_to: "form_level", form_level: 3 }),
  ];

  it("includes 'all' items for every student", () => {
    const forBoarder = itemsForStudent(items, { boarding: true }, 2).map((i) => i.id);
    expect(forBoarder).toContain("all");
  });
  it("includes boarders-only items only for boarders", () => {
    expect(itemsForStudent(items, { boarding: true }, 2).map((i) => i.id)).toContain("boarders");
    expect(itemsForStudent(items, { boarding: false }, 2).map((i) => i.id)).not.toContain("boarders");
  });
  it("includes day-only items only for day scholars", () => {
    expect(itemsForStudent(items, { boarding: false }, 2).map((i) => i.id)).toContain("day");
    expect(itemsForStudent(items, { boarding: true }, 2).map((i) => i.id)).not.toContain("day");
  });
  it("matches form_level items only for that exact form", () => {
    const ids = itemsForStudent(items, { boarding: false }, 2).map((i) => i.id);
    expect(ids).toContain("form2");
    expect(ids).not.toContain("form3");
  });
});

describe("totalCents", () => {
  it("sums amount_cents across items", () => {
    expect(totalCents([item({ amount_cents: 5000 }), item({ amount_cents: 3000 })])).toBe(8000);
  });
  it("is zero for an empty list", () => {
    expect(totalCents([])).toBe(0);
  });
});

describe("payableSuggestions", () => {
  it("offers nothing once the balance is cleared", () => {
    expect(payableSuggestions(0)).toEqual([]);
    expect(payableSuggestions(-500)).toEqual([]);
  });
  it("offers full and half for a real balance", () => {
    const s = payableSuggestions(100000);
    expect(s[0]).toEqual({ label: "Pay in full", cents: 100000 });
    expect(s.some((o) => o.label === "Pay half")).toBe(true);
    expect(s.at(-1)).toEqual({ label: "Another amount", cents: 0 });
  });
});

describe("normaliseMsisdn", () => {
  it.each([
    ["0722118004", "254722118004"],
    ["254722118004", "254722118004"],
    ["722118004", "254722118004"],
    ["0111222333", "254111222333"],
    ["0722 118 004", "254722118004"],
  ])("normalises %s to %s", (input, expected) => {
    const r = normaliseMsisdn(input);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.msisdn).toBe(expected);
  });

  it("rejects numbers that are not Kenyan mobile numbers", () => {
    expect(normaliseMsisdn("12345").ok).toBe(false);
    expect(normaliseMsisdn("").ok).toBe(false);
  });
});
