import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A stand-in for the Supabase client with a few tables in memory. `eq` filters really filter (a dotted column reaches
 * into the joined row, as PostgREST's embedded filters do), `order` and `range` really order and cut, `update` really
 * changes the rows it matched, so what the loaders ask for (this term, that status) changes what they find.
 */
type Row = Record<string, unknown>;
const db: { tables: Record<string, Row[]>; error: Record<string, string>; rpcError: string | null } = { tables: {}, error: {}, rpcError: null };
const calls: { queries: { table: string; filters: [string, unknown][] }[]; rpc: { name: string; args: Row }[]; or: { filter: string; options: unknown }[]; terms: number } = {
  queries: [], rpc: [], or: [], terms: 0,
};

/** Numbers by size, anything else by text: "300" is more than "50". */
const compare = (a: unknown, b: unknown): number =>
  typeof a === "number" && typeof b === "number" ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;

const pathValue = (row: Row, col: string): unknown => col.split(".").reduce<unknown>((v, key) => (v && typeof v === "object" ? (v as Row)[key] : undefined), row);

function builder(table: string) {
  const filters: [string, unknown][] = [];
  let sort: { col: string; ascending: boolean } | null = null;
  let window: [number, number] | null = null;
  let cut: number | null = null;
  let patch: Row | null = null;
  const matching = () => (db.tables[table] ?? []).filter((r) => filters.every(([col, value]) => pathValue(r, col) === value));
  const rows = () => {
    let out = matching();
    if (sort) {
      const { col, ascending } = sort;
      out = [...out].sort((a, b) => compare(pathValue(a, col), pathValue(b, col)) * (ascending ? 1 : -1));
    }
    if (window) out = out.slice(window[0], window[1] + 1);
    return cut === null ? out : out.slice(0, cut);
  };
  const answer = () => (db.error[table] ? { data: null, error: { message: db.error[table] } } : { data: rows(), error: null });
  const proxy: unknown = new Proxy({}, {
    get(_t, method: string) {
      if (method === "then") return (resolve: (v: unknown) => unknown) => {
        calls.queries.push({ table, filters: [...filters] });
        if (patch && !db.error[table]) {
          const hit = matching();
          hit.forEach((r) => Object.assign(r, patch));
          return resolve({ data: hit.map((r) => ({ id: r.id })), error: null });
        }
        return resolve(answer());
      };
      if (method === "maybeSingle") return () => {
        if (table === "terms") calls.terms += 1;
        calls.queries.push({ table, filters: [...filters] });
        const a = answer();
        return Promise.resolve(a.error ? a : { data: rows()[0] ?? null, error: null });
      };
      return (...args: unknown[]) => {
        if (method === "eq") filters.push([String(args[0]), args[1]]);
        if (method === "order") sort = { col: String(args[0]), ascending: (args[1] as { ascending?: boolean } | undefined)?.ascending !== false };
        if (method === "range") window = [Number(args[0]), Number(args[1])];
        if (method === "limit") cut = Number(args[0]);
        if (method === "or") calls.or.push({ filter: String(args[0]), options: args[1] });
        if (method === "update") patch = args[0] as Row;
        return proxy;
      };
    },
  });
  return proxy;
}

vi.mock("./supabase", () => ({
  supabase: () => ({
    from: (table: string) => builder(table),
    rpc: (name: string, args: Row) => { calls.rpc.push({ name, args }); return Promise.resolve({ error: db.rpcError ? { message: db.rpcError } : null }); },
  }),
}));

import {
  PAYMENT_METHODS, balanceStanding, feeFigures, fetchFeesCollection, learnerNameOf, paymentFormStart, proofFlags, proofToConfirm, readPaymentEntry, recordPayment,
  rejectionReason, rejectPaymentProof, searchPayableInvoices, shapeFeesCollection, type PendingProof, type RawInvoiceRow, type RawProofRow,
} from "./adminFees";

const TERM = { id: "term-3", tenant_id: "school-1", name: "Term 3, 2026", is_current: true };
const invoice = (id: string, total: number, paid: number, name = `Learner ${id}`, cls = "Form 1A", charges = 0): RawInvoiceRow => ({
  id, total_cents: total, charges_cents: charges, paid_cents: paid, students: { full_name: name, classes: { name: cls } },
});
const rawProof = (id: string, over: Partial<RawProofRow> = {}): RawProofRow => ({
  id, file_path: null, file_name: null, note: null, uploaded_at: "2026-11-05T08:00:00Z", sms_text: null, txn_source: null, txn_code: null, txn_amount_cents: null,
  txn_at: null, txn_payee: null, txn_payee_number: null, txn_account: null,
  fee_invoices: { id: "inv-1", total_cents: 1_000_000, paid_cents: 400_000, students: { full_name: "Ann Wanjiru", classes: { name: "Form 1A" } } },
  ...over,
});

beforeEach(() => {
  calls.queries.length = 0; calls.rpc.length = 0; calls.or.length = 0; calls.terms = 0;
  db.error = {}; db.rpcError = null;
  db.tables = {};
});

describe("the largest balances, the proofs and the totals, from what the queries answered", () => {
  it("lists only invoices still owing, the biggest balance first, ten at most, with the charges that are part of the bill", () => {
    const invoices = [
      invoice("paid", 500_000, 500_000), invoice("over", 500_000, 600_000),
      ...Array.from({ length: 12 }, (_, i) => invoice(`o${i}`, 1_000_000 + i * 10_000, 100_000)),
      invoice("none", 2_000_000, 0, "Dan Otieno", "Form 2B", 150_000),
    ];
    const { outstanding } = shapeFeesCollection({ invoices, proofs: [], overpaid: [] });
    expect(outstanding).toHaveLength(10);
    expect(outstanding[0]).toEqual({ id: "none", name: "Dan Otieno", cls: "Form 2B", billed: 2_000_000, charges: 150_000, paid: 0 });
    expect(outstanding.map((r) => r.id)).toEqual(["none", "o11", "o10", "o9", "o8", "o7", "o6", "o5", "o4", "o3"]);
    expect(outstanding.some((r) => r.id === "paid" || r.id === "over")).toBe(false);
  });

  it("says Unknown learner and a dash for an invoice whose learner or class cannot be read", () => {
    const { outstanding } = shapeFeesCollection({ invoices: [{ id: "x", total_cents: 100, charges_cents: 0, paid_cents: 0, students: null }, invoice("y", 200, 0, "Eve", "Form 1B")], proofs: [], overpaid: [] });
    expect(outstanding.find((r) => r.id === "x")).toMatchObject({ name: "Unknown learner", cls: "—" });
    const noClass = shapeFeesCollection({ invoices: [{ id: "z", total_cents: 100, charges_cents: 0, paid_cents: 0, students: { full_name: "Fay", classes: null } }], proofs: [], overpaid: [] });
    expect(noClass.outstanding[0]).toMatchObject({ name: "Fay", cls: "—" });
  });

  it("keeps every invoice's two amounts for the totals, not only the ten listed", () => {
    const { invoices } = shapeFeesCollection({ invoices: [invoice("a", 100, 40), invoice("b", 200, 200)], proofs: [], overpaid: [] });
    expect(invoices).toEqual([{ total_cents: 100, paid_cents: 40 }, { total_cents: 200, paid_cents: 200 }]);
  });

  it("makes each proof carry its learner, class and what is still owed on its invoice, never less than nothing", () => {
    const over = rawProof("p2", { fee_invoices: { id: "inv-2", total_cents: 500_000, paid_cents: 700_000, students: { full_name: "Bea Achieng", classes: null } } });
    const { pendingProofs } = shapeFeesCollection({ invoices: [], proofs: [rawProof("p1", { txn_code: "SFC1234ABC" }), over, rawProof("p3", { fee_invoices: null })], overpaid: [] });
    expect(pendingProofs[0]).toMatchObject({ id: "p1", txn_code: "SFC1234ABC", studentName: "Ann Wanjiru", cls: "Form 1A", invoice: { id: "inv-1", balanceCents: 600_000 } });
    expect(pendingProofs[1]).toMatchObject({ studentName: "Bea Achieng", cls: "—", invoice: { balanceCents: 0 } });
    expect(pendingProofs[2]).toMatchObject({ studentName: "Unknown learner", invoice: null });
    expect("fee_invoices" in pendingProofs[0]!).toBe(false);
  });
});

describe("the figures a term leads with", () => {
  it("adds up billed and collected, and counts one family's overpayment as no help to another's debt", () => {
    const f = feeFigures([
      { total_cents: 1_000_000, paid_cents: 1_000_000 },
      { total_cents: 1_000_000, paid_cents: 250_000 },
      { total_cents: 1_000_000, paid_cents: 1_200_000 },
      { total_cents: 1_000_000, paid_cents: 0 },
    ]);
    expect(f.billed).toBe(4_000_000);
    expect(f.collected).toBe(2_450_000);
    expect(f.outstandingTotal).toBe(1_750_000);
    expect(f.owingCount).toBe(2);
    expect(f.fullyPaidCount).toBe(2);
    expect(f.collectedPct).toBe(61);
    expect(f.fullyPaidPct).toBe(50);
  });

  it("is all zeros for a term with no invoices, and does not count a zero invoice as paid", () => {
    expect(feeFigures([])).toEqual({ billed: 0, collected: 0, outstandingTotal: 0, collectedPct: 0, owingCount: 0, fullyPaidCount: 0, fullyPaidPct: 0 });
    expect(feeFigures([{ total_cents: 0, paid_cents: 0 }]).fullyPaidCount).toBe(0);
  });

  it("calls a balance nothing paid, or part paid", () => {
    expect(balanceStanding({ paid: 0 })).toBe("Nothing paid");
    expect(balanceStanding({ paid: 1 })).toBe("Part paid");
  });
});

describe("what to look at twice in a proof", () => {
  const sms = (over: Partial<PendingProof> = {}): PendingProof => ({
    id: "p", file_path: null, file_name: null, note: null, uploaded_at: "x", studentName: "Ann", cls: "Form 1A", invoice: { id: "i", studentName: "Ann", cls: "Form 1A", balanceCents: 600_000 },
    sms_text: "SFC1234ABC Confirmed. Ksh6,000.00 paid to 522522", txn_source: "mpesa", txn_code: "SFC1234ABC", txn_amount_cents: 600_000, txn_at: "2026-11-05T08:00:00Z",
    txn_payee: null, txn_payee_number: "522522", txn_account: null, ...over,
  });
  const school = { paybill: "522522", till: null };

  it("has nothing to say about a proof with no pasted message", () => {
    expect(proofFlags(sms({ sms_text: null, txn_code: null }), school)).toEqual([]);
  });

  it("is quiet for a message that matches the balance and the school's own paybill", () => {
    expect(proofFlags(sms(), school, new Date("2026-11-06T00:00:00Z"))).toEqual([]);
  });

  it("flags an amount that is not the balance, a number that is not the school's, and a date in the future", () => {
    expect(proofFlags(sms({ txn_amount_cents: 500_000 }), school, new Date("2026-11-06T00:00:00Z"))).toEqual(["amount_differs"]);
    expect(proofFlags(sms({ txn_payee_number: "0712345678" }), school, new Date("2026-11-06T00:00:00Z"))).toEqual(["wrong_payee_number"]);
    expect(proofFlags(sms({ txn_at: "2026-12-30T00:00:00Z" }), school, new Date("2026-11-06T00:00:00Z"))).toEqual(["future_date"]);
    expect(proofFlags(sms({ txn_code: null }), school, new Date("2026-11-06T00:00:00Z"))).toEqual(["no_code"]);
  });
});

describe("what was typed for a payment", () => {
  const entry = (over: Partial<Parameters<typeof readPaymentEntry>[0]> = {}) =>
    readPaymentEntry({ amount: "15000", method: "cash", reference: "", balanceCents: 2_000_000, country: "KE", ...over });

  it("takes whole shillings, with spaces and thousands commas, as cents", () => {
    expect(entry()).toEqual({ ok: true, cents: 1_500_000 });
    expect(entry({ amount: " 15,000 " })).toEqual({ ok: true, cents: 1_500_000 });
  });

  it("refuses cents in the amount with a sentence, and anything that is not digits", () => {
    expect(entry({ amount: "500.50" })).toEqual({ ok: false, message: "Enter whole shillings: cents can't be paid or recorded." });
    expect(entry({ amount: "5k" })).toEqual({ ok: false, message: "Enter the amount in shillings, using digits only." });
  });

  it("lets exactly what is still owed be entered even when it has cents, so the balance can be cleared", () => {
    expect(entry({ amount: "10000.50", balanceCents: 1_000_050 })).toEqual({ ok: true, cents: 1_000_050 });
    expect(entry({ amount: "10000.40", balanceCents: 1_000_050 }).ok).toBe(false);
  });

  it("wants an amount: nothing, zero", () => {
    expect(entry({ amount: "" })).toEqual({ ok: false, message: "Enter the amount received." });
    expect(entry({ amount: "0" })).toEqual({ ok: false, message: "Enter the amount received." });
  });

  it("will not take more than is owed, and says how much is", () => {
    expect(entry({ amount: "20001" })).toEqual({ ok: false, message: "That is more than the KSh 20,000 still owed." });
    expect(entry({ amount: "20000" })).toEqual({ ok: true, cents: 2_000_000 });
  });

  it("wants the receipt, slip or cheque number for anything but cash, by its own name", () => {
    expect(entry({ method: "cash", reference: "" }).ok).toBe(true);
    expect(entry({ method: "mpesa", reference: "  " })).toEqual({ ok: false, message: "Enter the m-pesa receipt." });
    expect(entry({ method: "bank", reference: "" })).toEqual({ ok: false, message: "Enter the slip or transaction number." });
    expect(entry({ method: "cheque", reference: "" })).toEqual({ ok: false, message: "Enter the cheque number." });
    expect(entry({ method: "cheque", reference: "000123" }).ok).toBe(true);
  });

  it("knows the four ways money arrives", () => {
    expect(PAYMENT_METHODS.map((m) => m.value)).toEqual(["cash", "mpesa", "bank", "cheque"]);
  });

  it("names the learner from a search result's 'Name · admission number'", () => {
    expect(learnerNameOf("Ann Wanjiru · 1042")).toBe("Ann Wanjiru");
    expect(learnerNameOf("Ann Wanjiru")).toBe("Ann Wanjiru");
  });
});

describe("what a proof being confirmed starts the form with", () => {
  const confirm = (over: Partial<PendingProof> = {}) => proofToConfirm({
    id: "p1", file_path: null, file_name: "slip.jpg", note: "Paid Friday", uploaded_at: "x", studentName: "Ann", cls: "F1", invoice: null,
    sms_text: null, txn_source: null, txn_code: null, txn_amount_cents: null, txn_at: null, txn_payee: null, txn_payee_number: null, txn_account: null, ...over,
  });

  it("takes M-Pesa as M-Pesa, any other pasted message (Airtel Money, a bank) as bank, and a photo alone as nothing yet", () => {
    expect(confirm({ sms_text: "x", txn_source: "mpesa" }).method).toBe("mpesa");
    expect(confirm({ sms_text: "x", txn_source: "airtel" }).method).toBe("bank");
    expect(confirm({ sms_text: "x", txn_source: "bank" }).method).toBe("bank");
    expect(confirm({ sms_text: "x", txn_source: null }).method).toBe("bank");
    expect(confirm().method).toBeNull();
    expect(confirm()).toMatchObject({ id: "p1", fileName: "slip.jpg", note: "Paid Friday" });
  });

  it("starts a plain payment as cash with nothing filled in", () => {
    expect(paymentFormStart(undefined, 500_000)).toEqual({ amount: "", method: "cash", reference: "" });
  });

  it("fills in the code and amount from a message, never more than the balance, and a photo alone as bank", () => {
    const sms = confirm({ sms_text: "x", txn_source: "mpesa", txn_code: "SFC1234ABC", txn_amount_cents: 600_000 });
    expect(paymentFormStart(sms, 1_000_000)).toEqual({ amount: "6000", method: "mpesa", reference: "SFC1234ABC" });
    expect(paymentFormStart(sms, 400_000)).toEqual({ amount: "4000", method: "mpesa", reference: "SFC1234ABC" });
    expect(paymentFormStart(confirm(), 400_000)).toEqual({ amount: "", method: "bank", reference: "" });
  });
});

describe("the reason a proof is rejected with", () => {
  it("is trimmed, cut at 300 characters, and nothing until it has a few characters", () => {
    expect(rejectionReason("  The amount is different.  ")).toBe("The amount is different.");
    expect(rejectionReason("ab")).toBeNull();
    expect(rejectionReason("   ")).toBeNull();
    expect(rejectionReason("x".repeat(400))).toHaveLength(300);
  });
});

describe("recording a payment", () => {
  it("asks the database to record it, with the reference trimmed (none for cash with no number) and the proof it confirms", async () => {
    await recordPayment({ invoiceId: "inv-1", cents: 1_500_000, method: "mpesa", reference: " SFC1234ABC ", proofId: "p1" });
    await recordPayment({ invoiceId: "inv-2", cents: 500_000, method: "cash", reference: "  " });
    expect(calls.rpc).toEqual([
      { name: "record_payment", args: { p_invoice_id: "inv-1", p_amount_cents: 1_500_000, p_method: "mpesa", p_reference: "SFC1234ABC", p_proof_id: "p1" } },
      { name: "record_payment", args: { p_invoice_id: "inv-2", p_amount_cents: 500_000, p_method: "cash", p_reference: null, p_proof_id: null } },
    ]);
  });

  it("says what the database said when it refuses, such as a receipt recorded before", async () => {
    db.rpcError = "M-Pesa receipt SFC1234ABC has already been recorded.";
    await expect(recordPayment({ invoiceId: "inv-1", cents: 100, method: "mpesa", reference: "SFC1234ABC" })).rejects.toThrow("M-Pesa receipt SFC1234ABC has already been recorded.");
  });
});

describe("rejecting a proof", () => {
  beforeEach(() => {
    db.tables = { payment_proofs: [{ id: "p1", status: "pending" }, { id: "p2", status: "confirmed" }] };
  });

  it("saves the reason, who rejected it and when, on a proof still waiting", async () => {
    await rejectPaymentProof({ proofId: "p1", reviewerId: "grace", reason: "  The amount on the statement is different.  " });
    expect(db.tables.payment_proofs![0]).toMatchObject({ status: "rejected", reviewed_by: "grace", rejection_reason: "The amount on the statement is different." });
    expect(typeof db.tables.payment_proofs![0]!.reviewed_at).toBe("string");
  });

  it("does not turn a proof a colleague already confirmed into a rejection", async () => {
    await expect(rejectPaymentProof({ proofId: "p2", reviewerId: "grace", reason: "This payment is for a different learner." })).rejects.toThrow("That payment proof is no longer waiting for review.");
    expect(db.tables.payment_proofs![1]).toMatchObject({ status: "confirmed" });
  });

  it("wants a reason before it asks the database anything", async () => {
    await expect(rejectPaymentProof({ proofId: "p1", reviewerId: "grace", reason: "no" })).rejects.toThrow("Say why, in a few words: the family will read it.");
    expect(calls.queries).toHaveLength(0);
    expect(db.tables.payment_proofs![0]).toMatchObject({ status: "pending" });
  });

  it("says what the database said when it cannot save", async () => {
    db.error.payment_proofs = "permission denied for table payment_proofs";
    await expect(rejectPaymentProof({ proofId: "p1", reviewerId: "grace", reason: "The file or message can't be read." })).rejects.toThrow("permission denied for table payment_proofs");
  });
});

describe("finding an invoice to record a payment on", () => {
  beforeEach(() => {
    db.tables = { fee_invoices: [
      { id: "i1", term_id: "term-3", total_cents: 1_000_000, paid_cents: 250_000, students: { full_name: "Ann Wanjiru", admission_no: "1042", classes: { name: "Form 1A" } } },
      { id: "i2", term_id: "term-2", total_cents: 1_000_000, paid_cents: 0, students: { full_name: "Ann Wanjiru", admission_no: "1042", classes: null } },
      { id: "i3", term_id: "term-3", total_cents: 100_000, paid_cents: 150_000, students: null },
    ] };
  });

  it("looks in this term only, and gives the learner's name and admission number, class and what is owed (never below nothing)", async () => {
    const found = await searchPayableInvoices("term-3", "Ann");
    expect(found).toEqual([
      { id: "i1", studentName: "Ann Wanjiru · 1042", cls: "Form 1A", balanceCents: 750_000 },
      { id: "i3", studentName: "Unknown learner", cls: "—", balanceCents: 0 },
    ]);
  });

  it("takes the characters out of what was typed that would cut the filter short", async () => {
    await searchPayableInvoices("term-3", "Ann,(Wan)%jiru");
    expect(calls.or[0]).toEqual({ filter: "full_name.ilike.%Ann  Wan  jiru%,admission_no.ilike.%Ann  Wan  jiru%", options: { referencedTable: "students" } });
  });

  it("says what the database said when it cannot search", async () => {
    db.error.fee_invoices = "boom";
    await expect(searchPayableInvoices("term-3", "Ann")).rejects.toThrow("boom");
  });
});

describe("the term's collection, read from the database", () => {
  const invoices = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({
    id: `i${String(i).padStart(5, "0")}`, tenant_id: "school-1", term_id: "term-3", total_cents: 100_000, charges_cents: 0, paid_cents: i % 2 === 0 ? 100_000 : 0,
    students: { full_name: `Learner ${i}`, classes: { name: "Form 1A" } },
  }));

  beforeEach(() => {
    db.tables = {
      terms: [TERM, { ...TERM, id: "term-2", is_current: false }],
      fee_invoices: [...invoices(3), { id: "other-term", tenant_id: "school-1", term_id: "term-2", total_cents: 1, charges_cents: 0, paid_cents: 0, students: null }, { id: "other-school", tenant_id: "school-2", term_id: "term-3", total_cents: 1, charges_cents: 0, paid_cents: 0, students: null }],
      payment_proofs: [
        { ...rawProof("p1"), tenant_id: "school-1", status: "pending", fee_invoices: { ...rawProof("p1").fee_invoices, term_id: "term-3" } },
        { ...rawProof("p-old"), tenant_id: "school-1", status: "pending", fee_invoices: { ...rawProof("p-old").fee_invoices, term_id: "term-2" } },
        { ...rawProof("p-done"), tenant_id: "school-1", status: "confirmed", fee_invoices: { ...rawProof("p-done").fee_invoices, term_id: "term-3" } },
        { ...rawProof("p-else"), tenant_id: "school-2", status: "pending", fee_invoices: { ...rawProof("p-else").fee_invoices, term_id: "term-3" } },
      ],
      overpaid_invoices: [
        { id: "o1", tenant_id: "school-1", total_cents: 100, paid_cents: 150, overpaid_cents: 50, students: null, terms: { name: "Term 1, 2026" } },
        { id: "o2", tenant_id: "school-1", total_cents: 100, paid_cents: 400, overpaid_cents: 300, students: null, terms: null },
        { id: "o-else", tenant_id: "school-2", total_cents: 1, paid_cents: 2, overpaid_cents: 1, students: null, terms: null },
      ],
      tenants: [{ id: "school-1", payment_paybill: "522522", payment_till: null }],
    };
  });

  it("is this school's current term: its invoices, the proofs still waiting on them, what was overpaid (biggest first), and the school's own paybill", async () => {
    const c = await fetchFeesCollection("school-1");
    expect(c.term?.id).toBe("term-3");
    expect(c.invoices).toHaveLength(3);
    expect(c.outstanding.map((r) => r.id)).toEqual(["i00001"]);
    expect(c.pendingProofs.map((p) => p.id)).toEqual(["p1"]);
    expect(c.overpaid.map((o) => o.id)).toEqual(["o2", "o1"]);
    expect(c.school).toEqual({ paybill: "522522", till: null });
  });

  it("reads every page of invoices, not the first thousand", async () => {
    db.tables.fee_invoices = invoices(2_350);
    const c = await fetchFeesCollection("school-1");
    expect(c.invoices).toHaveLength(2_350);
    expect(feeFigures(c.invoices).owingCount).toBe(1_175);
  });

  it("does not ask for the term again when the caller has it", async () => {
    await fetchFeesCollection("school-1", TERM as never);
    expect(calls.terms).toBe(0);
    await fetchFeesCollection("school-1");
    expect(calls.terms).toBe(1);
  });

  it("has nothing to list between terms, and does not read invoices or proofs for no term", async () => {
    db.tables.terms = [{ ...TERM, is_current: false }];
    const c = await fetchFeesCollection("school-1");
    expect(c.term).toBeNull();
    expect(c.invoices).toEqual([]);
    expect(c.pendingProofs).toEqual([]);
    expect(calls.queries.some((q) => q.table === "fee_invoices" || q.table === "payment_proofs")).toBe(false);
  });

  it("says so when the proofs or the overpayments could not be read, rather than showing nothing to review", async () => {
    db.error.payment_proofs = "proofs unavailable";
    await expect(fetchFeesCollection("school-1")).rejects.toThrow("proofs unavailable");
    db.error = { overpaid_invoices: "overpaid unavailable" };
    await expect(fetchFeesCollection("school-1")).rejects.toThrow("overpaid unavailable");
    db.error = { fee_invoices: "invoices unavailable" };
    await expect(fetchFeesCollection("school-1")).rejects.toThrow("invoices unavailable");
  });
});
