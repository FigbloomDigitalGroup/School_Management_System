import { useEffect, useState } from "react";
import { formatMoney, levelsForTenant, supabase, targetYearLabel, yearGroupKey, yearGroupsOf, yearLabel, yearsFor, type FeeItem, type YearGroup } from "@figbloom/shared";
import { useTenantSession } from "../../lib/sessionContext";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast, type ToastFn } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";

const APPLIES_TO_OPTIONS: { value: FeeItem["applies_to"]; label: string }[] = [
  { value: "all", label: "Every learner" },
  { value: "boarders", label: "Boarders only" },
  { value: "day", label: "Day scholars only" },
  { value: "form_level", label: "One year group" },
];

/** Year groups the school has classes in; every year it could run when it has none yet. */
async function fetchYearGroups(tenantId: string, tenantLevel: Parameters<typeof levelsForTenant>[0]): Promise<YearGroup[]> {
  const { data, error } = await supabase().from("classes").select("level, form_level").eq("tenant_id", tenantId)
    .returns<{ level: YearGroup["level"]; form_level: number }[]>();
  if (error) throw new Error(error.message);
  const groups = yearGroupsOf(data ?? []);
  return groups.length ? groups : levelsForTenant(tenantLevel).flatMap((l) => yearsFor(l).map((y) => ({ key: yearGroupKey(l, y), level: l, year: y })));
}

async function fetchTermFeeItems(termId: string): Promise<FeeItem[]> {
  const { data, error } = await supabase().from("fee_items").select("*").eq("term_id", termId).order("name").returns<FeeItem[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

function FeeItemRow({ item, country, onSaved, onDeleted, toast }: {
  item: FeeItem; country: string;
  onSaved: () => void; onDeleted: () => void;
  toast: ToastFn;
}) {
  const [name, setName] = useState(item.name);
  const [amount, setAmount] = useState(String(item.amount_cents / 100));
  const [saving, setSaving] = useState(false);
  const dirty = name !== item.name || amount !== String(item.amount_cents / 100);

  async function save() {
    const cents = Math.round(parseFloat(amount) * 100);
    if (!name.trim() || !Number.isFinite(cents) || cents <= 0) { toast("Give it a name and a positive amount.", "error"); return; }
    setSaving(true);
    try {
      const { error } = await supabase().from("fee_items").update({ name: name.trim(), amount_cents: cents }).eq("id", item.id);
      if (error) throw error;
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? `Could not save: ${err.message}` : "Could not save.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove "${item.name}" from this term's fee structure?`)) return;
    const { error } = await supabase().from("fee_items").delete().eq("id", item.id);
    if (error) { toast(`Could not remove that item: ${error.message}`, "error"); return; }
    onDeleted();
  }

  return (
    <li className="grid gap-2 rounded-lg border border-line-soft px-3 py-2.5" style={{ gridTemplateColumns: "1fr 140px auto auto" }}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label={`Name for ${item.name}`}
        className="rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-[13px] outline-none"
      />
      <input
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        inputMode="decimal"
        aria-label={`Amount for ${item.name}`}
        className="w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-right font-mono text-[13px] outline-none"
      />
      <Button disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Button>
      <button type="button" onClick={() => void remove()} className="text-[12px] font-semibold text-warn-ink hover:underline">Remove</button>
      <div className="col-span-4 text-[11.5px] text-ink-faint">
        {item.applies_to === "all" ? "Every learner"
          : item.applies_to === "boarders" ? "Boarders only"
          : item.applies_to === "day" ? "Day scholars only"
          : `${targetYearLabel(item.level, item.form_level ?? 0)} only`} · currently {formatMoney(item.amount_cents, country)}
      </div>
    </li>
  );
}

/**
 * fee_items has no admin screen anywhere else — this is the only place a
 * term's fee structure gets created, priced, or retired. Scope (who an item
 * applies to) is fixed once created; changing that means removing the item
 * and adding a new one, rather than a form wide enough to edit it in place.
 */
export function FeeItemsEditor({ termId, termName, tenantId, country, onClose }: {
  termId: string; termName: string; tenantId: string; country: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const { tenant } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  const { data: items, loading, error } = useAsync(() => fetchTermFeeItems(termId), [termId, reloadKey]);
  const { data: yearGroups } = useAsync(() => fetchYearGroups(tenantId, tenant.level), [tenantId, tenant.level]);
  const reload = () => setReloadKey((k) => k + 1);

  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [appliesTo, setAppliesTo] = useState<FeeItem["applies_to"]>("all");
  const [pickedYear, setPickedYear] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const yearGroup = yearGroups?.find((y) => y.key === pickedYear) ?? yearGroups?.[0] ?? null;

  useEffect(() => { if (appliesTo !== "form_level") setPickedYear(null); }, [appliesTo]);

  async function createItem() {
    const cents = Math.round(parseFloat(amount) * 100);
    if (!name.trim() || !Number.isFinite(cents) || cents <= 0) { toast("Give the item a name and a positive amount.", "error"); return; }
    if (appliesTo === "form_level" && !yearGroup) { toast("Pick which year group this item is for.", "error"); return; }
    setCreating(true);
    try {
      const { error: err } = await supabase().from("fee_items").insert({
        tenant_id: tenantId, term_id: termId, name: name.trim(), amount_cents: cents,
        applies_to: appliesTo,
        form_level: appliesTo === "form_level" ? yearGroup!.year : null,
        level: appliesTo === "form_level" ? yearGroup!.level : null,
      });
      if (err) throw err;
      toast(`${name.trim()} added.`);
      setName("");
      setAmount("");
      reload();
    } catch (err) {
      toast(err instanceof Error ? `Could not add that item: ${err.message}` : "Could not add that item.", "error");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Fees"
      title={`Fee items · ${termName}`}
      blurb="Every learner already billed keeps their existing invoice — a change here only affects invoices generated after it."
      width={640}
      actions={<Button onClick={onClose}>Done</Button>}
    >
      {error ? (
        <p className="text-[12.5px] text-warn-ink">Could not load fee items: {error.message}</p>
      ) : loading || !items ? (
        <TableSkeleton rows={4} />
      ) : (
        <div className="grid gap-3">
          {items.length === 0 ? (
            <p className="text-[12.5px] text-ink-muted">No fee items yet — add the first one below.</p>
          ) : (
            <ul className="grid gap-2">
              {items.map((i) => (
                <FeeItemRow key={i.id} item={i} country={country} onSaved={() => { toast("Saved."); reload(); }} onDeleted={() => { toast("Removed."); reload(); }} toast={toast} />
              ))}
            </ul>
          )}

          <div className="grid gap-2 border-t border-line-soft pt-3">
            <div className="grid gap-2" style={{ gridTemplateColumns: "1fr 140px" }}>
              <label className="block">
                <span className="mb-1.5 block text-[11.5px] font-semibold">New item</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Tuition"
                  className="w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-[13px] outline-none"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[11.5px] font-semibold">Amount</span>
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                  placeholder="e.g. 15000"
                  className="w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-right font-mono text-[13px] outline-none"
                />
              </label>
            </div>
            <div className="flex items-end gap-2">
              <label className="block flex-1">
                <span className="mb-1.5 block text-[11.5px] font-semibold">Applies to</span>
                <select
                  value={appliesTo}
                  onChange={(e) => setAppliesTo(e.target.value as FeeItem["applies_to"])}
                  className="w-full rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-[13px]"
                >
                  {APPLIES_TO_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              {appliesTo === "form_level" && (
                <label className="block w-32">
                  <span className="mb-1.5 block text-[11.5px] font-semibold">Year group</span>
                  <select
                    value={yearGroup?.key ?? ""}
                    onChange={(e) => setPickedYear(e.target.value)}
                    className="w-full rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-[13px]"
                  >
                    {(yearGroups ?? []).map((y) => <option key={y.key} value={y.key}>{yearLabel(y.level, y.year)}</option>)}
                  </select>
                </label>
              )}
              <Button onClick={() => void createItem()} disabled={creating}>{creating ? "Adding…" : "Add item"}</Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
