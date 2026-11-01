import type { ReactNode } from "react";
import {
  DOSE_STATUS_LABEL, openMedicalRecord, REQUEST_STATUS_LABEL,
} from "@figbloom/shared";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Skeleton } from "../ui/Skeleton";
import { useAsync } from "../../lib/useAsync";
import { ErrorLine, HealthAlerts, OutcomeBadge, when } from "./common";

const fmtDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" });

/**
 * One learner's medical record, for the nurse: allergies and conditions
 * first and loud, then the rest of the health record, every sick bay visit,
 * medication schedules and the last 60 days of doses, and their family's
 * requests. Opening it is written to the school's audit trail (who, when,
 * which learner) by medical_record() in the database.
 */
export function MedicalRecordModal({ studentId, name, onClose }: { studentId: string; name: string; onClose: () => void }) {
  const { data, loading, error } = useAsync(() => openMedicalRecord(studentId), [studentId]);
  const h = data?.health ?? null;

  return (
    <Modal open onClose={onClose} eyebrow="Medical record" title={name} width={760}
      footNote="Opening this record is noted in the school's audit trail."
      actions={<Button onClick={onClose}>Close</Button>}>
      {error ? <ErrorLine what="the record" error={error} /> : loading || !data ? (
        <div className="grid gap-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-24 w-full" /></div>
      ) : (
        <div className="grid gap-4">
          <HealthAlerts health={h} />
          {h && (
            <dl className="grid gap-x-4 gap-y-1.5 text-[12.5px]" style={{ gridTemplateColumns: "max-content 1fr" }}>
              {h.blood_group && <><dt className="text-ink-muted">Blood group</dt><dd>{h.blood_group}</dd></>}
              {h.dietary_needs && <><dt className="text-ink-muted">Diet</dt><dd>{h.dietary_needs}</dd></>}
              {h.special_needs && <><dt className="text-ink-muted">Support needs</dt><dd>{h.special_needs}</dd></>}
              {h.notes && <><dt className="text-ink-muted">Notes</dt><dd>{h.notes}</dd></>}
              {(h.doctor_name || h.doctor_phone) && <><dt className="text-ink-muted">Family doctor</dt><dd>{[h.doctor_name, h.doctor_phone].filter(Boolean).join(" · ")}</dd></>}
              {(h.emergency_name || h.emergency_phone) && (
                <><dt className="text-ink-muted">Emergency contact</dt><dd>{[h.emergency_name, h.emergency_relationship, h.emergency_phone].filter(Boolean).join(" · ")}</dd></>
              )}
            </dl>
          )}

          <Section title={`Sick bay visits · ${data.visits.length}`}>
            {data.visits.length === 0 ? <Empty>No visits yet.</Empty> : data.visits.map((v) => (
              <div key={v.id} className="border-b border-line-soft py-2 last:border-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[11.5px] text-ink-faint">{when(v.time_in)}</span>
                  <span className="text-[13px] font-semibold">{v.complaint}</span>
                  <OutcomeBadge outcome={v.outcome} />
                </div>
                <p className="mt-0.5 text-[12.5px] text-ink-muted">
                  {[v.temperature_c != null ? `${v.temperature_c}°C` : null, v.pulse_bpm != null ? `pulse ${v.pulse_bpm}` : null, v.observations,
                    v.assessment && `Assessment: ${v.assessment}`, v.treatment && `Treatment: ${v.treatment}`,
                    v.referred_to && `At: ${v.referred_to}`, v.follow_up && `Follow-up: ${v.follow_up}`].filter(Boolean).join(" · ")}
                </p>
                {(v.visit_medications ?? []).length > 0 && (
                  <p className="mt-0.5 text-[12.5px]">Given: {v.visit_medications!.map((m) => `${m.drug} ${m.dose}`).join(", ")}</p>
                )}
              </div>
            ))}
          </Section>

          <Section title="Medication">
            {data.schedules.length === 0 ? <Empty>No medication on a schedule.</Empty> : data.schedules.map((s) => (
              <p key={s.id} className="py-1 text-[12.5px]">
                <span className="font-semibold">{s.drug} {s.dose}</span> at {s.times.join(", ")} · {fmtDay(s.starts_on)} to {s.ends_on ? fmtDay(s.ends_on) : "until stopped"}
                {s.stopped_at ? " · stopped" : ""}{s.prescriber ? ` · ${s.prescriber}` : ""}
              </p>
            ))}
            {data.doses.length > 0 && (
              <p className="mt-1 text-[12px] text-ink-muted">
                Last 60 days: {(["given", "refused", "missed"] as const).map((k) => `${data.doses.filter((d) => d.status === k).length} ${DOSE_STATUS_LABEL[k].toLowerCase()}`).join(", ")}.
              </p>
            )}
          </Section>

          {data.requests.length > 0 && (
            <Section title="Requests from the family">
              {data.requests.map((r) => (
                <p key={r.id} className="py-1 text-[12.5px]">
                  {r.drug} {r.dose}, {r.times_per_day}× a day from {fmtDay(r.starts_on)} · {REQUEST_STATUS_LABEL[r.status]}
                </p>
              ))}
            </Section>
          )}
        </div>
      )}
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 font-mono text-micro tracking-[0.1em] text-ink-muted">{title.toUpperCase()}</h3>
      {children}
    </section>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="text-[12.5px] text-ink-faint">{children}</p>;
