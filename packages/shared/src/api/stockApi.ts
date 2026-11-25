import { todayIso } from "../inventory";
import type { HeadcountDay, ItemIndexRow, UniformIssueRow } from "../inventoryPaging";
import type { ConsumptionFlag, CostPerMealRow, MovementInput, MovementKind, MovementRow, SpendRow, StockLevel, UsageRow } from "../inventoryStock";
import { apiClient } from "./client";
import { ApiError, isApiError, userMessage } from "./errors";
import { inventoryItemFromApi, listApiIssues, listApiItems } from "./inventoryApi";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import { activeTenantId } from "./peopleApi";
import type { components } from "./schema";
import { listAcademicTerms } from "./setupApi";

/**
 * Stock in and out on apps/api: the API side of inventoryStock.ts (and the stock reads of inventoryPaging.ts). A port of the live
 * Supabase feature, so the rows keep Supabase's names and the screens do not change (apps/api/docs/INVENTORY-STOCK.md). What differs
 * from Supabase, handled here rather than in the screens:
 *
 *  - A movement the server refuses comes back as 409 (not enough stock, or the item is written off) with Supabase's wording, or 400
 *    (a price on a use, a day in the future); the server's sentence is shown as it is.
 *  - The recorder's name is `recorded_by_name` on the movement, not a join.
 *  - Ledger, usage, spend and cost per meal answer for at most 400 days (headcount 400, flags 366). The screens' own periods fit;
 *    `inventoryCapabilities().reportMaxDays` makes a long term fit too.
 *  - The current term's dates need `resource.academics.read`: a holder of the Inventory area without it gets `null`, and the screens
 *    then leave "This term" out.
 *  - There is no item index of written-off items (`GET /inventory/items` lists the live ones), so a report row of a written-off item has
 *    no name; and no closed issues, so the uniforms page counts only what is still out.
 *  - The AI briefing (`stock_insights`) is not on the API (the Bloom contract cannot carry it): `fetchStockInsights` throws NotOnApiError.
 */

type ApiMovement = components["schemas"]["InventoryMovement"];
type ApiFlag = components["schemas"]["InventoryConsumptionFlag"];
type ApiLevel = components["schemas"]["InventoryStockLevel"];

/** How many of an item's movements its history shows (Supabase: the last 500). */
export const MOVEMENTS_SHOWN = 500;

/** An ApiError whose message is the sentence for a person (the server's own for a refusal; ours for an outage), the code and status kept. */
function readable(err: unknown): unknown {
  if (!isApiError(err)) return err;
  const message = userMessage(err);
  if (message === err.message) return err;
  return new ApiError({ status: err.status, code: err.code, message, requestId: err.requestId, details: err.details, retryAfterSeconds: err.retryAfterSeconds });
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw readable(err);
  }
}

const numOrNull = (v: number | string | null | undefined): number | null => (v == null ? null : Number(v));

// ---------------------------------------------------------------- movements

/** Records one movement. Price and supplier go only on a delivery, meals served only on a use, as on Supabase (the API refuses them elsewhere). */
export function apiRecordStockMovement(input: MovementInput): Promise<void> {
  const received = input.kind === "received";
  return guarded(async () => {
    await apiClient().post("/v1/tenants/{tenantId}/inventory/movements", {
      path: { tenantId: input.tenantId },
      body: {
        item_id: input.itemId,
        kind: input.kind,
        quantity: input.quantity,
        occurred_on: input.occurredOn,
        unit_cost_cents: received ? input.unitCostCents ?? null : null,
        supplier: received ? input.supplier?.trim() || null : null,
        reference: input.reference?.trim() || null,
        purpose: input.kind === "used" || input.kind === "wasted" ? input.purpose?.trim() || null : null,
        meals_served: input.kind === "used" ? input.mealsServed ?? null : null,
        note: input.note?.trim() || null,
      },
      tenantId: input.tenantId,
    });
  });
}

function movementRow(m: ApiMovement): MovementRow {
  return {
    id: m.id,
    tenant_id: m.tenant_id,
    item_id: m.item_id,
    kind: m.kind as MovementKind,
    quantity: Number(m.quantity),
    unit_cost_cents: numOrNull(m.unit_cost_cents),
    supplier: m.supplier ?? null,
    reference: m.reference ?? null,
    occurred_on: m.occurred_on,
    purpose: m.purpose ?? null,
    meals_served: numOrNull(m.meals_served),
    note: m.note ?? null,
    recorded_by: m.recorded_by ?? null,
    created_at: m.created_at,
    recordedByName: m.recorded_by_name ?? null,
  };
}

/** An item's movements, newest first, at most the last 500 (it stops paging once it has them). */
export function apiFetchMovements(itemId: string): Promise<MovementRow[]> {
  const tenantId = activeTenantId();
  return guarded(async () => {
    let seen = 0;
    const rows = await listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/inventory/movements", {
        path: { tenantId },
        query: { item_id: itemId, limit: API_PAGE_LIMIT, cursor },
        tenantId,
      });
      seen += r.movements.length;
      return { items: r.movements, page: { ...r.page, next_cursor: seen >= MOVEMENTS_SHOWN ? null : r.page.next_cursor } };
    });
    return rows.slice(0, MOVEMENTS_SHOWN).map(movementRow);
  });
}

// ---------------------------------------------------------------- stock levels and the reports

function stockLevel(l: ApiLevel): StockLevel {
  return {
    item_id: l.item_id,
    name: l.name,
    category: l.category,
    unit: l.unit ?? null,
    consumable: l.consumable,
    quantity: Number(l.quantity),
    reorder_level: numOrNull(l.reorder_level),
    unit_cost_cents: numOrNull(l.unit_cost_cents),
    value_cents: Number(l.value_cents),
    used_28d: Number(l.used_28d),
    wasted_28d: Number(l.wasted_28d),
    avg_daily_use: numOrNull(l.avg_daily_use),
    days_of_cover: numOrNull(l.days_of_cover),
    low: l.low,
    last_received_on: l.last_received_on ?? null,
    next_delivery_on: l.next_delivery_on ?? null,
  };
}

export function apiFetchStockLevels(tenantId: string, asOf?: string): Promise<StockLevel[]> {
  return guarded(async () => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/inventory/stock-levels", { path: { tenantId }, query: { as_of: asOf }, tenantId });
    return r.levels.map(stockLevel);
  });
}

export function apiFetchUsage(tenantId: string, from: string, to: string, bucket: "day" | "week" | "month" | "year"): Promise<UsageRow[]> {
  return guarded(async () => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/inventory/reports/usage", { path: { tenantId }, query: { from, to, bucket }, tenantId });
    return r.usage.map((u) => ({
      item_id: u.item_id, period_start: u.period_start, used: Number(u.used), wasted: Number(u.wasted), received: Number(u.received),
      shrinkage: Number(u.shrinkage), spend_cents: Number(u.spend_cents), used_cost_cents: Number(u.used_cost_cents),
    }));
  });
}

export function apiFetchSpendByMonth(tenantId: string, from: string, to: string): Promise<SpendRow[]> {
  return guarded(async () => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/inventory/reports/spend-by-month", { path: { tenantId }, query: { from, to }, tenantId });
    return r.spend.map((s) => ({ month: s.month, category: s.category, spend_cents: Number(s.spend_cents), deliveries: Number(s.deliveries) }));
  });
}

export function apiFetchCostPerMeal(tenantId: string, from: string, to: string, bucket: "week" | "month"): Promise<CostPerMealRow[]> {
  return guarded(async () => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/inventory/reports/cost-per-meal", { path: { tenantId }, query: { from, to, bucket }, tenantId });
    return r.cost_per_meal.map((c) => ({
      period_start: c.period_start, purpose: c.purpose, used_cost_cents: Number(c.used_cost_cents), meals_served: Number(c.meals_served),
      cost_per_meal_cents: numOrNull(c.cost_per_meal_cents),
    }));
  });
}

function consumptionFlag(f: ApiFlag): ConsumptionFlag {
  return {
    kind: f.kind,
    item_id: f.item_id,
    item_name: f.item_name,
    category: f.category,
    unit: f.unit ?? null,
    purpose: f.purpose ?? null,
    occurred_on: f.occurred_on,
    period_from: f.period_from ?? null,
    expected: numOrNull(f.expected),
    actual: numOrNull(f.actual),
    headcount: numOrNull(f.headcount),
    baseline_headcount: numOrNull(f.baseline_headcount),
    visitors: numOrNull(f.visitors),
    severity: f.severity,
    explained: f.explained,
    reason: f.reason,
  };
}

/** The flags as the server worked them out, in its order; inventoryStock.ts sorts them for the screen. */
export function apiFetchConsumptionFlags(tenantId: string, from: string, to: string): Promise<ConsumptionFlag[]> {
  return guarded(async () => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/inventory/reports/flags", { path: { tenantId }, query: { from, to }, tenantId });
    return r.flags.map(consumptionFlag);
  });
}

export function apiFetchHeadcount(tenantId: string, from: string, to: string): Promise<HeadcountDay[]> {
  return guarded(async () => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/inventory/reports/headcount", { path: { tenantId }, query: { from, to }, tenantId });
    return r.days
      .map((d) => {
        const learners = Number(d.learners ?? 0), staff = Number(d.staff ?? 0), visitors = Number(d.visitors ?? 0);
        return { day: d.day.slice(0, 10), learners, staff, visitors, total: learners + staff + visitors };
      })
      .sort((a, b) => (a.day < b.day ? -1 : 1));
  });
}

// ---------------------------------------------------------------- what the stock pages label their rows with

/**
 * The current term's dates, for the "This term" period. Reading terms needs the Academics area, which a holder of only the Inventory
 * area does not have: that is `null` (no "This term"), not an error.
 */
export async function apiFetchCurrentTermDates(tenantId: string): Promise<{ starts_on: string; ends_on: string } | null> {
  try {
    const current = (await listAcademicTerms(tenantId)).find((t) => t.is_current);
    return current ? { starts_on: current.starts_on, ends_on: current.ends_on } : null;
  } catch (err) {
    if (isApiError(err) && err.code === "forbidden") return null;
    throw readable(err);
  }
}

/** Every live item's name, store and unit. The API lists items that are not written off, so a written-off item has no row here. */
export function apiFetchItemIndex(tenantId: string): Promise<ItemIndexRow[]> {
  return guarded(async () =>
    (await listApiItems(tenantId)).map(inventoryItemFromApi).map(({ id, name, category, unit, consumable, tracking, retired_at }) => (
      { id, name, category, unit, consumable, tracking, retired_at }
    )));
}

/**
 * Uniforms handed out in the period. The API lists open issues only, so a uniform that has come back (or was lost) is not counted:
 * this is what is still out with people, issued in the period.
 */
export function apiFetchUniformIssues(tenantId: string, from: string, to: string): Promise<UniformIssueRow[]> {
  return guarded(async () => {
    const [issues, items] = await Promise.all([listApiIssues(tenantId), listApiItems(tenantId)]);
    const uniforms = new Map(items.filter((i) => i.category === "uniforms").map((i) => [i.id, i.name]));
    return issues
      .filter((r) => uniforms.has(r.item_id))
      .map((r) => ({ id: r.id, item_id: r.item_id, quantity: r.quantity, issued_at: r.issued_at, student_id: r.learner_id ?? null, name: uniforms.get(r.item_id) ?? "Uniform" }))
      .filter((r) => {
        const day = todayIso(new Date(r.issued_at));
        return day >= from && day <= to;
      });
  });
}
