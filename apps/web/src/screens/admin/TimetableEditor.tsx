import { useEffect, useState } from "react";
import type { Weekday } from "@figbloom/shared";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { WEEKDAYS } from "@figbloom/shared";

interface Cell { label: string; room: string; subjectId: string | null }
// id is a stable client-side key, independent of the editable `time` text —
// without it, retyping a period's time (to fix a typo, or to slot in a
// break) had no way to know "the row that used to be 09:00" once its time
// field no longer read "09:00".
interface PeriodRow { id: string; time: string; cells: Record<Weekday, Cell> }
interface Slot { day: Weekday; start_time: string; label: string; room: string | null; subject_id?: string | null }
interface SubjectOption { id: string; name: string }

const emptyCells = (): Record<Weekday, Cell> =>
  Object.fromEntries(WEEKDAYS.map((d) => [d, { label: "", room: "", subjectId: null }])) as Record<Weekday, Cell>;

let rowIdSeq = 0;
const nextRowId = () => `row-${++rowIdSeq}`;

/** Digits only, colon auto-inserted after HH, capped at HH:MM — typing "1430" or "14:30" both land on "14:30". */
function formatTimeInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 4);
  return digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * A small weekly grid — time down the side, days across the top. Deliberately
 * period-based rather than a drag-and-drop calendar: the school's day is a
 * fixed sequence of periods, not arbitrary appointments. Generic over what
 * it's a timetable FOR (a K-12 class or a higher-ed course section) — the
 * grid shape is identical, only the fetch/save calls differ.
 *
 * A "period" here is just a row at a time — a break or lunch is nothing
 * special, just a row whose label is "Break" instead of a subject; the same
 * free-text field already handles Games/Library/Class meeting. What used to
 * be genuinely missing was editing a period once added (its time was
 * display-only) and repeating one across the week without retyping it five
 * times — both fixed below.
 *
 * The `subjects` prop (K-12 only — a higher-ed section already has one fixed
 * instructor) links a period to a real subject, separately from its free-text
 * label. That's what lets a teacher's own timetable know which periods are
 * actually theirs, via teaching_assignments, instead of showing every period
 * of a class they merely teach one subject in.
 */
export function TimetableEditor({ entityId, title, subjects, fetchSlots, saveSlots, onClose }: {
  entityId: string; title: string;
  subjects?: SubjectOption[];
  fetchSlots: (id: string) => Promise<Slot[]>;
  saveSlots: (id: string, slots: { day: Weekday; start_time: string; label: string; room: string | null; subject_id: string | null }[]) => Promise<void>;
  onClose: () => void;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<PeriodRow[] | null>(null);
  const [newTime, setNewTime] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchSlots(entityId)
      .then((slots) => {
        if (!alive) return;
        const times = Array.from(new Set(slots.map((s) => s.start_time))).sort();
        const built: PeriodRow[] = times.map((time) => {
          const cells = emptyCells();
          for (const s of slots.filter((s) => s.start_time === time)) {
            cells[s.day] = { label: s.label, room: s.room ?? "", subjectId: s.subject_id ?? null };
          }
          return { id: nextRowId(), time, cells };
        });
        setRows(built);
      })
      .catch((err: Error) => { if (alive) toast(`Could not load the timetable: ${err.message}`); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId]);

  function setCell(id: string, day: Weekday, field: keyof Cell, value: string | null) {
    setRows((rs) => (rs ?? []).map((r) => (r.id !== id ? r : { ...r, cells: { ...r.cells, [day]: { ...r.cells[day], [field]: value } } })));
  }

  function setCellSubject(id: string, day: Weekday, subjectId: string, subjectsById: Map<string, SubjectOption>) {
    setRows((rs) => (rs ?? []).map((r) => {
      if (r.id !== id) return r;
      const current = r.cells[day];
      const next: Cell = {
        ...current,
        subjectId: subjectId || null,
        // Convenience, not a lock — picking a subject fills the label if it's
        // still blank or was previously following another subject's name;
        // typing a custom label afterwards is untouched by this.
        label: subjectId && (!current.label.trim() || (current.subjectId && current.label === subjectsById.get(current.subjectId)?.name))
          ? subjectsById.get(subjectId)?.name ?? current.label
          : current.label,
      };
      return { ...r, cells: { ...r.cells, [day]: next } };
    }));
  }

  function retimePeriod(id: string, raw: string) {
    const time = formatTimeInput(raw);
    setRows((rs) => (rs ?? []).map((r) => (r.id === id ? { ...r, time } : r)));
  }

  // Re-sorting on every keystroke would make the row jump around the table
  // mid-edit (a partial value like "1" sorts oddly against "09:00"/"14:00")
  // — only settle its position once the admin's done typing.
  function resortRows() {
    setRows((rs) => (rs ? [...rs].sort((a, b) => a.time.localeCompare(b.time)) : rs));
  }

  function copyMondayToWeek(id: string) {
    setRows((rs) => (rs ?? []).map((r) => {
      if (r.id !== id) return r;
      const monday = r.cells.Mon;
      return { ...r, cells: Object.fromEntries(WEEKDAYS.map((d) => [d, { ...monday }])) as Record<Weekday, Cell> };
    }));
  }

  function addPeriod() {
    const t = newTime.trim();
    if (!TIME_RE.test(t)) { toast("Enter a time as HH:MM, e.g. 08:00."); return; }
    setRows((rs) => {
      const existing = rs ?? [];
      if (existing.some((r) => r.time === t)) { toast("That period already exists."); return existing; }
      return [...existing, { id: nextRowId(), time: t, cells: emptyCells() }].sort((a, b) => a.time.localeCompare(b.time));
    });
    setNewTime("");
  }

  function removePeriod(id: string) {
    setRows((rs) => (rs ?? []).filter((r) => r.id !== id));
  }

  async function handleSave() {
    if (!rows) return;
    for (const r of rows) {
      if (!TIME_RE.test(r.time)) { toast(`"${r.time}" isn't a valid time — use HH:MM, e.g. 08:00.`); return; }
    }
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.time)) { toast(`Two periods are both set to ${r.time} — give one a different time first.`); return; }
      seen.add(r.time);
    }

    setSaving(true);
    try {
      const slots = rows.flatMap((r) =>
        WEEKDAYS.map((d) => ({
          day: d, start_time: r.time, label: r.cells[d].label, room: r.cells[d].room || null,
          subject_id: r.cells[d].subjectId,
        })),
      );
      await saveSlots(entityId, slots);
      toast(`Timetable saved for ${title}.`);
      onClose();
    } catch (err) {
      toast(err instanceof Error ? `Could not save the timetable: ${err.message}` : "Could not save the timetable.");
    } finally {
      setSaving(false);
    }
  }

  const subjectsById = new Map((subjects ?? []).map((s) => [s.id, s]));

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Timetable"
      title={`Timetable · ${title}`}
      blurb={
        subjects
          ? "Leave a cell blank for a free period. A break or lunch is just a row labeled that way. Link a period to a subject so its teacher (set under Subjects) shows up automatically — leave it unlinked for Games, Library, Class meeting and the like."
          : "Leave a cell blank for a free period. A break or lunch is just a row labeled that way — non-subject periods work the same as any other."
      }
      width={760}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={() => void handleSave()} disabled={!rows || saving}>
            {saving ? "Saving…" : "Save timetable"}
          </Button>
        </>
      }
    >
      {!rows ? (
        <TableSkeleton rows={6} />
      ) : (
        <div className="grid gap-3">
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[700px] border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-line bg-page">
                  <th className="px-2 py-2 text-left font-semibold">Time</th>
                  {WEEKDAYS.map((d) => <th key={d} className="px-2 py-2 text-left font-semibold">{d}</th>)}
                  <th className="w-16" />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={7} className="px-2 py-6 text-center text-ink-faint">No periods yet — add one below.</td></tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.id} className="border-b border-line-soft last:border-0">
                      <td className="px-2 py-1.5">
                        <input
                          value={r.time}
                          onChange={(e) => retimePeriod(r.id, e.target.value)}
                          onBlur={resortRows}
                          inputMode="numeric"
                          maxLength={5}
                          aria-label={`Time for the period currently at ${r.time}`}
                          className="w-[68px] rounded border border-[#D3DAD5] px-1.5 py-1 font-mono text-ink-muted outline-none"
                        />
                      </td>
                      {WEEKDAYS.map((d) => (
                        <td key={d} className="px-1.5 py-1.5">
                          <input
                            value={r.cells[d].label}
                            onChange={(e) => setCell(r.id, d, "label", e.target.value)}
                            placeholder="Subject or Break"
                            aria-label={`${d} ${r.time} subject`}
                            className="mb-1 w-full rounded border border-[#D3DAD5] px-1.5 py-1 text-[12px] outline-none"
                          />
                          <input
                            value={r.cells[d].room}
                            onChange={(e) => setCell(r.id, d, "room", e.target.value)}
                            placeholder="Room"
                            aria-label={`${d} ${r.time} room`}
                            className="mb-1 w-full rounded border border-[#D3DAD5] px-1.5 py-1 text-[11.5px] text-ink-muted outline-none"
                          />
                          {subjects && (
                            <select
                              value={r.cells[d].subjectId ?? ""}
                              onChange={(e) => setCellSubject(r.id, d, e.target.value, subjectsById)}
                              aria-label={`${d} ${r.time} linked subject`}
                              className="w-full rounded border border-[#D3DAD5] bg-white px-1.5 py-1 text-[11px] text-ink-muted outline-none"
                            >
                              <option value="">No subject link</option>
                              {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                          )}
                        </td>
                      ))}
                      <td className="px-1.5 text-center">
                        <div className="grid gap-1">
                          <button
                            type="button"
                            onClick={() => copyMondayToWeek(r.id)}
                            title="Copy Monday's entry to every day — for a break, lunch, or anything that repeats all week"
                            aria-label={`Copy Monday to every day for the ${r.time} period`}
                            className="text-[11px] font-semibold text-leaf hover:underline"
                          >
                            ⇉ week
                          </button>
                          <button type="button" onClick={() => removePeriod(r.id)} aria-label={`Remove the ${r.time} period`} className="text-warn-ink">✕</button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-2">
            <input
              value={newTime}
              onChange={(e) => setNewTime(formatTimeInput(e.target.value))}
              placeholder="08:00"
              inputMode="numeric"
              maxLength={5}
              aria-label="New period time"
              className="w-24 rounded-md border border-[#D3DAD5] px-2.5 py-1.5 font-mono text-small outline-none"
            />
            <Button onClick={addPeriod}>Add period</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
