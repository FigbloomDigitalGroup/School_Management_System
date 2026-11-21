import { describe, expect, it } from "vitest";
import {
  balanceCents, formatMoney, itemsForStudent, normaliseMsisdn, overpaidCents, parseShillings, payableSuggestions, planTermBilling, totalCents,
  wholeShillings,
} from "./fees";
import type { FeeInvoice, FeeItem } from "./types";

describe("formatMoney", () => {
  it("formats cents as whole-shilling KSh with thousands separators for Kenya", () => {
    expect(formatMoney(150000, "KE")).toBe("KSh 1,500");
    expect(formatMoney(0, "KE")).toBe("KSh 0");
  });

  it("falls back to Kenya's formatting for an unregistered country", () => {
    expect(formatMoney(150000, "XX")).toBe("KSh 1,500");
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
  it("is the whole total when nothing is paid, and zero when it is paid to the cent", () => {
    expect(balanceCents(invoice({ total_cents: 1000000, paid_cents: 0 }))).toBe(1000000);
    expect(balanceCents(invoice({ total_cents: 1000000, paid_cents: 400000 }))).toBe(600000);
    expect(balanceCents(invoice({ total_cents: 1000000, paid_cents: 1000000 }))).toBe(0);
    expect(balanceCents(invoice({ total_cents: 0, paid_cents: 0 }))).toBe(0);
  });
});

describe("overpaidCents", () => {
  it("is what was paid above the total", () => {
    expect(overpaidCents({ total_cents: 10000, paid_cents: 15000 })).toBe(5000);
  });
  it("is nothing while a balance is owed or exactly cleared", () => {
    expect(overpaidCents({ total_cents: 10000, paid_cents: 4000 })).toBe(0);
    expect(overpaidCents({ total_cents: 10000, paid_cents: 10000 })).toBe(0);
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
  it("keeps a Grade 1 item off a Form 1 learner's bill once the item names its level", () => {
    const mixed = [
      item({ id: "grade1", applies_to: "form_level", form_level: 1, level: "primary" }),
      item({ id: "form1", applies_to: "form_level", form_level: 1, level: "secondary" }),
      item({ id: "any1", applies_to: "form_level", form_level: 1 }),
    ];
    expect(itemsForStudent(mixed, { boarding: false }, 1, "secondary").map((i) => i.id)).toEqual(["form1", "any1"]);
    expect(itemsForStudent(mixed, { boarding: false }, 1, "primary").map((i) => i.id)).toEqual(["grade1", "any1"]);
  });
});

describe("planTermBilling", () => {
  const items = [
    item({ id: "tuition", applies_to: "all", amount_cents: 1000000 }),
    item({ id: "boarding", applies_to: "boarders", amount_cents: 500000 }),
    item({ id: "kcse", applies_to: "form_level", form_level: 4, level: "secondary", amount_cents: 200000 }),
  ];
  const student = (id: string, over: Partial<{ boarding: boolean; formLevel: number | null; classLevel: "secondary" | null }> = {}) =>
    ({ id, boarding: false, formLevel: 2, classLevel: "secondary" as const, ...over });

  it("bills each learner the items that apply to them", () => {
    const plan = planTermBilling(
      [student("day2"), student("boarder4", { boarding: true, formLevel: 4 })],
      items, new Set(),
    );
    expect(plan.invoices).toEqual([
      { student_id: "day2", total_cents: 1000000 },
      { student_id: "boarder4", total_cents: 1700000 },
    ]);
    expect(plan.totalCents).toBe(2700000);
  });

  it("skips learners who already have an invoice for the term", () => {
    const plan = planTermBilling([student("a"), student("b")], items, new Set(["a"]));
    expect(plan.invoices.map((i) => i.student_id)).toEqual(["b"]);
    expect(plan.alreadyBilled).toBe(1);
  });

  it("gives no invoice when nothing applies", () => {
    const plan = planTermBilling([student("a", { boarding: true })], [item({ applies_to: "day", amount_cents: 100 })], new Set());
    expect(plan.invoices).toEqual([]);
    expect(plan.nothingApplies).toBe(1);
  });

  it("bills a learner with no class only the school-wide items", () => {
    const plan = planTermBilling([student("uni", { formLevel: null, classLevel: null })], items, new Set());
    expect(plan.invoices).toEqual([{ student_id: "uni", total_cents: 1000000 }]);
  });

  // Worked by hand: tuition 1,000,000 for all; boarding +500,000 for boarders; KCSE +200,000 for Form 4 only.
  //   day Form 2 = 1,000,000 · boarder Form 2 = 1,500,000 · day Form 4 = 1,200,000 · boarder Form 4 = 1,700,000
  //   whole school = 1,000,000 + 1,500,000 + 1,200,000 + 1,700,000 = 5,400,000
  const school = () => [
    student("day2"),
    student("boarder2", { boarding: true }),
    student("day4", { formLevel: 4 }),
    student("boarder4", { boarding: true, formLevel: 4 }),
  ];

  it("totals a mixed school to the amounts worked out by hand", () => {
    const plan = planTermBilling(school(), items, new Set());
    expect(plan.invoices).toEqual([
      { student_id: "day2", total_cents: 1000000 },
      { student_id: "boarder2", total_cents: 1500000 },
      { student_id: "day4", total_cents: 1200000 },
      { student_id: "boarder4", total_cents: 1700000 },
    ]);
    expect(plan.totalCents).toBe(5400000);
    expect(plan.alreadyBilled).toBe(0);
    expect(plan.nothingApplies).toBe(0);
  });

  it("bills nobody twice: planning again from the first plan's learners finds nothing to do", () => {
    const first = planTermBilling(school(), items, new Set());
    const second = planTermBilling(school(), items, new Set(first.invoices.map((i) => i.student_id)));
    expect(second.invoices).toEqual([]);
    expect(second.totalCents).toBe(0);
    expect(second.alreadyBilled).toBe(4);
  });

  it("bills a learner admitted after the first run, and only that learner, at today's items", () => {
    const first = planTermBilling(school(), items, new Set());
    const already = new Set(first.invoices.map((i) => i.student_id));
    const second = planTermBilling([...school(), student("late", { boarding: true, formLevel: 4 })], items, already);
    expect(second.invoices).toEqual([{ student_id: "late", total_cents: 1700000 }]);
    expect(second.alreadyBilled).toBe(4);
  });

  it("does not invoice a learner whose only applicable item is for nothing (zero amount)", () => {
    const plan = planTermBilling([student("a")], [item({ applies_to: "all", amount_cents: 0 })], new Set());
    expect(plan.invoices).toEqual([]);
    expect(plan.nothingApplies).toBe(1);
  });

  it("keeps every amount an exact whole number of cents across a large school", () => {
    const many = Array.from({ length: 1000 }, (_, n) => student(`s${n}`, { boarding: n % 2 === 0 }));
    const plan = planTermBilling(many, items, new Set());
    // 500 boarders x 1,500,000 + 500 day x 1,000,000 = 750,000,000 + 500,000,000
    expect(plan.totalCents).toBe(1250000000);
    expect(plan.invoices.every((i) => Number.isInteger(i.total_cents))).toBe(true);
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
  // FIG-1317: it used to round to the nearest KSh 100, so KSh 250 offered KSh 100
  it.each([
    [15000, 7500], [25000, 12500], [35000, 17500], [20000, 10000], [300000, 150000],
  ])("'Pay half' of %i cents is %i cents", (balance, half) => {
    expect(payableSuggestions(balance).find((o) => o.label === "Pay half")?.cents).toBe(half);
  });
  it("rounds an odd balance's half to the whole shilling, as M-Pesa charges", () => {
    expect(payableSuggestions(15100).find((o) => o.label === "Pay half")?.cents).toBe(7600);
  });
  it("offers no half of KSh 1, which would be nothing", () => {
    expect(payableSuggestions(100).some((o) => o.label === "Pay half")).toBe(false);
  });
  it("never offers a suggestion above a whole-shilling balance", () => {
    // with cents in the balance a suggestion rounds up to the whole shilling M-Pesa charges (see FIG-1334), so only whole shillings are checked
    for (const balance of [100, 5000, 10000, 15000, 25000, 123400]) {
      for (const s of payableSuggestions(balance)) expect(s.cents).toBeLessThanOrEqual(balance);
    }
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

describe("whole shillings (FIG-1334)", () => {
  it("shows an amount with cents exactly, and a whole one as before", () => {
    expect(formatMoney(1000050, "KE")).toBe("KSh 10,000.50");
    expect(formatMoney(12345, "KE")).toBe("KSh 123.45");
    expect(formatMoney(45, "KE")).toBe("KSh 0.45");
    expect(formatMoney(150000, "KE")).toBe("KSh 1,500");
  });

  it("reads whole shillings, with spaces and thousands commas", () => {
    expect(parseShillings("500")).toEqual({ ok: true, cents: 50000 });
    expect(parseShillings(" 21,300 ")).toEqual({ ok: true, cents: 2130000 });
    expect(parseShillings("")).toEqual({ ok: true, cents: 0 });
  });

  it("refuses a decimal point instead of dropping it: 500.50 never becomes 50,050", () => {
    for (const typed of ["500.50", "100.5", ".50", "250."]) {
      const r = parseShillings(typed);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/whole shillings/);
    }
    expect(parseShillings("12abc").ok).toBe(false);
  });

  it("offers 'Pay in full' a balance with cents rounded up to the shilling, which M-Pesa can charge", () => {
    expect(payableSuggestions(12345)[0]).toEqual({ label: "Pay in full", cents: 12400 });
    expect(wholeShillings(12345)).toBe(12400);
    expect(wholeShillings(12300)).toBe(12300);
  });
});
