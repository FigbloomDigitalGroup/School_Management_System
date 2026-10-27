import type { ParsedPaymentSms } from "./paymentSms";
import { supabase } from "./supabase";

/**
 * A family's proof of payment for an invoice (payment_proofs): a photo or
 * PDF of the slip, the confirmation SMS pasted as text
 * (20261027100000_payment_proof_text.sql), or both. The office checks it
 * against the school's own statement before recording the payment. The
 * browser's version, with file uploads, is uploadPaymentProof in the web
 * app; the phone apps send the pasted message, which needs no file.
 */

export interface PaymentProof {
  id: string;
  invoice_id: string;
  /** Null for a proof that is only a pasted SMS. */
  file_path: string | null;
  file_name: string | null;
  note: string | null;
  status: "pending" | "confirmed" | "rejected";
  uploaded_at: string;
  txn_code: string | null;
  txn_amount_cents: number | null;
  rejection_reason: string | null;
}

export const PAYMENT_PROOF_LABEL: Record<PaymentProof["status"], string> = {
  pending: "Pending review",
  confirmed: "Confirmed",
  rejected: "Rejected",
};

/** Newest first. */
export async function listPaymentProofs(invoiceId: string): Promise<PaymentProof[]> {
  const { data, error } = await supabase()
    .from("payment_proofs")
    .select("id, invoice_id, file_path, file_name, note, status, uploaded_at, txn_code, txn_amount_cents, rejection_reason")
    .eq("invoice_id", invoiceId)
    .order("uploaded_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as PaymentProof[];
}

/**
 * Sends the pasted confirmation message as proof. parsed is what
 * parsePaymentSms read from text; the database refuses a code that has
 * already been used for this school, and says so in its message.
 */
export async function sendSmsPaymentProof(input: {
  tenantId: string; invoiceId: string; uploadedBy: string; note?: string;
  text: string; parsed: ParsedPaymentSms;
}): Promise<void> {
  if (!input.parsed.code) throw new Error("There is no transaction code in that message.");
  const p = input.parsed;
  const { error } = await supabase().from("payment_proofs").insert({
    tenant_id: input.tenantId,
    invoice_id: input.invoiceId,
    uploaded_by: input.uploadedBy,
    file_path: null,
    file_name: null,
    note: input.note ?? null,
    sms_text: input.text.trim(),
    txn_source: p.source,
    txn_code: p.code,
    txn_amount_cents: p.amountCents,
    txn_at: p.paidAt,
    txn_payee: p.payee,
    txn_payee_number: p.payeeNumber,
    txn_account: p.account,
  });
  if (error) throw new Error(error.message);
}
