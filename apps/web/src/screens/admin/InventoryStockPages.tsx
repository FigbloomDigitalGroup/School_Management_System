import { useMemo, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  formatMoney, formatQty, groupFlags, INVENTORY_CATEGORY_LABEL, inStore, inventoryCapabilities, spendByMonthFor, STORES, storeOf, usageByItem,
  type InventoryCategory, type StockLevel, type StoreKey,
} from "@figbloom/shared";
import { BarList } from "../../components/analytics/BarList";
import { ColumnChart, shortNumber } from "../../components/analytics/ColumnChart";
import { PageHead } from "../../components/ConsoleShell";
import { Cell, DataTable, Mono } from "../../components/ui/DataTable";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { StatRow } from "../../components/ui/StatCard";
import { useTenantSession } from "../../lib/sessionContext";
import { FlagsPanel } from "./InventoryFlags";
import { PerHeadCharts, TopItemsCharts, UseByStoreChart } from "./InventoryTrends";
import { CoverBar, LowStockTable, MealTrendChart, StockFilters, StockLevelCell, UsageTable } from "./InventoryStock";
import {
  mealTrend, monthLabel, PERIODS, useFlags, useInventoryBase, useItemIndex, useLevels, useMealTrend, useSpend, useStockParams, useStockRange,
  useUniforms, useUsage, usageSeries,
} from "./inventoryStockData";

/**
 * The Stock & kitchen widgets' own pages: /admin/inventory/stock/<section>,
 * each with the full list or chart, the same store and period (kept in the
 * URL, so a link can be shared) and a way back. Items open in the register's
 * item window (?item=), on the inventory page.
 */

export const STOCK_SECTIONS = ["levels", "low-stock", "flags", "spend", "usage", "trends", "clinic", "kitchen", "uniforms"] as const;
type Section = (typeof STOCK_SECTIONS)[number];

const TITLES: Record<Section, { title: string; blurb: string }> = {
  levels: { title: "Stock value", blurb: "Every stock line and what it's worth on hand, at the latest delivery price. Biggest first." },
  "low-stock": { title: "Low stock and running out", blurb: "At or below the reorder level, out of stock, or with under a week left at the usual daily use. Soonest to run out first." },
  flags: { title: "Worth a look", blurb: "Use against each item's own usual, stock-takes, delivery prices and days of stock left, worked out in the database. Biggest first; tiny sick-bay changes are grouped as small." },
  spend: { title: "Spend on deliveries", blurb: "What priced deliveries cost, month by month, and which stores it went to." },
  trends: { title: "Trends", blurb: "Cost of use over time by store, one item's use per head against how many people were in (flagged days marked), the top items by cost of use, and the biggest rises in delivery spend." },
  usage: { title: "Use per item", blurb: "What each item used in the period, its trend, what was wasted or went missing, and what it cost." },
  clinic: { title: "Clinic", blurb: "Sick-bay supplies: what was used in the period and the flags on them. Medicine given in the sick bay comes off stock by itself." },
  kitchen: { title: "Kitchen", blurb: "Cost per meal month by month, food used in the period, and the kitchen's flags." },
  uniforms: { title: "Uniforms issued and billed", blurb: "Uniform items handed out in the period and what was added to families' fees for them." },
};

export function InventoryStockPage() {
  const { section } = useParams();
  const s = (STOCK_SECTIONS as readonly string[]).includes(section ?? "") ? (section as Section) : "levels";
  const base = useInventoryBase();
  const nav = useNavigate();
  const { period, store, setPeriod, setStore, qs } = useStockParams();
  const back = `${base}?tab=stock${qs ? `&${qs}` : ""}`;
  const openItem = (id: string) => nav(`${base}?tab=stock&item=${id}${qs ? `&${qs}` : ""}`);
  const { tenant } = useTenantSession();
  const { range, termAvailable } = useStockRange(tenant.id, period);
  const caps = inventoryCapabilities();
  const fixedStore: StoreKey | null = s === "clinic" ? "clinic" : s === "kitchen" ? "kitchen" : s === "uniforms" ? "uniforms" : null;
  const t = { ...TITLES[s] };
  // what the API build cannot do changes what two of the pages can say
  if (s === "clinic" && !caps.sickBayUsesStock) t.blurb = "Sick-bay supplies: what was used in the period and the flags on them. Record the medicine given in the sick bay as use: it does not come off stock by itself on the new system yet.";
  if (s === "uniforms" && !caps.chargeToFees) t.blurb = "Uniform items still out with people that were handed out in the period. Returned ones are not listed on the new system yet, and charging families for them is not there either.";

  return (
    <>
      <PageHead
        eyebrow="Inventory · Stock & kitchen"
        title={t.title}
        blurb={t.blurb}
        actions={<Link to={back} className="rounded-md border border-[#D3DAD5] bg-white px-3 py-1.5 text-small hover:bg-page">← Stock & kitchen</Link>}
      />
      <div className="grid gap-5 px-7 py-6">
        <nav aria-label="Stock pages" className="flex flex-wrap gap-1.5 text-[12.5px]">
          {STOCK_SECTIONS.map((k) => (
            <Link key={k} to={`${base}/stock/${k}${qs ? `?${qs}` : ""}`} aria-current={k === s ? "page" : undefined}
              className={`rounded-full border px-2.5 py-1 ${k === s ? "border-[#17402A] bg-[#17402A] font-semibold text-white" : "border-line bg-white text-ink-muted hover:bg-page"}`}>
              {TITLES[k].title}
            </Link>
          ))}
        </nav>
        <StockFilters period={period} store={fixedStore ?? store} onPeriod={setPeriod} onStore={setStore} range={range}
          hidePeriod={s === "levels" || s === "low-stock" || s === "spend"} hideStore={!!fixedStore} hideTerm={!termAvailable} />
        {s === "levels" && <LevelsSection store={store} onOpenItem={openItem} />}
        {s === "low-stock" && <LowSection store={store} onOpenItem={openItem} />}
        {s === "flags" && <FlagsSection store={store} />}
        {s === "spend" && <SpendSection store={store} />}
        {s === "usage" && <UsageSection store={store} onOpenItem={openItem} />}
        {s === "trends" && (
          <>
            <UseByStoreChart store={store} />
            <PerHeadCharts />
            <TopItemsCharts store={store} />
          </>
        )}
        {s === "clinic" && <ClinicSection onOpenItem={openItem} />}
        {s === "kitchen" && <KitchenSection onOpenItem={openItem} />}
        {s === "uniforms" && <UniformsSection />}
      </div>
    </>
  );
}

function useMoney() {
  const { tenant } = useTenantSession();
  return (c: number | null | undefined) => (c == null ? "—" : formatMoney(c, tenant.country));
}

function Loading({ when, children }: { when: boolean; children: ReactNode }) {
  return when ? <TableSkeleton rows={8} /> : <>{children}</>;
}

function LevelsSection({ store, onOpenItem }: { store: StoreKey; onOpenItem: (id: string) => void }) {
  const { tenant } = useTenantSession();
  const levels = useLevels(tenant.id);
  const money = useMoney();
  const rows = useMemo(() => (levels.data ?? []).filter((l) => inStore(l.category, store)).sort((a, b) => b.value_cents - a.value_cents), [levels.data, store]);
  const total = rows.reduce((a, l) => a + l.value_cents, 0);
  return (
    <Loading when={levels.loading}>
      <StatRow stats={[
        { label: "Stock value", value: money(total), sub: `${rows.length} stock lines` },
        { label: "Biggest line", value: rows[0] ? money(rows[0].value_cents) : "—", sub: rows[0]?.name },
        { label: "Low or out", value: String(rows.filter((l) => l.low || l.quantity <= 0).length), sub: "at or below reorder level" },
      ]} />
      <DataTable
        rowsLabel="stock lines"
        pageSize={25}
        columns={[
          { key: "item", header: "Item", width: "1.6fr", render: (l: StockLevel) => <Cell sub={INVENTORY_CATEGORY_LABEL[l.category as InventoryCategory]}>{l.name}</Cell> },
          { key: "on", header: "In stock", render: (l: StockLevel) => <StockLevelCell item={{ ...l, available: l.quantity }} /> },
          { key: "price", header: "Latest price", align: "right", render: (l: StockLevel) => <span className="text-[13px]">{money(l.unit_cost_cents)}</span> },
          {
            key: "value", header: "Value", align: "right", width: "1.2fr",
            render: (l: StockLevel) => (
              <span className="inline-flex items-center justify-end gap-2">
                <span className="h-1.5 w-16 overflow-hidden rounded-full bg-line-soft" aria-hidden>
                  <span className="block h-full rounded-full bg-[#2A78D6]" style={{ width: `${rows[0] ? Math.max(2, (l.value_cents / rows[0].value_cents) * 100) : 0}%` }} />
                </span>
                <span className="text-[13px] font-medium">{money(l.value_cents)}</span>
              </span>
            ),
          },
          { key: "cover", header: "Lasts", align: "right", render: (l: StockLevel) => <CoverBar days={l.days_of_cover} /> },
        ]}
        rows={rows}
        rowKey={(l) => l.item_id}
        onRowClick={(l) => onOpenItem(l.item_id)}
        minWidth="760px"
        empty={{ title: "No stock lines here", body: "Add consumables to the register, with a unit and a price, to see their value." }}
      />
    </Loading>
  );
}

function LowSection({ store, onOpenItem }: { store: StoreKey; onOpenItem: (id: string) => void }) {
  const { tenant } = useTenantSession();
  const levels = useLevels(tenant.id);
  const rows = (levels.data ?? []).filter((l) => inStore(l.category, store) && (l.low || l.quantity <= 0 || (l.consumable && l.days_of_cover != null && l.days_of_cover < 7)));
  return (
    <Loading when={levels.loading}>
      <StatRow stats={[
        { label: "Out of stock", value: String(rows.filter((l) => l.quantity <= 0).length), alarming: rows.some((l) => l.quantity <= 0) },
        { label: "At reorder level", value: String(rows.filter((l) => l.low && l.quantity > 0).length) },
        { label: "Under 3 days left", value: String(rows.filter((l) => l.days_of_cover != null && l.days_of_cover < 3).length), alarming: rows.some((l) => l.days_of_cover != null && l.days_of_cover < 3) },
        { label: "Under a week left", value: String(rows.filter((l) => l.days_of_cover != null && l.days_of_cover < 7).length) },
      ]} />
      <LowStockTable rows={rows} onOpenItem={onOpenItem} paged />
    </Loading>
  );
}

function FlagsSection({ store }: { store: StoreKey }) {
  const { tenant } = useTenantSession();
  const { period } = useStockParams();
  const { ready, flagFrom, range } = useStockRange(tenant.id, period);
  const flags = useFlags(tenant.id, ready, flagFrom, range.to);
  const rows = (flags.data ?? []).filter((f) => inStore(f.category, store));
  return <FlagsPanel flags={rows} loading={flags.loading || !ready} error={flags.error} title={`Flags, ${PERIODS.find((p) => p.key === period)!.label.toLowerCase()}`} />;
}

function SpendSection({ store }: { store: StoreKey }) {
  const { tenant } = useTenantSession();
  const spend = useSpend(tenant.id, 12);
  const money = useMoney();
  const rows = spendByMonthFor(spend.data ?? [], store);
  const byStore = STORES.filter((s) => s.key !== "all").map((s) => ({
    key: s.key, label: s.label,
    value: Math.round((spend.data ?? []).filter((r) => storeOf(r.category) === s.key).reduce((a, r) => a + r.spend_cents, 0) / 100),
  })).filter((b) => b.value > 0).sort((a, b) => b.value - a.value);
  const total = rows.reduce((a, r) => a + r.spend_cents, 0);
  const avg = rows.length ? total / rows.length : 0;
  return (
    <Loading when={spend.loading}>
      <StatRow stats={[
        { label: "Last 12 months", value: money(total), sub: `${rows.reduce((a, r) => a + r.deliveries, 0)} priced deliveries` },
        { label: "Average month", value: money(Math.round(avg)) },
        { label: "Biggest month", value: rows.length ? money(Math.max(...rows.map((r) => r.spend_cents))) : "—", sub: rows.length ? monthLabel(rows.reduce((a, r) => (r.spend_cents > a.spend_cents ? r : a)).month) : undefined },
      ]} />
      <ColumnChart
        title="Spend on deliveries, by month"
        summary={`${store === "all" ? "All stores" : STORES.find((s) => s.key === store)!.label}, the last twelve months. This month is highlighted.`}
        valueHeader="Spend"
        format={(v) => formatMoney(v * 100, tenant.country)}
        short={shortNumber}
        highlight={rows[rows.length - 1]?.month}
        height={240}
        columns={rows.map((r) => ({ key: r.month, label: monthLabel(r.month), value: Math.round(r.spend_cents / 100), detail: `${r.deliveries} deliveries` }))}
      />
      {store === "all" && byStore.length > 0 && (
        <BarList title="By store, last twelve months" valueHeader="KES" bars={byStore} max={Math.max(1, ...byStore.map((b) => b.value))} />
      )}
    </Loading>
  );
}

function UsageSection({ store, onOpenItem, only }: { store: StoreKey; onOpenItem: (id: string) => void; only?: StoreKey }) {
  const { tenant } = useTenantSession();
  const { period } = useStockParams();
  const { ready, range } = useStockRange(tenant.id, period);
  const usage = useUsage(tenant.id, period, ready, range);
  const index = useItemIndex(tenant.id);
  const money = useMoney();
  const scope = only ?? store;
  const totals = useMemo(() => usageByItem(usage.data ?? []), [usage.data]);
  const series = useMemo(() => usageSeries(usage.data ?? []), [usage.data]);
  const rows = totals.filter((u) => inStore(index.byId.get(u.item_id)?.category, scope) && (u.used || u.wasted || u.shrinkage));
  return (
    <Loading when={usage.loading || index.loading || !ready}>
      {usage.error ? <p className="text-[12.5px] text-warn-ink">Could not load use: {usage.error.message}</p> : (
        <>
          <StatRow stats={[
            { label: "Cost of use", value: money(rows.reduce((a, u) => a + u.used_cost_cents, 0)), sub: `${rows.length} items` },
            { label: "Wasted or missing", value: String(rows.filter((u) => u.wasted + u.shrinkage > 0).length), sub: "items with any" },
            { label: "Delivered", value: money(rows.reduce((a, u) => a + u.spend_cents, 0)), sub: "priced deliveries in the period" },
          ]} />
          <UsageTable rows={rows} byId={index.byId} series={series} money={money} onOpenItem={onOpenItem} groupByStore={scope === "all"} pageSize={25} />
        </>
      )}
    </Loading>
  );
}

function ClinicSection({ onOpenItem }: { onOpenItem: (id: string) => void }) {
  const { tenant } = useTenantSession();
  const { period } = useStockParams();
  const { ready, flagFrom, range } = useStockRange(tenant.id, period);
  const flags = useFlags(tenant.id, ready, flagFrom, range.to);
  const clinicFlags = (flags.data ?? []).filter((f) => storeOf(f.category) === "clinic");
  const g = groupFlags(clinicFlags);
  return (
    <>
      <p className="rounded-lg border border-line bg-sunken px-4 py-2.5 text-[12.5px] text-ink-muted">
        {g.small.length > 0 ? `${g.small.length} of the ${clinicFlags.length} clinic flags are small changes (under 10 units either way, like 8 plasters against 4) and are folded away below. ` : ""}
        No learner's name or visit appears here: only supplies.
      </p>
      <UsageSection store="clinic" only="clinic" onOpenItem={onOpenItem} />
      <FlagsPanel flags={clinicFlags} loading={flags.loading || !ready} error={flags.error} title="Clinic flags" />
    </>
  );
}

function KitchenSection({ onOpenItem }: { onOpenItem: (id: string) => void }) {
  const { tenant } = useTenantSession();
  const meals = useMealTrend(tenant.id);
  const { period } = useStockParams();
  const { ready, flagFrom, range } = useStockRange(tenant.id, period);
  const flags = useFlags(tenant.id, ready, flagFrom, range.to);
  const money = useMoney();
  const trend = mealTrend(meals.data ?? []);
  return (
    <>
      <Loading when={meals.loading}>
        {meals.error && <p className="text-[12.5px] text-warn-ink">Could not work out the cost per meal: {meals.error.message}</p>}
        <div className="grid gap-5 lg:grid-cols-2">
          <MealTrendChart rows={meals.data ?? []} country={tenant.country} />
          {trend.length > 0 ? (
            <ColumnChart
              title="Meals served, by month"
              summary={`All meals. Latest month: ${trend[trend.length - 1]!.meals.toLocaleString()} meals at ${money(trend[trend.length - 1]!.cents)} each.`}
              valueHeader="Meals"
              format={(v) => v.toLocaleString()}
              short={shortNumber}
              highlight={trend[trend.length - 1]!.month}
              columns={trend.map((x) => ({ key: x.month, label: monthLabel(x.month), value: x.meals, detail: `${money(x.cents)} a meal` }))}
            />
          ) : <span />}
        </div>
      </Loading>
      <UsageSection store="kitchen" only="kitchen" onOpenItem={onOpenItem} />
      <FlagsPanel flags={(flags.data ?? []).filter((f) => storeOf(f.category) === "kitchen")} loading={flags.loading || !ready} error={flags.error} title="Kitchen flags" />
    </>
  );
}

function UniformsSection() {
  const { tenant } = useTenantSession();
  const { period } = useStockParams();
  const { ready, range } = useStockRange(tenant.id, period);
  const { issues, charges } = useUniforms(tenant.id, ready, range);
  const money = useMoney();
  const caps = inventoryCapabilities();
  const rows = useMemo(() => {
    const by = new Map<string, { item_id: string; name: string; copies: number; learners: Set<string>; billedCents: number; billed: number }>();
    for (const i of issues.data ?? []) {
      const r = by.get(i.item_id) ?? { item_id: i.item_id, name: i.name, copies: 0, learners: new Set<string>(), billedCents: 0, billed: 0 };
      r.copies += i.quantity;
      if (i.student_id) r.learners.add(i.student_id);
      const c = charges.data?.get(i.id);
      if (c) { r.billedCents += c.amountCents; r.billed += 1; }
      by.set(i.item_id, r);
    }
    return [...by.values()].sort((a, b) => b.copies - a.copies);
  }, [issues.data, charges.data]);
  const months = useMemo(() => {
    const by = new Map<string, number>();
    for (const i of issues.data ?? []) by.set(i.issued_at.slice(0, 7), (by.get(i.issued_at.slice(0, 7)) ?? 0) + i.quantity);
    return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  }, [issues.data]);
  const copies = rows.reduce((a, r) => a + r.copies, 0);
  const billed = rows.reduce((a, r) => a + r.billedCents, 0);
  return (
    <Loading when={issues.loading || !ready}>
      <StatRow stats={[
        { label: "Issued", value: copies.toLocaleString(), sub: `${new Set((issues.data ?? []).map((i) => i.student_id).filter(Boolean)).size.toLocaleString()} learners` },
        // charging a family for a lost or damaged item is not on the API, so there is nothing billed to show there
        ...(caps.chargeToFees ? [{ label: "Billed to families", value: charges.loading ? "…" : money(billed), sub: `${rows.reduce((a, r) => a + r.billed, 0).toLocaleString()} charges` }] : []),
        { label: "Items", value: String(rows.length), sub: "uniform lines handed out" },
      ]} />
      {months.length > 1 && (
        <ColumnChart title="Uniforms issued, by month" valueHeader="Copies" format={(v) => v.toLocaleString()} short={shortNumber}
          columns={months.map(([m, n]) => ({ key: m, label: monthLabel(m), value: n }))} />
      )}
      <DataTable
        rowsLabel="uniform items"
        pageSize={25}
        columns={[
          { key: "name", header: "Item", width: "1.8fr", render: (r: (typeof rows)[number]) => <Cell>{r.name}</Cell> },
          { key: "copies", header: "Issued", align: "right", render: (r: (typeof rows)[number]) => <Mono>{r.copies.toLocaleString()}</Mono> },
          { key: "learners", header: "Learners", align: "right", render: (r: (typeof rows)[number]) => <Mono>{r.learners.size.toLocaleString()}</Mono> },
          ...(caps.chargeToFees ? [{ key: "billed", header: "Billed", align: "right" as const, render: (r: (typeof rows)[number]) => <span className="text-[13px]">{r.billed ? `${money(r.billedCents)} · ${r.billed}` : "—"}</span> }] : []),
        ]}
        rows={rows}
        rowKey={(r) => r.item_id}
        minWidth="560px"
        empty={{ title: "No uniforms issued in this period", body: caps.chargeToFees ? "Issue uniforms from the register and charge them to fees from History." : "Issue uniforms from the register and they show up here while they are out." }}
      />
      <p className="text-[12px] text-ink-faint">Quantities are copies; {formatQty(copies, null)} in all for {PERIODS.find((p) => p.key === period)!.label.toLowerCase()}.</p>
    </Loading>
  );
}
