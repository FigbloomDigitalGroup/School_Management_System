import type { Tx } from "../../db/sql.js";
import { listInvoices } from "../finance/invoices.js";
import { CURRENCY, toMinor, type InvoiceStatus } from "../finance/money.js";

/**
 * One child's fees (docs/FAMILY-READS.md): invoices with their lines, charges that were not voided, payments and payment
 * proofs. The learner id is already proven to be the caller's child. Payments never carry a phone number (a payment made
 * by another guardian must not reveal that guardian's phone), and no staff user id is returned.
 */
export interface ChildInvoice {
  id: string;
  term: { id: string; label: string };
  currency: typeof CURRENCY;
  due_on: string;
  status: InvoiceStatus | "voided";
  lines_minor: number;
  charges_minor: number;
  adjustments_minor: number;
  total_minor: number;
  paid_minor: number;
  balance_minor: number;
  created_at: string;
  voided_at: string | null;
  lines: Array<{ name: string; amount_minor: number }>;
  charges: Array<{ amount_minor: number; reason: string; created_at: string }>;
  payments: Array<{
    id: string;
    amount_minor: number;
    method: string;
    status: string;
    mpesa_receipt: string | null;
    reference: string | null;
    failure_reason: string | null;
    created_at: string;
    completed_at: string | null;
  }>;
  proofs: Array<{
    id: string;
    status: string;
    txn_code: string | null;
    txn_amount_minor: number | null;
    note: string | null;
    file_name: string | null;
    rejection_reason: string | null;
    created_at: string;
  }>;
}

const MAX_INVOICES = 50;

export async function childFees(tx: Tx, input: { tenantId: string; learnerId: string }): Promise<ChildInvoice[]> {
  const page = await listInvoices(tx, { tenantId: input.tenantId, learnerId: input.learnerId, page: { limit: MAX_INVOICES, rawCursor: undefined } });
  const invoices = page.items;
  if (invoices.length === 0) return [];
  const ids = invoices.map((i) => i.id);
  const terms = await tx.query<{ id: string; label: string }>(
    `SELECT id, label FROM academic_terms WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [input.tenantId, [...new Set(invoices.map((i) => i.term_id))]],
  );
  // every detail query names the invoices of THIS learner only (the ids above came from a learner-filtered list)
  const lines = await tx.query<{ invoice_id: string; name: string; amount_minor: string }>(
    `SELECT l.invoice_id, l.name, l.amount_minor
       FROM finance_invoice_lines l
       JOIN finance_invoices i ON i.tenant_id = l.tenant_id AND i.id = l.invoice_id AND i.learner_id = $3
      WHERE l.tenant_id = $1 AND l.invoice_id = ANY($2::uuid[])
      ORDER BY l.name, l.id`,
    [input.tenantId, ids, input.learnerId],
  );
  const charges = await tx.query<{ invoice_id: string; amount_minor: string; reason: string; created_at: Date }>(
    `SELECT c.invoice_id, c.amount_minor, c.reason, c.created_at
       FROM finance_charges c
       JOIN finance_invoices i ON i.tenant_id = c.tenant_id AND i.id = c.invoice_id AND i.learner_id = $3
      WHERE c.tenant_id = $1 AND c.invoice_id = ANY($2::uuid[]) AND c.voided_at IS NULL
      ORDER BY c.created_at, c.id`,
    [input.tenantId, ids, input.learnerId],
  );
  const payments = await tx.query<{
    id: string;
    invoice_id: string;
    amount_minor: string;
    method: string;
    status: string;
    mpesa_receipt: string | null;
    reference: string | null;
    failure_reason: string | null;
    created_at: Date;
    completed_at: Date | null;
  }>(
    `SELECT p.id, p.invoice_id, p.amount_minor, p.method, p.status, p.mpesa_receipt, p.reference, p.failure_reason,
            p.created_at, p.completed_at
       FROM finance_payments p
       JOIN finance_invoices i ON i.tenant_id = p.tenant_id AND i.id = p.invoice_id AND i.learner_id = $3
      WHERE p.tenant_id = $1 AND p.invoice_id = ANY($2::uuid[])
      ORDER BY p.created_at DESC, p.id`,
    [input.tenantId, ids, input.learnerId],
  );
  const proofs = await tx.query<{
    id: string;
    invoice_id: string;
    status: string;
    txn_code: string | null;
    txn_amount_minor: string | null;
    note: string | null;
    file_name: string | null;
    rejection_reason: string | null;
    created_at: Date;
  }>(
    `SELECT f.id, f.invoice_id, f.status, f.txn_code, f.txn_amount_minor, f.note, f.file_name, f.rejection_reason, f.created_at
       FROM finance_payment_proofs f
       JOIN finance_invoices i ON i.tenant_id = f.tenant_id AND i.id = f.invoice_id AND i.learner_id = $3
      WHERE f.tenant_id = $1 AND f.invoice_id = ANY($2::uuid[])
      ORDER BY f.created_at DESC, f.id`,
    [input.tenantId, ids, input.learnerId],
  );
  const termLabel = new Map(terms.rows.map((t) => [t.id, t.label]));
  const group = <T extends { invoice_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.invoice_id, [...(m.get(r.invoice_id) ?? []), r]);
    return m;
  };
  const linesBy = group(lines.rows);
  const chargesBy = group(charges.rows);
  const paymentsBy = group(payments.rows);
  const proofsBy = group(proofs.rows);
  return invoices.map((i) => ({
    id: i.id,
    term: { id: i.term_id, label: termLabel.get(i.term_id) ?? "" },
    currency: i.currency,
    due_on: i.due_on,
    status: i.status,
    lines_minor: i.lines_minor,
    charges_minor: i.charges_minor,
    adjustments_minor: i.adjustments_minor,
    total_minor: i.total_minor,
    paid_minor: i.paid_minor,
    balance_minor: i.balance_minor,
    created_at: i.created_at,
    voided_at: i.voided_at,
    lines: (linesBy.get(i.id) ?? []).map((l) => ({ name: l.name, amount_minor: toMinor(l.amount_minor) })),
    charges: (chargesBy.get(i.id) ?? []).map((c) => ({ amount_minor: toMinor(c.amount_minor), reason: c.reason, created_at: c.created_at.toISOString() })),
    payments: (paymentsBy.get(i.id) ?? []).map((p) => ({
      id: p.id,
      amount_minor: toMinor(p.amount_minor),
      method: p.method,
      status: p.status,
      mpesa_receipt: p.mpesa_receipt,
      reference: p.reference,
      failure_reason: p.failure_reason,
      created_at: p.created_at.toISOString(),
      completed_at: p.completed_at ? p.completed_at.toISOString() : null,
    })),
    proofs: (proofsBy.get(i.id) ?? []).map((f) => ({
      id: f.id,
      status: f.status,
      txn_code: f.txn_code,
      txn_amount_minor: f.txn_amount_minor === null ? null : toMinor(f.txn_amount_minor),
      note: f.note,
      file_name: f.file_name,
      rejection_reason: f.rejection_reason,
      created_at: f.created_at.toISOString(),
    })),
  }));
}
