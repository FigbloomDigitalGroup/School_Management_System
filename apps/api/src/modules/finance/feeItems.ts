import type { Tx } from "../../db/sql.js";
import { notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { getTermById } from "../academics/structure.js";
import { pageQuery, type Page, type PageInput } from "../academics/pagination.js";
import { pgCode } from "../academics/pgError.js";
import { assertWholeShillings, CURRENCY, toMinor, type FeeScope } from "./money.js";

export interface PublicFeeItem {
  id: string;
  tenantId: string;
  term_id: string;
  name: string;
  amount_minor: number;
  currency: typeof CURRENCY;
  applies_to: FeeScope;
  form_level: number | null;
  active: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

type Row = {
  id: string;
  tenant_id: string;
  term_id: string;
  name: string;
  amount_minor: string;
  currency: string;
  applies_to: FeeScope;
  form_level: number | null;
  active: boolean;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const COLS = `id, tenant_id, term_id, name, amount_minor, currency, applies_to, form_level, active, archived_at, created_at, updated_at`;

function map(row: Row): PublicFeeItem {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    term_id: row.term_id,
    name: row.name,
    amount_minor: toMinor(row.amount_minor),
    currency: CURRENCY,
    applies_to: row.applies_to,
    form_level: row.form_level,
    active: row.active,
    archived_at: row.archived_at ? row.archived_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function checkScope(applies_to: FeeScope, form_level: number | null | undefined): number | null {
  if (applies_to === "form_level") {
    if (form_level === null || form_level === undefined) throw validationError("form_level is required when applies_to is form_level");
    return form_level;
  }
  if (form_level !== null && form_level !== undefined) throw validationError("form_level is only used when applies_to is form_level");
  return null;
}

export async function createFeeItem(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    term_id: string;
    name: string;
    amount_minor: number;
    applies_to: FeeScope;
    form_level?: number | null;
    ip?: string | null;
  },
): Promise<PublicFeeItem> {
  await getTermById(tx, { tenantId: input.tenantId, termId: input.term_id });
  assertWholeShillings(input.amount_minor, "amount_minor");
  const form_level = checkScope(input.applies_to, input.form_level);
  const name = input.name.trim();
  try {
    const res = await tx.query<Row>(
      `INSERT INTO finance_fee_items (tenant_id, term_id, name, amount_minor, applies_to, form_level, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLS}`,
      [input.tenantId, input.term_id, name, input.amount_minor, input.applies_to, form_level, input.actorUserId],
    );
    const row = res.rows[0]!;
    await recordSecurityEvent(tx, {
      eventType: "finance.fee_item.created",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { feeItemId: row.id, termId: row.term_id, amountMinor: toMinor(row.amount_minor), appliesTo: row.applies_to },
      ip: input.ip,
    });
    return map(row);
  } catch (err) {
    if (pgCode(err) === "23503") throw validationError("term_id must belong to this school");
    throw err;
  }
}

export async function getFeeItem(tx: Tx, input: { tenantId: string; feeItemId: string }): Promise<PublicFeeItem> {
  const res = await tx.query<Row>(`SELECT ${COLS} FROM finance_fee_items WHERE tenant_id = $1 AND id = $2`, [
    input.tenantId,
    input.feeItemId,
  ]);
  if (!res.rows[0]) throw notFound("Fee item not found");
  return map(res.rows[0]);
}

export async function listFeeItems(
  tx: Tx,
  input: { tenantId: string; termId?: string; active?: boolean | null; page: PageInput },
): Promise<Page<PublicFeeItem>> {
  const params: unknown[] = [input.tenantId];
  const where = ["tenant_id = $1"];
  if (input.termId) {
    params.push(input.termId);
    where.push(`term_id = $${params.length}`);
  }
  if (input.active === true || input.active === false) {
    params.push(input.active);
    where.push(`active = $${params.length}`);
  }
  const out = await pageQuery<Row>(
    tx,
    `SELECT ${COLS} FROM finance_fee_items WHERE ${where.join(" AND ")}`,
    params,
    { name: "fee_items", expr: "lower(q.name)", type: "text", dir: "asc" },
    input.page,
  );
  return { items: out.rows.map(map), page: out.page };
}

/**
 * Change a fee item. Invoices already billed keep their snapshot lines: a change affects only
 * learners billed afterwards (legacy: the invoice total is computed once, at billing).
 */
export async function updateFeeItem(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    feeItemId: string;
    name?: string;
    amount_minor?: number;
    applies_to?: FeeScope;
    form_level?: number | null;
    ip?: string | null;
  },
): Promise<PublicFeeItem> {
  const current = await getFeeItem(tx, input);
  if (!current.active) throw validationError("An archived fee item cannot change");
  const applies_to = input.applies_to ?? current.applies_to;
  const form_level = checkScope(applies_to, input.form_level !== undefined ? input.form_level : current.form_level);
  if (input.amount_minor !== undefined) assertWholeShillings(input.amount_minor, "amount_minor");
  const name = input.name !== undefined ? input.name.trim() : current.name;
  const amount = input.amount_minor ?? current.amount_minor;
  const res = await tx.query<Row>(
    `UPDATE finance_fee_items SET name = $3, amount_minor = $4, applies_to = $5, form_level = $6
      WHERE tenant_id = $1 AND id = $2 RETURNING ${COLS}`,
    [input.tenantId, input.feeItemId, name, amount, applies_to, form_level],
  );
  const row = res.rows[0]!;
  await recordSecurityEvent(tx, {
    eventType: "finance.fee_item.updated",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: {
      feeItemId: row.id,
      from: { name: current.name, amountMinor: current.amount_minor, appliesTo: current.applies_to, formLevel: current.form_level },
      to: { name: row.name, amountMinor: toMinor(row.amount_minor), appliesTo: row.applies_to, formLevel: row.form_level },
    },
    ip: input.ip,
  });
  return map(row);
}

export async function archiveFeeItem(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; feeItemId: string; ip?: string | null },
): Promise<PublicFeeItem> {
  const current = await getFeeItem(tx, input);
  if (!current.active) return current;
  const res = await tx.query<Row>(
    `UPDATE finance_fee_items SET active = false, archived_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING ${COLS}`,
    [input.tenantId, input.feeItemId],
  );
  await recordSecurityEvent(tx, {
    eventType: "finance.fee_item.archived",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { feeItemId: input.feeItemId },
    ip: input.ip,
  });
  return map(res.rows[0]!);
}
