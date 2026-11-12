import { describe, expect, it } from "vitest";
import { flattenInvoicePayments } from "./paidPayments";

const pay = (id: string, completed_at: string | null, amount_cents = 100) => ({
  id, amount_cents, method: "mpesa" as const, mpesa_receipt: null, reference: null, msisdn: null, completed_at, created_at: "2026-11-01T00:00:00+00:00",
});

describe("flattenInvoicePayments", () => {
  it("gives one row per payment, each with the learner it was paid for", () => {
    const rows = flattenInvoicePayments([
      { student_id: "kid-1", payments: [pay("a", "2026-10-01T10:00:00+00:00"), pay("b", "2026-10-02T10:00:00+00:00")] },
      { student_id: "kid-2", payments: [pay("c", "2026-10-03T10:00:00+00:00")] },
    ]);
    expect(rows.map((r) => [r.id, r.fee_invoices.student_id])).toEqual([["c", "kid-2"], ["b", "kid-1"], ["a", "kid-1"]]);
  });

  it("puts the newest payment first across invoices and learners", () => {
    const rows = flattenInvoicePayments([
      { student_id: "kid-1", payments: [pay("old", "2026-01-05T08:00:00+00:00")] },
      { student_id: "kid-2", payments: [pay("new", "2026-09-05T08:00:00+00:00")] },
      { student_id: "kid-1", payments: [pay("mid", "2026-05-05T08:00:00+00:00")] },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["new", "mid", "old"]);
  });

  it("puts a payment with no completion time first, as a descending sort in the database does", () => {
    const rows = flattenInvoicePayments([{ student_id: "kid-1", payments: [pay("done", "2026-10-01T10:00:00+00:00"), pay("open", null)] }]);
    expect(rows.map((r) => r.id)).toEqual(["open", "done"]);
  });

  it("keeps every field of the payment", () => {
    const [row] = flattenInvoicePayments([{ student_id: "kid-1", payments: [{ ...pay("a", "2026-10-01T10:00:00+00:00", 250000), mpesa_receipt: "QWE123", msisdn: "254700000001" }] }]);
    expect(row).toMatchObject({ id: "a", amount_cents: 250000, mpesa_receipt: "QWE123", msisdn: "254700000001", fee_invoices: { student_id: "kid-1" } });
  });

  it("gives nothing for no invoices, and for an invoice with no payments", () => {
    expect(flattenInvoicePayments([])).toEqual([]);
    expect(flattenInvoicePayments([{ student_id: "kid-1", payments: [] }])).toEqual([]);
  });
});
