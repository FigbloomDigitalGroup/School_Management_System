import { randomUUID } from "node:crypto";
import type { Tx } from "../../db/sql.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { getTermById } from "../academics/structure.js";
import { pageQuery, type Page, type PageInput } from "../academics/pagination.js";
import { pgCode } from "../academics/pgError.js";
import { assertWholeShillings, balanceMinor, CURRENCY, feeApplies, toMinor, type FeeScope, type InvoiceStatus } from "./money.js";

export interface PublicInvoice {
  id: string;
  tenantId: string;
  learner_id: string;
  term_id: string;
  currency: typeof CURRENCY;
  due_on: string;
  lines_minor: number;
  charges_minor: number;
  adjustments_minor: number;
  total_minor: number;
  paid_minor: number;
  balance_minor: number;
  overpaid_minor: number;
  status: InvoiceStatus | "voided";
  billing_run_id: string | null;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
}

type Row = {
  id: string;
  tenant_id: string;
  learner_id: string;
  term_id: string;
  due_on: string;
  lines_minor: string;
  charges_minor: string;
  adjustments_minor: string;
  total_minor: string;
  paid_minor: string;
  status: InvoiceStatus;
  billing_run_id: string | null;
  created_at: Date;
  voided_at: Date | null;
  void_reason: string | null;
};

// Status is derived by the SQL rule with the school's local date: never stored, never computed by the client.
const COLS = `i.id, i.tenant_id, i.learner_id, i.term_id, i.due_on::text AS due_on, i.lines_minor, i.charges_minor,
  i.adjustments_minor, i.total_minor, i.paid_minor,
  finance_invoice_status(i.total_minor, i.paid_minor, i.due_on, finance_school_today(i.tenant_id)) AS status,
  i.billing_run_id, i.created_at, i.voided_at, i.void_reason`;

export function mapInvoice(row: Row): PublicInvoice {
  const total = toMinor(row.total_minor);
  const paid = toMinor(row.paid_minor);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    learner_id: row.learner_id,
    term_id: row.term_id,
    currency: CURRENCY,
    due_on: row.due_on,
    lines_minor: toMinor(row.lines_minor),
    charges_minor: toMinor(row.charges_minor),
    adjustments_minor: toMinor(row.adjustments_minor),
    total_minor: total,
    paid_minor: paid,
    balance_minor: balanceMinor(total, paid),
    overpaid_minor: Math.max(paid - total, 0),
    status: row.voided_at ? "voided" : row.status,
    billing_run_id: row.billing_run_id,
    created_at: row.created_at.toISOString(),
    voided_at: row.voided_at ? row.voided_at.toISOString() : null,
    void_reason: row.void_reason,
  };
}

export async function getInvoice(tx: Tx, input: { tenantId: string; invoiceId: string; lock?: boolean }): Promise<PublicInvoice> {
  const res = await tx.query<Row>(
    `SELECT ${COLS} FROM finance_invoices i WHERE i.tenant_id = $1 AND i.id = $2${input.lock ? " FOR UPDATE" : ""}`,
    [input.tenantId, input.invoiceId],
  );
  if (!res.rows[0]) throw notFound("Invoice not found");
  return mapInvoice(res.rows[0]);
}

export async function listInvoices(
  tx: Tx,
  input: { tenantId: string; termId?: string; learnerId?: string; status?: InvoiceStatus | "voided"; page: PageInput },
): Promise<Page<PublicInvoice>> {
  const params: unknown[] = [input.tenantId];
  const where = ["i.tenant_id = $1"];
  if (input.termId) {
    params.push(input.termId);
    where.push(`i.term_id = $${params.length}`);
  }
  if (input.learnerId) {
    params.push(input.learnerId);
    where.push(`i.learner_id = $${params.length}`);
  }
  let inner = `SELECT ${COLS} FROM finance_invoices i WHERE ${where.join(" AND ")}`;
  if (input.status) {
    params.push(input.status);
    inner = `SELECT * FROM (SELECT x.*, CASE WHEN x.voided_at IS NOT NULL THEN 'voided' ELSE x.status END AS shown FROM (${inner}) x) y WHERE y.shown = $${params.length}`;
  }
  const out = await pageQuery<Row>(
    tx,
    inner,
    params,
    { name: "invoices", expr: "q.created_at", type: "timestamptz", dir: "desc" },
    input.page,
  );
  return { items: out.rows.map(mapInvoice), page: out.page };
}

export interface InvoiceDetail {
  invoice: PublicInvoice;
  lines: Array<{ id: string; fee_item_id: string; name: string; amount_minor: number }>;
  charges: Array<{
    id: string;
    amount_minor: number;
    reason: string;
    created_by: string;
    created_at: string;
    voided_at: string | null;
    void_reason: string | null;
  }>;
  adjustments: Array<{
    id: string;
    from_total_minor: number;
    to_total_minor: number;
    delta_minor: number;
    reason: string;
    created_by: string;
    created_at: string;
  }>;
}

export async function getInvoiceDetail(tx: Tx, input: { tenantId: string; invoiceId: string }): Promise<InvoiceDetail> {
  const invoice = await getInvoice(tx, input);
  const lines = await tx.query<{ id: string; fee_item_id: string; name: string; amount_minor: string }>(
    `SELECT id, fee_item_id, name, amount_minor FROM finance_invoice_lines WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY name, id`,
    [input.tenantId, input.invoiceId],
  );
  const charges = await tx.query<{
    id: string; amount_minor: string; reason: string; created_by: string; created_at: Date; voided_at: Date | null; void_reason: string | null;
  }>(
    `SELECT id, amount_minor, reason, created_by, created_at, voided_at, void_reason
       FROM finance_charges WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY created_at, id`,
    [input.tenantId, input.invoiceId],
  );
  const adjustments = await tx.query<{
    id: string; from_total_minor: string; to_total_minor: string; delta_minor: string; reason: string; created_by: string; created_at: Date;
  }>(
    `SELECT id, from_total_minor, to_total_minor, delta_minor, reason, created_by, created_at
       FROM finance_invoice_adjustments WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY created_at, id`,
    [input.tenantId, input.invoiceId],
  );
  return {
    invoice,
    lines: lines.rows.map((l) => ({ id: l.id, fee_item_id: l.fee_item_id, name: l.name, amount_minor: toMinor(l.amount_minor) })),
    charges: charges.rows.map((c) => ({
      id: c.id,
      amount_minor: toMinor(c.amount_minor),
      reason: c.reason,
      created_by: c.created_by,
      created_at: c.created_at.toISOString(),
      voided_at: c.voided_at ? c.voided_at.toISOString() : null,
      void_reason: c.void_reason,
    })),
    adjustments: adjustments.rows.map((a) => ({
      id: a.id,
      from_total_minor: toMinor(a.from_total_minor),
      to_total_minor: toMinor(a.to_total_minor),
      delta_minor: toMinor(a.delta_minor),
      reason: a.reason,
      created_by: a.created_by,
      created_at: a.created_at.toISOString(),
    })),
  };
}

/**
 * Bill a term (legacy bill_term + planTermBilling, now computed by the SERVER): for every active
 * learner, total = sum of the term's active fee items that apply to the learner (all / boarders / day /
 * form level of the learner's class in the term's academic year). A learner already billed for the term
 * is skipped; a zero total creates no invoice. Invoices carry snapshot lines; the database derives the
 * total from them. Concurrent runs cannot double-bill (unique live invoice per learner and term).
 */
export async function billTerm(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; term_id: string; due_on: string; ip?: string | null },
): Promise<{ billing_run_id: string; created: number; already_billed: number; nothing_to_bill: number; total_minor: number }> {
  const term = await getTermById(tx, { tenantId: input.tenantId, termId: input.term_id });
  const items = await tx.query<{ id: string; name: string; amount_minor: string; applies_to: FeeScope; form_level: number | null }>(
    `SELECT id, name, amount_minor, applies_to, form_level FROM finance_fee_items
      WHERE tenant_id = $1 AND term_id = $2 AND active ORDER BY lower(name), id`,
    [input.tenantId, input.term_id],
  );
  if (items.rowCount === 0) throw validationError("This term has no active fee items to bill");
  const learners = await tx.query<{ id: string; boarding: boolean; form_level: number | null; billed: boolean }>(
    `SELECT l.id, l.boarding,
            (SELECT c.form_level FROM class_memberships cm
               JOIN classes c ON c.tenant_id = cm.tenant_id AND c.id = cm.class_id
              WHERE cm.tenant_id = l.tenant_id AND cm.learner_id = l.id AND cm.active
                AND cm.academic_year_id = $2
              LIMIT 1) AS form_level,
            EXISTS (SELECT 1 FROM finance_invoices i WHERE i.tenant_id = l.tenant_id AND i.learner_id = l.id
                     AND i.term_id = $3 AND i.voided_at IS NULL) AS billed
       FROM learners l
      WHERE l.tenant_id = $1 AND l.active
      ORDER BY l.id`,
    [input.tenantId, term.academic_year_id, input.term_id],
  );
  const runId = randomUUID();
  let created = 0;
  let already = 0;
  let nothing = 0;
  let totalMinor = 0;
  for (const learner of learners.rows) {
    if (learner.billed) {
      already++;
      continue;
    }
    const applicable = items.rows.filter((it) => feeApplies(it, learner));
    const sum = applicable.reduce((acc, it) => acc + toMinor(it.amount_minor), 0);
    if (sum === 0) {
      nothing++;
      continue;
    }
    const inv = await tx.query<{ id: string }>(
      `INSERT INTO finance_invoices (tenant_id, learner_id, term_id, due_on, billing_run_id, created_by)
       VALUES ($1, $2, $3, $4::date, $5, $6)
       ON CONFLICT (tenant_id, learner_id, term_id) WHERE voided_at IS NULL DO NOTHING
       RETURNING id`,
      [input.tenantId, learner.id, input.term_id, input.due_on, runId, input.actorUserId],
    );
    const invoiceId = inv.rows[0]?.id;
    if (!invoiceId) {
      already++;
      continue;
    }
    for (const it of applicable) {
      await tx.query(
        `INSERT INTO finance_invoice_lines (tenant_id, invoice_id, fee_item_id, name, amount_minor) VALUES ($1, $2, $3, $4, $5)`,
        [input.tenantId, invoiceId, it.id, it.name, toMinor(it.amount_minor)],
      );
    }
    created++;
    totalMinor += sum;
  }
  await recordSecurityEvent(tx, {
    eventType: "finance.term.billed",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { termId: input.term_id, billingRunId: runId, created, alreadyBilled: already, nothingToBill: nothing, totalMinor },
    ip: input.ip,
  });
  return { billing_run_id: runId, created, already_billed: already, nothing_to_bill: nothing, total_minor: totalMinor };
}

export async function setDueDate(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; invoiceId: string; due_on: string; ip?: string | null },
): Promise<PublicInvoice> {
  const current = await getInvoice(tx, { ...input, lock: true });
  if (current.voided_at) throw conflict("A voided invoice cannot change");
  await tx.query(`UPDATE finance_invoices SET due_on = $3::date WHERE tenant_id = $1 AND id = $2`, [input.tenantId, input.invoiceId, input.due_on]);
  await recordSecurityEvent(tx, {
    eventType: "finance.invoice.due_date_changed",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { invoiceId: input.invoiceId, from: current.due_on, to: input.due_on },
    ip: input.ip,
  });
  return getInvoice(tx, input);
}

/** Legacy "delete an invoice nothing hangs off" becomes a final, audited void that keeps the record. */
export async function voidInvoice(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; invoiceId: string; reason: string; ip?: string | null },
): Promise<PublicInvoice> {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 300) throw validationError("reason must be 3–300 characters");
  const current = await getInvoice(tx, { ...input, lock: true });
  if (current.voided_at) throw conflict("This invoice is already voided");
  try {
    await tx.query(
      `UPDATE finance_invoices SET voided_at = now(), voided_by = $3, void_reason = $4 WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.invoiceId, input.actorUserId, reason],
    );
  } catch (err) {
    if (pgCode(err) === "23514") throw conflict("An invoice with payments, live charges or payment proofs cannot be voided");
    throw err;
  }
  await recordSecurityEvent(tx, {
    eventType: "finance.invoice.voided",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { invoiceId: input.invoiceId, totalMinor: current.total_minor },
    ip: input.ip,
  });
  return getInvoice(tx, input);
}

/** Legacy charge_learner: an extra line on the learner's CURRENT-term invoice (no invoice is created). */
export async function addCharge(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; invoiceId: string; amount_minor: number; reason: string; ip?: string | null },
): Promise<PublicInvoice> {
  assertWholeShillings(input.amount_minor, "amount_minor");
  const reason = input.reason.trim();
  if (reason.length < 1 || reason.length > 200) throw validationError("reason must be 1–200 characters");
  const current = await getInvoice(tx, { ...input, lock: true });
  if (current.voided_at) throw conflict("A voided invoice cannot change");
  const term = await tx.query<{ is_current: boolean }>(`SELECT is_current FROM academic_terms WHERE tenant_id = $1 AND id = $2`, [
    input.tenantId,
    current.term_id,
  ]);
  if (!term.rows[0]?.is_current) throw conflict("Charges are added to the learner's current-term invoice only");
  const charge = await tx.query<{ id: string }>(
    `INSERT INTO finance_charges (tenant_id, invoice_id, amount_minor, reason, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.tenantId, input.invoiceId, input.amount_minor, reason, input.actorUserId],
  );
  await recordSecurityEvent(tx, {
    eventType: "finance.charge.added",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { invoiceId: input.invoiceId, chargeId: charge.rows[0]!.id, amountMinor: input.amount_minor },
    ip: input.ip,
  });
  return getInvoice(tx, input);
}

export async function voidCharge(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; invoiceId: string; chargeId: string; reason: string; ip?: string | null },
): Promise<PublicInvoice> {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 300) throw validationError("reason must be 3–300 characters");
  const charge = await tx.query<{ voided_at: Date | null; amount_minor: string }>(
    `SELECT voided_at, amount_minor FROM finance_charges WHERE tenant_id = $1 AND id = $2 AND invoice_id = $3 FOR UPDATE`,
    [input.tenantId, input.chargeId, input.invoiceId],
  );
  if (!charge.rows[0]) throw notFound("Charge not found");
  if (charge.rows[0].voided_at) throw conflict("This charge is already voided");
  try {
    await tx.query(
      `UPDATE finance_charges SET voided_at = now(), voided_by = $3, void_reason = $4 WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.chargeId, input.actorUserId, reason],
    );
  } catch (err) {
    if (pgCode(err) === "23514") throw conflict("This charge is already paid for and cannot be voided");
    throw err;
  }
  await recordSecurityEvent(tx, {
    eventType: "finance.charge.voided",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { invoiceId: input.invoiceId, chargeId: input.chargeId, amountMinor: toMinor(charge.rows[0].amount_minor) },
    ip: input.ip,
  });
  return getInvoice(tx, input);
}

/**
 * Legacy adjust_invoice_total: set a new total with a reason (waivers, discounts and bursaries are not
 * product features; this is the only correction). The new total is whole shillings, at least what is
 * paid and at least the live charges. `expected_total_minor` guards against a concurrent change.
 */
export async function adjustInvoiceTotal(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    invoiceId: string;
    expected_total_minor: number;
    new_total_minor: number;
    reason: string;
    ip?: string | null;
  },
): Promise<PublicInvoice> {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 300) throw validationError("reason must be 3–300 characters");
  if (!Number.isSafeInteger(input.new_total_minor) || input.new_total_minor < 0 || input.new_total_minor % 100 !== 0) {
    throw validationError("new_total_minor must be whole shillings, zero or more");
  }
  const current = await getInvoice(tx, { ...input, lock: true });
  if (current.voided_at) throw conflict("A voided invoice cannot change");
  if (current.total_minor !== input.expected_total_minor) throw conflict("The invoice total changed meanwhile");
  if (input.new_total_minor === current.total_minor) throw validationError("The new total is the same as the current total");
  if (input.new_total_minor < current.paid_minor) throw validationError("The new total cannot be less than what is already paid");
  if (input.new_total_minor < current.charges_minor) throw validationError("The new total cannot be less than the live charges");
  try {
    await tx.query(
      `INSERT INTO finance_invoice_adjustments (tenant_id, invoice_id, from_total_minor, to_total_minor, delta_minor, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [input.tenantId, input.invoiceId, current.total_minor, input.new_total_minor, input.new_total_minor - current.total_minor, reason, input.actorUserId],
    );
  } catch (err) {
    if (pgCode(err) === "FB409") throw conflict("The invoice total changed meanwhile");
    if (pgCode(err) === "23514") throw validationError("The new total cannot be less than what is paid or charged");
    throw err;
  }
  await recordSecurityEvent(tx, {
    eventType: "finance.invoice.adjusted",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { invoiceId: input.invoiceId, fromTotalMinor: current.total_minor, toTotalMinor: input.new_total_minor },
    ip: input.ip,
  });
  return getInvoice(tx, input);
}
