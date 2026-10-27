import { useEffect, useState } from "react";
import {
  addVisitMedication, fetchMedicalStock, fetchStudentHealth, findMedicalLearners, logVisit, markVisitAttendance,
  offersAttendanceMark, VISIT_OUTCOME_LABEL, outcomeClosesVisit, pushMedicalNotices, updateVisit, VISIT_OUTCOMES, sickBayVisitProblem,
  type LearnerHit, type SickBayVisit, type SickBayVisitDraft, type VisitOutcome,
} from "@figbloom/shared";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { useToast } from "../ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { fromLocalInput, HealthAlerts, hm, toLocalInput } from "./common";

const input = "w-full rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-forest";
const label = "mb-1 block text-[11.5px] font-semibold";

function draftFrom(v: SickBayVisit | null): SickBayVisitDraft {
  return {
    student_id: v?.student_id ?? null,
    time_in: v?.time_in ?? new Date().toISOString(),
    complaint: v?.complaint ?? "",
    temperature_c: v?.temperature_c ?? null,
    pulse_bpm: v?.pulse_bpm ?? null,
    observations: v?.observations ?? "",
    assessment: v?.assessment ?? "",
    treatment: v?.treatment ?? "",
    outcome: v?.outcome ?? null,
    referred_to: v?.referred_to ?? "",
    time_out: v?.time_out ?? null,
    follow_up: v?.follow_up ?? "",
  };
}

interface MedLine { drug: string; dose: string; time: string; stockId: string; qty: string }
const blankMed = (): MedLine => ({ drug: "", dose: "", time: hm(new Date().toISOString()), stockId: "", qty: "1" });

/**
 * Log a sick bay visit, or carry one on: what brought them in, what the
 * nurse saw and did, medicine given (optionally off the Medical stock), and
 * where they went. Allergies and conditions sit at the top the moment a
 * learner is picked. A learner sent home, referred or admitted gets a clear
 * "mark in the register" action; nothing changes the register by itself.
 */
export function VisitModal({ visit, onClose, onSaved }: { visit: SickBayVisit | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { tenant } = useTenantSession();
  const [saved, setSaved] = useState<SickBayVisit | null>(visit);
  const [d, setD] = useState<SickBayVisitDraft>(() => draftFrom(visit));
  const [learner, setLearner] = useState<LearnerHit | null>(visit?.students
    ? { id: visit.student_id, full_name: visit.students.full_name, admission_no: visit.students.admission_no, class_name: visit.students.classes?.name ?? null }
    : null);
  const [meds, setMeds] = useState<MedLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const { data: health, loading: healthLoading } = useAsync(
    () => (learner ? fetchStudentHealth(learner.id) : Promise.resolve(null)), [learner?.id]);
  const { data: stock } = useAsync(() => fetchMedicalStock(tenant.id).catch(() => []), [tenant.id]);

  const set = (patch: Partial<SickBayVisitDraft>) => setD((x) => ({ ...x, ...patch }));
  function setOutcome(outcome: VisitOutcome | null) {
    // leaving the sick bay stamps the time out; staying clears it
    const closes = outcomeClosesVisit(outcome, d.referred_to);
    set({ outcome, time_out: closes ? (d.time_out ?? new Date().toISOString()) : null });
  }

  async function save() {
    const draft = { ...d, student_id: learner?.id ?? null };
    const p = sickBayVisitProblem(draft);
    const badMed = meds.find((m) => (m.drug.trim() || m.dose.trim()) && (!m.drug.trim() || !m.dose.trim() || !/^\d\d:\d\d$/.test(m.time)));
    if (p || badMed) { setProblem(p ?? "Each medicine needs a name, a dose and the time given."); return; }
    setProblem(null);
    setBusy(true);
    try {
      const row = saved ? await updateVisit(saved.id, draft) : await logVisit(tenant.id, draft);
      // a time given is on the day of the visit
      const day = new Date(row.time_in);
      for (const m of meds.filter((x) => x.drug.trim())) {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(m.time.slice(0, 2)), Number(m.time.slice(3, 5)));
        const qty = m.stockId ? Math.max(1, Math.round(Number(m.qty) || 1)) : null;
        await addVisitMedication(tenant.id, row.id, {
          drug: m.drug, dose: m.dose, given_at: at.toISOString(), inventory_item_id: m.stockId || null, stock_quantity: qty,
        });
      }
      if (row.outcome && row.outcome !== saved?.outcome) void pushMedicalNotices(row.id);
      setSaved(row);
      setMeds([]);
      onSaved();
      if (!offersAttendanceMark(row.outcome)) onClose();
      else toast("Saved. You can mark them in today's register below.");
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Could not save the visit.");
    } finally {
      setBusy(false);
    }
  }

  async function markRegister(mark: "excused" | "absent") {
    if (!saved) return;
    setBusy(true);
    try {
      await markVisitAttendance(saved.id, mark);
      setSaved({ ...saved, attendance_mark: mark, attendance_marked_at: new Date().toISOString() });
      onSaved();
      toast(`${learner?.full_name ?? "The learner"} is marked ${mark} in today's register.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not mark the register.", "error");
    } finally {
      setBusy(false);
    }
  }

  const offerRegister = !!saved && offersAttendanceMark(saved.outcome) && saved.outcome === d.outcome;

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Sick bay"
      title={saved ? `Visit: ${learner?.full_name ?? ""}` : "New visit"}
      width={760}
      footNote={problem ?? undefined}
      actions={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>{saved ? "Save changes" : "Log visit"}</Button>
        </>
      }
    >
      <div className="grid gap-3.5">
        {saved ? (
          <p className="text-[13px] text-ink-muted">{learner?.full_name} · ADM {learner?.admission_no}{learner?.class_name ? ` · ${learner.class_name}` : ""}</p>
        ) : (
          <LearnerPicker tenantId={tenant.id} value={learner} onChange={setLearner} />
        )}
        {learner && <HealthAlerts health={health} loading={healthLoading} />}

        <div className="grid gap-2.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <label className="block">
            <span className={label}>Time in</span>
            <input type="datetime-local" className={input} value={toLocalInput(d.time_in)}
              onChange={(e) => e.target.value && set({ time_in: fromLocalInput(e.target.value) })} />
          </label>
          <label className="block">
            <span className={label}>Complaint</span>
            <input className={input} maxLength={300} value={d.complaint} onChange={(e) => set({ complaint: e.target.value })} placeholder="e.g. Headache, fever" />
          </label>
          <label className="block">
            <span className={label}>Temperature (°C)</span>
            <input type="number" step="0.1" min={30} max={45} className={input} value={d.temperature_c ?? ""}
              onChange={(e) => set({ temperature_c: e.target.value === "" ? null : Number(e.target.value) })} />
          </label>
          <label className="block">
            <span className={label}>Pulse (beats a minute)</span>
            <input type="number" min={20} max={250} className={input} value={d.pulse_bpm ?? ""}
              onChange={(e) => set({ pulse_bpm: e.target.value === "" ? null : Math.round(Number(e.target.value)) })} />
          </label>
        </div>
        <Area label="Other observations" value={d.observations} onChange={(observations) => set({ observations })} placeholder="e.g. BP 110/70, pale, vomited once" />
        <Area label="Assessment" value={d.assessment} onChange={(assessment) => set({ assessment })} />
        <Area label="Treatment given" value={d.treatment} onChange={(treatment) => set({ treatment })} placeholder="e.g. Rest, oral fluids, cold compress" />

        <section className="rounded-lg border border-line p-3">
          <h3 className="text-[12.5px] font-semibold">Medicine given</h3>
          {(saved?.visit_medications ?? []).length > 0 && (
            <ul className="mt-1.5 grid gap-0.5 text-[12.5px]">
              {saved!.visit_medications!.map((m) => (
                <li key={m.id}><span className="font-mono">{hm(m.given_at)}</span> · {m.drug} {m.dose}{m.stock_quantity ? ` (${m.stock_quantity} from stock)` : ""}</li>
              ))}
            </ul>
          )}
          {meds.map((m, i) => (
            <div key={i} className="mt-2 grid items-end gap-2" style={{ gridTemplateColumns: "1.4fr 1fr 0.7fr 1.4fr 0.5fr auto" }}>
              <input aria-label="Medicine" className={input} placeholder="Medicine" value={m.drug} onChange={(e) => setMeds(meds.map((x, j) => (j === i ? { ...x, drug: e.target.value } : x)))} />
              <input aria-label="Dose" className={input} placeholder="Dose, e.g. 500mg" value={m.dose} onChange={(e) => setMeds(meds.map((x, j) => (j === i ? { ...x, dose: e.target.value } : x)))} />
              <input aria-label="Time given" type="time" className={input} value={m.time} onChange={(e) => setMeds(meds.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)))} />
              <select aria-label="From stock" className={input} value={m.stockId} onChange={(e) => setMeds(meds.map((x, j) => (j === i ? { ...x, stockId: e.target.value } : x)))}>
                <option value="">Not from stock</option>
                {(stock ?? []).map((s) => <option key={s.id} value={s.id} disabled={s.quantity < 1}>{s.name} ({s.quantity} left)</option>)}
              </select>
              <input aria-label="Units from stock" type="number" min={1} className={input} disabled={!m.stockId} value={m.qty} onChange={(e) => setMeds(meds.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
              <button type="button" aria-label="Remove" className="px-1.5 text-ink-muted" onClick={() => setMeds(meds.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button onClick={() => setMeds([...meds, blankMed()])}>Add a medicine</Button>
            <span className="text-[11.5px] text-ink-faint">Saved with the visit. Medicine given can't be edited afterwards; add a note to correct one.</span>
          </div>
        </section>

        <div className="grid gap-2.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <label className="block">
            <span className={label}>Outcome</span>
            <select className={input} value={d.outcome ?? ""} onChange={(e) => setOutcome((e.target.value || null) as VisitOutcome | null)}>
              <option value="">Still being seen</option>
              {VISIT_OUTCOMES.map((o) => <option key={o} value={o}>{VISIT_OUTCOME_LABEL[o]}</option>)}
            </select>
          </label>
          {(d.outcome === "hospital" || d.outcome === "admitted") && (
            <label className="block">
              <span className={label}>{d.outcome === "hospital" ? "Referred to" : "Admitted at (blank: the sick bay)"}</span>
              <input className={input} maxLength={200} value={d.referred_to}
                onChange={(e) => set({ referred_to: e.target.value, ...(d.outcome === "admitted" ? { time_out: e.target.value.trim() ? (d.time_out ?? new Date().toISOString()) : null } : {}) })}
                placeholder="Hospital or clinic" />
            </label>
          )}
          <label className="block">
            <span className={label}>Time out (blank: still in the sick bay)</span>
            <input type="datetime-local" className={input} value={d.time_out ? toLocalInput(d.time_out) : ""}
              onChange={(e) => set({ time_out: e.target.value ? fromLocalInput(e.target.value) : null })} />
          </label>
        </div>
        <Area label="Follow-up" value={d.follow_up} onChange={(follow_up) => set({ follow_up })} placeholder="e.g. Check temperature again at 4pm" />

        {offerRegister && (
          <section className="rounded-lg border border-line bg-page p-3">
            <h3 className="text-[12.5px] font-semibold">Today's register</h3>
            {saved?.attendance_mark ? (
              <p className="mt-1 text-[12.5px] text-ink-muted">Marked {saved.attendance_mark} in the register, with the note "Sick bay".</p>
            ) : (
              <>
                <p className="mt-1 text-[12.5px] text-ink-muted">
                  {learner?.full_name ?? "The learner"} won't be in class. Mark them in that day's register so their class teacher and the office see why.
                </p>
                <div className="mt-2 flex gap-2">
                  <Button variant="primary" disabled={busy} onClick={() => void markRegister("excused")}>Mark excused</Button>
                  <Button disabled={busy} onClick={() => void markRegister("absent")}>Mark absent</Button>
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
}

function Area({ label: text, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <span className={label}>{text}</span>
      <textarea rows={2} maxLength={2000} className={`${input} resize-y`} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** Name or admission number, at least two characters; picks one learner. */
export function LearnerPicker({ tenantId, value, onChange }: { tenantId: string; value: LearnerHit | null; onChange: (l: LearnerHit | null) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<LearnerHit[]>([]);
  useEffect(() => {
    if (value || q.trim().length < 2) { setHits([]); return; }
    let alive = true;
    const t = window.setTimeout(() => {
      findMedicalLearners(tenantId, q).then((h) => { if (alive) setHits(h); }).catch(() => { if (alive) setHits([]); });
    }, 250);
    return () => { alive = false; window.clearTimeout(t); };
  }, [q, tenantId, value]);

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-line bg-page px-3 py-2">
        <span className="text-[13.5px] font-semibold">{value.full_name} <span className="font-mono text-[11px] font-normal text-ink-faint">ADM {value.admission_no}{value.class_name ? ` · ${value.class_name}` : ""}</span></span>
        <Button onClick={() => { onChange(null); setQ(""); }}>Change</Button>
      </div>
    );
  }
  return (
    <div className="relative">
      <label className="block">
        <span className={label}>Learner</span>
        <input className={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or admission number" autoComplete="off" />
      </label>
      {hits.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-line bg-white shadow">
          {hits.map((h) => (
            <li key={h.id}>
              <button type="button" className="w-full px-3 py-2 text-left text-[13px] hover:bg-page" onClick={() => onChange(h)}>
                {h.full_name} <span className="font-mono text-[11px] text-ink-faint">ADM {h.admission_no}{h.class_name ? ` · ${h.class_name}` : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
