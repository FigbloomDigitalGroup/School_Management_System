import { useEffect, useState, type ChangeEvent } from "react";
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

/** Groups flat (day, time) slots back into one row per unique time — the shape both the initial load and a CSV import build. */
function slotsToRows(slots: Slot[]): PeriodRow[] {
  const times = Array.from(new Set(slots.map((s) => s.start_time))).sort();
  return times.map((time) => {
    const cells = emptyCells();
    for (const s of slots.filter((s) => s.start_time === time)) {
      cells[s.day] = { label: s.label, room: s.room ?? "", subjectId: s.subject_id ?? null };
    }
    return { id: nextRowId(), time, cells };
  });
}

const DAY_ALIASES: Record<string, Weekday> = {
  mon: "Mon", monday: "Mon",
  tue: "Tue", tues: "Tue", tuesday: "Tue",
  wed: "Wed", weds: "Wed", wednesday: "Wed",
  thu: "Thu", thur: "Thu", thurs: "Thu", thursday: "Thu",
  fri: "Fri", friday: "Fri",
};

/**
 * One row per (day, time) cell — the same shape the grid saves as, so a
 * CSV import needs no separate validation story: it builds the identical
 * Slot[] the grid itself produces, then reuses slotsToRows() to populate
 * the same rows state the admin can still review and tweak before saving.
 * Blocking errors (bad time/day/missing label) stop the whole import,
 * same reasoning as the student CSV importer — a partial import that
 * silently skipped rows is worse than one that never ran. An unrecognised
 * subject name is the one non-blocking case: the row still imports, just
 * unlinked, since that's easy to fix afterward in the grid's own dropdown.
 */
function parseTimetableCsv(text: string, subjects: SubjectOption[]): { slots: Slot[]; blocking: string[]; warnings: string[] } {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0);
  const blocking: string[] = [];
  const warnings: string[] = [];
  if (lines.length < 2) return { slots: [], blocking: ["The file has no data rows."], warnings };

  const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const idx = { time: col("time"), day: col("day"), label: col("label"), room: col("room"), subject: col("subject") };
  const subjectByName = new Map(subjects.map((s) => [s.name.trim().toLowerCase(), s.id]));

  const slots: Slot[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split(",").map((c) => c.trim());
    const line = i + 1;
    const rawTime = idx.time >= 0 ? (cells[idx.time] ?? "") : "";
    const rawDay = idx.day >= 0 ? (cells[idx.day] ?? "") : "";
    const label = idx.label >= 0 ? (cells[idx.label] ?? "") : "";
    const room = idx.room >= 0 ? (cells[idx.room] ?? "") : "";
    const subjectName = idx.subject >= 0 ? (cells[idx.subject] ?? "") : "";
    if (!rawTime && !rawDay && !label) continue;

    const time = formatTimeInput(rawTime);
    if (!TIME_RE.test(time)) { blocking.push(`Line ${line}: "${rawTime}" isn't a valid time — use HH:MM.`); continue; }
    const day = DAY_ALIASES[rawDay.trim().toLowerCase()];
    if (!day) { blocking.push(`Line ${line}: "${rawDay}" isn't Mon-Fri.`); continue; }
    if (!label.trim()) { blocking.push(`Line ${line}: missing a label.`); continue; }

    let subjectId: string | null = null;
    if (subjectName.trim()) {
      subjectId = subjectByName.get(subjectName.trim().toLowerCase()) ?? null;
      if (!subjectId) warnings.push(`Line ${line}: "${subjectName}" isn't one of this school's subjects — imported unlinked.`);
    }
    slots.push({ day, start_time: time, label: label.trim(), room: room.trim() || null, subject_id: subjectId });
  }
  return { slots, blocking, warnings };
}

function timetableCsvTemplate(hasSubjects: boolean): string {
  const header = hasSubjects ? "time,day,label,room,subject" : "time,day,label,room";
  const row = (time: string, day: string, label: string, room: string, subject: string) =>
    hasSubjects ? `${time},${day},${label},${room},${subject}` : `${time},${day},${label},${room}`;
  return [
    header,
    row("08:00", "Mon", "Biology", "Lab 1", "Biology"),
    row("08:00", "Tue", "Mathematics", "Room 4", "Mathematics"),
    row("11:00", "Mon", "Break", "", ""),
  ].join("\n");
}

function downloadTimetableCsvTemplate(hasSubjects: boolean): void {
  const blob = new Blob([timetableCsvTemplate(hasSubjects)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "timetable-import-template.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

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
        setRows(slotsToRows(slots));
      })
      .catch((err: Error) => { if (alive) toast(`Could not load the timetable: ${err.message}`, "error"); });
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
    if (!TIME_RE.test(t)) { toast("Enter a time as HH:MM, e.g. 08:00.", "error"); return; }
    setRows((rs) => {
      const existing = rs ?? [];
      if (existing.some((r) => r.time === t)) { toast("That period already exists.", "error"); return existing; }
      return [...existing, { id: nextRowId(), time: t, cells: emptyCells() }].sort((a, b) => a.time.localeCompare(b.time));
    });
    setNewTime("");
  }

  function removePeriod(id: string) {
    setRows((rs) => (rs ?? []).filter((r) => r.id !== id));
  }

  function onImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const { slots, blocking, warnings } = parseTimetableCsv(String(reader.result ?? ""), subjects ?? []);
      if (blocking.length > 0) {
        toast(`Could not import: ${blocking[0]}${blocking.length > 1 ? ` (+${blocking.length - 1} more)` : ""}`, "error");
        return;
      }
      if (slots.length === 0) { toast("Nothing to import — the file has no valid rows.", "error"); return; }
      if ((rows?.length ?? 0) > 0 && !window.confirm(`Replace the ${rows!.length} period${rows!.length === 1 ? "" : "s"} already here with ${slots.length} imported row${slots.length === 1 ? "" : "s"}?`)) return;
      setRows(slotsToRows(slots));
      toast(
        warnings.length > 0
          ? `Imported ${slots.length} rows — ${warnings[0]}${warnings.length > 1 ? ` (+${warnings.length - 1} more)` : ""}`
          : `Imported ${slots.length} rows. Review the grid, then save.`,
      );
    };
    reader.readAsText(file);
  }

  async function handleSave() {
    if (!rows) return;
    for (const r of rows) {
      if (!TIME_RE.test(r.time)) { toast(`"${r.time}" isn't a valid time — use HH:MM, e.g. 08:00.`, "error"); return; }
    }
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.time)) { toast(`Two periods are both set to ${r.time} — give one a different time first.`, "error"); return; }
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
      toast(err instanceof Error ? `Could not save the timetable: ${err.message}` : "Could not save the timetable.", "error");
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

          <div className="flex flex-wrap items-center gap-2">
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
            <span className="mx-1 text-ink-faint">·</span>
            <Button onClick={() => downloadTimetableCsvTemplate(!!subjects)}>Download CSV template</Button>
            <label className="text-small font-medium text-leaf">
              <span className="hit inline-block cursor-pointer rounded-md border border-[#D3DAD5] bg-white px-3 py-1.5 hover:bg-page">
                Import CSV
              </span>
              <input type="file" accept=".csv,text/csv" className="hidden" onChange={onImportFile} aria-label="Import timetable CSV" />
            </label>
          </div>
        </div>
      )}
    </Modal>
  );
}
