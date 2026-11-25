import type { Tx } from "../../db/sql.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { pageQuery, type Page, type PageInput } from "../academics/pagination.js";
import { pgCode, pgMessage } from "../academics/pgError.js";
import { getInvoice } from "./invoices.js";
import { CURRENCY, toMinor } from "./money.js";

/**
 * Payment proofs (legacy payment_proofs): evidence of a payment made outside the app, as pasted SMS
 * text and/or a file reference. Files are METADATA ONLY: no object storage is approved, so no byte is
 * stored or served (same contract as directory documents, PHASE3-DOCUMENT-STORAGE-CONTRACT.md).
 * Lifecycle: pending -> confirmed (only by recording the payment, recordPayment with proof_id) or
 * -> rejected (with a reason). A proof is never deleted or edited.
 */
export type ProofVia = "office" | "guardian" | "learner";

export interface PublicProof {
  id: string;
  tenantId: string;
  invoice_id: string;
  submitted_by: string;
  /** `learner`: a learner paying their own fees through their own login (docs/STUDENT-ACCOUNTS.md, migration 110). */
  submitted_via: ProofVia;
  note: string | null;
  file: { file_name: string; content_type: string; byte_size: number; storage_status: "metadata_only"; object_available: false } | null;
  sms_text: string | null;
  txn_source: "mpesa" | "airtel" | "bank" | "unknown" | null;
  txn_code: string | null;
  txn_amount_minor: number | null;
  currency: typeof CURRENCY;
  txn_at: string | null;
  txn_payee: string | null;
  txn_payee_number: string | null;
  txn_account: string | null;
  status: "pending" | "confirmed" | "rejected";
  payment_id: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
  created_at: string;
}

type Row = {
  id: string;
  tenant_id: string;
  invoice_id: string;
  submitted_by: string;
  submitted_via: ProofVia;
  note: string | null;
  file_name: string | null;
  content_type: string | null;
  byte_size: number | null;
  sms_text: string | null;
  txn_source: PublicProof["txn_source"];
  txn_code: string | null;
  txn_amount_minor: string | null;
  txn_at: Date | null;
  txn_payee: string | null;
  txn_payee_number: string | null;
  txn_account: string | null;
  status: PublicProof["status"];
  payment_id: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  rejection_reason: string | null;
  created_at: Date;
};

const COLS = `id, tenant_id, invoice_id, submitted_by, submitted_via, note, file_name, content_type, byte_size, sms_text,
  txn_source, txn_code, txn_amount_minor, txn_at, txn_payee, txn_payee_number, txn_account, status, payment_id,
  reviewed_by, reviewed_at, rejection_reason, created_at`;

function map(r: Row): PublicProof {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    invoice_id: r.invoice_id,
    submitted_by: r.submitted_by,
    submitted_via: r.submitted_via,
    note: r.note,
    file: r.file_name
      ? { file_name: r.file_name, content_type: r.content_type!, byte_size: r.byte_size!, storage_status: "metadata_only", object_available: false }
      : null,
    sms_text: r.sms_text,
    txn_source: r.txn_source,
    txn_code: r.txn_code,
    txn_amount_minor: r.txn_amount_minor === null ? null : toMinor(r.txn_amount_minor),
    currency: CURRENCY,
    txn_at: r.txn_at ? r.txn_at.toISOString() : null,
    txn_payee: r.txn_payee,
    txn_payee_number: r.txn_payee_number,
    txn_account: r.txn_account,
    status: r.status,
    payment_id: r.payment_id,
    reviewed_by: r.reviewed_by,
    reviewed_at: r.reviewed_at ? r.reviewed_at.toISOString() : null,
    rejection_reason: r.rejection_reason,
    created_at: r.created_at.toISOString(),
  };
}

export interface ProofInput {
  invoice_id: string;
  note?: string | null;
  file?: { file_name: string; content_type: "image/jpeg" | "image/png" | "image/webp" | "application/pdf"; byte_size: number } | null;
  sms_text?: string | null;
  txn_source?: "mpesa" | "airtel" | "bank" | "unknown" | null;
  txn_code?: string | null;
  txn_amount_minor?: number | null;
  txn_at?: string | null;
  txn_payee?: string | null;
  txn_payee_number?: string | null;
  txn_account?: string | null;
}

export async function submitProof(
  tx: Tx,
  input: ProofInput & { tenantId: string; actorUserId: string; via: ProofVia; ip?: string | null },
): Promise<PublicProof> {
  const invoice = await getInvoice(tx, { tenantId: input.tenantId, invoiceId: input.invoice_id });
  if (invoice.voided_at) throw conflict("The invoice is voided");
  if (!input.file && !input.sms_text) throw validationError("A proof needs the payment message text or a file");
  if (input.file && (/[/\\]/.test(input.file.file_name) || [...input.file.file_name].some((ch) => ch.charCodeAt(0) < 32))) throw validationError("file_name must be a plain file name");
  if (input.sms_text && !input.txn_code) throw validationError("txn_code is required with a payment message");
  const code = input.txn_code ? input.txn_code.trim().toUpperCase() : null;
  if (input.txn_amount_minor !== undefined && input.txn_amount_minor !== null && (!Number.isSafeInteger(input.txn_amount_minor) || input.txn_amount_minor <= 0)) {
    throw validationError("txn_amount_minor must be a positive whole number of cents");
  }
  try {
    const res = await tx.query<Row>(
      `INSERT INTO finance_payment_proofs
         (tenant_id, invoice_id, submitted_by, submitted_via, note, file_name, content_type, byte_size, storage_status,
          sms_text, txn_source, txn_code, txn_amount_minor, txn_at, txn_payee, txn_payee_number, txn_account)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz, $15, $16, $17)
       RETURNING ${COLS}`,
      [
        input.tenantId,
        input.invoice_id,
        input.actorUserId,
        input.via,
        input.note?.trim() || null,
        input.file?.file_name ?? null,
        input.file?.content_type ?? null,
        input.file?.byte_size ?? null,
        input.file ? "metadata_only" : null,
        input.sms_text ?? null,
        input.txn_source ?? null,
        code,
        input.txn_amount_minor ?? null,
        input.txn_at ?? null,
        input.txn_payee ?? null,
        input.txn_payee_number ?? null,
        input.txn_account ?? null,
      ],
    );
    const row = res.rows[0]!;
    await recordSecurityEvent(tx, {
      eventType: "finance.proof.submitted",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { proofId: row.id, invoiceId: row.invoice_id, via: input.via, hasFile: Boolean(input.file), hasMessage: Boolean(input.sms_text) },
      ip: input.ip,
    });
    return map(row);
  } catch (err) {
    const c = pgCode(err);
    const msg = pgMessage(err);
    if (c === "23505" && msg.includes("already recorded")) throw conflict("That transaction is already recorded as a payment");
    if (c === "23505") throw conflict("A proof with this transaction code is already waiting for review");
    if (c === "23514" && msg.includes("does not appear")) throw validationError("The transaction code does not appear in the message");
    if (c === "23514") throw validationError("The proof is not valid");
    throw err;
  }
}

export async function getProof(tx: Tx, input: { tenantId: string; proofId: string }): Promise<PublicProof> {
  const res = await tx.query<Row>(`SELECT ${COLS} FROM finance_payment_proofs WHERE tenant_id = $1 AND id = $2`, [input.tenantId, input.proofId]);
  if (!res.rows[0]) throw notFound("Payment proof not found");
  return map(res.rows[0]);
}

export async function listProofs(
  tx: Tx,
  input: { tenantId: string; invoiceId?: string; status?: PublicProof["status"]; page: PageInput },
): Promise<Page<PublicProof>> {
  const params: unknown[] = [input.tenantId];
  const where = ["tenant_id = $1"];
  if (input.invoiceId) {
    params.push(input.invoiceId);
    where.push(`invoice_id = $${params.length}`);
  }
  if (input.status) {
    params.push(input.status);
    where.push(`status = $${params.length}`);
  }
  const out = await pageQuery<Row>(
    tx,
    `SELECT ${COLS} FROM finance_payment_proofs WHERE ${where.join(" AND ")}`,
    params,
    { name: "payment_proofs", expr: "q.created_at", type: "timestamptz", dir: "desc" },
    input.page,
  );
  return { items: out.rows.map(map), page: out.page };
}

export async function rejectProof(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; proofId: string; reason: string; ip?: string | null },
): Promise<PublicProof> {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 300) throw validationError("reason must be 3–300 characters");
  const current = await tx.query<{ status: string }>(
    `SELECT status FROM finance_payment_proofs WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.proofId],
  );
  if (!current.rows[0]) throw notFound("Payment proof not found");
  if (current.rows[0].status !== "pending") throw conflict("This proof has already been reviewed");
  await tx.query(
    `UPDATE finance_payment_proofs SET status = 'rejected', reviewed_by = $3, rejection_reason = $4 WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.proofId, input.actorUserId, reason],
  );
  await recordSecurityEvent(tx, {
    eventType: "finance.proof.rejected",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { proofId: input.proofId },
    ip: input.ip,
  });
  return getProof(tx, input);
}
