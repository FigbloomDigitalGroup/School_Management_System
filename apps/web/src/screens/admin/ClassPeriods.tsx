import { useState, type FormEvent } from "react";
import { WEEKDAYS, addClassPeriod, fetchClassPeriods, type ClassPeriod, type Weekday } from "@figbloom/shared";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const FULL_DAY: Record<Weekday, string> = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday" };

/** Digits only, colon inserted after HH, capped at HH:MM: typing "0815" or "08:15" both land on "08:15". */
function formatTimeInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 4);
  return digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits;
}

/**
 * A class's timetable on the new system: the periods it has, and a form to add one. The week-grid editor (admin/TimetableEditor)
 * saves the whole week at once and gives each period a free-text label; the API makes one period at a time, names it by its
 * subject, and cannot change or remove one yet, so this is a list and an "Add a period" form instead (timetableCapabilities).
 */
export function ClassPeriods({ classId, className, subjects, onClose }: {
  classId: string; className: string; subjects: { id: string; name: string }[]; onClose: () => void;
}) {
  const toast = useToast();
  const [reloadKey, setReloadKey] = useState(0);
  const { data: periods, error } = useAsync(() => fetchClassPeriods(classId), [classId, reloadKey]);
  const [day, setDay] = useState<Weekday>("Mon");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [subjectId, setSubjectId] = useState(subjects[0]?.id ?? "");
  const [room, setRoom] = useState("");
  const [saving, setSaving] = useState(false);

  async function add(e?: FormEvent) {
    e?.preventDefault();
    if (!subjectId) { toast("Choose a subject for the period.", "error"); return; }
    if (!TIME_RE.test(startsAt) || !TIME_RE.test(endsAt)) { toast("Enter the start and end as HH:MM, e.g. 08:00.", "error"); return; }
    if (endsAt <= startsAt) { toast("The period must end after it starts.", "error"); return; }
    setSaving(true);
    try {
      await addClassPeriod({ classId, day, startsAt, endsAt, subjectId, room: room.trim() || null });
      toast(`Period added to ${className}.`);
      setStartsAt(""); setEndsAt(""); setRoom("");
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? `Could not add the period: ${err.message}` : "Could not add the period.", "error");
    } finally {
      setSaving(false);
    }
  }

  const byDay = (d: Weekday): ClassPeriod[] => (periods ?? []).filter((p) => p.day === d);

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Timetable"
      title={`Timetable · ${className}`}
      blurb="A period is a subject at a time on a day. You can add periods here; changing or removing one is not on the new system yet."
      width={720}
      actions={<Button onClick={onClose}>Close</Button>}
    >
      <div className="grid gap-4">
        {error ? (
          <p className="text-[12.5px] text-warn-ink">Could not load the timetable: {error.message}</p>
        ) : !periods ? (
          <TableSkeleton rows={4} />
        ) : periods.length === 0 ? (
          <p className="text-[12.5px] text-ink-faint">No periods yet. Add the first one below.</p>
        ) : (
          <div className="grid gap-3">
            {WEEKDAYS.filter((d) => byDay(d).length > 0).map((d) => (
              <section key={d} aria-label={FULL_DAY[d]}>
                <h3 className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-ink-faint">{FULL_DAY[d]}</h3>
                <div className="overflow-hidden rounded-lg border border-line">
                  {byDay(d).map((p) => (
                    <div key={p.id} className="flex items-center gap-3 border-b border-line-soft px-3.5 py-2 text-[13px] last:border-0">
                      <span className="w-28 shrink-0 font-mono text-[12px] text-ink-muted">{p.startsAt}–{p.endsAt}</span>
                      <span className="min-w-0 flex-1 font-medium">{p.subjectName}</span>
                      <span className="shrink-0 text-[12px] text-ink-faint">
                        {[p.room, p.teacherName].filter(Boolean).join(" · ") || "—"}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        <form onSubmit={(e) => void add(e)} className="grid gap-3 rounded-lg border border-line bg-page p-3.5">
          <h3 className="text-[12.5px] font-semibold">Add a period</h3>
          {subjects.length === 0 ? (
            <p className="text-[12.5px] text-ink-muted">Add a subject first (Subjects page), then its periods can be put here.</p>
          ) : (
            <>
              <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
                <label className="block">
                  <span className="mb-1.5 block text-[12.5px] font-semibold">Day</span>
                  <select value={day} onChange={(e) => setDay(e.target.value as Weekday)} className="w-full rounded-md border border-[#D3DAD5] bg-white px-3 py-2 text-[13px]">
                    {WEEKDAYS.map((d) => <option key={d} value={d}>{FULL_DAY[d]}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[12.5px] font-semibold">Starts</span>
                  <input value={startsAt} onChange={(e) => setStartsAt(formatTimeInput(e.target.value))} placeholder="08:00" inputMode="numeric" maxLength={5}
                    className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 font-mono text-[13px] outline-none" />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[12.5px] font-semibold">Ends</span>
                  <input value={endsAt} onChange={(e) => setEndsAt(formatTimeInput(e.target.value))} placeholder="08:40" inputMode="numeric" maxLength={5}
                    className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 font-mono text-[13px] outline-none" />
                </label>
              </div>
              <div className="grid gap-3" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
                <label className="block">
                  <span className="mb-1.5 block text-[12.5px] font-semibold">Subject</span>
                  <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)} className="w-full rounded-md border border-[#D3DAD5] bg-white px-3 py-2 text-[13px]">
                    {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[12.5px] font-semibold">Room (optional)</span>
                  <input value={room} onChange={(e) => setRoom(e.target.value)} placeholder="e.g. Lab 1" maxLength={64}
                    className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none" />
                </label>
              </div>
              <div>
                <Button type="submit" variant="accent" disabled={saving}>{saving ? "Adding…" : "Add period"}</Button>
              </div>
            </>
          )}
        </form>
      </div>
    </Modal>
  );
}
