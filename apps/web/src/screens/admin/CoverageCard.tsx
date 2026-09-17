import { useState } from "react";
import { formatShortDate } from "@figbloom/shared";
import { Button } from "../../components/ui/Button";
import { useToast } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";
import { assignCoverage, fetchCoverageThisWeek, type CoverageItem } from "../../lib/coverage";

const keyFor = (item: Pick<CoverageItem, "date" | "classId" | "time">) => `${item.date}|${item.classId}|${item.time}`;

/**
 * Dashboard card for this week's coverage gaps — periods whose assigned
 * teacher is on approved leave. Not just informational: the principal picks
 * a substitute (from who else specializes in that subject) or marks the
 * period free, right here. Assigning notifies the substitute in-app;
 * nothing to notify for a free period.
 */
export function CoverageCard() {
  const toast = useToast();
  const { profile, tenant } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  const { data: coverage } = useAsync(() => fetchCoverageThisWeek(), [reloadKey]);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [editingKeys, setEditingKeys] = useState<Set<string>>(new Set());
  const [savingKey, setSavingKey] = useState<string | null>(null);

  if (!coverage || coverage.length === 0) return null;

  async function assign(item: CoverageItem, coveringTeacherId: string | null) {
    const key = keyFor(item);
    setSavingKey(key);
    try {
      await assignCoverage({ tenantId: tenant.id, assignedBy: profile.id, item, coveringTeacherId });
      toast(coveringTeacherId ? `Assigned to cover — they've been notified.` : "Marked as a free period.");
      setEditingKeys((s) => { const next = new Set(s); next.delete(key); return next; });
      setPicked((p) => { const next = { ...p }; delete next[key]; return next; });
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? `Could not save: ${err.message}` : "Could not save.");
    } finally {
      setSavingKey(null);
    }
  }

  const unresolvedCount = coverage.filter((c) => !c.assignment).length;

  return (
    <section className="rounded-lg border border-warn-ink/30 bg-warn-ink/5 p-4">
      <h2 className="text-body font-semibold text-warn-ink">Needs cover this week · {unresolvedCount}</h2>
      <ul className="mt-2.5 grid gap-2.5">
        {coverage.map((c) => {
          const key = keyFor(c);
          const saving = savingKey === key;
          const editing = editingKeys.has(key) || !c.assignment;
          return (
            <li key={key} className="rounded-lg bg-white/70 px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-small font-semibold text-warn-ink">{c.subjectName} · {c.className}</span>
                <span className="shrink-0 font-mono text-[11px] text-warn-ink">{c.weekday} {c.time}</span>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-warn-ink">
                {c.absentTeacherName} is on approved leave {formatShortDate(c.date)}.
              </p>

              {!editing && c.assignment ? (
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-[12px] font-semibold text-ok-ink">
                    {c.assignment.coveringTeacherId ? `Covered by ${c.assignment.coveringTeacherName}` : "Marked as a free period"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setEditingKeys((s) => new Set(s).add(key))}
                    className="text-[11.5px] font-semibold text-warn-ink hover:underline"
                  >
                    Change
                  </button>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <select
                    value={picked[key] ?? ""}
                    onChange={(e) => setPicked((p) => ({ ...p, [key]: e.target.value }))}
                    aria-label={`Substitute for ${c.subjectName} · ${c.className}`}
                    className="rounded-md border border-warn-ink/30 bg-white px-2 py-1 text-[12px]"
                  >
                    <option value="">
                      {c.substitutes.length > 0 ? "Choose a substitute…" : "Nobody else on file teaches this"}
                    </option>
                    {c.substitutes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <Button
                    variant="accent"
                    disabled={!picked[key] || saving}
                    onClick={() => void assign(c, picked[key]!)}
                  >
                    {saving ? "Saving…" : "Assign"}
                  </Button>
                  <Button disabled={saving} onClick={() => void assign(c, null)}>Mark free period</Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
