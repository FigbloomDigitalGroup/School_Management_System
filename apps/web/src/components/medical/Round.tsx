import { useState } from "react";
import {
  DOSE_STATUS_LABEL, fetchDoses, fetchSchedules, localDay, parseTimes, recordDose, roundList, saveSchedule,
  scheduleDraftProblem, stopSchedule, type DoseSlot, type DoseStatus, type LearnerHit, type SlotState,
} from "@figbloom/shared";
import { Badge, type Tone } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { TableSkeleton } from "../ui/Skeleton";
import { EmptyState } from "../ui/DataTable";
import { useToast } from "../ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { ErrorLine, hm } from "./common";
import { LearnerPicker } from "./VisitModal";

const STATE: Record<SlotState, { label: string; tone: Tone }> = {
  given: { label: "Given", tone: "ok" },
  refused: { label: "Refused", tone: "warn" },
  missed: { label: "Missed", tone: "warn" },
  upcoming: { label: "Later", tone: "muted" },
  due: { label: "Due now", tone: "info" },
  overdue: { label: "Overdue", tone: "warn" },
  unrecorded: { label: "Not recorded", tone: "muted" },
};

/**
 * Today's medication round: every prescribed dose in time order, due now,
 * later or overdue, and what was recorded. The nurse marks each given,
 * refused or missed; the time and who gave it are stamped by the database.
 * Below it, the schedules running today, with "Add" and "Stop".
 */
export function MedicationRound({ onOpenLearner }: { onOpenLearner: (id: string, name: string) => void }) {
  const toast = useToast();
  const { tenant } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  const today = localDay(new Date());
  const { data, loading, error } = useAsync(async () => {
    const [schedules, doses] = await Promise.all([fetchSchedules(tenant.id, today, today), fetchDoses(tenant.id, today, today)]);
    return { schedules, doses };
  }, [tenant.id, today, reloadKey]);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const round = data ? roundList(data.schedules, data.doses, new Date()) : [];
  const running = (data?.schedules ?? []).filter((s) => !s.stopped_at);

  async function mark(slot: DoseSlot, status: DoseStatus) {
    let note: string | undefined;
    if (status !== "given") {
      const why = window.prompt(status === "refused" ? "Why did they refuse? (optional)" : "Why was it missed? (optional)");
      if (why === null) return;
      note = why;
    }
    const key = `${slot.schedule.id}-${slot.time}`;
    setBusy(key);
    try {
      await recordDose(tenant.id, slot, status, note);
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? `Could not record: ${err.message}` : "Could not record.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function stop(id: string, what: string) {
    if (!window.confirm(`Stop ${what}? Doses already recorded are kept.`)) return;
    try {
      await stopSchedule(id);
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not stop it.", "error");
    }
  }

  if (error) return <ErrorLine what="today's round" error={error} />;
  if (loading || !data) return <TableSkeleton rows={6} />;

  return (
    <div className="grid gap-5">
      <section className="overflow-hidden rounded-lg border border-line bg-white">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-body font-semibold">Today's round · {round.length} {round.length === 1 ? "dose" : "doses"}</h2>
          <Button onClick={() => setReloadKey((k) => k + 1)}>Refresh</Button>
        </header>
        {round.length === 0 ? (
          <EmptyState title="Nothing on the round today" body="Add a learner's prescribed medicine below, or approve a family's request, and its doses appear here." />
        ) : round.map((slot) => {
          const key = `${slot.schedule.id}-${slot.time}`;
          const st = STATE[slot.state];
          return (
            <div key={key} className="flex flex-wrap items-center gap-3 border-b border-line-soft px-4 py-2.5 last:border-0">
              <span className="w-12 font-mono text-[13px]">{slot.time}</span>
              <button type="button" className="min-w-[180px] flex-1 text-left" onClick={() => onOpenLearner(slot.schedule.student_id, slot.schedule.students?.full_name ?? "")}>
                <div className="text-[13.5px] font-medium">{slot.schedule.students?.full_name}</div>
                <div className="text-[12px] text-ink-muted">{slot.schedule.drug} {slot.schedule.dose}{slot.schedule.notes ? ` · ${slot.schedule.notes}` : ""}</div>
              </button>
              <Badge tone={st.tone}>{st.label}{slot.dose ? ` ${hm(slot.dose.recorded_at)}` : ""}</Badge>
              <div className="flex gap-1.5">
                {(["given", "refused", "missed"] as DoseStatus[]).map((s) => (
                  <Button key={s} variant={s === "given" && !slot.dose ? "primary" : "secondary"} disabled={busy === key || slot.dose?.status === s}
                    onClick={() => void mark(slot, s)}>
                    {DOSE_STATUS_LABEL[s]}
                  </Button>
                ))}
              </div>
            </div>
          );
        })}
      </section>

      <section className="overflow-hidden rounded-lg border border-line bg-white">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-body font-semibold">Medication schedules · {running.length}</h2>
          <Button variant="accent" onClick={() => setAdding(true)}>Add a schedule</Button>
        </header>
        {running.length === 0 ? (
          <EmptyState title="No medication on a schedule" body="A learner on prescribed medicine (common for boarders) gets a schedule: the drug, dose, times of day and dates." />
        ) : running.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center gap-3 border-b border-line-soft px-4 py-2.5 last:border-0">
            <div className="min-w-[180px] flex-1">
              <div className="text-[13.5px] font-medium">{s.students?.full_name} <span className="font-mono text-[11px] text-ink-faint">{s.students?.classes?.name}</span></div>
              <div className="text-[12px] text-ink-muted">
                {s.drug} {s.dose} at {s.times.join(", ")} · until {s.ends_on ?? "stopped"} · {s.prescribed_by === "doctor" ? "prescribed" : "from the family"}{s.prescriber ? ` (${s.prescriber})` : ""}
              </div>
            </div>
            <Button onClick={() => void stop(s.id, `${s.drug} for ${s.students?.full_name ?? "this learner"}`)}>Stop</Button>
          </div>
        ))}
      </section>

      {adding && <ScheduleModal onClose={() => setAdding(false)} onSaved={() => { setAdding(false); setReloadKey((k) => k + 1); }} />}
    </div>
  );
}

const input = "w-full rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-forest";
const label = "mb-1 block text-[11.5px] font-semibold";

function ScheduleModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { tenant } = useTenantSession();
  const [learner, setLearner] = useState<LearnerHit | null>(null);
  const [drug, setDrug] = useState("");
  const [dose, setDose] = useState("");
  const [times, setTimes] = useState("08:00, 20:00");
  const [startsOn, setStartsOn] = useState(localDay(new Date()));
  const [endsOn, setEndsOn] = useState("");
  const [by, setBy] = useState<"doctor" | "parent">("doctor");
  const [prescriber, setPrescriber] = useState("");
  const [notes, setNotes] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    const parsed = parseTimes(times);
    const d = { student_id: learner?.id ?? "", drug, dose, times: parsed ?? [], starts_on: startsOn, ends_on: endsOn || null, prescribed_by: by, prescriber, notes };
    const p = !parsed ? "Give the times as 24-hour times, e.g. 07:00, 13:00, 19:00." : scheduleDraftProblem(d);
    if (p) { setProblem(p); return; }
    setBusy(true);
    try {
      await saveSchedule(tenant.id, d);
      onSaved();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} eyebrow="Medication" title="Add a schedule" footNote={problem ?? undefined}
      actions={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={() => void save()}>Save</Button></>}>
      <div className="grid gap-3">
        <LearnerPicker tenantId={tenant.id} value={learner} onChange={setLearner} />
        <div className="grid gap-2.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <label className="block"><span className={label}>Medicine</span><input className={input} value={drug} maxLength={120} onChange={(e) => setDrug(e.target.value)} placeholder="e.g. Amoxicillin" /></label>
          <label className="block"><span className={label}>Dose</span><input className={input} value={dose} maxLength={120} onChange={(e) => setDose(e.target.value)} placeholder="e.g. 250mg" /></label>
          <label className="block"><span className={label}>Times of day</span><input className={input} value={times} onChange={(e) => setTimes(e.target.value)} placeholder="07:00, 13:00, 19:00" /></label>
          <label className="block">
            <span className={label}>Given by</span>
            <select className={input} value={by} onChange={(e) => setBy(e.target.value as "doctor" | "parent")}>
              <option value="doctor">A doctor's prescription</option>
              <option value="parent">The parent</option>
            </select>
          </label>
          <label className="block"><span className={label}>First day</span><input type="date" className={input} value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></label>
          <label className="block"><span className={label}>Last day (blank: until stopped)</span><input type="date" className={input} value={endsOn} onChange={(e) => setEndsOn(e.target.value)} /></label>
          <label className="block"><span className={label}>Doctor or clinic</span><input className={input} value={prescriber} maxLength={120} onChange={(e) => setPrescriber(e.target.value)} /></label>
          <label className="block"><span className={label}>Notes</span><input className={input} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. After meals" /></label>
        </div>
      </div>
    </Modal>
  );
}
