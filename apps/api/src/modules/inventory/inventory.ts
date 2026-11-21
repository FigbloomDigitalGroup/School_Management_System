import type { Tx } from "../../db/sql.js";
import { isRealCalendarDate } from "../../http/schemas.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import type { PageInfo } from "../../http/pagination.js";
import { pageQuery, type PageInput } from "../academics/pagination.js";
import { recordSecurityEvent } from "../audit/audit.js";

export interface InventoryItem {
  id: string;
  tenant_id: string;
  name: string;
  category: string;
  tracking: "asset" | "stock";
  quantity: number;
  asset_tag: string | null;
  condition: string;
  location: string | null;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InventoryIssue {
  id: string;
  tenant_id: string;
  item_id: string;
  learner_id: string | null;
  holder_user_id: string | null;
  quantity: number;
  status: string;
  issued_at: string;
  due_on: string | null;
  closed_at: string | null;
}

const ITEM_COLS = `id, tenant_id, name, category, tracking, quantity, asset_tag, condition, location, retired_at, created_at, updated_at`;
const ISSUE_COLS = `id, tenant_id, item_id, learner_id, holder_user_id, quantity, status, issued_at, due_on::text AS due_on, closed_at`;

export function assertValidCalendarDate(dateStr: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw validationError(`${field} must be YYYY-MM-DD`);
  }
  if (!isRealCalendarDate(dateStr)) throw validationError(`${field} is not a valid calendar date`);
}

export async function createInventoryItem(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    name: string;
    category: string;
    tracking: "asset" | "stock";
    quantity?: number;
    asset_tag?: string | null;
    condition?: string;
    location?: string | null;
  },
): Promise<InventoryItem> {
  const qty = input.tracking === "asset" ? 1 : (input.quantity ?? 1);
  if (qty < 1) throw validationError("quantity must be at least 1");
  try {
    const res = await tx.query<InventoryItem>(
      `INSERT INTO inventory_items (tenant_id, name, category, tracking, quantity, asset_tag, condition, location, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING ${ITEM_COLS}`,
      [
        input.tenantId,
        input.name.trim(),
        input.category,
        input.tracking,
        qty,
        input.asset_tag ?? null,
        input.condition ?? "good",
        input.location ?? null,
        input.actorUserId,
      ],
    );
    await recordSecurityEvent(tx, {
      eventType: "inventory.item.created",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { itemId: res.rows[0]!.id },
    });
    return res.rows[0]!;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23505") throw conflict("An inventory item with this asset_tag already exists");
    throw err;
  }
}

export async function listInventoryItems(
  tx: Tx,
  input: { tenantId: string; limit: number; rawCursor?: unknown; includeRetired?: boolean },
): Promise<{ items: InventoryItem[]; page: PageInfo }> {
  const page: PageInput = { limit: input.limit, rawCursor: input.rawCursor };
  const inner = input.includeRetired
    ? `SELECT ${ITEM_COLS} FROM inventory_items WHERE tenant_id = $1`
    : `SELECT ${ITEM_COLS} FROM inventory_items WHERE tenant_id = $1 AND retired_at IS NULL`;
  const res = await pageQuery<InventoryItem>(
    tx,
    inner,
    [input.tenantId],
    {
      name: input.includeRetired ? "inventory_items_all_name_asc" : "inventory_items_active_name_asc",
      expr: "q.name",
      type: "text",
      dir: "asc",
    },
    page,
  );
  const items = res.rows.map(({ page_key: _pk, ...rest }) => rest);
  return { items, page: res.page };
}

export async function getInventoryItem(tx: Tx, tenantId: string, itemId: string): Promise<InventoryItem | null> {
  const res = await tx.query<InventoryItem>(`SELECT ${ITEM_COLS} FROM inventory_items WHERE tenant_id = $1 AND id = $2`, [
    tenantId,
    itemId,
  ]);
  return res.rows[0] ?? null;
}

export async function retireInventoryItem(
  tx: Tx,
  input: { tenantId: string; itemId: string; actorUserId: string },
): Promise<InventoryItem> {
  const existing = await getInventoryItem(tx, input.tenantId, input.itemId);
  if (!existing) throw notFound("Inventory item not found");
  if (existing.retired_at) throw conflict("Inventory item is already retired");
  const openIssues = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM inventory_issues WHERE tenant_id = $1 AND item_id = $2 AND status = 'out'`,
    [input.tenantId, input.itemId],
  );
  if ((openIssues.rows[0]?.n ?? 0) > 0) {
    throw conflict("Cannot retire an inventory item while it has open issues");
  }
  try {
    const res = await tx.query<InventoryItem>(
      `UPDATE inventory_items SET retired_at = now()
        WHERE tenant_id = $1 AND id = $2 AND retired_at IS NULL
        RETURNING ${ITEM_COLS}`,
      [input.tenantId, input.itemId],
    );
    if (!res.rows[0]) throw notFound("Inventory item not found");
    await recordSecurityEvent(tx, {
      eventType: "inventory.item.retired",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { itemId: input.itemId },
    });
    return res.rows[0];
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23514") throw conflict("Cannot retire an inventory item while it has open issues");
    throw err;
  }
}

export async function issueInventoryItem(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    itemId: string;
    learnerId?: string | null;
    holderUserId?: string | null;
    quantity?: number;
    dueOn?: string | null;
  },
): Promise<InventoryIssue> {
  if (!input.learnerId && !input.holderUserId) throw validationError("learner_id or holder_user_id is required");
  if (input.learnerId && input.holderUserId) throw validationError("Provide exactly one holder");
  if (input.dueOn) assertValidCalendarDate(input.dueOn, "due_on");

  const item = await getInventoryItem(tx, input.tenantId, input.itemId);
  if (!item) throw notFound("Inventory item not found");
  if (item.retired_at) throw validationError("Retired items cannot be issued");

  if (input.learnerId) {
    const learner = await tx.query(
      `SELECT 1 FROM learners WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL`,
      [input.tenantId, input.learnerId],
    );
    if (!learner.rows[0]) throw validationError("learner_id must be an active learner in this school");
  }
  if (input.holderUserId) {
    const holder = await tx.query(
      `SELECT 1 FROM school_memberships
        WHERE tenant_id = $1 AND user_id = $2 AND archived_at IS NULL
          AND role IN ('school_admin', 'teacher', 'staff', 'driver')`,
      [input.tenantId, input.holderUserId],
    );
    if (!holder.rows[0]) throw validationError("holder_user_id must be an active staff member in this school");
  }

  try {
    const res = await tx.query<InventoryIssue>(
      `INSERT INTO inventory_issues (tenant_id, item_id, learner_id, holder_user_id, quantity, issued_by, due_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING ${ISSUE_COLS}`,
      [
        input.tenantId,
        input.itemId,
        input.learnerId ?? null,
        input.holderUserId ?? null,
        input.quantity ?? 1,
        input.actorUserId,
        input.dueOn ?? null,
      ],
    );
    await recordSecurityEvent(tx, {
      eventType: "inventory.issue.created",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { issueId: res.rows[0]!.id, itemId: input.itemId },
    });
    return res.rows[0]!;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23514") throw validationError("Not enough copies available");
    if (code === "23503") throw validationError("Invalid item or holder reference");
    throw err;
  }
}

export async function closeInventoryIssue(
  tx: Tx,
  input: {
    tenantId: string;
    issueId: string;
    actorUserId: string;
    status: "returned" | "damaged" | "lost";
    returnedCondition?: string | null;
    note?: string | null;
  },
): Promise<InventoryIssue> {
  if (input.status === "lost" && input.returnedCondition !== undefined && input.returnedCondition !== null) {
    throw validationError("returned_condition cannot be set when closing an issue as lost");
  }
  const res = await tx.query<InventoryIssue>(
    `UPDATE inventory_issues
        SET status = $3, returned_condition = $4, note = COALESCE($5, note), closed_by = $6, closed_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'out'
      RETURNING ${ISSUE_COLS}`,
    [input.tenantId, input.issueId, input.status, input.returnedCondition ?? null, input.note ?? null, input.actorUserId],
  );
  if (!res.rows[0]) throw notFound("Open inventory issue not found");
  await recordSecurityEvent(tx, {
    eventType: "inventory.issue.closed",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { issueId: input.issueId, status: input.status },
  });
  return res.rows[0];
}

export async function listOpenIssues(
  tx: Tx,
  tenantId: string,
  limit: number,
  rawCursor?: unknown,
): Promise<{ issues: InventoryIssue[]; page: PageInfo }> {
  const page: PageInput = { limit, rawCursor };
  const inner = `SELECT ${ISSUE_COLS} FROM inventory_issues WHERE tenant_id = $1 AND status = 'out'`;
  const res = await pageQuery<InventoryIssue>(
    tx,
    inner,
    [tenantId],
    { name: "inventory_open_issues_issued_desc", expr: "q.issued_at", type: "timestamptz", dir: "desc" },
    page,
  );
  const issues = res.rows.map(({ page_key: _pk, ...rest }) => rest);
  return { issues, page: res.page };
}
