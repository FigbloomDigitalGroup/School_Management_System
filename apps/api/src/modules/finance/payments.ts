import type { Tx } from "../../db/sql.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { pageQuery, type Page, type PageInput } from "../academics/pagination.js";
import { pgCode, pgMessage } from "../academics/pgError.js";
import { getInvoice, type PublicInvoice } from "./invoices.js";
import { assertMinorAmount, CURRENCY, toMinor } from "./money.js";

export type PaymentMethod = "mpesa" | "bank" | "cash" | "cheque";
export type PaymentStatus = "pending" | "success" | "failed" | "cancelled" | "timeout";

export interface PublicPayment {
  id: string;
  tenantId: string;
  invoice_id: string;
  currency: typeof CURRENCY;
  amount_minor: number;
  method: PaymentMethod;
  status: PaymentStatus;
  reference: string | null;
  mpesa_receipt: string | null;
  failure_reason: string | null;
  proof_id: string | null;
  recorded_by: string | null;
  created_at: string;
  completed_at: string | null;
}

type Row = {
  id: string;
  tenant_id: string;
  invoice_id: string;
  amount_minor: string;
  method: PaymentMethod;
  status: PaymentStatus;
  reference: string | null;
  mpesa_receipt: string | null;
  failure_reason: string | null;
  proof_id: string | null;
  recorded_by: string | null;
  created_at: Date;
  completed_at: Date | null;
};

export const PAYMENT_COLS = `id, tenant_id, invoice_id, amount_minor, method, status, reference, mpesa_receipt, failure_reason,
  proof_id, recorded_by, created_at, completed_at`;

export function mapPayment(row: Row): PublicPayment {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    invoice_id: row.invoice_id,
    currency: CURRENCY,
    amount_minor: toMinor(row.amount_minor),
    method: row.method,
    status: row.status,
    reference: row.reference,
    mpesa_receipt: row.mpesa_receipt,
    failure_reason: row.failure_reason,
    proof_id: row.proof_id,
    recorded_by: row.recorded_by,
    created_at: row.created_at.toISOString(),
    completed_at: row.completed_at ? row.completed_at.toISOString() : null,
  };
}

export async function getPayment(tx: Tx, input: { tenantId: string; paymentId: string }): Promise<PublicPayment> {
  const res = await tx.query<Row>(`SELECT ${PAYMENT_COLS} FROM finance_payments WHERE tenant_id = $1 AND id = $2`, [
    input.tenantId,
    input.paymentId,
  ]);
  if (!res.rows[0]) throw notFound("Payment not found");
  return mapPayment(res.rows[0]);
}

export async function listPayments(
  tx: Tx,
  input: { tenantId: string; invoiceId?: string; status?: PaymentStatus; page: PageInput },
): Promise<Page<PublicPayment>> {
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
    `SELECT ${PAYMENT_COLS} FROM finance_payments WHERE ${where.join(" AND ")}`,
    params,
    { name: "payments", expr: "q.created_at", type: "timestamptz", dir: "desc" },
    input.page,
  );
  return { items: out.rows.map(mapPayment), page: out.page };
}

/**
 * Record a payment made outside the app (legacy record_payment): cash, bank deposit, cheque, or an
 * M-Pesa receipt the family paid directly. Rules (database-enforced too, under the invoice lock):
 * amount > 0 and not more than the outstanding balance; whole shillings unless it is exactly the
 * balance; non-cash needs a reference; an M-Pesa receipt is recorded once (system-wide); a bank or
 * cheque reference is not recorded twice on one invoice. Naming a pending proof confirms it with this
 * payment in the same transaction.
 */
export async function recordPayment(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    invoice_id: string;
    amount_minor: number;
    method: PaymentMethod;
    reference?: string | null;
    proof_id?: string | null;
    ip?: string | null;
  },
): Promise<{ payment: PublicPayment; invoice: PublicInvoice }> {
  assertMinorAmount(input.amount_minor, "amount_minor");
  const reference = input.reference === undefined || input.reference === null || input.reference.trim() === "" ? null : input.reference.trim();
  if (input.method !== "cash" && !reference) throw validationError("A reference is required for this payment method");
  if (reference && reference.length > 60) throw validationError("reference must be at most 60 characters");
  const invoice = await getInvoice(tx, { tenantId: input.tenantId, invoiceId: input.invoice_id, lock: true });
  if (invoice.voided_at) throw conflict("The invoice is voided");
  if (input.amount_minor > invoice.balance_minor) throw validationError("That is more than the outstanding balance");
  if (input.amount_minor % 100 !== 0 && input.amount_minor !== invoice.balance_minor) {
    throw validationError("Whole shillings only, unless paying the exact remaining balance");
  }
  let receipt: string | null = null;
  let storedRef: string | null = reference;
  if (input.method === "mpesa") {
    receipt = reference!.toUpperCase().replace(/\s/g, "");
    if (!/^[A-Z0-9]{6,20}$/.test(receipt)) throw validationError("An M-Pesa receipt is 6–20 letters and digits");
    storedRef = null;
  }
  if (input.proof_id) {
    const proof = await tx.query<{ txn_code: string | null; txn_amount_minor: string | null; status: string; invoice_id: string }>(
      `SELECT txn_code, txn_amount_minor, status, invoice_id FROM finance_payment_proofs
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [input.tenantId, input.proof_id],
    );
    const p = proof.rows[0];
    if (!p || p.status !== "pending" || p.invoice_id !== input.invoice_id) {
      throw conflict("The proof is not pending on this invoice");
    }
    if (p.txn_amount_minor !== null && toMinor(p.txn_amount_minor) !== input.amount_minor) {
      throw validationError("The payment amount must match the proof amount");
    }
    if (p.txn_code) {
      const code = p.txn_code.toUpperCase();
      const matchesReceipt = receipt !== null && receipt === code;
      const matchesRef = storedRef !== null && storedRef.toUpperCase().replace(/\s/g, "") === code;
      if (!matchesReceipt && !matchesRef) {
        throw validationError("The payment reference must match the proof transaction code");
      }
    }
  }
  let row: Row;
  try {
    const res = await tx.query<Row>(
      `INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status, reference, mpesa_receipt, proof_id, recorded_by)
       VALUES ($1, $2, $3, $4, 'success', $5, $6, $7, $8) RETURNING ${PAYMENT_COLS}`,
      [input.tenantId, input.invoice_id, input.amount_minor, input.method, storedRef, receipt, input.proof_id ?? null, input.actorUserId],
    );
    row = res.rows[0]!;
  } catch (err) {
    const code = pgCode(err);
    const msg = pgMessage(err);
    if (code === "23505") throw conflict("That payment reference is already recorded");
    if (code === "23514" && msg.includes("proof")) throw conflict("The proof is not pending on this invoice");
    if (code === "23514") throw validationError("The payment does not fit the invoice balance or rules");
    if (code === "23503") throw validationError("Invoice or proof must belong to this school");
    throw err;
  }
  if (input.proof_id) {
    await tx.query(
      `UPDATE finance_payment_proofs SET status = 'confirmed', payment_id = $3, reviewed_by = $4
        WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.proof_id, row.id, input.actorUserId],
    );
    await recordSecurityEvent(tx, {
      eventType: "finance.proof.confirmed",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { proofId: input.proof_id, paymentId: row.id, invoiceId: input.invoice_id },
      ip: input.ip,
    });
  }
  await recordSecurityEvent(tx, {
    eventType: "finance.payment.recorded",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { paymentId: row.id, invoiceId: input.invoice_id, amountMinor: input.amount_minor, method: input.method },
    ip: input.ip,
  });
  return { payment: mapPayment(row), invoice: await getInvoice(tx, { tenantId: input.tenantId, invoiceId: input.invoice_id }) };
}
