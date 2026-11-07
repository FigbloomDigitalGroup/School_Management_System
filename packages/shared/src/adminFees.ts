import { formatMoney, parseShillings } from "./fees";
import { fetchAllPages } from "./paging";
import { paymentSmsFlags, type PaymentSmsFlag, type PaymentSmsSource } from "./paymentSms";
import { supabase } from "./supabase";
import type { Term } from "./types";

/**
 * What the bursar does with fees away from the desk: how the term is going, the balances that matter most, money
 * received outside the M-Pesa prompt, and the proof families upload. It was inline in the web's Fees and FeeCollection
 * screens; it lives here so the phone's admin console says the same things, the same way. (Setting the fee items,
 * billing the term and signing invoices stay on the web.)
 */

/** A learner still owing, as the largest-balances list shows them. Money is cents. */
export interface OutstandingRow {
  id: string;
  name: string;
  cls: string;
  /** The invoice total, charges included. */
  billed: number;
  /** The part of `billed` that is charges (a lost textbook). */
  charges: number;
  paid: number;
}

/** An invoice paid above its total, in any term (the overpaid_invoices view). */
export interface OverpaidRow {
  id: string;
  total_cents: number;
  paid_cents: number;
  overpaid_cents: number;
  students: { full_name: string; classes: { name: string } | null } | null;
  terms: { name: string } | null;
}

/** An invoice a payment can still be recorded on. */
export interface PayableInvoice {
  id: string;
  studentName: string;
  cls: string;
  balanceCents: number;
}

/** What a pasted confirmation SMS said (payment_proofs.sms_text and the txn_* fields parsed from it). */
export interface ProofSms {
  sms_text: string | null;
  txn_source: PaymentSmsSource | null;
  txn_code: string | null;
  txn_amount_cents: number | null;
  txn_at: string | null;
  txn_payee: string | null;
  txn_payee_number: string | null;
  txn_account: string | null;
}

/** A proof a family uploaded and the office has not yet confirmed or rejected. */
export interface PendingProof extends ProofSms {
  id: string;
  file_path: string | null;
  file_name: string | null;
  note: string | null;
  uploaded_at: string;
  studentName: string;
  cls: string;
  invoice: PayableInvoice | null;
}

export interface RawInvoiceRow {
  id: string;
  total_cents: number;
  charges_cents: number;
  paid_cents: number;
  students: { full_name: string; classes: { name: string } | null } | null;
}

export interface RawProofRow extends ProofSms {
  id: string;
  file_path: string | null;
  file_name: string | null;
  note: string | null;
  uploaded_at: string;
  fee_invoices: { id: string; total_cents: number; paid_cents: number; students: { full_name: string; classes: { name: string } | null } | null } | null;
}

/** The school's own M-Pesa numbers, which a pasted message is checked against. */
export interface SchoolPayee { paybill: string | null; till: string | null }

export interface FeesCollection {
  term: Term | null;
  /** Every invoice of the term, only its two amounts: the totals are the school's whole term. */
  invoices: { total_cents: number; paid_cents: number }[];
  /** The ten largest balances. */
  outstanding: OutstandingRow[];
  overpaid: OverpaidRow[];
  pendingProofs: PendingProof[];
  school: SchoolPayee;
}

/** How many of the biggest balances are listed. */
export const OUTSTANDING_LIST = 10;

/** The raw answers of the queries, made into what the screens show. Pure, so the rules can be tested without a database. */
export function shapeFeesCollection(raw: { invoices: RawInvoiceRow[]; proofs: RawProofRow[]; overpaid: OverpaidRow[] }): Pick<FeesCollection, "invoices" | "outstanding" | "overpaid" | "pendingProofs"> {
  const outstanding = raw.invoices
    .filter((r) => r.paid_cents < r.total_cents)
    .map((r) => ({
      id: r.id,
      name: r.students?.full_name ?? "Unknown learner",
      cls: r.students?.classes?.name ?? "—",
      billed: r.total_cents,
      charges: r.charges_cents,
      paid: r.paid_cents,
    }))
    .sort((a, b) => (b.billed - b.paid) - (a.billed - a.paid))
    .slice(0, OUTSTANDING_LIST);

  const pendingProofs: PendingProof[] = raw.proofs.map((r) => {
    const studentName = r.fee_invoices?.students?.full_name ?? "Unknown learner";
    const cls = r.fee_invoices?.students?.classes?.name ?? "—";
    const { fee_invoices: _invoice, ...proof } = r;
    return {
      ...proof,
      studentName,
      cls,
      invoice: r.fee_invoices
        ? { id: r.fee_invoices.id, studentName, cls, balanceCents: Math.max(r.fee_invoices.total_cents - r.fee_invoices.paid_cents, 0) }
        : null,
    };
  });

  return {
    invoices: raw.invoices.map((r) => ({ total_cents: r.total_cents, paid_cents: r.paid_cents })),
    outstanding,
    overpaid: raw.overpaid,
    pendingProofs,
  };
}

/** The current term of a school, or null between terms. */
export async function fetchTenantCurrentTerm(tenantId: string): Promise<Term | null> {
  const { data, error } = await supabase().from("terms").select("*").eq("tenant_id", tenantId).eq("is_current", true).maybeSingle<Term>();
  if (error) throw new Error(error.message);
  return data ?? null;
}

/**
 * The term's collection: every invoice (read in pages, not the first 1,000), the largest balances, what was paid above
 * what was owed (any term: money owed back does not expire with the term), the proofs waiting for review, and the
 * school's own payee numbers. Give `term` when the caller already has it, to skip asking.
 */
export async function fetchFeesCollection(tenantId: string, term?: Term | null): Promise<FeesCollection> {
  const sb = supabase();
  const current = term === undefined ? await fetchTenantCurrentTerm(tenantId) : term;
  const termId = current?.id ?? null;

  const [invoices, proofs, overpaid, tenant] = await Promise.all([
    termId
      ? fetchAllPages<RawInvoiceRow>((from, to) =>
          sb.from("fee_invoices").select("id,total_cents,charges_cents,paid_cents,students(full_name,classes(name))")
            .eq("tenant_id", tenantId).eq("term_id", termId).order("id").range(from, to).returns<RawInvoiceRow[]>())
      : Promise.resolve([] as RawInvoiceRow[]),
    // Payment proofs are keyed by invoice, not term: reach the current term through fee_invoices.
    termId
      ? sb.from("payment_proofs")
          .select("id,file_path,file_name,note,uploaded_at,sms_text,txn_source,txn_code,txn_amount_cents,txn_at,txn_payee,txn_payee_number,txn_account,fee_invoices!inner(id,total_cents,paid_cents,term_id,students(full_name,classes(name)))")
          .eq("tenant_id", tenantId)
          .eq("status", "pending")
          .eq("fee_invoices.term_id", termId)
          .order("uploaded_at", { ascending: true })
          .returns<RawProofRow[]>()
      : Promise.resolve({ data: [] as RawProofRow[], error: null }),
    sb.from("overpaid_invoices").select("id,total_cents,paid_cents,overpaid_cents,students(full_name,classes(name)),terms(name)")
      .eq("tenant_id", tenantId).order("overpaid_cents", { ascending: false }).returns<OverpaidRow[]>(),
    sb.from("tenants").select("payment_paybill,payment_till").eq("id", tenantId).maybeSingle<{ payment_paybill: string | null; payment_till: string | null }>(),
  ]);
  // A query that failed must not read as "nothing to review".
  if (proofs.error) throw new Error(proofs.error.message);
  if (overpaid.error) throw new Error(overpaid.error.message);
  if (tenant.error) throw new Error(tenant.error.message);

  return {
    term: current,
    ...shapeFeesCollection({ invoices, proofs: proofs.data ?? [], overpaid: overpaid.data ?? [] }),
    school: { paybill: tenant.data?.payment_paybill ?? null, till: tenant.data?.payment_till ?? null },
  };
}

export interface FeeFigures {
  billed: number;
  collected: number;
  /** Per invoice: one family's overpayment does not cancel another's debt. */
  outstandingTotal: number;
  collectedPct: number;
  owingCount: number;
  fullyPaidCount: number;
  fullyPaidPct: number;
}

/** The four figures a term's fee page leads with. */
export function feeFigures(invoices: { total_cents: number; paid_cents: number }[]): FeeFigures {
  const billed = invoices.reduce((a, i) => a + i.total_cents, 0);
  const collected = invoices.reduce((a, i) => a + i.paid_cents, 0);
  const fullyPaidCount = invoices.filter((i) => i.paid_cents >= i.total_cents && i.total_cents > 0).length;
  return {
    billed,
    collected,
    outstandingTotal: invoices.reduce((a, i) => a + Math.max(i.total_cents - i.paid_cents, 0), 0),
    collectedPct: billed > 0 ? Math.round((collected / billed) * 100) : 0,
    owingCount: invoices.filter((i) => i.paid_cents < i.total_cents).length,
    fullyPaidCount,
    fullyPaidPct: invoices.length > 0 ? Math.round((fullyPaidCount / invoices.length) * 100) : 0,
  };
}

/** What a balance looks like at a glance: nothing paid at all, or part of it. */
export const balanceStanding = (r: Pick<OutstandingRow, "paid">): "Nothing paid" | "Part paid" => (r.paid === 0 ? "Nothing paid" : "Part paid");

/** What the bursar should look at twice in a pasted message (none for a proof with no message). */
export function proofFlags(p: PendingProof, school: SchoolPayee, now: Date = new Date()): PaymentSmsFlag[] {
  if (!p.sms_text) return [];
  return paymentSmsFlags(
    { code: p.txn_code, amountCents: p.txn_amount_cents, payeeNumber: p.txn_payee_number, paidAt: p.txn_at },
    { balanceCents: p.invoice?.balanceCents ?? null, paybill: school.paybill, till: school.till },
    now,
  );
}

// ---------------------------------------------------------------- record a payment

export const PAYMENT_METHODS = [
  { value: "cash", label: "Cash", refLabel: "Receipt book number", refHint: "Optional for cash." },
  { value: "mpesa", label: "M-Pesa to the school's paybill/till", refLabel: "M-Pesa receipt", refHint: "The code on the confirmation SMS, e.g. SFC1234ABC. Each receipt can only be recorded once." },
  { value: "bank", label: "Bank deposit or transfer", refLabel: "Slip or transaction number", refHint: "As printed on the deposit slip." },
  { value: "cheque", label: "Cheque", refLabel: "Cheque number", refHint: "Record it once the cheque has cleared." },
] as const;
export type PaymentMethodValue = (typeof PAYMENT_METHODS)[number]["value"];

/** A short name for a method, for a button or a confirmation ("M-Pesa", not the whole sentence). */
export const PAYMENT_METHOD_SHORT: Record<PaymentMethodValue, string> = { cash: "Cash", mpesa: "M-Pesa", bank: "Bank", cheque: "Cheque" };

interface InvoiceSearchRow {
  id: string;
  total_cents: number;
  paid_cents: number;
  students: { full_name: string; admission_no: string; classes: { name: string } | null } | null;
}

/** Invoices of the term whose learner's name or admission number matches what was typed (at most eight). */
export async function searchPayableInvoices(termId: string, q: string): Promise<PayableInvoice[]> {
  // These characters would end the filter early (PostgREST's or() splits on commas and brackets).
  const term = q.replace(/[%,()]/g, " ").trim();
  const { data, error } = await supabase().from("fee_invoices")
    .select("id, total_cents, paid_cents, students!inner(full_name, admission_no, classes(name))")
    .eq("term_id", termId)
    .or(`full_name.ilike.%${term}%,admission_no.ilike.%${term}%`, { referencedTable: "students" })
    .limit(8)
    .returns<InvoiceSearchRow[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id,
    studentName: r.students ? `${r.students.full_name} · ${r.students.admission_no}` : "Unknown learner",
    cls: r.students?.classes?.name ?? "—",
    balanceCents: Math.max(r.total_cents - r.paid_cents, 0),
  }));
}

/** The learner's name from a search result's "Name · admission no". */
export const learnerNameOf = (studentName: string): string => studentName.split(" · ")[0] ?? studentName;

/**
 * What was typed for a payment, checked the way the database will: whole shillings (or exactly what is still owed, so
 * a balance left with cents can be cleared), no more than the balance, and a reference for anything but cash.
 */
export function readPaymentEntry(input: { amount: string; method: PaymentMethodValue; reference: string; balanceCents: number; country: string }):
  { ok: true; cents: number } | { ok: false; message: string } {
  const parsed = parseShillings(input.amount);
  const typed = Math.round(parseFloat(input.amount.replace(/[\s,]/g, "")) * 100);
  const cents = parsed.ok ? parsed.cents : typed === input.balanceCents ? typed : NaN;
  if (!parsed.ok && !Number.isFinite(cents)) return { ok: false, message: parsed.message };
  if (!Number.isFinite(cents) || cents <= 0) return { ok: false, message: "Enter the amount received." };
  if (cents > input.balanceCents) return { ok: false, message: `That is more than the ${formatMoney(input.balanceCents, input.country)} still owed.` };
  const method = PAYMENT_METHODS.find((m) => m.value === input.method)!;
  if (input.method !== "cash" && !input.reference.trim()) return { ok: false, message: `Enter the ${method.refLabel.toLowerCase()}.` };
  return { ok: true, cents };
}

/**
 * The one way the office credits an invoice outside the M-Pesa prompt: cash at the bursar's window, a bank slip, a
 * cheque, or M-Pesa paid straight to the school's paybill. record_payment() writes a real payment (so the balance
 * moves the way an M-Pesa prompt moves it), confirms the family's uploaded proof when it came from one, and logs it.
 * The database's own refusals ("M-Pesa receipt X has already been recorded") come back as the error's message.
 */
export async function recordPayment(input: { invoiceId: string; cents: number; method: PaymentMethodValue; reference: string; proofId?: string | null }): Promise<void> {
  const { error } = await supabase().rpc("record_payment", {
    p_invoice_id: input.invoiceId,
    p_amount_cents: input.cents,
    p_method: input.method,
    p_reference: input.reference.trim() || null,
    p_proof_id: input.proofId ?? null,
  });
  if (error) throw new Error(error.message);
}

/** What a proof being confirmed brings to the payment form: the code and amount a pasted message showed, and how it was paid. */
export interface ProofToConfirm {
  id: string;
  fileName: string | null;
  note: string | null;
  smsText?: string | null;
  /** Read from the pasted SMS; they fill the form, and the bursar checks them against the statement. */
  code?: string | null;
  amountCents?: number | null;
  method?: "mpesa" | "bank" | null;
}

export function proofToConfirm(p: PendingProof): ProofToConfirm {
  return {
    id: p.id,
    fileName: p.file_name,
    note: p.note,
    smsText: p.sms_text,
    code: p.txn_code,
    amountCents: p.txn_amount_cents,
    // Airtel Money and bank transfers are recorded as bank: there is no separate method for them.
    method: p.txn_source === "mpesa" ? "mpesa" : p.sms_text ? "bank" : null,
  };
}

/** The amount and method a proof starts the payment form with: never more than the balance, which record_payment would refuse anyway. */
export function paymentFormStart(proof: ProofToConfirm | undefined, balanceCents: number | undefined): { amount: string; method: PaymentMethodValue; reference: string } {
  return {
    amount: proof?.amountCents ? String(Math.min(proof.amountCents, balanceCents ?? proof.amountCents) / 100) : "",
    method: proof?.method ?? (proof ? "bank" : "cash"),
    reference: proof?.code ?? "",
  };
}

// ---------------------------------------------------------------- reject a proof

/** Reasons the bursar can pick from; the family sees what is sent. */
export const REJECT_REASONS = [
  "The transaction code is not on the school's statement.",
  "The amount on the statement is different.",
  "This payment is for a different learner.",
  "The file or message can't be read.",
] as const;

/** The reason as it is saved: trimmed, at most 300 characters; null while it is too short to mean anything. */
export function rejectionReason(text: string): string | null {
  const reason = text.trim().slice(0, 300);
  return reason.length >= 3 ? reason : null;
}

/**
 * Rejects a proof, with the reason the family will see (so they know whether to send it again or call). Only a proof
 * still waiting is rejected: one a colleague confirmed a moment ago is not turned into a rejection.
 */
export async function rejectPaymentProof(input: { proofId: string; reviewerId: string; reason: string }): Promise<void> {
  const reason = rejectionReason(input.reason);
  if (!reason) throw new Error("Say why, in a few words: the family will read it.");
  const { data, error } = await supabase()
    .from("payment_proofs")
    .update({ status: "rejected", reviewed_by: input.reviewerId, reviewed_at: new Date().toISOString(), rejection_reason: reason })
    .eq("id", input.proofId)
    .eq("status", "pending")
    .select("id");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error("That payment proof is no longer waiting for review.");
}
