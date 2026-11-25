import { useMemo, useState } from "react";
import {
  formatMoney, formatQty, formatShortDate, monthsBack, perHeadSeries, spendIncreases, STORES, storeOf, todayIso, usageByItem,
  type StoreKey,
} from "@figbloom/shared";
import { BarList } from "../../components/analytics/BarList";
import { LineChart } from "../../components/analytics/LineChart";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useTenantSession } from "../../lib/sessionContext";
import {
  monthLabel, PERIODS, useDailyUsage, useFlags, useHeadcount, useItemIndex, useStockParams, useStockRange, useTwoMonths, useUsage, usageBucket,
} from "./inventoryStockData";

/**
 * Three ways to read use over time: cost of use by store, one item's use per
 * head next to how many people were in (with its flagged days marked), and
 * the top items by cost of use and by rise in delivery spend.
 */

const niceMax = (v: number) => {
  const p = 10 ** Math.floor(Math.log10(Math.max(v, 1e-6)));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
};
const ticks = (top: number) => [0, top / 4, top / 2, (3 * top) / 4, top].map((t) => Math.round(t * 100) / 100);

const bucketLabel = (iso: string, bucket: "day" | "week" | "month") =>
  bucket === "month" ? monthLabel(iso) : bucket === "week" ? `wk ${formatShortDate(iso.slice(0, 10))}` : new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric" });

export function UseByStoreChart({ store }: { store: StoreKey }) {
  const { tenant } = useTenantSession();
  const { period } = useStockParams();
  const { ready, range } = useStockRange(tenant.id, period);
  const usage = useUsage(tenant.id, period, ready, range);
  const index = useItemIndex(tenant.id);
  const bucket = usageBucket(period);
  if (usage.loading || index.loading || !ready) return <TableSkeleton rows={5} />;
  const rows = usage.data ?? [];
  const buckets = [...new Set(rows.map((r) => r.period_start.slice(0, 10)))].sort();
  const per = new Map<string, number[]>();
  for (const r of rows) {
    const s = storeOf(index.byId.get(r.item_id)?.category);
    if (store !== "all" && s !== store) continue;
    const arr = per.get(s) ?? buckets.map(() => 0);
    arr[buckets.indexOf(r.period_start.slice(0, 10))]! += r.used_cost_cents / 100_000; // KES thousands: short enough for the axis
    per.set(s, arr);
  }
  const order = STORES.map((s) => s.key as string);
  const ranked = [...per.entries()].filter(([, v]) => v.some((x) => x > 0)).sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0));
  const shown = ranked.slice(0, 4).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  const left = ranked.slice(4).map(([s]) => STORES.find((x) => x.key === s)!.label);
  const top = niceMax(Math.max(1, ...shown.flatMap(([, v]) => v)));
  if (buckets.length < 2 || shown.length === 0) {
    return <section className="rounded-lg border border-line bg-white px-4 py-3 text-[13px] text-ink-muted">Not enough use recorded in this period to draw a trend. Try This term or This year.</section>;
  }
  return (
    <LineChart
      title="Cost of use over time, by store"
      summary={`Thousands of KES of stock used per ${bucket}, ${PERIODS.find((p) => p.key === period)!.label.toLowerCase()}. ${shown.map(([s, v]) => `${STORES.find((x) => x.key === s)!.label} ${formatMoney(Math.round(v.reduce((a, b) => a + b, 0) * 100_000), tenant.country)}`).join(", ")}.${left.length ? ` Also used (smaller): ${left.join(", ")}.` : ""}`}
      points={buckets.map((b) => ({ label: bucketLabel(b, bucket) }))}
      series={shown.map(([s, v]) => ({ key: s, name: STORES.find((x) => x.key === s)!.label, values: v.map((x) => Math.round(x * 10) / 10) }))}
      yMin={0} yMax={top} yTicks={ticks(top)} digits={1} unit="k" xHeader={bucket === "month" ? "Month" : bucket === "week" ? "Week" : "Day"}
    />
  );
}

export function PerHeadCharts() {
  const { tenant } = useTenantSession();
  const { period } = useStockParams();
  const { ready, range } = useStockRange(tenant.id, "month");
  // always the last six weeks: long enough for a baseline either side of a spike, short enough to read day by day
  const from = todayIso(new Date(Date.now() - 41 * 86_400_000));
  const flagFrom = from;
  void period;
  const index = useItemIndex(tenant.id);
  const daily = useDailyUsage(tenant.id, ready, from, range.to);
  const heads = useHeadcount(tenant.id, ready, from, range.to);
  const flags = useFlags(tenant.id, ready, flagFrom, range.to);
  const used = useMemo(() => usageByItem(daily.data ?? []).filter((u) => u.used > 0), [daily.data]);
  const options = used.map((u) => index.byId.get(u.item_id)).filter((i): i is NonNullable<typeof i> => !!i && !!i.consumable).sort((a, b) => a.name.localeCompare(b.name));
  const [picked, setPicked] = useState<string | null>(null);
  const itemId = picked ?? options.find((o) => /^rice/i.test(o.name))?.id ?? options[0]?.id ?? null;
  const item = itemId ? index.byId.get(itemId) : undefined;

  if (index.loading || daily.loading || heads.loading || !ready) return <TableSkeleton rows={6} />;
  if (daily.error || heads.error) return <p className="text-[12.5px] text-warn-ink">Could not load use per head: {(daily.error ?? heads.error)!.message}</p>;
  if (!item) return <section className="rounded-lg border border-line bg-white px-4 py-3 text-[13px] text-ink-muted">No consumables used in this window yet.</section>;

  const bucket: "day" | "week" = storeOf(item.category) === "kitchen" ? "day" : "week";
  const series = perHeadSeries((daily.data ?? []).filter((r) => r.item_id === item.id), heads.data ?? [], bucket).filter((p) => p.heads > 0 || p.used > 0);
  const itemFlags = (flags.data ?? []).filter((f) => f.item_id === item.id && !f.explained && (f.kind === "usage_up" || f.kind === "usage_down" || f.kind === "usage_trend"));
  const markIdx = itemFlags.map((f) => {
    const k = bucket === "day" ? f.occurred_on : series.find((p) => p.period <= f.occurred_on && f.occurred_on < addDays(p.period, 7))?.period;
    return { index: series.findIndex((p) => p.period === k), label: `${f.kind === "usage_down" ? "▼" : "▲"} ${formatShortDate(f.occurred_on)}` };
  }).filter((m) => m.index >= 0);
  const per = series.map((p) => (p.perHead == null ? null : Math.round(p.perHead * 1000) / 1000));
  const unit = item.unit;
  const topPer = niceMax(Math.max(0.001, ...per.filter((v): v is number => v != null)));
  const headVals = series.map((p) => (p.heads > 0 ? p.heads : null));
  const topHeads = niceMax(Math.max(1, ...headVals.filter((v): v is number => v != null)));
  const points = series.map((p) => ({ label: bucketLabel(p.period, bucket) }));
  const story = itemFlags[0]
    ? `Flagged: ${itemFlags.map((f) => formatShortDate(f.occurred_on)).join(", ")}. ${itemFlags[0].reason}`
    : "No unexplained use flags for this item in the window.";

  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-body font-semibold">Use per head against headcount, last six weeks</h2>
        <label className="ml-auto flex items-center gap-2 text-[13px]">
          <span className="text-ink-muted">Item</span>
          <select value={item.id} onChange={(e) => setPicked(e.target.value)} className="rounded-md border border-[#D3DAD5] bg-white px-2 py-1.5 text-small">
            {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
      </div>
      <p className="text-[12.5px] text-ink-muted">{story}</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <LineChart
          title={`${item.name}: use per head, by ${bucket}`}
          summary={`${unit ?? "units"} per person in school${bucket === "week" ? " (week's use over the week's average headcount)" : ""}. Dashed lines mark flagged ${bucket === "day" ? "days" : "weeks"}.`}
          points={points}
          series={[{ key: "per", name: `Per head (${unit ?? "units"})`, values: per }]}
          yMin={0} yMax={topPer} yTicks={ticks(topPer)} digits={3} marks={markIdx} xHeader={bucket === "day" ? "Day" : "Week"} height={220}
        />
        <LineChart
          title="People in school"
          summary={`Learners present, staff and visitors, ${bucket === "day" ? "each day" : "average a day each week"}. If this line is flat where use jumps, more people don't explain it.`}
          points={points}
          series={[{ key: "heads", name: "Headcount", values: headVals }]}
          yMin={0} yMax={topHeads} yTicks={ticks(topHeads).map(Math.round)} digits={0} marks={markIdx} xHeader={bucket === "day" ? "Day" : "Week"} height={220}
        />
      </div>
      <p className="text-[12px] text-ink-faint">
        Total used in the window: {formatQty(series.reduce((a, p) => a + p.used, 0), unit)}. Show as table on either chart lists every {bucket}.
      </p>
    </section>
  );
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function TopItemsCharts({ store }: { store: StoreKey }) {
  const { tenant } = useTenantSession();
  const { period } = useStockParams();
  const { ready, range } = useStockRange(tenant.id, period);
  const usage = useUsage(tenant.id, period, ready, range);
  const two = useTwoMonths(tenant.id);
  const index = useItemIndex(tenant.id);
  if (usage.loading || two.loading || index.loading || !ready) return <TableSkeleton rows={6} />;
  const inScope = (id: string) => store === "all" || storeOf(index.byId.get(id)?.category) === store;
  const top = usageByItem(usage.data ?? []).filter((u) => inScope(u.item_id) && u.used_cost_cents > 0).slice(0, 10);
  const thisMonth = monthsBack(0);
  const lastMonth = monthsBack(1);
  const rises = spendIncreases(two.data ?? [], thisMonth, lastMonth).filter((r) => inScope(r.item_id)).slice(0, 10);
  const name = (id: string) => index.byId.get(id)?.name ?? "Item";
  const k = (c: number) => Math.round(c / 100);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {top.length ? (
        <BarList
          title="Top 10 items by cost of use"
          summary={`${PERIODS.find((p) => p.key === period)!.label}. ${name(top[0]!.item_id)} leads at ${formatMoney(top[0]!.used_cost_cents, tenant.country)}.`}
          valueHeader="KES"
          bars={top.map((u) => ({ key: u.item_id, label: name(u.item_id), value: k(u.used_cost_cents), detail: `${formatQty(u.used, index.byId.get(u.item_id)?.unit)} used` }))}
          max={Math.max(1, ...top.map((u) => k(u.used_cost_cents)))}
        />
      ) : <section className="rounded-lg border border-line bg-white px-4 py-3 text-[13px] text-ink-muted">Nothing priced was used in this period.</section>}
      {rises.length ? (
        <BarList
          title="Biggest spend increases, this month vs last"
          summary={`Delivery spend per item, ${monthLabel(thisMonth)} against ${monthLabel(lastMonth)}. Only rises are shown.`}
          valueHeader="KES more"
          bars={rises.map((r) => ({ key: r.item_id, label: name(r.item_id), value: k(r.rise), detail: `${formatMoney(r.before, tenant.country)} → ${formatMoney(r.now, tenant.country)}` }))}
          max={Math.max(1, ...rises.map((r) => k(r.rise)))}
        />
      ) : <section className="rounded-lg border border-line bg-white px-4 py-3 text-[13px] text-ink-muted">No item's delivery spend is up on last month.</section>}
    </div>
  );
}
