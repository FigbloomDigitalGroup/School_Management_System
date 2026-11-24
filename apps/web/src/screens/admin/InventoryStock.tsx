import { useMemo, useState } from "react";
import {
  FLAG_KIND_LABEL, fetchConsumptionFlags, fetchCostPerMeal, fetchCurrentTermDates, fetchMovements, fetchSpendByMonth, fetchStockInsights,
  fetchStockLevels, fetchUsage, formatMoney, formatQty, formatShortDate, INVENTORY_CATEGORY_LABEL, monthsBack, MOVEMENT_KIND_LABEL,
  inStore, movementProblem, periodRange, PURPOSE_SUGGESTIONS, recordStockMovement, spendByMonthFor, stockOverview, stockStatus, stockTakeDelta,
  storeOf, STORES, summariseStores, todayIso, usageByItem,
  type ConsumptionFlag, type FlagSeverity, type InventoryCategory, type InventoryItemRow, type MovementKind, type MovementRow,
  type ReportPeriod, type StockInsights, type StockLevel, type StoreKey, type UsageByItem,
} from "@figbloom/shared";
import { BarList } from "../../components/analytics/BarList";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, Mono } from "../../components/ui/DataTable";
import { TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { StatRow } from "../../components/ui/StatCard";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";

/**
 * Stock in and out for consumables (the kitchen first): the badge a stock
 * line shows in the register, the Receive / Use / Stock-take forms, an item's
 * movement history, and the Stock & kitchen view (overview, flags worked out
 * in the database, an AI briefing on them, use, spend and cost per meal).
 */

const MOVE_TONE: Record<MovementKind, Tone> = { received: "ok", used: "info", wasted: "warn", adjusted: "muted" };
const SEVERITY_TONE: Record<FlagSeverity, Tone> = { high: "warn", medium: "warn", low: "muted" };

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

const PERIODS: { key: ReportPeriod; label: string }[] = [
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "term", label: "This term" },
  { key: "year", label: "This year" },
];

export function StockView({ items, onOpenItem }: { items: InventoryItemRow[]; onOpenItem: (i: InventoryItemRow) => void }) {
  const { tenant } = useTenantSession();
  const [period, setPeriod] = useState<ReportPeriod>("month");
  const [store, setStore] = useState<StoreKey>("all");
  const { data: term } = useAsync(() => fetchCurrentTermDates(tenant.id), [tenant.id]);
  const range = periodRange(period, new Date(), term);
  // the flags look at a window long enough for a baseline and a 4-week trend, even for "this week"
  const flagFrom = period === "week" ? todayIso(new Date(Date.now() - 27 * 86_400_000)) : range.from;

  const levels = useAsync(() => fetchStockLevels(tenant.id), [tenant.id]);
  const usage = useAsync(() => fetchUsage(tenant.id, range.from, range.to, "month"), [tenant.id, range.from, range.to]);
  const spend = useAsync(() => fetchSpendByMonth(tenant.id, monthsBack(5), todayIso()), [tenant.id]);
  const meals = useAsync(() => fetchCostPerMeal(tenant.id, range.from, range.to, "month"), [tenant.id, range.from, range.to]);
  const flags = useAsync(() => fetchConsumptionFlags(tenant.id, flagFrom, range.to), [tenant.id, flagFrom, range.to]);

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const inScope = (category: string | undefined) => inStore(category, store);
  const spendRows = useMemo(() => spendByMonthFor(spend.data ?? [], store), [spend.data, store]);
  const overview = levels.data && spend.data
    ? stockOverview(levels.data.filter((l) => inScope(l.category)), spendRows.map((r) => ({ ...r, category: store })))
    : null;
  const money = (c: number | null | undefined) => (c == null ? "—" : formatMoney(c, tenant.country));

  const usageRows = useMemo(() => usageByItem(usage.data ?? []).filter((u) => inScope(byId.get(u.item_id)?.category) && (u.used || u.wasted || u.shrinkage)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [usage.data, byId, store]);
  const stores = levels.data && usage.data && store === "all"
    ? summariseStores(levels.data, usageByItem(usage.data), (id) => byId.get(id)?.category)
    : null;
  const lowRows = (levels.data ?? []).filter((l) => inScope(l.category) && (l.low || l.quantity <= 0 || (l.consumable && l.days_of_cover != null && l.days_of_cover < 7)));
  const flagRows = (flags.data ?? []).filter((f) => inScope(byId.get(f.item_id)?.category));
  const mealRows = (meals.data ?? []).filter((m) => m.meals_served > 0);

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Period" className="flex rounded-md border border-[#D3DAD5] bg-white p-0.5">
          {PERIODS.map((p) => (
            <button key={p.key} type="button" aria-pressed={period === p.key} onClick={() => setPeriod(p.key)} className="rounded px-3 py-1.5 text-small"
              style={period === p.key ? { background: "#17402A", color: "#fff", fontWeight: 600 } : {}}>
              {p.label}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Store" className="flex flex-wrap rounded-md border border-[#D3DAD5] bg-white p-0.5">
          {STORES.map((st) => (
            <button key={st.key} type="button" aria-pressed={store === st.key} onClick={() => setStore(st.key)} className="rounded px-3 py-1.5 text-small"
              style={store === st.key ? { background: "#17402A", color: "#fff", fontWeight: 600 } : {}}>
              {st.label}
            </button>
          ))}
        </div>
        <span className="text-[12.5px] text-ink-faint">{formatShortDate(range.from)} to {formatShortDate(range.to)}</span>
      </div>

      <StatRow stats={[
        { label: "Stock value", value: overview ? money(overview.valueCents) : "", sub: "on hand, at the latest prices", loading: !overview },
        {
          label: "Spent this month", value: overview ? money(overview.spendThisMonthCents) : "", loading: !overview,
          sub: overview ? (overview.spendChangePct == null ? "on deliveries" : `${overview.spendChangePct >= 0 ? "+" : ""}${overview.spendChangePct}% on last month (${money(overview.spendLastMonthCents)})`) : undefined,
        },
        { label: "Low stock", value: overview ? String(overview.lowCount) : "", sub: "at or below reorder level", alarming: (overview?.lowCount ?? 0) > 0, loading: !overview },
        { label: "Under a week left", value: overview ? String(overview.shortCoverCount) : "", sub: "at the usual daily use", alarming: (overview?.shortCoverCount ?? 0) > 0, loading: !overview },
      ]} />

      {stores && stores.length > 1 && (
        <section className="grid gap-2">
          <h2 className="text-body font-semibold">By store</h2>
          <DataTable
            columns={[
              { key: "store", header: "Store", width: "1.4fr", render: (x) => <button type="button" className="text-left text-[13px] font-medium underline-offset-2 hover:underline" onClick={() => setStore(x.store)}>{x.label}</button> },
              { key: "items", header: "Stock lines", align: "right", render: (x) => <Mono>{x.items}</Mono> },
              { key: "value", header: "Stock value", align: "right", render: (x) => <span className="text-[13px]">{money(x.valueCents)}</span> },
              { key: "used", header: `Used ${PERIODS.find((p) => p.key === period)!.label.toLowerCase()}`, align: "right", render: (x) => <span className="text-[13px]">{money(x.usedCostCents)}</span> },
              { key: "low", header: "Low", align: "right", render: (x) => x.low ? <Badge tone="warn">{x.low} low</Badge> : <span className="text-ink-faint">—</span> },
            ]}
            rows={stores}
            rowKey={(x) => x.store}
            minWidth="560px"
            empty={{ title: "No stock lines yet", body: "Add consumables to the register to see them here." }}
          />
        </section>
      )}

      <FlagsPanel flags={flagRows} loading={flags.loading && !flags.data} error={flags.error} />
      <InsightsPanel from={flagFrom} to={range.to} />

      <section className="grid gap-2">
        <h2 className="text-body font-semibold">Used {PERIODS.find((p) => p.key === period)!.label.toLowerCase()}</h2>
        {usage.error ? <p className="text-[12.5px] text-warn-ink">Could not load use: {usage.error.message}</p> : usage.loading && !usage.data ? <TableSkeleton rows={6} /> : (
          // grouped by store when showing them all
          store === "all" && usageRows.length > 0
            ? STORES.filter((st) => st.key !== "all" && usageRows.some((u) => storeOf(byId.get(u.item_id)?.category) === st.key)).map((st) => (
              <div key={st.key} className="grid gap-1.5">
                <h3 className="text-[12.5px] font-semibold uppercase tracking-wide text-ink-muted">{st.label}</h3>
                <UsageTable rows={usageRows.filter((u) => storeOf(byId.get(u.item_id)?.category) === st.key)} byId={byId} money={money} onOpenItem={onOpenItem} />
              </div>
            ))
            : <UsageTable rows={usageRows} byId={byId} money={money} onOpenItem={onOpenItem} />
        )}
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        {spendRows.length > 0 ? (
          <BarList
            title="Spend on deliveries, by month"
            summary={`${store === "all" ? "All stores" : STORES.find((st) => st.key === store)!.label}, the last six months.`}
            valueHeader="KES"
            bars={spendRows.map((s) => ({
              key: s.month, label: new Date(`${s.month}T00:00:00`).toLocaleDateString("en-GB", { month: "short", year: "numeric" }),
              value: Math.round(s.spend_cents / 100), detail: `${s.deliveries} deliveries`,
            }))}
            max={Math.max(1, ...spendRows.map((s) => Math.round(s.spend_cents / 100)))}
          />
        ) : (
          <section className="rounded-lg border border-line bg-white px-4 py-3 text-[13px] text-ink-muted">No priced deliveries in the last six months yet.</section>
        )}
        {(store === "all" || store === "kitchen") && <section className="grid content-start gap-2">
          <h2 className="text-body font-semibold">Cost per meal</h2>
          <DataTable
            columns={[
              { key: "month", header: "Month", render: (m) => <span className="text-[13px]">{new Date(`${m.period_start.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}</span> },
              { key: "purpose", header: "Meal", render: (m) => <span className="text-[13px]">{m.purpose}</span> },
              { key: "meals", header: "Meals", align: "right", render: (m) => <Mono>{m.meals_served.toLocaleString()}</Mono> },
              { key: "cpm", header: "Per meal", align: "right", render: (m) => <span className="text-[13px] font-semibold">{money(m.cost_per_meal_cents == null ? null : Math.round(m.cost_per_meal_cents))}</span> },
            ]}
            rows={mealRows}
            rowKey={(m) => `${m.period_start}-${m.purpose}`}
            minWidth="420px"
            empty={{ title: "No meal counts yet", body: "Enter meals served when recording the kitchen's use to see the cost of a meal." }}
          />
        </section>}
      </div>

      <section className="grid gap-2">
        <h2 className="text-body font-semibold">Low stock and days of cover</h2>
        <DataTable
          columns={[
            { key: "item", header: "Item", width: "1.6fr", render: (l: StockLevel) => <Cell sub={INVENTORY_CATEGORY_LABEL[l.category as InventoryCategory]}>{l.name}</Cell> },
            { key: "on", header: "In stock", render: (l: StockLevel) => <StockLevelCell item={{ ...l, available: l.quantity }} /> },
            { key: "reorder", header: "Reorder at", align: "right", render: (l: StockLevel) => <span className="text-[13px]">{l.reorder_level == null ? "—" : formatQty(l.reorder_level, l.unit)}</span> },
            { key: "use", header: "Daily use", align: "right", render: (l: StockLevel) => <span className="text-[13px]">{l.avg_daily_use ? formatQty(l.avg_daily_use, l.unit) : "—"}</span> },
            { key: "cover", header: "Lasts", align: "right", render: (l: StockLevel) => l.days_of_cover == null ? <span className="text-ink-faint">—</span> : <Badge tone={l.days_of_cover < 3 ? "warn" : l.days_of_cover < 7 ? "info" : "muted"}>{Math.floor(l.days_of_cover)} days</Badge> },
            { key: "next", header: "Next delivery usually", render: (l: StockLevel) => <span className="text-[13px]">{l.next_delivery_on ? formatShortDate(l.next_delivery_on) : "—"}</span> },
          ]}
          rows={lowRows}
          rowKey={(l) => l.item_id}
          onRowClick={(l) => { const i = byId.get(l.item_id); if (i) onOpenItem(i); }}
          minWidth="720px"
          empty={{ title: "Nothing is running low", body: "Items at or below their reorder level, or with under a week left at the usual use, are listed here." }}
        />
      </section>
    </div>
  );
}

/** Use per item in the period: one store's items. */
function UsageTable({ rows, byId, money, onOpenItem }: {
  rows: UsageByItem[]; byId: Map<string, InventoryItemRow>; money: (c: number | null | undefined) => string; onOpenItem: (i: InventoryItemRow) => void;
}) {
  return (
    <DataTable
      columns={[
        { key: "item", header: "Item", width: "1.6fr", render: (u) => { const i = byId.get(u.item_id); return <Cell sub={i ? INVENTORY_CATEGORY_LABEL[i.category as InventoryCategory] : undefined}>{i?.name ?? "Item"}</Cell>; } },
        { key: "used", header: "Used", align: "right", render: (u) => <Mono>{formatQty(u.used, byId.get(u.item_id)?.unit)}</Mono> },
        { key: "lost", header: "Wasted / missing", align: "right", render: (u) => u.wasted + u.shrinkage ? <Mono>{formatQty(u.wasted + u.shrinkage, byId.get(u.item_id)?.unit)}</Mono> : <span className="text-ink-faint">—</span> },
        { key: "cost", header: "Cost of use", align: "right", render: (u) => <span className="text-[13px]">{money(u.used_cost_cents)}</span> },
        { key: "spend", header: "Deliveries", align: "right", render: (u) => <span className="text-[13px]">{u.spend_cents ? money(u.spend_cents) : "—"}</span> },
      ]}
      rows={rows}
      rowKey={(u) => u.item_id}
      onRowClick={(u) => { const i = byId.get(u.item_id); if (i) onOpenItem(i); }}
      minWidth="640px"
      empty={{ title: "Nothing used in this period", body: "Record use from an item's page (Use) and it shows up here. Sick-bay medicine counts by itself." }}
    />
  );
}

/** The database's flags: alarms first, then rises that headcount explains. Always shown, AI or not. */
function FlagsPanel({ flags, loading, error }: { flags: ConsumptionFlag[]; loading: boolean; error: Error | null }) {
  const [showExplained, setShowExplained] = useState(false);
  const alarms = flags.filter((f) => !f.explained);
  const explained = flags.filter((f) => f.explained);
  return (
    <section className="rounded-lg border border-line bg-white">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-body font-semibold">Worth a look</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">Each item's use against its own usual: kitchen food day by day per head (meals served, or learners, staff and visitors), other stores week by week (lab per practical, clinic per sick-bay visit, the rest per head); and stock-takes, delivery prices and days of stock left.</p>
        </div>
        {explained.length > 0 && (
          <Button onClick={() => setShowExplained((v) => !v)}>{showExplained ? "Hide" : "Show"} {explained.length} explained</Button>
        )}
      </header>
      <div className="px-4 py-3">
        {error ? <p className="text-[12.5px] text-warn-ink">Could not work out the flags: {error.message}</p>
          : loading ? <TableSkeleton rows={3} />
          : alarms.length === 0 && !showExplained ? <p className="text-[13px] text-ink-muted">Nothing unusual in this period.{explained.length ? " Some rises were matched by more people eating (see explained)." : ""}</p>
          : (
            <ul className="grid gap-2">
              {[...alarms, ...(showExplained ? explained : [])].map((f, i) => (
                <li key={`${f.kind}-${f.item_id}-${f.occurred_on}-${f.purpose ?? ""}-${i}`} className="flex flex-wrap items-start gap-2 text-[13px]">
                  <Badge tone={f.explained ? "ok" : SEVERITY_TONE[f.severity]}>{f.explained ? "Explained" : FLAG_KIND_LABEL[f.kind]}</Badge>
                  <span className="min-w-0 flex-1">{f.reason}</span>
                </li>
              ))}
            </ul>
          )}
      </div>
    </section>
  );
}

/** Bloom's briefing on the flags, on request. If AI is off or fails it says so; the flags above don't depend on it. */
function InsightsPanel({ from, to }: { from: string; to: string }) {
  const [state, setState] = useState<{ insights?: StockInsights; at?: Date; error?: string; busy?: boolean }>({});
  async function refresh() {
    setState((s) => ({ ...s, busy: true, error: undefined }));
    try {
      const insights = await fetchStockInsights(from, to);
      setState({ insights, at: new Date() });
    } catch (err) {
      setState((s) => ({ ...s, busy: false, error: err instanceof Error ? err.message : "Bloom didn't answer." }));
    }
  }
  const i = state.insights;
  const list = (title: string, items: string[] | undefined) => items && items.length > 0 && (
    <div>
      <h3 className="text-[12.5px] font-semibold uppercase tracking-wide text-ink-muted">{title}</h3>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-[13px]">{items.map((t, k) => <li key={k}>{t}</li>)}</ul>
    </div>
  );
  return (
    <section className="rounded-lg border border-line bg-white">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-body font-semibold">AI insights</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {state.at ? `Generated ${state.at.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}. ` : ""}
            Bloom reads the flags and stock levels (no one's name) and suggests what to ask. It can get things wrong.
          </p>
        </div>
        <Button variant="accent" onClick={() => void refresh()} disabled={state.busy}>{state.busy ? "Thinking…" : i ? "Refresh" : "Get insights"}</Button>
      </header>
      <div className="grid gap-3 px-4 py-3">
        {state.error ? <p className="text-[12.5px] text-warn-ink">AI insights aren't available: {state.error.replace(/\.?$/, ".")} The flags above are worked out without AI.</p>
          : !i ? <p className="text-[13px] text-ink-muted">Ask Bloom for a short briefing for the head teacher or bursar.</p>
          : (
            <>
              <p className="text-[14px] font-medium">{i.headline}</p>
              {list("What stands out", i.standsOut)}
              {list("Questions to ask", i.questions)}
              {list("Looks fine", i.looksFine)}
              {list("Suggestions", i.suggestions)}
            </>
          )}
      </div>
    </section>
  );
}
