import { useEffect, useState } from "react";
import type { Weekday } from "@figbloom/shared";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { WEEKDAYS } from "@figbloom/shared";

interface Cell { label: string; room: string }
interface PeriodRow { time: string; cells: Record<Weekday, Cell> }
interface Slot { day: Weekday; start_time: string; label: string; room: string | null }

const emptyCells = (): Record<Weekday, Cell> =>
  Object.fromEntries(WEEKDAYS.map((d) => [d, { label: "", room: "" }])) as Record<Weekday, Cell>;

/**
 * A small weekly grid — time down the side, days across the top. Deliberately
 * period-based rather than a drag-and-drop calendar: the school's day is a
 * fixed sequence of periods, not arbitrary appointments. Generic over what
 * it's a timetable FOR (a K-12 class or a higher-ed course section) — the
 * grid shape is identical, only the fetch/save calls differ.
 */
export function TimetableEditor({ entityId, title, fetchSlots, saveSlots, onClose }: {
  entityId: string; title: string;
  fetchSlots: (id: string) => Promise<Slot[]>;
  saveSlots: (id: string, slots: { day: Weekday; start_time: string; label: string; room: string | null }[]) => Promise<void>;
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
          for (const s of slots.filter((s) => s.start_time === time)) cells[s.day] = { label: s.label, room: s.room ?? "" };
          return { time, cells };
        });
        setRows(built);
      })
      .catch((err: Error) => { if (alive) toast(`Could not load the timetable: ${err.message}`); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId]);

  function setCell(time: string, day: Weekday, field: keyof Cell, value: string) {
    setRows((rs) => (rs ?? []).map((r) => (r.time !== time ? r : { ...r, cells: { ...r.cells, [day]: { ...r.cells[day], [field]: value } } })));
  }

  function addPeriod() {
    const t = newTime.trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) { toast("Enter a time as HH:MM, e.g. 08:00."); return; }
    setRows((rs) => {
      const existing = rs ?? [];
      if (existing.some((r) => r.time === t)) { toast("That period already exists."); return existing; }
      return [...existing, { time: t, cells: emptyCells() }].sort((a, b) => a.time.localeCompare(b.time));
    });
    setNewTime("");
  }

  function removePeriod(time: string) {
    setRows((rs) => (rs ?? []).filter((r) => r.time !== time));
  }

  async function handleSave() {
    if (!rows) return;
    setSaving(true);
    try {
      const slots = rows.flatMap((r) =>
        WEEKDAYS.map((d) => ({ day: d, start_time: r.time, label: r.cells[d].label, room: r.cells[d].room || null })),
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

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Timetable"
      title={`Timetable · ${title}`}
      blurb="Leave a cell blank for a free period. Non-subject periods (Games, Library, Class meeting) work the same as any other."
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
            <table className="w-full min-w-[640px] border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-line bg-page">
                  <th className="px-2 py-2 text-left font-semibold">Time</th>
                  {WEEKDAYS.map((d) => <th key={d} className="px-2 py-2 text-left font-semibold">{d}</th>)}
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={7} className="px-2 py-6 text-center text-ink-faint">No periods yet — add one below.</td></tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.time} className="border-b border-line-soft last:border-0">
                      <td className="px-2 py-1.5 font-mono text-ink-muted">{r.time}</td>
                      {WEEKDAYS.map((d) => (
                        <td key={d} className="px-1.5 py-1.5">
                          <input
                            value={r.cells[d].label}
                            onChange={(e) => setCell(r.time, d, "label", e.target.value)}
                            placeholder="Subject"
                            aria-label={`${d} ${r.time} subject`}
                            className="mb-1 w-full rounded border border-[#D3DAD5] px-1.5 py-1 text-[12px] outline-none"
                          />
                          <input
                            value={r.cells[d].room}
                            onChange={(e) => setCell(r.time, d, "room", e.target.value)}
                            placeholder="Room"
                            aria-label={`${d} ${r.time} room`}
                            className="w-full rounded border border-[#D3DAD5] px-1.5 py-1 text-[11.5px] text-ink-muted outline-none"
                          />
                        </td>
                      ))}
                      <td className="px-1.5 text-center">
                        <button type="button" onClick={() => removePeriod(r.time)} aria-label={`Remove ${r.time}`} className="text-warn-ink">✕</button>
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
              onChange={(e) => setNewTime(e.target.value)}
              placeholder="08:00"
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
