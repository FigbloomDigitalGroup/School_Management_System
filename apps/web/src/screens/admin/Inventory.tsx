import { useMemo, useState } from "react";
import {
  chargeLearner, fetchIssueCharges, suggestedCharge, voidFeeCharge, type FeeCharge,
  closeInventoryIssue, daysOverdue, endOfSchoolYear, fetchInventory, fetchInventoryIssues, fetchInventoryPeople, formatMoney,
  formatShortDate, INVENTORY_CATEGORY_LABEL, isOverdue, ISSUE_STATUS_LABEL, issueInventoryItem, issueInventoryToClass,
  issueMatches, issuesCsv, ITEM_CONDITION_LABEL, registerCsv, saveInventoryItem, setItemRetired, sortIssues, summariseInventory,
  type InventoryCategory, type InventoryIssueRow, type InventoryItemInput, type InventoryItemRow, type InventoryPeople,
  type IssueStatus, type ItemCondition,
} from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, Mono } from "../../components/ui/DataTable";
import { SelectField, TextArea, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { StatRow } from "../../components/ui/StatCard";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";

type Tab = "register" | "out" | "overdue" | "history";
const TABS: { key: Tab; label: string }[] = [
  { key: "register", label: "Register" },
  { key: "out", label: "Out now" },
  { key: "overdue", label: "Overdue" },
  { key: "history", label: "History" },
];

const CONDITION_TONE: Record<ItemCondition, Tone> = { new: "ok", good: "ok", fair: "muted", poor: "warn", broken: "warn" };
const STATUS_TONE: Record<IssueStatus, Tone> = { out: "info", returned: "ok", damaged: "warn", lost: "warn" };

const CATEGORY_OPTIONS = (Object.keys(INVENTORY_CATEGORY_LABEL) as InventoryCategory[]).map((c) => ({ value: c, label: INVENTORY_CATEGORY_LABEL[c] }));
const CONDITION_OPTIONS = (Object.keys(ITEM_CONDITION_LABEL) as ItemCondition[]).map((c) => ({ value: c, label: ITEM_CONDITION_LABEL[c] }));

function downloadCsv(text: string, filename: string): void {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const issuedOn = (iso: string) => formatShortDate(iso.slice(0, 10));

/**
 * The school's inventory: the register of what it owns, and who has what.
 * Things go out to a learner or a member of staff (or, for textbooks, one
 * copy to everyone in a class) and come back returned, damaged, or lost;
 * nothing is deleted, so every item and every person keeps a full history.
 */
export function AdminInventory() {
  const toast = useToast();
  const { tenant } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);
  const { data: items, loading: itemsLoading, error: itemsError } = useAsync(() => fetchInventory(tenant.id), [tenant.id, reloadKey]);
  const { data: issues, loading: issuesLoading, error: issuesError } = useAsync(() => fetchInventoryIssues(tenant.id), [tenant.id, reloadKey]);
  const { data: people } = useAsync(() => fetchInventoryPeople(tenant.id), [tenant.id]);
  const { data: charges } = useAsync(() => fetchIssueCharges(tenant.id), [tenant.id, reloadKey]);
  const [charging, setCharging] = useState<InventoryIssueRow | null>(null);

  const [tab, setTab] = useState<Tab>("register");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<InventoryItemRow | "new" | null>(null);
  const [issuing, setIssuing] = useState<InventoryItemRow | null>(null);
  const [returning, setReturning] = useState<InventoryIssueRow | null>(null);
  const [viewing, setViewing] = useState<InventoryItemRow | null>(null);

  const summary = items && issues ? summariseInventory(items, issues) : null;
  const q = query.trim().toLowerCase();

  const registerRows = useMemo(() => (items ?? []).filter((i) =>
    !q || [i.name, i.asset_tag, i.location, INVENTORY_CATEGORY_LABEL[i.category]].some((s) => s?.toLowerCase().includes(q)),
  ), [items, q]);

  const issueRows = useMemo(() => {
    const all = sortIssues(issues ?? []);
    const byTab = tab === "out" ? all.filter((i) => i.status === "out")
      : tab === "overdue" ? all.filter((i) => isOverdue(i))
      : all;
    return byTab.filter((i) => issueMatches(i, query));
  }, [issues, tab, query]);

  const loading = (itemsLoading && !items) || (issuesLoading && !issues);
  const error = itemsError ?? issuesError;

  function exportCsv() {
    if (tab === "register") downloadCsv(registerCsv(registerRows), "inventory-register.csv");
    else downloadCsv(issuesCsv(issueRows), `inventory-${tab}.csv`);
  }

  /** A person's whole history: every issue to them, out and closed. */
  function showHolder(r: InventoryIssueRow) {
    setTab("history");
    setQuery(r.holderName);
  }

  const money = (cents: number | null) => (cents == null ? "—" : formatMoney(cents, tenant.country));

  return (
    <>
      <PageHead
        eyebrow="School"
        title="Inventory"
        blurb="What the school owns and who has it. Issue textbooks, equipment and uniforms to learners or staff and track what comes back."
        actions={
          <div className="flex gap-2">
            <Button onClick={exportCsv} disabled={loading}>Export CSV</Button>
            <Button variant="accent" onClick={() => setEditing("new")}>Add item</Button>
          </div>
        }
      />

      <div className="grid gap-5 px-7 py-6">
        <StatRow stats={[
          { label: "Items", value: summary ? summary.items.toLocaleString() : "", sub: summary ? `${summary.copiesOwned.toLocaleString()} copies in all` : undefined, loading: !summary },
          { label: "Out now", value: summary ? summary.out.toLocaleString() : "", sub: "copies with people", loading: !summary },
          { label: "Overdue", value: summary ? summary.overdue.toLocaleString() : "", sub: "past their return date", alarming: (summary?.overdue ?? 0) > 0, loading: !summary },
          { label: "Lost", value: summary ? summary.lost.toLocaleString() : "", sub: "copies, all time", loading: !summary },
        ]} />

        <div className="flex flex-wrap items-center gap-3">
          <div role="group" aria-label="Show" className="flex rounded-md border border-[#D3DAD5] bg-white p-0.5">
            {TABS.map((t) => (
              <button key={t.key} type="button" aria-pressed={tab === t.key} onClick={() => setTab(t.key)} className="rounded px-3 py-1.5 text-small"
                style={tab === t.key ? { background: "#17402A", color: "#fff", fontWeight: 600 } : {}}>
                {t.label}{t.key === "overdue" && summary?.overdue ? ` · ${summary.overdue}` : ""}
              </button>
            ))}
          </div>
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={tab === "register" ? "Item, tag or location" : "Item, tag, name or admission number"}
            aria-label="Search inventory"
            className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small outline-none" />
          {query && <Button onClick={() => setQuery("")}>Clear</Button>}
        </div>

        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load the inventory: {error.message}
          </p>
        ) : loading ? (
          <TableSkeleton rows={8} />
        ) : tab === "register" ? (
          <DataTable
            columns={[
              {
                key: "name", header: "Item", width: "1.8fr",
                render: (i: InventoryItemRow) => (
                  <Cell sub={[i.asset_tag, i.location].filter(Boolean).join(" · ") || undefined}>
                    <span className={i.retired_at ? "text-ink-faint line-through" : ""}>{i.name}</span>
                  </Cell>
                ),
              },
              { key: "category", header: "Category", render: (i: InventoryItemRow) => <span className="text-[13px]">{INVENTORY_CATEGORY_LABEL[i.category]}</span> },
              {
                key: "stock", header: "On the shelf",
                render: (i: InventoryItemRow) => i.retired_at ? <Badge>Written off</Badge>
                  : i.tracking === "asset" ? <Badge tone={i.out ? "info" : "ok"}>{i.out ? "Out" : "In store"}</Badge>
                  : <span className="text-[13px]"><Mono>{i.available}</Mono> of {i.quantity}</span>,
              },
              { key: "condition", header: "Condition", render: (i: InventoryItemRow) => <Badge tone={CONDITION_TONE[i.condition]}>{ITEM_CONDITION_LABEL[i.condition]}</Badge> },
              { key: "cost", header: "Unit cost", align: "right", render: (i: InventoryItemRow) => <span className="text-[13px]">{money(i.unit_cost_cents)}</span> },
              {
                key: "actions", header: "", align: "right", width: "1.3fr",
                render: (i: InventoryItemRow) => (
                  <div className="flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                    <Button onClick={() => setEditing(i)}>Edit</Button>
                    <Button variant="accent" disabled={!!i.retired_at || i.available === 0} onClick={() => setIssuing(i)}>Issue</Button>
                  </div>
                ),
              },
            ]}
            rows={registerRows}
            rowKey={(i) => i.id}
            onRowClick={(i) => setViewing(i)}
            minWidth="880px"
            empty={q
              ? { title: "Nothing matches", body: "Try a different name, tag or location." }
              : { title: "The register is empty", body: "Add the school's textbooks, equipment and furniture to start tracking who has what.", action: <Button variant="accent" onClick={() => setEditing("new")}>Add item</Button> }}
          />
        ) : (
          <IssueTable
            rows={issueRows}
            onReturn={setReturning}
            onHolder={showHolder}
            charges={charges ?? null}
            onCharge={setCharging}
            country={tenant.country}
            empty={
              q ? { title: "Nothing matches", body: "Try a different item, name or admission number." }
              : tab === "overdue" ? { title: "Nothing overdue", body: "Everything that's out is still within its return date." }
              : tab === "out" ? { title: "Nothing is out", body: "Issue an item from the register and it shows up here." }
              : { title: "No history yet", body: "Every hand-out and return is kept here." }
            }
          />
        )}
      </div>

      {editing && (
        <ItemModal
          item={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => { setEditing(null); toast(msg); reload(); }}
        />
      )}
      {issuing && (
        <IssueModal
          item={issuing}
          people={people ?? null}
          onClose={() => setIssuing(null)}
          onIssued={(msg) => { setIssuing(null); toast(msg); reload(); }}
        />
      )}
      {returning && (
        <ReturnModal
          issue={returning}
          onClose={() => setReturning(null)}
          onDone={(msg) => { setReturning(null); toast(msg); reload(); }}
        />
      )}
      {charging && (
        <ChargeModal
          issue={charging}
          unitCostCents={(items ?? []).find((i) => i.id === charging.item_id)?.unit_cost_cents ?? null}
          existing={charges?.get(charging.id) ?? null}
          country={tenant.country}
          onClose={() => setCharging(null)}
          onDone={(msg) => { setCharging(null); toast(msg); reload(); }}
        />
      )}
      {viewing && (
        <ItemHistoryModal
          item={viewing}
          issues={sortIssues((issues ?? []).filter((i) => i.item_id === viewing.id))}
          onClose={() => setViewing(null)}
          onIssue={() => { setIssuing(viewing); setViewing(null); }}
          onReturn={(r) => { setReturning(r); setViewing(null); }}
          onRetire={async (retired) => {
            try {
              await setItemRetired(viewing.id, retired);
              toast(retired ? `${viewing.name} written off.` : `${viewing.name} is back on the register.`);
              setViewing(null);
              reload();
            } catch (err) {
              toast(err instanceof Error ? `Could not save that: ${err.message}` : "Could not save that.", "error");
            }
          }}
        />
      )}
    </>
  );
}

function IssueTable({ rows, onReturn, onHolder, charges, onCharge, country, empty, compact }: {
  rows: InventoryIssueRow[];
  onReturn?: (r: InventoryIssueRow) => void;
  onHolder?: (r: InventoryIssueRow) => void;
  /** Standing charges by issue; with onCharge, a learner's lost or damaged item offers "Charge to fees". */
  charges?: Map<string, FeeCharge> | null;
  onCharge?: (r: InventoryIssueRow) => void;
  country?: string;
  empty: { title: string; body: string };
  compact?: boolean;
}) {
  const chargeable = (r: InventoryIssueRow) => !!onCharge && r.holderKind === "learner" && (r.status === "lost" || r.status === "damaged");
  function action(r: InventoryIssueRow) {
    if (r.status === "out") return onReturn ? <Button onClick={(e) => { e.stopPropagation(); onReturn(r); }}>Return</Button> : null;
    if (!chargeable(r)) return null;
    const charge = charges?.get(r.id);
    return charge ? (
      <button type="button" className="text-[12.5px] text-ink-muted underline-offset-2 hover:underline"
        onClick={(e) => { e.stopPropagation(); onCharge!(r); }} title="See or cancel the charge">
        Charged {formatMoney(charge.amountCents, country ?? "KE")}
      </button>
    ) : (
      <Button onClick={(e) => { e.stopPropagation(); onCharge!(r); }}>Charge to fees</Button>
    );
  }
  return (
    <DataTable
      columns={[
        ...(compact ? [] : [{ key: "item", header: "Item", width: "1.5fr", render: (r: InventoryIssueRow) => <Cell sub={r.assetTag ?? undefined}>{r.itemName}{r.quantity > 1 ? ` × ${r.quantity}` : ""}</Cell> }]),
        {
          key: "holder", header: "With", width: "1.5fr",
          render: (r: InventoryIssueRow) => (
            <Cell sub={`${r.holderKind === "learner" ? "Learner" : "Staff"}${r.holderDetail ? ` · ${r.holderDetail}` : ""}`}>
              {onHolder ? (
                <button type="button" className="text-left underline-offset-2 hover:underline" onClick={(e) => { e.stopPropagation(); onHolder(r); }}
                  title={`Everything issued to ${r.holderName}`}>
                  {r.holderName}
                </button>
              ) : r.holderName}
              {compact && r.quantity > 1 ? ` × ${r.quantity}` : ""}
            </Cell>
          ),
        },
        { key: "issued", header: "Issued", render: (r: InventoryIssueRow) => <span className="text-[13px]">{issuedOn(r.issued_at)}</span> },
        {
          key: "due", header: "Due back",
          render: (r: InventoryIssueRow) => {
            if (r.status !== "out") return <span className="text-[13px] text-ink-faint">{r.closed_at ? `Closed ${issuedOn(r.closed_at)}` : "—"}</span>;
            const late = daysOverdue(r);
            return late > 0
              ? <Badge tone="warn">{late} day{late === 1 ? "" : "s"} overdue</Badge>
              : <span className="text-[13px]">{r.due_on ? formatShortDate(r.due_on) : "No date"}</span>;
          },
        },
        {
          key: "status", header: "Status",
          render: (r: InventoryIssueRow) => (
            <Badge tone={STATUS_TONE[r.status]}>
              {ISSUE_STATUS_LABEL[r.status]}{r.returned_condition && r.status !== "lost" ? ` · ${ITEM_CONDITION_LABEL[r.returned_condition].toLowerCase()}` : ""}
            </Badge>
          ),
        },
        ...(onReturn || onCharge ? [{
          key: "actions", header: "", align: "right" as const,
          render: action,
        }] : []),
      ]}
      rows={rows}
      rowKey={(r) => r.id}
      minWidth={compact ? "560px" : "880px"}
      empty={empty}
    />
  );
}

// ---------------------------------------------------------------- add / edit

function ItemModal({ item, onClose, onSaved }: { item: InventoryItemRow | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const { tenant } = useTenantSession();
  const [form, setForm] = useState({
    name: item?.name ?? "",
    category: item?.category ?? ("textbooks" as InventoryCategory),
    tracking: item?.tracking ?? ("stock" as InventoryItemRow["tracking"]),
    quantity: String(item?.quantity ?? 1),
    asset_tag: item?.asset_tag ?? "",
    condition: item?.condition ?? ("new" as ItemCondition),
    location: item?.location ?? "",
    purchased_on: item?.purchased_on ?? "",
    unit_cost: item?.unit_cost_cents != null ? String(item.unit_cost_cents / 100) : "",
    notes: item?.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const qty = Number(form.quantity);
  const cost = form.unit_cost.trim() === "" ? null : Number(form.unit_cost);
  const qtyBad = form.tracking === "stock" && (!Number.isInteger(qty) || qty < 0);
  const costBad = cost != null && (!Number.isFinite(cost) || cost < 0);
  const minQty = item?.out ?? 0;

  async function save() {
    if (!form.name.trim() || qtyBad || costBad) return;
    if (form.tracking === "stock" && qty < minQty) {
      setError(`${minQty} copies are out with people, so the school owns at least ${minQty}.`);
      return;
    }
    setSaving(true);
    setError(null);
    const input: InventoryItemInput = {
      name: form.name.trim(),
      category: form.category,
      tracking: form.tracking,
      quantity: form.tracking === "asset" ? 1 : qty,
      asset_tag: form.asset_tag.trim() || null,
      condition: form.condition,
      location: form.location.trim() || null,
      purchased_on: form.purchased_on || null,
      unit_cost_cents: cost == null ? null : Math.round(cost * 100),
      notes: form.notes.trim() || null,
    };
    try {
      await saveInventoryItem(tenant.id, input, item?.id);
      onSaved(item ? `${input.name} saved.` : `${input.name} added to the register.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that.");
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Inventory"
      title={item ? `Edit ${item.name}` : "Add an item"}
      blurb="One thing with its own tag (a projector, a microscope), or a stock of identical copies (a class set of textbooks, hockey sticks)."
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={() => void save()} disabled={saving || !form.name.trim() || qtyBad || costBad}>
            {saving ? "Saving…" : item ? "Save" : "Add item"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3.5">
        <TextField id="inv-name" label="Name" placeholder="e.g. KLB Biology Form 2" value={form.name} onChange={(e) => set("name", e.target.value)} />
        <div className="grid gap-3.5 sm:grid-cols-2">
          <SelectField id="inv-category" label="Category" value={form.category} onChange={(e) => set("category", e.target.value as InventoryCategory)} options={CATEGORY_OPTIONS} />
          <SelectField
            id="inv-tracking" label="Tracked as" value={form.tracking}
            // an asset with copies out can't become stock and back mid-loan; keep it simple
            disabled={!!item?.out}
            onChange={(e) => set("tracking", e.target.value as InventoryItemRow["tracking"])}
            options={[{ value: "stock", label: "Stock (many identical copies)" }, { value: "asset", label: "One item with its own tag" }]}
          />
        </div>
        <div className="grid gap-3.5 sm:grid-cols-2">
          {form.tracking === "stock" ? (
            <TextField id="inv-qty" label="Copies owned" type="number" min={minQty} value={form.quantity} onChange={(e) => set("quantity", e.target.value)}
              error={qtyBad ? "A whole number, 0 or more." : undefined} hint={minQty ? `${minQty} out with people now.` : undefined} />
          ) : (
            <TextField id="inv-tag" label="Asset tag or serial" mono placeholder="e.g. PRJ-007" value={form.asset_tag} onChange={(e) => set("asset_tag", e.target.value)} />
          )}
          <SelectField id="inv-condition" label="Condition" value={form.condition} onChange={(e) => set("condition", e.target.value as ItemCondition)} options={CONDITION_OPTIONS} />
        </div>
        {form.tracking === "stock" && (
          <TextField id="inv-tag-stock" label="Tag or code (optional)" mono placeholder="e.g. BIO-F2" value={form.asset_tag} onChange={(e) => set("asset_tag", e.target.value)} />
        )}
        <div className="grid gap-3.5 sm:grid-cols-2">
          <TextField id="inv-location" label="Kept in (optional)" placeholder="e.g. Library store" value={form.location} onChange={(e) => set("location", e.target.value)} />
          <TextField id="inv-purchased" label="Bought on (optional)" type="date" value={form.purchased_on} onChange={(e) => set("purchased_on", e.target.value)} />
        </div>
        <TextField id="inv-cost" label={form.tracking === "stock" ? "Cost per copy (optional)" : "Cost (optional)"} type="number" min={0} step="0.01"
          value={form.unit_cost} onChange={(e) => set("unit_cost", e.target.value)} error={costBad ? "Enter an amount, or leave it blank." : undefined} />
        <TextArea id="inv-notes" label="Notes (optional)" value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        {error && <p role="alert" className="text-[12.5px] text-warn-ink">{error}</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- issue

type HolderKind = "learner" | "staff" | "class";

function IssueModal({ item, people, onClose, onIssued }: {
  item: InventoryItemRow; people: InventoryPeople | null; onClose: () => void; onIssued: (msg: string) => void;
}) {
  const { tenant } = useTenantSession();
  const [kind, setKind] = useState<HolderKind>("learner");
  const [search, setSearch] = useState("");
  const [holderId, setHolderId] = useState("");
  const [classId, setClassId] = useState("");
  const [quantity, setQuantity] = useState("1");
  // textbooks come back at the end of the year; everything else is the office's call
  const [dueOn, setDueOn] = useState(item.category === "textbooks" ? endOfSchoolYear() : "");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const s = search.trim().toLowerCase();
  const options = useMemo(() => {
    if (!people) return [];
    const list = kind === "learner"
      ? people.learners.map((l) => ({ id: l.id, label: `${l.full_name} · ADM ${l.admission_no}`, hay: `${l.full_name} ${l.admission_no}` }))
      : people.staff.map((p) => ({ id: p.id, label: `${p.full_name}${p.staff_title ? ` · ${p.staff_title}` : ""}`, hay: `${p.full_name} ${p.staff_title ?? ""}` }));
    return list.filter((o) => !s || o.hay.toLowerCase().includes(s)).slice(0, 200);
  }, [people, kind, s]);

  const qty = item.tracking === "asset" ? 1 : Number(quantity);
  const qtyBad = !Number.isInteger(qty) || qty < 1 || qty > item.available;
  const chosen = kind === "class" ? !!classId : !!holderId;

  async function issue() {
    if (!chosen || (kind !== "class" && qtyBad)) return;
    setSaving(true);
    setError(null);
    try {
      if (kind === "class") {
        const n = await issueInventoryToClass(item.id, classId, dueOn || null);
        const cls = people?.classes.find((c) => c.id === classId)?.name ?? "the class";
        onIssued(n === 0 ? `Everyone in ${cls} already has ${item.name}.` : `${item.name} issued to ${n} learner${n === 1 ? "" : "s"} in ${cls}.`);
      } else {
        await issueInventoryItem({
          tenantId: tenant.id, itemId: item.id, quantity: qty, dueOn: dueOn || null, note,
          holder: kind === "learner" ? { kind: "learner", studentId: holderId } : { kind: "staff", profileId: holderId },
        });
        const who = options.find((o) => o.id === holderId)?.label.split(" · ")[0] ?? "them";
        onIssued(`${item.name}${qty > 1 ? ` × ${qty}` : ""} issued to ${who}.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not issue that.");
      setSaving(false);
    }
  }

  const kinds: { key: HolderKind; label: string }[] = [
    { key: "learner", label: "A learner" },
    { key: "staff", label: "Staff" },
    ...(item.tracking === "stock" ? [{ key: "class" as const, label: "A whole class" }] : []),
  ];

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={item.tracking === "stock" ? `${item.available} of ${item.quantity} on the shelf` : item.asset_tag ?? "Inventory"}
      title={`Issue ${item.name}`}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={() => void issue()} disabled={saving || !chosen || (kind !== "class" && qtyBad)}>
            {saving ? "Issuing…" : "Issue"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3.5">
        <div role="group" aria-label="Issue to" className="flex w-fit rounded-md border border-[#D3DAD5] bg-white p-0.5">
          {kinds.map((k) => (
            <button key={k.key} type="button" aria-pressed={kind === k.key} className="rounded px-3 py-1.5 text-small"
              onClick={() => { setKind(k.key); setHolderId(""); setSearch(""); }}
              style={kind === k.key ? { background: "#17402A", color: "#fff", fontWeight: 600 } : {}}>
              {k.label}
            </button>
          ))}
        </div>

        {kind === "class" ? (
          <SelectField id="issue-class" label="Class" value={classId} onChange={(e) => setClassId(e.target.value)}
            hint="One copy to every learner in the class who doesn't already have one. If there aren't enough copies, nobody is issued one."
            options={[{ value: "", label: people ? "Choose a class" : "Loading…" }, ...(people?.classes ?? []).map((c) => ({ value: c.id, label: c.name }))]} />
        ) : (
          <>
            <TextField id="issue-search" label={kind === "learner" ? "Find the learner" : "Find the staff member"}
              placeholder={kind === "learner" ? "Name or admission number" : "Name or title"}
              value={search} onChange={(e) => setSearch(e.target.value)} />
            <SelectField id="issue-holder" label={kind === "learner" ? "Learner" : "Staff member"} value={holderId} onChange={(e) => setHolderId(e.target.value)}
              options={[{ value: "", label: !people ? "Loading…" : options.length ? `Choose (${options.length}${options.length === 200 ? "+" : ""} match${options.length === 1 ? "" : "es"})` : "No one matches" },
                ...options.map((o) => ({ value: o.id, label: o.label }))]} />
            {item.tracking === "stock" && (
              <TextField id="issue-qty" label="Copies" type="number" min={1} max={item.available} value={quantity} onChange={(e) => setQuantity(e.target.value)}
                error={qtyBad ? `Between 1 and ${item.available}.` : undefined} />
            )}
          </>
        )}

        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[200px] flex-1">
            <TextField id="issue-due" label="Due back (optional)" type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
          </div>
          <Button onClick={() => setDueOn(endOfSchoolYear())}>End of year</Button>
          {dueOn && <Button onClick={() => setDueOn("")}>No date</Button>}
        </div>
        {kind !== "class" && <TextField id="issue-note" label="Note (optional)" placeholder="e.g. Cover torn on arrival" value={note} onChange={(e) => setNote(e.target.value)} />}
        {error && <p role="alert" className="text-[12.5px] text-warn-ink">{error}</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- return

function ReturnModal({ issue, onClose, onDone }: { issue: InventoryIssueRow; onClose: () => void; onDone: (msg: string) => void }) {
  const [outcome, setOutcome] = useState<Exclude<IssueStatus, "out">>("returned");
  const [condition, setCondition] = useState<ItemCondition>(issue.condition_out ?? "good");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // added to whatever was noted when it went out, not instead of it
      const fullNote = note.trim() && issue.note ? `${issue.note} · ${note.trim()}` : note;
      await closeInventoryIssue(issue.id, outcome, outcome === "lost" ? null : condition, fullNote);
      // Never charged automatically: the office can do it from History if the family is to pay.
      const chargeHint = issue.holderKind === "learner" && outcome !== "returned" ? " To charge the family, use Charge to fees under History." : "";
      onDone((outcome === "lost"
        ? `${issue.itemName} marked lost by ${issue.holderName}.`
        : `${issue.itemName} returned by ${issue.holderName}.`) + chargeHint);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that.");
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={`Issued ${issuedOn(issue.issued_at)}${issue.condition_out ? ` · ${ITEM_CONDITION_LABEL[issue.condition_out].toLowerCase()} when issued` : ""}`}
      title={`${issue.itemName}${issue.quantity > 1 ? ` × ${issue.quantity}` : ""} from ${issue.holderName}`}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={outcome === "lost" ? "danger" : "accent"} onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : outcome === "lost" ? "Mark lost" : "Record return"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3.5">
        <SelectField id="return-outcome" label="What happened" value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}
          hint={outcome === "lost" ? (issue.quantity > 1 ? `${issue.quantity} copies come off the stock count.` : "The item is written off the register.") : undefined}
          options={[
            { value: "returned", label: "Returned" },
            { value: "damaged", label: "Returned damaged" },
            { value: "lost", label: "Lost / not returned" },
          ]} />
        {outcome !== "lost" && (
          <SelectField id="return-condition" label="Condition on return" value={condition} onChange={(e) => setCondition(e.target.value as ItemCondition)} options={CONDITION_OPTIONS} />
        )}
        <TextField id="return-note" label="Note (optional)" placeholder={outcome === "lost" ? "e.g. Family to replace it" : "e.g. Spine broken"} value={note} onChange={(e) => setNote(e.target.value)} />
        {error && <p role="alert" className="text-[12.5px] text-warn-ink">{error}</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- charge to fees

/**
 * Charges the learner's family for a lost or damaged item, on this term's
 * invoice. Starts from the item's cost (suggestedCharge) but the office
 * decides: change the amount, the wording, or close without charging. A
 * standing charge can be cancelled here too, with a reason.
 */
function ChargeModal({ issue, unitCostCents, existing, country, onClose, onDone }: {
  issue: InventoryIssueRow; unitCostCents: number | null; existing: FeeCharge | null; country: string;
  onClose: () => void; onDone: (msg: string) => void;
}) {
  const suggested = suggestedCharge({ status: issue.status, quantity: issue.quantity, itemName: issue.itemName, unitCostCents });
  const [amount, setAmount] = useState(suggested.amountCents == null ? "" : String(Math.round(suggested.amountCents / 100)));
  const [reason, setReason] = useState(suggested.reason);
  const [voidReason, setVoidReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<string>) {
    setSaving(true);
    setError(null);
    try {
      onDone(await fn());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that.");
      setSaving(false);
    }
  }

  const charge = () => run(async () => {
    const whole = Number(amount);
    if (!Number.isFinite(whole) || whole <= 0 || !Number.isInteger(whole)) throw new Error("Enter the amount to charge, in whole shillings.");
    if (!reason.trim()) throw new Error("Say what the charge is for.");
    await chargeLearner({ studentId: issue.student_id!, amountCents: whole * 100, reason, issueId: issue.id });
    return `${formatMoney(whole * 100, country)} added to ${issue.holderName}'s fees.`;
  });

  const cancel = () => run(async () => {
    if (!voidReason.trim()) throw new Error("Say why the charge is being cancelled.");
    await voidFeeCharge(existing!.id, voidReason);
    return `Charge cancelled. ${issue.holderName}'s balance is ${formatMoney(existing!.amountCents, country)} lower.`;
  });

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={`${issue.status === "lost" ? "Lost" : "Returned damaged"}${issue.closed_at ? ` ${issuedOn(issue.closed_at)}` : ""}`}
      title={existing ? `Charged to ${issue.holderName}` : `Charge ${issue.holderName} for ${issue.itemName}`}
      actions={
        <>
          <Button onClick={onClose}>{existing ? "Close" : "Don't charge"}</Button>
          {existing
            ? <Button variant="danger" onClick={() => void cancel()} disabled={saving}>{saving ? "Cancelling…" : "Cancel the charge"}</Button>
            : <Button variant="accent" onClick={() => void charge()} disabled={saving}>{saving ? "Charging…" : "Add to fees"}</Button>}
        </>
      }
    >
      {existing ? (
        <div className="grid gap-3.5">
          <p className="text-[13px]">
            <span className="font-medium">{existing.reason}</span>: {formatMoney(existing.amountCents, country)}, added {formatShortDate(existing.createdAt.slice(0, 10))}.
            It's on this term's invoice and in the family's balance.
          </p>
          <TextField id="charge-void-reason" label="Reason for cancelling" placeholder="e.g. The book was found" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
          {error && <p role="alert" className="text-[12.5px] text-warn-ink">{error}</p>}
        </div>
      ) : (
        <div className="grid gap-3.5">
          <TextField id="charge-amount" label="Amount" type="number" min={1} step={1} value={amount} onChange={(e) => setAmount(e.target.value)}
            hint={unitCostCents == null
              ? "The register has no cost for this item. Enter what the family should pay."
              : `The register's cost is ${formatMoney(unitCostCents, country)}${issue.quantity > 1 ? ` a copy, ${issue.quantity} copies` : ""}. Change it if the family should pay less, for damage or wear.`} />
          <TextField id="charge-reason" label="On the fee statement as" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
          <p className="text-[12px] text-ink-faint">Added to this term's invoice. The family sees it on their Fees screen and it's in the balance they pay, by M-Pesa or otherwise.</p>
          {error && <p role="alert" className="text-[12.5px] text-warn-ink">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- item history

function ItemHistoryModal({ item, issues, onClose, onIssue, onReturn, onRetire }: {
  item: InventoryItemRow;
  issues: InventoryIssueRow[];
  onClose: () => void;
  onIssue: () => void;
  onReturn: (r: InventoryIssueRow) => void;
  onRetire: (retired: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const facts = [
    INVENTORY_CATEGORY_LABEL[item.category],
    item.tracking === "stock" ? `${item.available} of ${item.quantity} on the shelf` : item.out ? "Out" : "In store",
    ITEM_CONDITION_LABEL[item.condition],
    item.location,
    item.purchased_on ? `Bought ${formatShortDate(item.purchased_on)} ${item.purchased_on.slice(0, 4)}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <Modal
      open
      onClose={onClose}
      width={760}
      eyebrow={item.asset_tag ?? "Inventory"}
      title={item.name}
      blurb={facts}
      footNote={item.notes ?? undefined}
      actions={
        <>
          <Button variant={item.retired_at ? "secondary" : "danger"} disabled={busy || (!item.retired_at && item.out > 0)}
            title={!item.retired_at && item.out > 0 ? "Get back what's out before writing it off" : undefined}
            onClick={async () => { setBusy(true); await onRetire(!item.retired_at); setBusy(false); }}>
            {item.retired_at ? "Put back on the register" : "Write off"}
          </Button>
          <Button variant="accent" disabled={!!item.retired_at || item.available === 0} onClick={onIssue}>Issue</Button>
        </>
      }
    >
      <IssueTable
        rows={issues}
        onReturn={onReturn}
        compact
        empty={{ title: "Never issued", body: "Every hand-out and return of this item will be listed here." }}
      />
    </Modal>
  );
}
