import { useMemo } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import {
  fetchConsumptionFlags, fetchCostPerMeal, fetchCurrentTermDates, fetchHeadcount, fetchIssueCharges, fetchItemIndex, fetchSpendByMonth, fetchStockLevels,
  fetchUniformIssues, fetchUsage, flagWindow, monthsBack, periodRange, STORES, todayIso,
  type CostPerMealRow, type ItemIndexRow, type ReportPeriod, type StoreKey, type UsageRow,
} from "@figbloom/shared";
import { invalidate, useQuery } from "../../lib/queryCache";

/**
 * What the Stock & kitchen tab and its pages read, through one cache so going
 * from the tab to a page and back is instant. Every key starts with the
 * tenant id and "inv:", so invalidateInventory() after a delivery, use,
 * stock-take, issue or charge refreshes all of it.
 */

export const PERIODS: { key: ReportPeriod; label: string }[] = [
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "term", label: "This term" },
  { key: "year", label: "This year" },
];

const STALE = 2 * 60_000;

export const invKey = (tenantId: string, ...parts: (string | number)[]) => [tenantId, "inv", ...parts].join(":");

export function invalidateInventory(tenantId: string): void {
  invalidate(`${tenantId}:inv:`);
}

/** The store and period live in the URL, so a page can be shared and Back keeps them. */
export function useStockParams() {
  const [params, setParams] = useSearchParams();
  const p = params.get("period");
  const s = params.get("store");
  const period: ReportPeriod = PERIODS.some((x) => x.key === p) ? (p as ReportPeriod) : "month";
  const store: StoreKey = STORES.some((x) => x.key === s) ? (s as StoreKey) : "all";
  const set = (key: string, value: string, fallback: string) => {
    const next = new URLSearchParams(params);
    if (value === fallback) next.delete(key); else next.set(key, value);
    setParams(next, { replace: true });
  };
  const qs = new URLSearchParams({ ...(period !== "month" ? { period } : {}), ...(store !== "all" ? { store } : {}) }).toString();
  return {
    period, store, qs,
    setPeriod: (v: ReportPeriod) => set("period", v, "month"),
    setStore: (v: StoreKey) => set("store", v, "all"),
  };
}

/** "/s/<slug>/admin/inventory", wherever under it we are. */
export function useInventoryBase(): string {
  const { pathname } = useLocation();
  const i = pathname.indexOf("/admin/inventory");
  return i >= 0 ? pathname.slice(0, i + "/admin/inventory".length) : "/admin/inventory";
}

/** The buckets a period's use is drawn in: days for a week, weeks for a month or term, months for a year. */
export function usageBucket(period: ReportPeriod): "day" | "week" | "month" {
  return period === "week" ? "day" : period === "year" ? "month" : "week";
}

export function useStockRange(tenantId: string, period: ReportPeriod) {
  const term = useQuery(invKey(tenantId, "term"), () => fetchCurrentTermDates(tenantId), { staleTime: 10 * 60_000 });
  // "This term" waits for the term's dates rather than fetching the year and then the term
  const ready = period !== "term" || !term.loading;
  const range = periodRange(period, new Date(), term.data);
  // the flags always look at the last eight weeks up to the period's end, whatever the period:
  // long enough for a baseline and a 4-week trend, short enough to stay quick (a whole year timed out)
  const flags = flagWindow(range.to);
  return { ready, range, flagFrom: flags.from, flagTo: flags.to };
}

/** A read that failed and how to try it again. */
export interface Failure { error: Error; retry: () => void }

/** The first of these reads that failed (its retry fetches all of the failed ones again), or null. */
export function firstFailure(...qs: { error: Error | null; retry: () => void }[]): Failure | null {
  const failed = qs.filter((q) => q.error);
  if (!failed.length) return null;
  return { error: failed[0]!.error!, retry: () => { for (const q of failed) q.retry(); } };
}

export function useItemIndex(tenantId: string) {
  const q = useQuery(invKey(tenantId, "index"), () => fetchItemIndex(tenantId), { staleTime: STALE });
  const byId = useMemo(() => new Map<string, ItemIndexRow>((q.data ?? []).map((i) => [i.id, i])), [q.data]);
  return { ...q, byId };
}

export function useLevels(tenantId: string) {
  return useQuery(invKey(tenantId, "levels"), () => fetchStockLevels(tenantId), { staleTime: STALE });
}

export function useSpend(tenantId: string, months = 6) {
  const from = monthsBack(months - 1);
  return useQuery(invKey(tenantId, "spend", from), () => fetchSpendByMonth(tenantId, from, todayIso()), { staleTime: STALE });
}

export function useUsage(tenantId: string, period: ReportPeriod, ready: boolean, range: { from: string; to: string }) {
  const bucket = usageBucket(period);
  return useQuery<UsageRow[]>(ready ? invKey(tenantId, "usage", range.from, range.to, bucket) : null,
    () => fetchUsage(tenantId, range.from, range.to, bucket), { staleTime: STALE });
}

export function useFlags(tenantId: string, ready: boolean, from: string, to: string) {
  return useQuery(ready ? invKey(tenantId, "flags", from, to) : null, () => fetchConsumptionFlags(tenantId, from, to), { staleTime: STALE });
}

/** Cost per meal by month over the last six months: the kitchen's trend, whatever the period. */
export function useMealTrend(tenantId: string) {
  const from = monthsBack(5);
  return useQuery<CostPerMealRow[]>(invKey(tenantId, "meals", from), () => fetchCostPerMeal(tenantId, from, todayIso(), "month"), { staleTime: STALE });
}

export function useUniforms(tenantId: string, ready: boolean, range: { from: string; to: string }) {
  const issues = useQuery(ready ? invKey(tenantId, "uniforms", range.from, range.to) : null, () => fetchUniformIssues(tenantId, range.from, range.to), { staleTime: STALE });
  const charges = useQuery(invKey(tenantId, "charges"), () => fetchIssueCharges(tenantId), { staleTime: STALE });
  return { issues, charges };
}

// ---------------------------------------------------------------- shaping

/** Per item, its use in each bucket of the period (zeros filled), oldest first: the sparkline's values. */
export function usageSeries(rows: UsageRow[]): { buckets: string[]; byItem: Map<string, number[]> } {
  const buckets = [...new Set(rows.map((r) => r.period_start.slice(0, 10)))].sort();
  const index = new Map(buckets.map((b, i) => [b, i]));
  const byItem = new Map<string, number[]>();
  for (const r of rows) {
    let s = byItem.get(r.item_id);
    if (!s) { s = buckets.map(() => 0); byItem.set(r.item_id, s); }
    s[index.get(r.period_start.slice(0, 10))!]! += r.used;
  }
  return { buckets, byItem };
}

/** A month's cost per meal across all meals (weighted by meals served), oldest first. */
export function mealTrend(rows: CostPerMealRow[]): { month: string; cents: number; meals: number }[] {
  const by = new Map<string, { cost: number; meals: number }>();
  for (const r of rows) {
    if (r.meals_served <= 0) continue;
    const m = r.period_start.slice(0, 7);
    const a = by.get(m) ?? { cost: 0, meals: 0 };
    a.cost += r.used_cost_cents;
    a.meals += r.meals_served;
    by.set(m, a);
  }
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, a]) => ({ month, cents: Math.round(a.cost / a.meals), meals: a.meals }));
}

export const monthLabel = (isoMonth: string) =>
  new Date(`${isoMonth.slice(0, 7)}-01T00:00:00`).toLocaleDateString("en-GB", { month: "short", year: "2-digit" });

export function useHeadcount(tenantId: string, ready: boolean, from: string, to: string) {
  return useQuery(ready ? invKey(tenantId, "headcount", from, to) : null, () => fetchHeadcount(tenantId, from, to), { staleTime: STALE });
}

/** Use by day over a window (the per-head chart). */
export function useDailyUsage(tenantId: string, ready: boolean, from: string, to: string) {
  return useQuery<UsageRow[]>(ready ? invKey(tenantId, "usage", from, to, "day") : null, () => fetchUsage(tenantId, from, to, "day"), { staleTime: STALE });
}

/** Last month and this month, per item, for the spend increases. */
export function useTwoMonths(tenantId: string) {
  const from = monthsBack(1);
  return useQuery<UsageRow[]>(invKey(tenantId, "usage", from, todayIso(), "month"), () => fetchUsage(tenantId, from, todayIso(), "month"), { staleTime: STALE });
}
