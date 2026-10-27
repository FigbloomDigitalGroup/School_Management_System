import { supabase } from "./supabase";
import type { IssueStatus } from "./inventory";

/**
 * One-off charges on a learner's term invoice: a lost textbook, a broken
 * microscope (supabase/migrations/20261028200001_fee_charges.sql).
 *
 * A charge raises the invoice's total_cents, so every balance (total minus
 * paid) already includes it: the Fees screens, the M-Pesa prompt, the report
 * card and the phone app need nothing extra to agree. What they can add is
 * the line itself, so a family sees why the total went up. charges_cents is
 * the part of the total that is charges; feesOnlyCents() is the rest.
 *
 * The office makes every charge by hand. suggestedCharge() only prefills
 * the form from the item's cost.
 */

export interface FeeCharge {
  id: string;
  invoiceId: string;
  studentId: string;
  amountCents: number;
  reason: string;
  issueId: string | null;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
}

interface ChargeRow {
  id: string; invoice_id: string; student_id: string; amount_cents: number; reason: string; issue_id: string | null;
  created_at: string; voided_at: string | null; void_reason: string | null;
}
const CHARGE_COLS = "id, invoice_id, student_id, amount_cents, reason, issue_id, created_at, voided_at, void_reason";
const toCharge = (r: ChargeRow): FeeCharge => ({
  id: r.id, invoiceId: r.invoice_id, studentId: r.student_id, amountCents: r.amount_cents, reason: r.reason,
  issueId: r.issue_id, createdAt: r.created_at, voidedAt: r.voided_at, voidReason: r.void_reason,
});

// ------------------------------------------------------------------ pure

/** The billed fees alone, out of an invoice total that includes charges. */
export function feesOnlyCents(i: { total_cents: number; charges_cents?: number | null }): number {
  return Math.max(i.total_cents - (i.charges_cents ?? 0), 0);
}

/** Charges still standing (cancelled ones are kept, but no longer owed). */
export function standingCharges<T extends Pick<FeeCharge, "voidedAt">>(charges: T[]): T[] {
  return charges.filter((c) => !c.voidedAt);
}

/**
 * What the charge form starts with for a lost or damaged hand-out: the
 * item's cost for each copy, and a reason the family will understand.
 * amountCents is null when the register has no cost for the item.
 */
export function suggestedCharge(issue: {
  status: IssueStatus; quantity: number; itemName: string; unitCostCents: number | null;
}): { amountCents: number | null; reason: string } {
  const what = issue.status === "lost" ? "Lost" : "Damaged";
  const copies = issue.quantity > 1 ? ` (${issue.quantity} copies)` : "";
  return {
    amountCents: issue.unitCostCents == null ? null : issue.unitCostCents * issue.quantity,
    reason: `${what}: ${issue.itemName}${copies}`.slice(0, 200),
  };
}

// ------------------------------------------------------------------ reading

/** Charges on these invoices, cancelled ones included, oldest first. RLS gives each reader only what they may see. */
export async function fetchInvoiceCharges(invoiceIds: string[]): Promise<FeeCharge[]> {
  if (!invoiceIds.length) return [];
  const { data, error } = await supabase().from("fee_charges").select(CHARGE_COLS)
    .in("invoice_id", invoiceIds).order("created_at").returns<ChargeRow[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map(toCharge);
}

/** The school's charges made for inventory hand-outs, keyed by issue: the Inventory screen's "Charged" marks. Standing ones only. */
export async function fetchIssueCharges(tenantId: string): Promise<Map<string, FeeCharge>> {
  const { data, error } = await supabase().from("fee_charges").select(CHARGE_COLS)
    .eq("tenant_id", tenantId).not("issue_id", "is", null).is("voided_at", null).returns<ChargeRow[]>();
  if (error) throw new Error(error.message);
  return new Map((data ?? []).map((r) => [r.issue_id!, toCharge(r)]));
}

// ------------------------------------------------------------------ writing (the office)

/** Adds a charge to the learner's invoice for the current term. Returns the charge's id. */
export async function chargeLearner(input: { studentId: string; amountCents: number; reason: string; issueId?: string | null }): Promise<string> {
  const { data, error } = await supabase().rpc("charge_learner", {
    p_student_id: input.studentId, p_amount_cents: input.amountCents, p_reason: input.reason, p_issue_id: input.issueId ?? null,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

/** Cancels a charge; the invoice total comes down by its amount. Refused once it has been paid for. */
export async function voidFeeCharge(chargeId: string, reason: string): Promise<void> {
  const { error } = await supabase().rpc("void_fee_charge", { p_charge_id: chargeId, p_reason: reason });
  if (error) throw new Error(error.message);
}
