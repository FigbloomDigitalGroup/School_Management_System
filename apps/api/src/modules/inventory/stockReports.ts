import type { Tx } from "../../db/sql.js";
import { validationError } from "../../http/errors.js";
import { schoolToday } from "../tenancy/schoolClock.js";

/**
 * The stock reports (docs/INVENTORY-STOCK.md, slice S1b): thin readers over the database functions of migration 116, which
 * are a port of the live Supabase report functions with the same maths. Each function runs as the caller (SECURITY INVOKER)
 * and refuses a school other than the one of the request; the route checks `resource.inventory.read` first. Numbers come
 * back as numbers and days as YYYY-MM-DD.
 */

export const REPORT_BUCKETS = ["day", "week", "month", "year"] as const;
export type ReportBucket = (typeof REPORT_BUCKETS)[number];

/** How far back the flags look when the caller gives no period (#390 on Supabase: the last 8 weeks). */
export const FLAG_WINDOW_WEEKS = 8;
/** Longest period of the ledger, usage, spend and cost-per-meal reports (API only; see the design note). */
export const MAX_REPORT_DAYS = 400;
/** Supabase's own limits: headcount 400 days, flags a year. */
export const MAX_HEADCOUNT_DAYS = 400;
export const MAX_FLAG_DAYS = 366;

const dayNumber = (d: string): number => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000;

export function addDays(d: string, n: number): string {
  return new Date((dayNumber(d) + n) * 86_400_000).toISOString().slice(0, 10);
}

/** Refuses a period that runs backwards or is longer than `maxDays` (to - from). */
export function assertPeriod(from: string, to: string, maxDays: number): void {
  if (from > to) throw validationError("from must be on or before to");
  if (dayNumber(to) - dayNumber(from) > maxDays) throw validationError(`Ask for at most ${maxDays} days at a time`);
}

const n = (v: string | number): number => Number(v);
const nOrNull = (v: string | number | null): number | null => (v === null ? null : Number(v));

export interface LedgerRow {
  item_id: string;
  kind: string;
  quantity: number;
  occurred_on: string;
  purpose: string | null;
  meals_served: number | null;
  unit_cost_cents: number | null;
  supplier: string | null;
  created_at: string;
  source: string;
}

/** Everything that went in or out of the school's stock lines in a period (inventory_ledger), oldest day first. */
export async function stockLedger(tx: Tx, input: { tenantId: string; from: string; to: string }): Promise<LedgerRow[]> {
  assertPeriod(input.from, input.to, MAX_REPORT_DAYS);
  const res = await tx.query<LedgerRow & { unit_cost_cents: string | null }>(
    `SELECT l.item_id, l.kind, l.quantity, l.occurred_on::text AS occurred_on, l.purpose, l.meals_served,
            l.unit_cost_cents::text AS unit_cost_cents, l.supplier, l.created_at, l.source
       FROM public.inventory_ledger($1, $2::date, $3::date) l
      ORDER BY l.occurred_on, l.created_at, l.item_id`,
    [input.tenantId, input.from, input.to],
  );
  return res.rows.map((r) => ({ ...r, unit_cost_cents: nOrNull(r.unit_cost_cents) }));
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

/** Use, waste, deliveries, shrinkage and money per item per day, week (from Monday), month or year (inventory_usage). */
export async function stockUsage(tx: Tx, input: { tenantId: string; from: string; to: string; bucket: ReportBucket }): Promise<UsageRow[]> {
  assertPeriod(input.from, input.to, MAX_REPORT_DAYS);
  const res = await tx.query<Record<keyof UsageRow, string>>(
    `SELECT u.item_id, u.period_start::text AS period_start, u.used::text AS used, u.wasted::text AS wasted,
            u.received::text AS received, u.shrinkage::text AS shrinkage, u.spend_cents::text AS spend_cents,
            u.used_cost_cents::text AS used_cost_cents
       FROM public.inventory_usage($1, $2::date, $3::date, $4) u`,
    [input.tenantId, input.from, input.to, input.bucket],
  );
  return res.rows.map((r) => ({
    item_id: r.item_id,
    period_start: r.period_start,
    used: n(r.used),
    wasted: n(r.wasted),
    received: n(r.received),
    shrinkage: n(r.shrinkage),
    spend_cents: n(r.spend_cents),
    used_cost_cents: n(r.used_cost_cents),
  }));
}

export interface SpendRow {
  month: string;
  category: string;
  spend_cents: number;
  deliveries: number;
}

/** What deliveries cost, month by month and store by store (inventory_spend_by_month). */
export async function stockSpendByMonth(tx: Tx, input: { tenantId: string; from: string; to: string }): Promise<SpendRow[]> {
  assertPeriod(input.from, input.to, MAX_REPORT_DAYS);
  const res = await tx.query<{ month: string; category: string; spend_cents: string; deliveries: number }>(
    `SELECT s.month::text AS month, s.category, s.spend_cents::text AS spend_cents, s.deliveries
       FROM public.inventory_spend_by_month($1, $2::date, $3::date) s`,
    [input.tenantId, input.from, input.to],
  );
  return res.rows.map((r) => ({ ...r, spend_cents: n(r.spend_cents) }));
}

export interface CostPerMealRow {
  period_start: string;
  purpose: string;
  used_cost_cents: number;
  meals_served: number;
  cost_per_meal_cents: number | null;
}

/** Kitchen food used, priced at the day's delivery price, over meals served, per period and purpose (inventory_cost_per_meal). */
export async function stockCostPerMeal(
  tx: Tx,
  input: { tenantId: string; from: string; to: string; bucket: ReportBucket },
): Promise<CostPerMealRow[]> {
  assertPeriod(input.from, input.to, MAX_REPORT_DAYS);
  const res = await tx.query<{ period_start: string; purpose: string; used_cost_cents: string; meals_served: string; cost_per_meal_cents: string | null }>(
    `SELECT c.period_start::text AS period_start, c.purpose, c.used_cost_cents::text AS used_cost_cents,
            c.meals_served::text AS meals_served, c.cost_per_meal_cents::text AS cost_per_meal_cents
       FROM public.inventory_cost_per_meal($1, $2::date, $3::date, $4) c`,
    [input.tenantId, input.from, input.to, input.bucket],
  );
  return res.rows.map((r) => ({
    period_start: r.period_start,
    purpose: r.purpose,
    used_cost_cents: n(r.used_cost_cents),
    meals_served: n(r.meals_served),
    cost_per_meal_cents: nOrNull(r.cost_per_meal_cents),
  }));
}

export interface HeadcountDay {
  day: string;
  learners: number;
  staff: number;
  visitors: number;
}

/** Learners on the roll, staff and gate visitors on each day (inventory_headcount): counts only, never a person. */
export async function stockHeadcount(tx: Tx, input: { tenantId: string; from: string; to: string }): Promise<HeadcountDay[]> {
  assertPeriod(input.from, input.to, MAX_HEADCOUNT_DAYS);
  const res = await tx.query<HeadcountDay>(
    `SELECT h.day::text AS day, h.learners, h.staff, h.visitors FROM public.inventory_headcount($1, $2::date, $3::date) h`,
    [input.tenantId, input.from, input.to],
  );
  return res.rows;
}

export interface ConsumptionFlag {
  kind: string;
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
  severity: "high" | "medium" | "low";
  explained: boolean;
  reason: string;
}

/**
 * The deterministic anomaly flags (inventory_consumption_flags), in the database's order. Without a period: the last
 * FLAG_WINDOW_WEEKS weeks to the school's today (`to` alone: the 8 weeks to it).
 */
export async function stockFlags(
  tx: Tx,
  input: { tenantId: string; from?: string; to?: string },
): Promise<{ from: string; to: string; flags: ConsumptionFlag[] }> {
  const to = input.to ?? (await schoolToday(tx, input.tenantId));
  const from = input.from ?? addDays(to, -(FLAG_WINDOW_WEEKS * 7 - 1));
  assertPeriod(from, to, MAX_FLAG_DAYS);
  const res = await tx.query<ConsumptionFlag & { expected: string | null; actual: string | null }>(
    `SELECT f.kind, f.item_id, f.item_name, f.category, f.unit, f.purpose, f.occurred_on::text AS occurred_on,
            f.period_from::text AS period_from, f.expected::text AS expected, f.actual::text AS actual,
            f.headcount, f.baseline_headcount, f.visitors, f.severity, f.explained, f.reason
       FROM public.inventory_consumption_flags($1, $2::date, $3::date) f`,
    [input.tenantId, from, to],
  );
  return { from, to, flags: res.rows.map((r) => ({ ...r, expected: nOrNull(r.expected), actual: nOrNull(r.actual) })) };
}
