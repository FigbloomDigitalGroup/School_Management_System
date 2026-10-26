import { useState } from "react";
import {
  COMPETENCY_ITEMS, COMPETENCY_LEVELS, competencyKey, fetchClassRoster, fetchCompetencyRatings, ratedCount, saveCompetencyRating,
} from "@figbloom/shared";
import { SelectField } from "./ui/Field";
import { TableSkeleton } from "./ui/Skeleton";
import { useToast } from "./ui/Toast";
import { useAsync } from "../lib/useAsync";

/**
 * The class teacher rates the core competencies and values for a CBC class,
 * one item at a time down the class list, the way it's done on paper: pick
 * "Critical thinking", then tap a level for each learner. A tap saves; tapping
 * the chosen level again clears it. The ratings go onto report cards the
 * next time the class is prepared.
 */
export function CompetencyRatings({ tenantId, termId, classId }: { tenantId: string; termId: string; classId: string }) {
  const toast = useToast();
  const [itemKey, setItemKey] = useState(competencyKey(COMPETENCY_ITEMS[0]!.kind, COMPETENCY_ITEMS[0]!.code));
  const [levels, setLevels] = useState<Map<string, Map<string, string>> | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const { data, loading, error } = useAsync(async () => {
    const roster = await fetchClassRoster(classId);
    const ratings = await fetchCompetencyRatings(termId, roster.map((s) => s.id));
    setLevels(ratings);
    return roster;
  }, [termId, classId]);

  const item = COMPETENCY_ITEMS.find((it) => competencyKey(it.kind, it.code) === itemKey)!;
  const learners = data ?? [];
  const ratedHere = learners.filter((l) => levels?.get(l.id)?.has(itemKey)).length;

  async function rate(studentId: string, level: string) {
    const current = levels?.get(studentId)?.get(itemKey) ?? null;
    const next = current === level ? null : level;
    const update = (value: string | null) => setLevels((prev) => {
      const copy = new Map(prev ?? []);
      const mine = new Map(copy.get(studentId) ?? []);
      if (value) mine.set(itemKey, value); else mine.delete(itemKey);
      copy.set(studentId, mine);
      return copy;
    });
    update(next);
    setSaving(studentId);
    try {
      await saveCompetencyRating(tenantId, termId, studentId, item.kind, item.code, next);
    } catch (err) {
      update(current);
      toast(err instanceof Error ? err.message : "Could not save that rating.", "error");
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="rounded-lg border border-line bg-white p-4">
      <h2 className="text-[14px] font-semibold">Core competencies and values</h2>
      <p className="mt-0.5 text-[12px] text-ink-faint">
        Rate each learner on the rubric, one item at a time. Ratings appear on report cards the next time the class is prepared.
      </p>
      <div className="mt-3 max-w-[420px]">
        <SelectField
          id="competency-item"
          label="Rating"
          value={itemKey}
          onChange={(e) => setItemKey(e.target.value)}
          options={COMPETENCY_ITEMS.map((it) => ({
            value: competencyKey(it.kind, it.code),
            label: `${it.kind === "value" ? "Value: " : ""}${it.label}`,
          }))}
        />
      </div>

      {error ? (
        <p className="mt-3 text-[12.5px] text-warn-ink">Could not load the class: {error.message}</p>
      ) : loading && !data ? (
        <div className="mt-3"><TableSkeleton rows={4} /></div>
      ) : !learners.length ? (
        <p className="mt-3 text-[12.5px] text-ink-faint">This class has no learners yet.</p>
      ) : (
        <>
          <p className="mt-3 text-[12px] text-ink-faint">{ratedHere} of {learners.length} rated for {item.label.toLowerCase()}</p>
          <ul className="mt-2 divide-y divide-line rounded-md border border-line">
            {learners.map((l) => {
              const chosen = levels?.get(l.id)?.get(itemKey);
              return (
                <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium">{l.full_name}</div>
                    <div className="text-[11px] text-ink-faint">{ratedCount(levels?.get(l.id))} of {COMPETENCY_ITEMS.length} rated</div>
                  </div>
                  <div className="flex gap-1" role="group" aria-label={`${item.label} for ${l.full_name}`}>
                    {COMPETENCY_LEVELS.map((lv) => (
                      <button
                        key={lv.code}
                        type="button"
                        title={lv.label}
                        aria-pressed={chosen === lv.code}
                        disabled={saving === l.id}
                        onClick={() => rate(l.id, lv.code)}
                        className={`h-8 w-11 rounded-md border text-[12px] font-semibold transition-colors ${
                          chosen === lv.code ? "border-accent bg-accent text-white" : "border-line bg-white text-ink-soft hover:border-accent"
                        }`}
                      >
                        {lv.code}
                      </button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
