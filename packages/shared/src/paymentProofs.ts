import { safeFileName } from "./materials";
import type { ParsedPaymentSms } from "./paymentSms";
import { uploadFile } from "./storageUpload";
import { supabase } from "./supabase";
import { PRIVATE_DOCS_BUCKET, type UploadableFile } from "./uploads";

/**
 * A family's proof of payment for an invoice (payment_proofs): a photo or
 * PDF of the slip, the confirmation SMS pasted as text
 * (20261027100000_payment_proof_text.sql), or both. The office checks it
 * against the school's own statement before recording the payment. The
 * browser's version is uploadPaymentProof in the web app; the phone apps send
 * the pasted message, a photo or PDF, or both (sendPaymentProof).
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

/** Where a proof's file lives: the invoice's own folder, which the database checks. */
export function paymentProofFilePath(tenantId: string, invoiceId: string, fileName: string, now: number = Date.now()): string {
  return `${tenantId}/invoices/${invoiceId}/${now}-${safeFileName(fileName)}`;
}

/**
 * Sends a proof: the pasted confirmation message (parsed is what
 * parsePaymentSms read from its text), a photo, or both. The database refuses
 * a transaction code already used for this school, and says so in its
 * message; a photo that went up without its proof is taken back out.
 */
export async function sendPaymentProof(input: {
  tenantId: string; invoiceId: string; uploadedBy: string; note?: string;
  sms?: { text: string; parsed: ParsedPaymentSms };
  file?: UploadableFile;
}): Promise<void> {
  if (!input.file && !input.sms) throw new Error("Add a photo or paste the confirmation message.");
  if (input.sms && !input.sms.parsed.code) throw new Error("There is no transaction code in that message.");

  let path: string | null = null;
  if (input.file) {
    path = paymentProofFilePath(input.tenantId, input.invoiceId, input.file.name);
    await uploadFile(PRIVATE_DOCS_BUCKET, path, input.file);
  }

  const p = input.sms?.parsed;
  const { error } = await supabase().from("payment_proofs").insert({
    tenant_id: input.tenantId,
    invoice_id: input.invoiceId,
    uploaded_by: input.uploadedBy,
    file_path: path,
    file_name: input.file?.name ?? null,
    note: input.note ?? null,
    sms_text: input.sms?.text.trim() ?? null,
    txn_source: p?.source ?? null,
    txn_code: p?.code ?? null,
    txn_amount_cents: p?.amountCents ?? null,
    txn_at: p?.paidAt ?? null,
    txn_payee: p?.payee ?? null,
    txn_payee_number: p?.payeeNumber ?? null,
    txn_account: p?.account ?? null,
  });
  if (error) {
    if (path) await supabase().storage.from(PRIVATE_DOCS_BUCKET).remove([path]).catch(() => {});
    throw new Error(error.message);
  }
}

/** Sends just the pasted confirmation message (no photo). */
export async function sendSmsPaymentProof(input: {
  tenantId: string; invoiceId: string; uploadedBy: string; note?: string;
  text: string; parsed: ParsedPaymentSms;
}): Promise<void> {
  await sendPaymentProof({ tenantId: input.tenantId, invoiceId: input.invoiceId, uploadedBy: input.uploadedBy, note: input.note, sms: { text: input.text, parsed: input.parsed } });
}
