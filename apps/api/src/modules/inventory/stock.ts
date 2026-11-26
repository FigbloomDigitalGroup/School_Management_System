import type { Tx } from "../../db/sql.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import { decodeCursor, pageFingerprint, pageFromKeysetRows, type PageInfo } from "../../http/pagination.js";
import type { PageInput } from "../academics/pagination.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { schoolToday } from "../tenancy/schoolClock.js";
import { ITEM_COLS, type InventoryItem } from "./inventory.js";

/**
 * Stock in and stock out for consumables (docs/INVENTORY-STOCK.md, migration 115): deliveries, a day's use, waste and
 * stock-take corrections. A port of the live Supabase feature (20261124200000_inventory_movements.sql). A movement is never
 * changed or deleted; the database keeps inventory_items.quantity in step under a lock on the item (inventory_movements_apply)
 * and refuses to take stock below zero or below what the register still owes to issues.
 */

export const MOVEMENT_KINDS = ["received", "used", "wasted", "adjusted"] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export interface InventoryMovement {
  id: string;
  tenant_id: string;
  item_id: string;
  kind: MovementKind;
  /** received / used / wasted: positive; adjusted: signed. */
  quantity: number;
  unit_cost_cents: number | null;
  supplier: string | null;
  reference: string | null;
  occurred_on: string;
  purpose: string | null;
  meals_served: number | null;
  note: string | null;
  recorded_by: string | null;
  /** The recorder's name, for the item's history (Supabase: the recorder's profile name). */
  recorded_by_name: string | null;
  created_at: string;
}

interface MovementRow extends Omit<InventoryMovement, "unit_cost_cents"> {
  unit_cost_cents: string | null;
  created_at_key: string;
}

const MOVEMENT_SELECT = `
  SELECT m.id, m.tenant_id, m.item_id, m.kind, m.quantity, m.unit_cost_cents::text AS unit_cost_cents, m.supplier, m.reference,
         m.occurred_on::text AS occurred_on, m.purpose, m.meals_served, m.note, m.recorded_by, u.full_name AS recorded_by_name,
         m.created_at, to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_key
    FROM inventory_movements m
    LEFT JOIN users u ON u.id = m.recorded_by`;

function toMovement({ created_at_key: _k, unit_cost_cents, ...row }: MovementRow): InventoryMovement {
  return { ...row, unit_cost_cents: unit_cost_cents === null ? null : Number(unit_cost_cents) };
}

/** What a movement does to the count: deliveries add, use and waste take away, a stock-take is signed. */
export function movementDelta(kind: MovementKind, quantity: number): number {
  return kind === "received" || kind === "adjusted" ? quantity : -quantity;
}

/** A blank or whitespace-only text is no value at all (the trigger trims the same way). */
function text(value: string | null | undefined): string | null {
  const t = value?.trim();
  return t ? t : null;
}

export interface MovementInput {
  tenantId: string;
  actorUserId: string;
  itemId: string;
  kind: MovementKind;
  quantity: number;
  occurredOn?: string;
  unitCostCents?: number | null;
  supplier?: string | null;
  reference?: string | null;
  purpose?: string | null;
  mealsServed?: number | null;
  note?: string | null;
}

/**
 * Records one movement and moves the item's count. The item is locked first (SELECT ... FOR UPDATE), so a second person
 * recording use of the same item waits here and then sees the count the first one left: the checks below answer with the
 * real numbers, and the trigger repeats them under the same lock as the database's own guarantee.
 */
export async function recordStockMovement(tx: Tx, input: MovementInput): Promise<{ movement: InventoryMovement; item: InventoryItem }> {
  const { kind, quantity } = input;
  // The sign rules, exactly (inventory_movements_sign).
  if (!Number.isInteger(quantity) || quantity === 0) throw validationError("quantity must be a whole number other than 0");
  if (kind !== "adjusted" && quantity < 0) throw validationError("quantity must be positive; only a stock-take (adjusted) is signed");
  const supplier = text(input.supplier);
  const unitCost = input.unitCostCents ?? null;
  // Price and supplier belong to a delivery, meals served to a day's use (inventory_movements_received_only / _used_only).
  if (kind !== "received" && (unitCost !== null || supplier !== null)) {
    throw validationError("unit_cost_cents and supplier are for received stock only");
  }
  if (kind !== "used" && (input.mealsServed ?? null) !== null) throw validationError("meals_served is for used stock only");

  const today = await schoolToday(tx, input.tenantId);
  const occurredOn = input.occurredOn ?? today;
  // The screens' own rule (movementProblem on Supabase), kept by the server too: a movement is something that happened.
  if (occurredOn > today) throw validationError("occurred_on cannot be in the future");

  const locked = await tx.query<InventoryItem>(
    `SELECT ${ITEM_COLS} FROM inventory_items WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.itemId],
  );
  const item = locked.rows[0];
  if (!item) throw notFound("Inventory item not found");
  if (item.tracking !== "stock") {
    throw validationError(`${item.name} is a single tracked item; only stock lines take deliveries and use`);
  }
  if (item.retired_at) throw conflict(`${item.name} has been written off`);
  const delta = movementDelta(kind, quantity);
  if (item.quantity + delta < 0) {
    throw conflict(`Only ${item.quantity} ${item.unit ?? "left"} of ${item.name} in stock`);
  }
  if (delta < 0) {
    const out = await tx.query<{ n: number }>(`SELECT public.inventory_out_count($1) AS n`, [input.itemId]);
    const owed = out.rows[0]?.n ?? 0;
    if (item.quantity + delta < owed) {
      throw conflict(`${owed} of ${item.name} are out with people or not returned; the stock cannot fall below that`);
    }
  }

  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO inventory_movements
       (tenant_id, item_id, kind, quantity, unit_cost_cents, supplier, reference, occurred_on, purpose, meals_served, note, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      input.tenantId,
      input.itemId,
      kind,
      quantity,
      unitCost,
      supplier,
      text(input.reference),
      occurredOn,
      text(input.purpose),
      input.mealsServed ?? null,
      text(input.note),
      input.actorUserId,
    ],
  );
  const movementId = inserted.rows[0]!.id;
  const movement = await tx.query<MovementRow>(`${MOVEMENT_SELECT} WHERE m.tenant_id = $1 AND m.id = $2`, [input.tenantId, movementId]);
  const after = await tx.query<InventoryItem>(`SELECT ${ITEM_COLS} FROM inventory_items WHERE tenant_id = $1 AND id = $2`, [
    input.tenantId,
    input.itemId,
  ]);
  await recordSecurityEvent(tx, {
    eventType: "inventory.movement.recorded",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { movementId, itemId: input.itemId, kind },
  });
  return { movement: toMovement(movement.rows[0]!), item: after.rows[0]! };
}

const MOVEMENTS_SORT = "occurred_on_desc_created_at_desc";
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Movements, newest first (the day it happened, then when it was recorded), optionally for one item and between two days.
 * Keyset-paged on (occurred_on, created_at, id); the cursor is bound to the school and every filter.
 */
export async function listStockMovements(
  tx: Tx,
  input: { tenantId: string; itemId?: string; from?: string; to?: string; page: PageInput },
): Promise<{ movements: InventoryMovement[]; page: PageInfo }> {
  if (input.from && input.to && input.from > input.to) throw validationError("from must be on or before to");
  const fingerprint = pageFingerprint(MOVEMENTS_SORT, {
    tenantId: input.tenantId,
    itemId: input.itemId ?? null,
    from: input.from ?? null,
    to: input.to ?? null,
  });
  const cursor = decodeCursor(input.page.rawCursor, {
    sort: MOVEMENTS_SORT,
    fingerprint,
    keySpecs: [{ kind: "text", maxLen: 10 }, { kind: "timestamptz_micros" }, { kind: "uuid" }],
  });
  if (cursor && !DATE_KEY.test(cursor.k[0]!)) throw validationError("cursor is invalid");

  const params: unknown[] = [input.tenantId, input.itemId ?? null, input.from ?? null, input.to ?? null];
  let keyset = "";
  if (cursor) {
    params.push(cursor.k[0], cursor.k[1], cursor.k[2]);
    keyset = ` AND (m.occurred_on, m.created_at, m.id) < ($5::date, $6::timestamptz, $7::uuid)`;
  }
  params.push(input.page.limit + 1);
  const res = await tx.query<MovementRow>(
    `${MOVEMENT_SELECT}
      WHERE m.tenant_id = $1
        AND ($2::uuid IS NULL OR m.item_id = $2::uuid)
        AND ($3::date IS NULL OR m.occurred_on >= $3::date)
        AND ($4::date IS NULL OR m.occurred_on <= $4::date)${keyset}
      ORDER BY m.occurred_on DESC, m.created_at DESC, m.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const out = pageFromKeysetRows(res.rows, {
    limit: input.page.limit,
    sort: MOVEMENTS_SORT,
    fingerprint,
    keysOf: (r) => [r.occurred_on, r.created_at_key, r.id],
  });
  return { movements: out.items.map(toMovement), page: out.page };
}

/** One live stock line as of a day (inventory_stock_levels on Supabase). */
export interface StockLevel {
  item_id: string;
  name: string;
  category: string;
  unit: string | null;
  consumable: boolean;
  quantity: number;
  reorder_level: number | null;
  unit_cost_cents: number | null;
  value_cents: number;
  used_28d: number;
  wasted_28d: number;
  avg_daily_use: number;
  days_of_cover: number | null;
  low: boolean;
  last_received_on: string | null;
  next_delivery_on: string | null;
}

type StockLevelRow = Omit<StockLevel, "unit_cost_cents" | "value_cents" | "used_28d" | "wasted_28d" | "avg_daily_use" | "days_of_cover"> & {
  unit_cost_cents: string | null;
  value_cents: string;
  used_28d: string;
  wasted_28d: string;
  avg_daily_use: string;
  days_of_cover: string | null;
};

const num = (v: string): number => Number(v);
const numOrNull = (v: string | null): number | null => (v === null ? null : Number(v));

/**
 * Every live stock line of the school as of a day, the same maths as Supabase's inventory_stock_levels: what is on hand and
 * what it is worth, the average daily use over the 28 days to then, how many days that lasts, whether it is at or below its
 * reorder level, and when the next delivery usually comes (the last one plus the median gap between delivery days in the
 * 120 days before). Use is read from the movements only: the API's sick bay does not take medicine from stock (see the
 * design note). `asOf` defaults to the school's today. The maths is the database function inventory_stock_levels
 * (migration 116), which the consumption flags use too, so the page and the flags can never disagree.
 */
export async function stockLevels(tx: Tx, input: { tenantId: string; asOf?: string }): Promise<{ as_of: string; levels: StockLevel[] }> {
  const asOf = input.asOf ?? (await schoolToday(tx, input.tenantId));
  const res = await tx.query<StockLevelRow>(
    `SELECT l.item_id, l.name, l.category, l.unit, l.consumable, l.quantity, l.reorder_level,
            l.unit_cost_cents::text AS unit_cost_cents, l.value_cents::text AS value_cents,
            l.used_28d::text AS used_28d, l.wasted_28d::text AS wasted_28d, l.avg_daily_use::text AS avg_daily_use,
            l.days_of_cover::text AS days_of_cover, l.low,
            l.last_received_on::text AS last_received_on, l.next_delivery_on::text AS next_delivery_on
       FROM public.inventory_stock_levels($1, $2::date) l
      ORDER BY l.category, l.name, l.item_id`,
    [input.tenantId, asOf],
  );
  return {
    as_of: asOf,
    levels: res.rows.map((r) => ({
      ...r,
      unit_cost_cents: numOrNull(r.unit_cost_cents),
      value_cents: num(r.value_cents),
      used_28d: num(r.used_28d),
      wasted_28d: num(r.wasted_28d),
      avg_daily_use: num(r.avg_daily_use),
      days_of_cover: numOrNull(r.days_of_cover),
    })),
  };
}
