import { supabase } from "./supabase";
import { invokeEdge } from "./edge";
import {
  apiFetchConsumptionFlags, apiFetchCostPerMeal, apiFetchCurrentTermDates, apiFetchMovements, apiFetchSpendByMonth, apiFetchStockLevels,
  apiFetchUsage, apiRecordStockMovement,
} from "./api/stockApi";
import { onApi } from "./backend";
import { NotOnApiError } from "./capabilities";
import { todayIso } from "./inventory";

/**
 * Stock in and stock out for consumables (20261124200000_inventory_movements):
 * deliveries, a day's use, waste and stock-take corrections, and the reports
 * and anomaly flags worked out from them in the database. A movement is never
 * changed or deleted; the database keeps inventory_items.quantity in step and
 * refuses to take stock below zero.
 *
 * On the API build (`onApi()`) every read and write below goes to apps/api (api/stockApi.ts), which keeps Supabase's field names, so
 * the screens do not change. The AI briefing is the one thing that is not on the API.
 */

export type MovementKind = "received" | "used" | "wasted" | "adjusted";

export const MOVEMENT_KIND_LABEL: Record<MovementKind, string> = {
  received: "Received", used: "Used", wasted: "Wasted", adjusted: "Stock-take",
};

/** Offered in the item form; anything up to 20 characters is accepted. */
export const UNIT_SUGGESTIONS = ["kg", "litres", "pieces", "bags", "crates", "packets", "trays", "bundles", "reams", "boxes"];
/** Offered when recording use; free text is accepted. */
export const PURPOSE_SUGGESTIONS = ["Breakfast", "Lunch", "Supper", "Staff tea", "Science practical", "Classroom"];

export interface InventoryMovement {
  id: string;
  tenant_id: string;
  item_id: string;
  kind: MovementKind;
  /** received/used/wasted: positive; adjusted: signed. */
  quantity: number;
  unit_cost_cents: number | null;
  supplier: string | null;
  reference: string | null;
  occurred_on: string;
  purpose: string | null;
  meals_served: number | null;
  note: string | null;
  recorded_by: string | null;
  created_at: string;
}

export interface MovementRow extends InventoryMovement {
  recordedByName: string | null;
}

/** What a movement does to the count: deliveries add, use and waste take away, a stock-take is signed. */
export function movementDelta(m: Pick<InventoryMovement, "kind" | "quantity">): number {
  return m.kind === "received" || m.kind === "adjusted" ? m.quantity : -m.quantity;
}

/** "25 kg", "1 bag", "3 bags"; a bare number when there is no unit. */
export function formatQty(n: number, unit: string | null | undefined): string {
  const num = Number.isInteger(n) ? n.toLocaleString("en-GB") : n.toLocaleString("en-GB", { maximumFractionDigits: 1 });
  if (!unit) return num;
  // one of a plural unit: "1 bag", "1 litre", "1 box"; "1 kg" stays as it is
  const u = Math.abs(n) !== 1 ? unit : /xes$/.test(unit) ? unit.slice(0, -2) : /[^s]s$/.test(unit) ? unit.slice(0, -1) : unit;
  return `${num} ${u}`;
}

export type StockStatus = "out" | "low" | "ok";

export function stockStatus(item: { quantity: number; reorder_level: number | null }): StockStatus {
  if (item.quantity <= 0) return "out";
  if (item.reorder_level != null && item.quantity <= item.reorder_level) return "low";
  return "ok";
}

export interface MovementInput {
  tenantId: string;
  itemId: string;
  kind: MovementKind;
  quantity: number;
  occurredOn: string;
  unitCostCents?: number | null;
  supplier?: string;
  reference?: string;
  purpose?: string;
  mealsServed?: number | null;
  note?: string;
}

/**
 * Why a movement can't be recorded, before it goes to the database (which
 * checks the same things and the stock under a lock), or null when it can.
 */
export function movementProblem(input: Pick<MovementInput, "kind" | "quantity" | "occurredOn" | "unitCostCents" | "mealsServed">, onHand: number, now = new Date()): string | null {
  const { kind, quantity } = input;
  if (!Number.isInteger(quantity) || quantity === 0) return "Enter a whole number.";
  if (kind !== "adjusted" && quantity < 0) return "Enter how much, as a positive number.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn)) return "Choose the date.";
  if (input.occurredOn > todayIso(now)) return "The date can't be in the future.";
  if (input.unitCostCents != null && (!Number.isInteger(input.unitCostCents) || input.unitCostCents < 0)) return "Enter the price, or leave it blank.";
  if (input.mealsServed != null && (!Number.isInteger(input.mealsServed) || input.mealsServed < 0)) return "Meals served is a whole number.";
  const after = onHand + movementDelta({ kind, quantity });
  if (after < 0) return `Only ${onHand} in stock.`;
  return null;
}

/** For a stock-take: the signed correction from what the register says to what was counted. */
export function stockTakeDelta(onHand: number, counted: number): number {
  return counted - onHand;
}

export type ReportPeriod = "week" | "month" | "term" | "year";

/** The dates a report covers: this ISO week (from Monday), this month, the current term, or this calendar year; to today. */
export function periodRange(period: ReportPeriod, now = new Date(), term?: { starts_on: string; ends_on: string } | null): { from: string; to: string } {
  const today = todayIso(now);
  const local = (d: Date) => todayIso(d);
  if (period === "week") {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const back = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - back);
    return { from: local(d), to: today };
  }
  if (period === "month") return { from: `${today.slice(0, 7)}-01`, to: today };
  if (period === "term" && term) return { from: term.starts_on, to: term.ends_on < today ? term.ends_on : today };
  return { from: `${today.slice(0, 4)}-01-01`, to: today };
}

/**
 * A range cut to its last `maxDays` days (to minus from), for an API that answers a report for a limited period. A term whose
 * dates were never moved on, or a year-long term, would otherwise be refused. Not cut when it already fits.
 */
export function capRange(range: { from: string; to: string }, maxDays: number): { from: string; to: string } {
  const day = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000;
  if (day(range.to) - day(range.from) <= maxDays) return range;
  const d = new Date((day(range.to) - maxDays) * 86_400_000);
  return { from: d.toISOString().slice(0, 10), to: range.to };
}

/** 1 Jan of the month n months before this one. */
export function monthsBack(n: number, now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth() - n, 1);
  return todayIso(d);
}

// ---------------------------------------------------------------- report rows

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
  avg_daily_use: number | null;
  days_of_cover: number | null;
  low: boolean;
  last_received_on: string | null;
  next_delivery_on: string | null;
}

export interface UsageRow {
  item_id: string;
  period_start: string;
  used: number;
  wasted: number;
  received: number;
  shrinkage: number;
  spend_cents: number;
  used_cost_cents: number;
}

/** What one store's deliveries cost in one month. */
export interface SpendRow { month: string; category: string; spend_cents: number; deliveries: number }

export interface CostPerMealRow { period_start: string; purpose: string; used_cost_cents: number; meals_served: number; cost_per_meal_cents: number | null }

// ---------------------------------------------------------------- stores

/**
 * The stores the stock screens filter by: the register's categories grouped the way a school runs them.
 * Sick-bay medicine (category medical) is the Clinic; anything not named here is Other.
 */
export type StoreKey = "all" | "kitchen" | "stationery" | "lab" | "clinic" | "uniforms" | "other";

export const STORES: { key: StoreKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "kitchen", label: "Kitchen" },
  { key: "stationery", label: "Stationery & art" },
  { key: "lab", label: "Lab" },
  { key: "clinic", label: "Clinic" },
  { key: "uniforms", label: "Uniforms" },
  { key: "other", label: "Other" },
];

const STORE_OF: Record<string, Exclude<StoreKey, "all" | "other">> = {
  kitchen: "kitchen", stationery: "stationery", lab_equipment: "lab", medical: "clinic", uniforms: "uniforms",
};

/** Which store an item's category belongs to. */
export function storeOf(category: string | null | undefined): Exclude<StoreKey, "all"> {
  return (category && STORE_OF[category]) || "other";
}

/** Whether an item's category is in the chosen store ("all" takes everything). */
export function inStore(category: string | null | undefined, store: StoreKey): boolean {
  return store === "all" || storeOf(category) === store;
}

/** Spend per month for one store (or all), oldest first. */
export function spendByMonthFor(rows: SpendRow[], store: StoreKey): { month: string; spend_cents: number; deliveries: number }[] {
  const by = new Map<string, { month: string; spend_cents: number; deliveries: number }>();
  for (const r of rows) {
    if (!inStore(r.category, store)) continue;
    const m = r.month.slice(0, 10);
    const a = by.get(m) ?? { month: m, spend_cents: 0, deliveries: 0 };
    a.spend_cents += r.spend_cents;
    a.deliveries += r.deliveries;
    by.set(m, a);
  }
  return [...by.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
}

export interface StoreSummary { store: Exclude<StoreKey, "all">; label: string; items: number; valueCents: number; usedCostCents: number; low: number }

/** One line per store that has stock lines: how many, what they're worth, what was used in the period, how many are low. */
export function summariseStores(levels: StockLevel[], usage: UsageByItem[], categoryOf: (itemId: string) => string | undefined): StoreSummary[] {
  const out = new Map<Exclude<StoreKey, "all">, StoreSummary>();
  const get = (store: Exclude<StoreKey, "all">) => {
    let s = out.get(store);
    if (!s) {
      s = { store, label: STORES.find((x) => x.key === store)!.label, items: 0, valueCents: 0, usedCostCents: 0, low: 0 };
      out.set(store, s);
    }
    return s;
  };
  for (const l of levels) {
    const s = get(storeOf(l.category));
    s.items += 1;
    s.valueCents += l.value_cents;
    if (l.low || l.quantity <= 0) s.low += 1;
  }
  for (const u of usage) get(storeOf(categoryOf(u.item_id))).usedCostCents += u.used_cost_cents;
  const order = STORES.map((s) => s.key);
  return [...out.values()].sort((a, b) => order.indexOf(a.store) - order.indexOf(b.store));
}

export type FlagKind = "usage_up" | "usage_down" | "usage_trend" | "non_school_day" | "shrinkage" | "price_jump" | "run_out";
export type FlagSeverity = "high" | "medium" | "low";

export interface ConsumptionFlag {
  kind: FlagKind;
  item_id: string;
  item_name: string;
  category: string;
  unit: string | null;
  purpose: string | null;
  occurred_on: string;
  period_from: string | null;
  expected: number | null;
  actual: number | null;
  headcount: number | null;
  baseline_headcount: number | null;
  visitors: number | null;
  severity: FlagSeverity;
  explained: boolean;
  reason: string;
}

export const FLAG_KIND_LABEL: Record<FlagKind, string> = {
  usage_up: "Use up", usage_down: "Use down", usage_trend: "Creeping up", non_school_day: "Non-school day",
  shrinkage: "Stock missing", price_jump: "Price jump", run_out: "Running out",
};

const SEVERITY_RANK: Record<FlagSeverity, number> = { high: 0, medium: 1, low: 2 };

/** Alarms first (most severe, newest), explained rises last. */
export function sortFlags<T extends Pick<ConsumptionFlag, "severity" | "explained" | "occurred_on">>(flags: T[]): T[] {
  return [...flags].sort((a, b) =>
    Number(a.explained) - Number(b.explained)
    || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || (a.occurred_on < b.occurred_on ? 1 : a.occurred_on > b.occurred_on ? -1 : 0));
}

/** Numbers come back from PostgREST as strings for numeric and bigint; make them numbers once, here. */
function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}
function numOrNull(v: unknown): number | null {
  return v == null ? null : Number(v);
}

export interface UsageByItem {
  item_id: string;
  used: number;
  wasted: number;
  received: number;
  shrinkage: number;
  spend_cents: number;
  used_cost_cents: number;
}

/** Usage rows (one per item per period) added up per item, most used (by value, then quantity) first. */
export function usageByItem(rows: UsageRow[]): UsageByItem[] {
  const by = new Map<string, UsageByItem>();
  for (const r of rows) {
    const a = by.get(r.item_id) ?? { item_id: r.item_id, used: 0, wasted: 0, received: 0, shrinkage: 0, spend_cents: 0, used_cost_cents: 0 };
    a.used += r.used; a.wasted += r.wasted; a.received += r.received; a.shrinkage += r.shrinkage;
    a.spend_cents += r.spend_cents; a.used_cost_cents += r.used_cost_cents;
    by.set(r.item_id, a);
  }
  return [...by.values()].sort((a, b) => b.used_cost_cents - a.used_cost_cents || b.used - a.used);
}

export interface StockOverview {
  valueCents: number;
  spendThisMonthCents: number;
  spendLastMonthCents: number;
  /** Rounded percentage change, null with nothing last month to compare with. */
  spendChangePct: number | null;
  lowCount: number;
  /** Consumables that run out within a week at their average use. */
  shortCoverCount: number;
}

export function stockOverview(levels: StockLevel[], spend: SpendRow[], now = new Date()): StockOverview {
  const thisMonth = monthsBack(0, now);
  const lastMonth = monthsBack(1, now);
  const spendIn = (m: string) => spend.filter((s) => s.month.slice(0, 10) === m).reduce((a, s) => a + s.spend_cents, 0);
  const t = spendIn(thisMonth);
  const l = spendIn(lastMonth);
  return {
    valueCents: levels.reduce((a, x) => a + x.value_cents, 0),
    spendThisMonthCents: t,
    spendLastMonthCents: l,
    spendChangePct: l > 0 ? Math.round(((t - l) / l) * 100) : null,
    lowCount: levels.filter((x) => x.low || x.quantity <= 0).length,
    shortCoverCount: levels.filter((x) => x.consumable && x.days_of_cover != null && x.days_of_cover < 7).length,
  };
}

// ---------------------------------------------------------------- data

const MOVEMENT_SELECT = "*, recorder:profiles!inventory_movements_recorded_by_fkey(full_name)";

/** An item's movements, newest first (at most the last 500). */
export async function fetchMovements(itemId: string): Promise<MovementRow[]> {
  if (onApi()) return apiFetchMovements(itemId);
  const { data, error } = await supabase().from("inventory_movements").select(MOVEMENT_SELECT).eq("item_id", itemId)
    .order("occurred_on", { ascending: false }).order("created_at", { ascending: false }).limit(500)
    .returns<(InventoryMovement & { recorder: { full_name: string } | null })[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map(({ recorder, ...m }) => ({ ...m, recordedByName: recorder?.full_name ?? null }));
}

export async function recordStockMovement(input: MovementInput): Promise<void> {
  if (onApi()) return apiRecordStockMovement(input);
  const received = input.kind === "received";
  const { error } = await supabase().from("inventory_movements").insert({
    tenant_id: input.tenantId,
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
  });
  if (error) throw new Error(error.message);
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
  const { data, error } = await supabase().rpc(fn, args);
  if (error) throw new Error(error.message);
  return (data ?? []) as T[];
}

export async function fetchStockLevels(tenantId: string, asOf?: string): Promise<StockLevel[]> {
  if (onApi()) return apiFetchStockLevels(tenantId, asOf);
  const rows = await rpc<Record<string, unknown>>("inventory_stock_levels", { p_tenant_id: tenantId, ...(asOf ? { p_as_of: asOf } : {}) });
  return rows.map((r) => ({
    ...(r as unknown as StockLevel),
    quantity: num(r.quantity), reorder_level: numOrNull(r.reorder_level), unit_cost_cents: numOrNull(r.unit_cost_cents),
    value_cents: num(r.value_cents), used_28d: num(r.used_28d), wasted_28d: num(r.wasted_28d),
    avg_daily_use: numOrNull(r.avg_daily_use), days_of_cover: numOrNull(r.days_of_cover),
  }));
}

export async function fetchUsage(tenantId: string, from: string, to: string, bucket: "day" | "week" | "month" | "year" = "week"): Promise<UsageRow[]> {
  if (onApi()) return apiFetchUsage(tenantId, from, to, bucket);
  const rows = await rpc<Record<string, unknown>>("inventory_usage", { p_tenant_id: tenantId, p_from: from, p_to: to, p_bucket: bucket });
  return rows.map((r) => ({
    item_id: String(r.item_id), period_start: String(r.period_start),
    used: num(r.used), wasted: num(r.wasted), received: num(r.received), shrinkage: num(r.shrinkage),
    spend_cents: num(r.spend_cents), used_cost_cents: num(r.used_cost_cents),
  }));
}

export async function fetchSpendByMonth(tenantId: string, from: string, to: string): Promise<SpendRow[]> {
  if (onApi()) return apiFetchSpendByMonth(tenantId, from, to);
  const rows = await rpc<Record<string, unknown>>("inventory_spend_by_month", { p_tenant_id: tenantId, p_from: from, p_to: to });
  return rows.map((r) => ({ month: String(r.month), category: String(r.category), spend_cents: num(r.spend_cents), deliveries: num(r.deliveries) }));
}

export async function fetchCostPerMeal(tenantId: string, from: string, to: string, bucket: "week" | "month" = "month"): Promise<CostPerMealRow[]> {
  if (onApi()) return apiFetchCostPerMeal(tenantId, from, to, bucket);
  const rows = await rpc<Record<string, unknown>>("inventory_cost_per_meal", { p_tenant_id: tenantId, p_from: from, p_to: to, p_bucket: bucket });
  return rows.map((r) => ({
    period_start: String(r.period_start), purpose: String(r.purpose), used_cost_cents: num(r.used_cost_cents),
    meals_served: num(r.meals_served), cost_per_meal_cents: numOrNull(r.cost_per_meal_cents),
  }));
}

export async function fetchConsumptionFlags(tenantId: string, from: string, to: string): Promise<ConsumptionFlag[]> {
  if (onApi()) return sortFlags(await apiFetchConsumptionFlags(tenantId, from, to));
  const rows = await rpc<Record<string, unknown>>("inventory_consumption_flags", { p_tenant_id: tenantId, p_from: from, p_to: to });
  return sortFlags(rows.map((r) => ({
    ...(r as unknown as ConsumptionFlag),
    expected: numOrNull(r.expected), actual: numOrNull(r.actual), headcount: numOrNull(r.headcount),
    baseline_headcount: numOrNull(r.baseline_headcount), visitors: numOrNull(r.visitors),
  })));
}

/**
 * The current term's dates, for the "This term" report period. On the API, reading terms needs the Academics area: a person who
 * has only Inventory gets null (the screens then leave "This term" out), not an error.
 */
export async function fetchCurrentTermDates(tenantId: string): Promise<{ starts_on: string; ends_on: string } | null> {
  if (onApi()) return apiFetchCurrentTermDates(tenantId);
  const { data, error } = await supabase().from("terms").select("starts_on, ends_on").eq("tenant_id", tenantId).eq("is_current", true).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { starts_on: string; ends_on: string } | null) ?? null;
}

// ---------------------------------------------------------------- AI insights

export interface StockInsights {
  headline: string;
  standsOut: string[];
  questions: string[];
  looksFine: string[];
  suggestions: string[];
}

/**
 * A short briefing on the period's flags from the ai-assist "stock_insights"
 * task. The function works the flags out itself from the database, as the
 * caller; only the dates go from here, and no person's name is ever sent.
 * Not on the API (its Bloom contract has no structured briefing: apps/api/docs/INVENTORY-STOCK.md, "stock_insights"), so the
 * screen hides the panel (`inventoryCapabilities().stockInsights`) and this throws.
 */
export async function fetchStockInsights(from: string, to: string): Promise<StockInsights> {
  if (onApi()) throw new NotOnApiError("The AI briefing on stock");
  const { result } = await invokeEdge<{ result: StockInsights }>("ai-assist", { task: "stock_insights", payload: { from, to } }, { timeoutMs: 90_000 });
  return result;
}
