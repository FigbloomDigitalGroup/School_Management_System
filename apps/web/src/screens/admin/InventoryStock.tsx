import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchMovements, formatMoney, formatQty, formatShortDate, groupFlags, INVENTORY_CATEGORY_LABEL, MOVEMENT_KIND_LABEL,
  inStore, movementProblem, PURPOSE_SUGGESTIONS, recordStockMovement, severityCounts, spendByMonthFor, stockOverview, stockStatus, stockTakeDelta,
  storeOf, STORES, summariseStores, todayIso, usageByItem,
  type CostPerMealRow, type InventoryCategory, type InventoryItemRow, type ItemIndexRow, type MovementKind, type MovementRow,
  type ReportPeriod, type StockLevel, type StoreKey, type UsageByItem,
} from "@figbloom/shared";
import { ColumnChart, shortNumber } from "../../components/analytics/ColumnChart";
import { LineChart } from "../../components/analytics/LineChart";
import { Sparkline } from "../../components/analytics/Sparkline";
import { Pagination } from "../../components/ui/Pagination";
import { StatLink, StatLinkGrid } from "../../components/ui/StatLink";
import { usePaging } from "../../components/ui/usePaging";
import { FlagsPanel, InsightsPanel, SeverityBadge } from "./InventoryFlags";
import { UseByStoreChart } from "./InventoryTrends";
import {
  mealTrend, monthLabel, PERIODS, useFlags, useInventoryBase, useItemIndex, useLevels, useMealTrend, useSpend, useStockParams, useStockRange,
  useUniforms, useUsage, usageSeries,
} from "./inventoryStockData";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, Mono } from "../../components/ui/DataTable";
import { TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";

/**
 * Stock in and out for consumables (the kitchen first): the badge a stock
 * line shows in the register, the Receive / Use / Stock-take forms, an item's
 * movement history, and the Stock & kitchen view (overview, flags worked out
 * in the database, an AI briefing on them, use, spend and cost per meal).
 */

const MOVE_TONE: Record<MovementKind, Tone> = { received: "ok", used: "info", wasted: "warn", adjusted: "muted" };

/** The register's "On the shelf" for a stock line with a unit or a reorder level: "120 kg" and a Low / Out badge. */
export function StockLevelCell({ item }: { item: Pick<InventoryItemRow, "quantity" | "reorder_level" | "unit" | "available" | "consumable"> }) {
  const status = stockStatus(item);
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-[13px]">
      {item.consumable ? <Mono>{formatQty(item.quantity, item.unit)}</Mono> : <><Mono>{item.available}</Mono> of {formatQty(item.quantity, item.unit)}</>}
      {status === "out" ? <Badge tone="warn">Out of stock</Badge> : status === "low" ? <Badge tone="warn">Low</Badge> : null}
    </span>
  );
}

// ---------------------------------------------------------------- receive / use / stock-take

export type MoveAction = "received" | "used" | "adjusted";

export function MovementModal({ item, action, onClose, onDone }: {
  item: InventoryItemRow; action: MoveAction; onClose: () => void; onDone: (msg: string) => void;
}) {
  const { tenant } = useTenantSession();
  const [qty, setQty] = useState("");
  const [wasted, setWasted] = useState(false);
  const [date, setDate] = useState(todayIso());
  const [cost, setCost] = useState(item.unit_cost_cents != null ? String(item.unit_cost_cents / 100) : "");
  const [supplier, setSupplier] = useState("");
  const [reference, setReference] = useState("");
  const [purpose, setPurpose] = useState(action === "used" ? "Lunch" : "");
  const [meals, setMeals] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kind: MovementKind = action === "used" && wasted ? "wasted" : action;
  const n = Number(qty);
  // a stock-take is entered as what was counted; the movement is the difference
  const quantity = action === "adjusted" ? stockTakeDelta(item.quantity, n) : n;
  const costCents = cost.trim() === "" ? null : Math.round(Number(cost) * 100);
  const mealsN = meals.trim() === "" ? null : Number(meals);
  const unit = item.unit;

  const problem = qty.trim() === "" ? "" : action === "adjusted" && quantity === 0 ? "That's what the register already says; nothing to correct."
    : action === "adjusted" && (!Number.isInteger(n) || n < 0) ? "Enter what you counted, 0 or more."
    : movementProblem({ kind, quantity, occurredOn: date, unitCostCents: costCents != null && Number.isFinite(costCents) ? costCents : costCents === null ? null : -1, mealsServed: mealsN }, item.quantity);

  async function save() {
    if (problem !== null) return;
    setSaving(true);
    setError(null);
    try {
      await recordStockMovement({
        tenantId: tenant.id, itemId: item.id, kind, quantity, occurredOn: date,
        unitCostCents: costCents, supplier, reference, purpose, mealsServed: mealsN, note,
      });
      onDone(action === "received" ? `${formatQty(n, unit)} of ${item.name} received.`
        : action === "adjusted" ? `${item.name} corrected to ${formatQty(n, unit)} (${quantity > 0 ? "+" : ""}${quantity}).`
        : `${formatQty(n, unit)} of ${item.name} ${kind === "wasted" ? "recorded as wasted" : "used"}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that.");
      setSaving(false);
    }
  }

  const title = action === "received" ? `Receive ${item.name}` : action === "used" ? `Use ${item.name}` : `Stock-take: ${item.name}`;
  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={`${formatQty(item.quantity, unit)} in stock`}
      title={title}
      blurb={action === "adjusted" ? "Count what's on the shelf and enter it. The difference is recorded as a correction; nothing in the history is changed."
        : action === "used" && item.category === "medical" ? "Medicine given in the sick bay comes off this stock by itself. Record only other use here (a first-aid kit, a trip)."
        : undefined}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={() => void save()} disabled={saving || problem !== null}>
            {saving ? "Saving…" : action === "received" ? "Record delivery" : action === "used" ? (wasted ? "Record waste" : "Record use") : "Save count"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3.5">
        <div className="grid gap-3.5 sm:grid-cols-2">
          <TextField id="move-qty" label={action === "adjusted" ? `Counted${unit ? ` (${unit})` : ""}` : `Quantity${unit ? ` (${unit})` : ""}`}
            type="number" min={0} step={1} value={qty} onChange={(e) => setQty(e.target.value)} error={problem || undefined}
            hint={action === "adjusted" && qty.trim() !== "" && Number.isInteger(n) ? `Register says ${formatQty(item.quantity, unit)}: ${quantity >= 0 ? "+" : ""}${quantity}.` : undefined} />
          <TextField id="move-date" label="Date" type="date" max={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        {action === "received" && (
          <>
            <div className="grid gap-3.5 sm:grid-cols-2">
              <TextField id="move-cost" label={`Price per ${unit ?? "unit"} (optional)`} type="number" min={0} step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} />
              <TextField id="move-supplier" label="Supplier (optional)" maxLength={160} placeholder="e.g. Kitui Grains Ltd" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
            </div>
            <TextField id="move-ref" label="Delivery note or LPO no. (optional)" mono maxLength={80} value={reference} onChange={(e) => setReference(e.target.value)} />
          </>
        )}
        {action === "used" && (
          <>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={wasted} onChange={(e) => setWasted(e.target.checked)} />
              Wasted or spoilt, not eaten or used
            </label>
            <div className="grid gap-3.5 sm:grid-cols-2">
              <div>
                <TextField id="move-purpose" label="For" list="move-purposes" maxLength={120} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
                <datalist id="move-purposes">{PURPOSE_SUGGESTIONS.map((p) => <option key={p} value={p} />)}</datalist>
              </div>
              {!wasted && (
                <TextField id="move-meals" label="Meals served (optional)" type="number" min={0} step={1} value={meals} onChange={(e) => setMeals(e.target.value)}
                  hint="How many ate this meal. Lets the report show cost per meal." />
              )}
            </div>
          </>
        )}
        <TextField id="move-note" label="Note (optional)" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        {error && <p role="alert" className="text-[12.5px] text-warn-ink">{error}</p>}
      </div>
    </Modal>
  );
}

/** An item's stock movements, newest first. */
export function MovementList({ itemId, unit, reloadKey, country }: { itemId: string; unit: string | null; reloadKey: number; country: string }) {
  const { data, loading, error } = useAsync(() => fetchMovements(itemId), [itemId, reloadKey]);
  if (error) return <p className="text-[12.5px] text-warn-ink">Could not load the movements: {error.message}</p>;
  if (loading && !data) return <TableSkeleton rows={4} />;
  return (
    <DataTable
      pageSize={10}
      rowsLabel="movements"
      columns={[
        { key: "date", header: "Date", render: (m: MovementRow) => <span className="text-[13px]">{formatShortDate(m.occurred_on)}</span> },
        { key: "kind", header: "What", render: (m: MovementRow) => <Badge tone={MOVE_TONE[m.kind]}>{MOVEMENT_KIND_LABEL[m.kind]}</Badge> },
        {
          key: "qty", header: "Quantity", align: "right",
          render: (m: MovementRow) => {
            const delta = m.kind === "received" || m.kind === "adjusted" ? m.quantity : -m.quantity;
            return <Mono>{delta > 0 ? "+" : "−"}{formatQty(Math.abs(delta), unit)}</Mono>;
          },
        },
        {
          key: "detail", header: "Details", width: "2fr",
          render: (m: MovementRow) => (
            <Cell sub={[m.note, m.recordedByName ? `by ${m.recordedByName}` : null].filter(Boolean).join(" · ") || undefined}>
              <span className="text-[13px]">
                {m.kind === "received"
                  ? [m.supplier, m.unit_cost_cents != null ? `${formatMoney(m.unit_cost_cents, country)} each` : null, m.reference].filter(Boolean).join(" · ") || "—"
                  : [m.purpose, m.meals_served != null ? `${m.meals_served.toLocaleString()} meals` : null].filter(Boolean).join(" · ") || "—"}
              </span>
            </Cell>
          ),
        },
      ]}
      rows={data ?? []}
      rowKey={(m) => m.id}
      minWidth="560px"
      empty={{ title: "No movements yet", body: "Deliveries, use and stock-takes of this item will be listed here." }}
    />
  );
}

// ---------------------------------------------------------------- the Stock & kitchen view

/** Period and store, kept in the URL. */
export function StockFilters({ period, store, onPeriod, onStore, range, hidePeriod, hideStore }: {
  period: ReportPeriod; store: StoreKey; onPeriod: (p: ReportPeriod) => void; onStore: (s: StoreKey) => void;
  range?: { from: string; to: string }; hidePeriod?: boolean; hideStore?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {!hidePeriod && (
        <div role="group" aria-label="Period" className="flex rounded-md border border-[#D3DAD5] bg-white p-0.5">
          {PERIODS.map((p) => (
            <button key={p.key} type="button" aria-pressed={period === p.key} onClick={() => onPeriod(p.key)} className="rounded px-3 py-1.5 text-small"
              style={period === p.key ? { background: "#17402A", color: "#fff", fontWeight: 600 } : {}}>
              {p.label}
            </button>
          ))}
        </div>
      )}
      {!hideStore && (
        <div role="group" aria-label="Store" className="flex flex-wrap rounded-md border border-[#D3DAD5] bg-white p-0.5">
          {STORES.map((st) => (
            <button key={st.key} type="button" aria-pressed={store === st.key} onClick={() => onStore(st.key)} className="rounded px-3 py-1.5 text-small"
              style={store === st.key ? { background: "#17402A", color: "#fff", fontWeight: 600 } : {}}>
              {st.label}
            </button>
          ))}
        </div>
      )}
      {range && !hidePeriod && <span className="text-[12.5px] text-ink-faint">{formatShortDate(range.from)} to {formatShortDate(range.to)}</span>}
    </div>
  );
}

const lowOf = (l: StockLevel) => l.low || l.quantity <= 0 || (l.consumable && l.days_of_cover != null && l.days_of_cover < 7);

/**
 * The Stock & kitchen tab: overview widgets that open their own pages, the
 * flags and Bloom's briefing, use per item with its trend, spend by month and
 * cost per meal. Every section loads on its own (in parallel, from the cache
 * when it's there) and shows a skeleton until then.
 */
export function StockView({ onOpenItem }: { onOpenItem: (itemId: string) => void }) {
  const { tenant } = useTenantSession();
  const base = useInventoryBase();
  const { period, store, setPeriod, setStore, qs } = useStockParams();
  const { ready, range, flagFrom } = useStockRange(tenant.id, period);
  const to = (section: string) => `${base}/stock/${section}${qs ? `?${qs}` : ""}`;

  const index = useItemIndex(tenant.id);
  const levels = useLevels(tenant.id);
  const spend = useSpend(tenant.id);
  const usage = useUsage(tenant.id, period, ready, range);
  const flags = useFlags(tenant.id, ready, flagFrom, range.to);
  const meals = useMealTrend(tenant.id);
  const uniforms = useUniforms(tenant.id, ready, range);

  const byId = index.byId;
  const money = (c: number | null | undefined) => (c == null ? "—" : formatMoney(c, tenant.country));
  const inScope = (category: string | undefined) => inStore(category, store);
  const periodLabel = PERIODS.find((p) => p.key === period)!.label.toLowerCase();

  const spendRows = useMemo(() => spendByMonthFor(spend.data ?? [], store), [spend.data, store]);
  const overview = levels.data && spend.data
    ? stockOverview(levels.data.filter((l) => inScope(l.category)), spendRows.map((r) => ({ ...r, category: store })))
    : null;
  const lowRows = (levels.data ?? []).filter((l) => inScope(l.category) && lowOf(l));
  const flagRows = (flags.data ?? []).filter((f) => inScope(f.category));
  const flagGroups = groupFlags(flagRows);
  const flagCounts = severityCounts(flagGroups.alarms);
  const usageTotals = useMemo(() => usageByItem(usage.data ?? []), [usage.data]);
  const series = useMemo(() => usageSeries(usage.data ?? []), [usage.data]);
  const usageRows = usageTotals.filter((u) => inScope(byId.get(u.item_id)?.category) && (u.used || u.wasted || u.shrinkage));
  const stores = levels.data && usage.data && store === "all"
    ? summariseStores(levels.data, usageTotals, (id) => byId.get(id)?.category)
    : null;
  const clinic = usageTotals.filter((u) => storeOf(byId.get(u.item_id)?.category) === "clinic");
  const clinicFlags = groupFlags((flags.data ?? []).filter((f) => storeOf(f.category) === "clinic"));
  const trend = mealTrend(meals.data ?? []);
  const lastMeal = trend[trend.length - 1];
  const prevMeal = trend[trend.length - 2];
  const uniformIssued = (uniforms.issues.data ?? []).reduce((a, i) => a + i.quantity, 0);
  const uniformBilled = uniforms.charges.data
    ? (uniforms.issues.data ?? []).reduce((a, i) => a + (uniforms.charges.data!.get(i.id)?.amountCents ?? 0), 0)
    : null;

  return (
    <div className="grid gap-5">
      <StockFilters period={period} store={store} onPeriod={setPeriod} onStore={setStore} range={range} />

      <StatLinkGrid>
        <StatLink label="Stock value" to={to("levels")} loading={!overview} action="Open every stock line by value"
          value={overview ? money(overview.valueCents) : ""} sub="on hand, at the latest prices" />
        <StatLink label="Spent this month" to={to("spend")} loading={!overview} action="Open spend by month"
          value={overview ? money(overview.spendThisMonthCents) : ""}
          sub={overview ? (overview.spendChangePct == null ? "on deliveries" : `${overview.spendChangePct >= 0 ? "▲ +" : "▼ "}${overview.spendChangePct}% on last month`) : undefined}>
          {spendRows.length > 1 && <Sparkline bars values={spendRows.map((s) => s.spend_cents / 100)} label={`Spend by month: ${spendRows.map((s) => `${monthLabel(s.month)} ${money(s.spend_cents)}`).join(", ")}`} />}
        </StatLink>
        <StatLink label="Low / running out" to={to("low-stock")} loading={!levels.data} action="Open the low stock list"
          value={levels.data ? String(lowRows.length) : ""} alarming={lowRows.length > 0}
          sub={overview ? `${overview.lowCount} at reorder level · ${overview.shortCoverCount} under a week left` : undefined} />
        <StatLink label="Worth a look" to={to("flags")} loading={flags.loading} action="Open every flag"
          value={flags.data ? String(flagGroups.alarms.length) : ""} alarming={flagCounts.high > 0}
          sub={flags.data ? `${flagGroups.small.length} small clinic · ${flagGroups.explained.length} explained` : undefined}>
          {flags.data && flagGroups.alarms.length > 0 && (
            <div className="flex flex-wrap gap-1">{(["high", "medium", "low"] as const).map((s) => flagCounts[s] > 0 && <SeverityBadge key={s} severity={s} count={flagCounts[s]} />)}</div>
          )}
        </StatLink>
        {(store === "all" || store === "kitchen") && (
          <StatLink label="Kitchen cost per meal" to={to("kitchen")} loading={meals.loading} action="Open the kitchen page"
            value={lastMeal ? money(lastMeal.cents) : "—"}
            sub={meals.error ? "couldn't load the meal costs; open to retry" : lastMeal ? `${monthLabel(lastMeal.month)}, ${lastMeal.meals.toLocaleString()} meals${prevMeal ? ` · ${lastMeal.cents >= prevMeal.cents ? "▲" : "▼"} from ${money(prevMeal.cents)}` : ""}` : "no meal counts yet"}>
            {trend.length > 1 && <Sparkline values={trend.map((t) => t.cents / 100)} label={`Cost per meal by month: ${trend.map((t) => `${monthLabel(t.month)} ${money(t.cents)}`).join(", ")}`} />}
          </StatLink>
        )}
        {(store === "all" || store === "clinic") && (
          <StatLink label={`Clinic use, ${periodLabel}`} to={to("clinic")} loading={usage.loading || index.loading} action="Open the clinic page"
            value={money(clinic.reduce((a, u) => a + u.used_cost_cents, 0))}
            sub={`${clinic.filter((u) => u.used > 0).length} items used · ${clinicFlags.alarms.length} flag${clinicFlags.alarms.length === 1 ? "" : "s"}${clinicFlags.small.length ? `, ${clinicFlags.small.length} small` : ""}`} />
        )}
        {(store === "all" || store === "uniforms") && (
          <StatLink label={`Uniforms, ${periodLabel}`} to={to("uniforms")} loading={uniforms.issues.loading} action="Open uniforms issued and billed"
            value={`${uniformIssued.toLocaleString()} issued`}
            sub={uniformBilled == null ? "billed: loading" : `${money(uniformBilled)} billed to families`} />
        )}
      </StatLinkGrid>

      {store === "all" && (stores ? stores.length > 1 && (
        <section className="grid gap-2">
          <h2 className="text-body font-semibold">By store</h2>
          <DataTable
            columns={[
              { key: "store", header: "Store", width: "1.4fr", render: (x) => <button type="button" className="text-left text-[13px] font-medium underline-offset-2 hover:underline" onClick={() => setStore(x.store)}>{x.label}</button> },
              { key: "items", header: "Stock lines", align: "right", render: (x) => <Mono>{x.items}</Mono> },
              { key: "value", header: "Stock value", align: "right", render: (x) => <span className="text-[13px]">{money(x.valueCents)}</span> },
              { key: "used", header: `Used ${periodLabel}`, align: "right", render: (x) => <span className="text-[13px]">{money(x.usedCostCents)}</span> },
              { key: "low", header: "Low", align: "right", render: (x) => x.low ? <Badge tone="warn">{x.low} low</Badge> : <span className="text-ink-faint">—</span> },
            ]}
            rows={stores}
            rowKey={(x) => x.store}
            minWidth="560px"
            empty={{ title: "No stock lines yet", body: "Add consumables to the register to see them here." }}
          />
        </section>
      ) : <TableSkeleton rows={4} />)}

      <FlagsPanel flags={flagRows} loading={flags.loading} error={flags.error} limit={8} moreTo={to("flags")} />
      <InsightsPanel from={flagFrom} to={range.to} />

      <div className="grid gap-5 lg:grid-cols-2">
        {spend.loading ? <TableSkeleton rows={4} /> : spendRows.length > 0 ? (
          <ColumnChart
            title="Spend on deliveries, by month"
            summary={`${store === "all" ? "All stores" : STORES.find((st) => st.key === store)!.label}, the last six months.${overview?.spendChangePct != null ? ` This month is ${overview.spendChangePct >= 0 ? "up" : "down"} ${Math.abs(overview.spendChangePct)}% on last.` : ""}`}
            valueHeader="Spend"
            format={(v) => formatMoney(v * 100, tenant.country)}
            short={shortNumber}
            highlight={spendRows[spendRows.length - 1]?.month}
            columns={spendRows.map((s) => ({ key: s.month, label: monthLabel(s.month), value: Math.round(s.spend_cents / 100), detail: `${s.deliveries} deliveries` }))}
          />
        ) : (
          <section className="rounded-lg border border-line bg-white px-4 py-3 text-[13px] text-ink-muted">No priced deliveries in the last six months yet.</section>
        )}
        {(store === "all" || store === "kitchen") && (meals.loading ? <TableSkeleton rows={4} /> : meals.error ? (
          <section className="rounded-lg border border-line bg-white px-4 py-3 text-[12.5px] text-warn-ink">Could not work out the cost per meal: {meals.error.message}</section>
        ) : (
          <MealTrendChart rows={meals.data ?? []} country={tenant.country} />
        ))}
      </div>

      <UseByStoreChart store={store} />

      <section className="grid gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-body font-semibold">Used {periodLabel}</h2>
          <span className="flex gap-4">
            <Link to={to("trends")} className="text-[13px] font-medium underline-offset-2 hover:underline">Trends and top items →</Link>
            <Link to={to("usage")} className="text-[13px] font-medium underline-offset-2 hover:underline">Open use per item →</Link>
          </span>
        </div>
        {usage.error ? <p className="text-[12.5px] text-warn-ink">Could not load use: {usage.error.message}</p> : usage.loading || index.loading ? <TableSkeleton rows={6} /> : (
          <UsageTable rows={usageRows} byId={byId} series={series} money={money} onOpenItem={onOpenItem} groupByStore={store === "all"} />
        )}
      </section>

      <section className="grid gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-body font-semibold">Low stock and days of cover</h2>
          <Link to={to("low-stock")} className="text-[13px] font-medium underline-offset-2 hover:underline">Open the full list →</Link>
        </div>
        {levels.loading ? <TableSkeleton rows={4} /> : <LowStockTable rows={lowRows} onOpenItem={onOpenItem} />}
      </section>
    </div>
  );
}

/** Cost per meal over the last six months: one line per meal (at most four), in shillings. */
export function MealTrendChart({ rows, country }: { rows: CostPerMealRow[]; country: string }) {
  const months = [...new Set(rows.filter((r) => r.meals_served > 0).map((r) => r.period_start.slice(0, 7)))].sort();
  const purposes = [...new Set(rows.filter((r) => r.meals_served > 0).map((r) => r.purpose))]
    .map((p) => ({ p, meals: rows.filter((r) => r.purpose === p).reduce((a, r) => a + r.meals_served, 0) }))
    .sort((a, b) => b.meals - a.meals).slice(0, 4).map((x) => x.p);
  if (months.length === 0) {
    return <section className="rounded-lg border border-line bg-white px-4 py-3 text-[13px] text-ink-muted">No meal counts yet. Enter meals served when recording the kitchen's use to see the cost of a meal.</section>;
  }
  const value = (m: string, p: string) => {
    const r = rows.find((x) => x.period_start.slice(0, 7) === m && x.purpose === p && x.meals_served > 0);
    return r && r.cost_per_meal_cents != null ? Math.round(r.cost_per_meal_cents) / 100 : null;
  };
  const series = purposes.map((p) => ({ key: p, name: p, values: months.map((m) => value(m, p)) }));
  const all = series.flatMap((s) => s.values).filter((v): v is number => v != null);
  const top = niceMax(Math.max(1, ...all));
  const trend = mealTrend(rows);
  const first = trend[0];
  const last = trend[trend.length - 1];
  return (
    <LineChart
      title="Cost per meal, by month"
      summary={first && last && trend.length > 1
        ? `All meals: ${formatMoney(first.cents, country)} in ${monthLabel(first.month)} to ${formatMoney(last.cents, country)} in ${monthLabel(last.month)}.`
        : "Food used divided by meals served."}
      points={months.map((m) => ({ label: monthLabel(m) }))}
      series={series}
      yMin={0}
      yMax={top}
      yTicks={[0, top / 4, top / 2, (3 * top) / 4, top].map((t) => Math.round(t))}
      digits={0}
      unit=""
    />
  );
}

function niceMax(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

/** Items at or below reorder level, out, or with under a week left: soonest to run out first. */
export function LowStockTable({ rows, onOpenItem, paged }: { rows: StockLevel[]; onOpenItem: (itemId: string) => void; paged?: boolean }) {
  const sorted = [...rows].sort((a, b) => (a.days_of_cover ?? (a.quantity <= 0 ? -1 : 1e9)) - (b.days_of_cover ?? (b.quantity <= 0 ? -1 : 1e9)));
  const paging = usePaging(sorted.length, rows.length);
  const shown = paged ? paging.slice(sorted) : sorted.slice(0, 10);
  return (
    <div className="grid gap-2">
      <DataTable
        columns={[
          { key: "item", header: "Item", width: "1.6fr", render: (l: StockLevel) => <Cell sub={INVENTORY_CATEGORY_LABEL[l.category as InventoryCategory]}>{l.name}</Cell> },
          { key: "on", header: "In stock", render: (l: StockLevel) => <StockLevelCell item={{ ...l, available: l.quantity }} /> },
          { key: "reorder", header: "Reorder at", align: "right", render: (l: StockLevel) => <span className="text-[13px]">{l.reorder_level == null ? "—" : formatQty(l.reorder_level, l.unit)}</span> },
          { key: "use", header: "Daily use", align: "right", render: (l: StockLevel) => <span className="text-[13px]">{l.avg_daily_use ? formatQty(l.avg_daily_use, l.unit) : "—"}</span> },
          { key: "cover", header: "Lasts", align: "right", render: (l: StockLevel) => <CoverBar days={l.days_of_cover} /> },
          { key: "next", header: "Next delivery usually", render: (l: StockLevel) => <span className="text-[13px]">{l.next_delivery_on ? formatShortDate(l.next_delivery_on) : "—"}</span> },
        ]}
        rows={shown}
        rowKey={(l) => l.item_id}
        onRowClick={(l) => onOpenItem(l.item_id)}
        minWidth="760px"
        empty={{ title: "Nothing is running low", body: "Items at or below their reorder level, or with under a week left at the usual use, are listed here." }}
      />
      {paged ? sorted.length > paging.size && <Pagination {...paging.props} />
        : sorted.length > 10 && <p className="text-[12px] text-ink-faint">Showing the 10 soonest to run out of {sorted.length}.</p>}
    </div>
  );
}

/** Days of cover as a number and a short bar against two weeks: words first, the bar only echoes them. */
export function CoverBar({ days }: { days: number | null }) {
  if (days == null) return <span className="text-ink-faint">—</span>;
  const d = Math.floor(days);
  const tone = d < 3 ? "#D9550C" : d < 7 ? "#2A78D6" : "#9DB5A6";
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-line-soft" aria-hidden>
        <span className="block h-full rounded-full" style={{ width: `${Math.min(100, (days / 14) * 100)}%`, background: tone }} />
      </span>
      <span className={`font-mono text-[12.5px] ${d < 3 ? "font-semibold text-warn-ink" : ""}`}>{d} day{d === 1 ? "" : "s"}</span>
    </span>
  );
}

/** Use per item in the period with its trend; grouped by store when showing them all; paged. */
export function UsageTable({ rows, byId, series, money, onOpenItem, groupByStore, pageSize = 10 }: {
  rows: UsageByItem[]; byId: Map<string, ItemIndexRow>; series: { buckets: string[]; byItem: Map<string, number[]> };
  money: (c: number | null | undefined) => string; onOpenItem: (itemId: string) => void; groupByStore?: boolean; pageSize?: number;
}) {
  const [storeFilter, setStoreFilter] = useState<StoreKey>("all");
  const storesHere = STORES.filter((st) => st.key !== "all" && rows.some((u) => storeOf(byId.get(u.item_id)?.category) === st.key));
  const filtered = groupByStore && storeFilter !== "all" ? rows.filter((u) => storeOf(byId.get(u.item_id)?.category) === storeFilter) : rows;
  const paging = usePaging(filtered.length, `${storeFilter}-${rows.length}`, pageSize);
  return (
    <div className="grid gap-2">
      {groupByStore && storesHere.length > 1 && (
        <div role="group" aria-label="Show store" className="flex flex-wrap gap-1.5">
          {[{ key: "all" as StoreKey, label: "All stores" }, ...storesHere].map((st) => (
            <button key={st.key} type="button" aria-pressed={storeFilter === st.key} onClick={() => setStoreFilter(st.key)}
              className={`rounded-full border px-2.5 py-1 text-[12px] ${storeFilter === st.key ? "border-[#17402A] bg-[#17402A] font-semibold text-white" : "border-line bg-white text-ink-muted hover:bg-page"}`}>
              {st.label}{st.key !== "all" ? ` · ${rows.filter((u) => storeOf(byId.get(u.item_id)?.category) === st.key).length}` : ""}
            </button>
          ))}
        </div>
      )}
      <DataTable
        columns={[
          { key: "item", header: "Item", width: "1.6fr", render: (u: UsageByItem) => { const i = byId.get(u.item_id); return <Cell sub={i ? `${STORES.find((s) => s.key === storeOf(i.category))?.label} · ${INVENTORY_CATEGORY_LABEL[i.category as InventoryCategory]}` : undefined}>{i?.name ?? "Item"}</Cell>; } },
          {
            key: "trend", header: "Trend", width: "1.1fr",
            render: (u: UsageByItem) => {
              const v = series.byItem.get(u.item_id) ?? [];
              const unit = byId.get(u.item_id)?.unit;
              return v.length > 1 ? <Sparkline values={v} label={`Use by ${series.buckets.length > 20 ? "day" : "period"}: ${v.map((x) => formatQty(Math.round(x * 10) / 10, unit)).join(", ")}`} /> : <span className="text-ink-faint">—</span>;
            },
          },
          { key: "used", header: "Used", align: "right", render: (u: UsageByItem) => <Mono>{formatQty(u.used, byId.get(u.item_id)?.unit)}</Mono> },
          { key: "lost", header: "Wasted / missing", align: "right", render: (u: UsageByItem) => u.wasted + u.shrinkage ? <Mono>{formatQty(u.wasted + u.shrinkage, byId.get(u.item_id)?.unit)}</Mono> : <span className="text-ink-faint">—</span> },
          { key: "cost", header: "Cost of use", align: "right", render: (u: UsageByItem) => <span className="text-[13px]">{money(u.used_cost_cents)}</span> },
          { key: "spend", header: "Deliveries", align: "right", render: (u: UsageByItem) => <span className="text-[13px]">{u.spend_cents ? money(u.spend_cents) : "—"}</span> },
        ]}
        rows={paging.slice(filtered)}
        rowKey={(u) => u.item_id}
        onRowClick={(u) => onOpenItem(u.item_id)}
        minWidth="760px"
        empty={{ title: "Nothing used in this period", body: "Record use from an item's page (Use) and it shows up here. Sick-bay medicine counts by itself." }}
      />
      {filtered.length > paging.size && <Pagination {...paging.props} />}
    </div>
  );
}
