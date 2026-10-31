import { useEffect, useState, type ReactNode } from "react";
import {
  DOSE_STATUS_LABEL, fetchChildMedical, localDay, markMedicalNoticesRead, REQUEST_STATUS_LABEL, requestDraftProblem,
  requestMedication, withdrawMedicationRequest, type MedicationRequestDraft,
} from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/DataTable";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { ErrorLine, OutcomeBadge, when } from "../../components/medical/common";
import { useParentData } from "../../lib/parentContext";
import { useAsync } from "../../lib/useAsync";
import { MEDICAL_READ_EVENT } from "../../lib/useMedicalUnread";
import { useTenantSession } from "../../lib/sessionContext";
import { UPLOAD_LIMIT_BYTES } from "../../lib/uploadLimit";
import { uploadPrescription } from "../../lib/uploads";
import { ChildSwitcher } from "./ChildSwitcher";
import { confirmDialog } from "../../components/ui/Confirm";

/**
 * The selected child's sick bay visits (what the nurse saw and did, and
 * where they went), their medication and its record, and what the school
 * told you. Ask the nurse to give a prescribed medicine here, with a photo
 * of the prescription. Opening the page marks the child's notices read.
 */
export function ParentHealth() {
  const toast = useToast();
  const { tenant } = useTenantSession();
  const { child } = useParentData();
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading, error } = useAsync(() => (child ? fetchChildMedical(child.id) : Promise.resolve(null)), [child?.id, reloadKey]);
  const [asking, setAsking] = useState(false);

  const unread = data?.notices.filter((n) => !n.read_at).length ?? 0;
  useEffect(() => {
    if (!child || !unread) return;
    markMedicalNoticesRead(child.id).then(() => window.dispatchEvent(new Event(MEDICAL_READ_EVENT))).catch(() => {});
  }, [child, unread]);

  async function withdraw(id: string) {
    if (!(await confirmDialog({ title: "Withdraw this request?", confirmLabel: "Withdraw" }))) return;
    try {
      await withdrawMedicationRequest(id);
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not withdraw it.", "error");
    }
  }

  const today = localDay(new Date());

  return (
    <>
      <PageHead
        eyebrow={child ? `${child.cls} · ADM ${child.adm}` : "Health"}
        title={child ? `${child.first}'s health at school` : "Health"}
        blurb="Visits to the sick bay, medicine the school gives, and what the nurse has told you."
        actions={<div className="flex flex-wrap items-center gap-2"><ChildSwitcher />{child && <Button variant="accent" onClick={() => setAsking(true)}>Ask the nurse to give a medicine</Button>}</div>}
      />
      <div className="grid gap-5 px-7 py-6">
        {error ? <ErrorLine what="health records" error={error} /> : loading || !data ? <TableSkeleton rows={5} /> : (
          <>
            {data.notices.length > 0 && (
              <Card title="From the sick bay">
                {data.notices.slice(0, 5).map((n) => (
                  <div key={n.id} className="border-b border-line-soft px-4 py-2.5 last:border-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13.5px] font-semibold">{n.title}</span>
                      {!n.read_at && <Badge tone="info">New</Badge>}
                      <span className="ml-auto font-mono text-[11px] text-ink-faint">{when(n.created_at)}</span>
                    </div>
                    <p className="mt-0.5 text-[12.5px] text-ink-muted">{n.body}</p>
                  </div>
                ))}
              </Card>
            )}

            <Card title={`Sick bay visits · ${data.visits.length}`}>
              {data.visits.length === 0 ? (
                <EmptyState title="No visits to the sick bay" body={`When ${child?.first ?? "your child"} sees the school nurse, the visit shows here.`} />
              ) : data.visits.map((v) => (
                <div key={v.id} className="border-b border-line-soft px-4 py-3 last:border-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11.5px] text-ink-faint">{when(v.time_in)}</span>
                    <span className="text-[13.5px] font-semibold">{v.complaint}</span>
                    <OutcomeBadge outcome={v.outcome} />
                  </div>
                  <p className="mt-0.5 text-[12.5px] text-ink-muted">
                    {[v.temperature_c != null ? `Temperature ${v.temperature_c}°C` : null, v.assessment, v.treatment && `Treatment: ${v.treatment}`,
                      v.referred_to && `At: ${v.referred_to}`, v.follow_up && `Follow-up: ${v.follow_up}`].filter(Boolean).join(" · ")}
                  </p>
                  {(v.visit_medications ?? []).length > 0 && (
                    <p className="mt-0.5 text-[12.5px]">Medicine given: {v.visit_medications!.map((m) => `${m.drug} ${m.dose}`).join(", ")}</p>
                  )}
                </div>
              ))}
            </Card>

            <Card title="Medication at school">
              {data.schedules.length === 0 ? (
                <EmptyState title="No medication" body="Medicine the school gives on a schedule, prescribed by a doctor or asked for by you, shows here with each dose." />
              ) : data.schedules.map((s) => {
                const doses = data.doses.filter((d) => d.schedule_id === s.id);
                const running = !s.stopped_at && (!s.ends_on || s.ends_on >= today);
                return (
                  <div key={s.id} className="border-b border-line-soft px-4 py-3 last:border-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13.5px] font-semibold">{s.drug} {s.dose}</span>
                      <span className="text-[12.5px] text-ink-muted">at {s.times.join(", ")}, {s.starts_on} to {s.ends_on ?? "until stopped"}</span>
                      <Badge tone={running ? "ok" : "muted"}>{running ? "Running" : "Finished"}</Badge>
                    </div>
                    {doses.length > 0 && (
                      <ul className="mt-1 grid gap-0.5 text-[12px]">
                        {doses.slice(0, 9).map((d) => (
                          <li key={d.id}>
                            <span className="font-mono">{d.due_on} {d.due_time}</span> · {DOSE_STATUS_LABEL[d.status]}{d.note ? ` (${d.note})` : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </Card>

            {data.requests.length > 0 && (
              <Card title="Your requests">
                {data.requests.map((r) => (
                  <div key={r.id} className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-2.5 last:border-0">
                    <span className="text-[13px]">{r.drug} {r.dose}, {r.times_per_day}× a day from {r.starts_on}</span>
                    <Badge tone={r.status === "approved" ? "ok" : r.status === "declined" ? "warn" : "muted"}>{REQUEST_STATUS_LABEL[r.status]}</Badge>
                    {r.decision_note && <span className="text-[12px] text-ink-muted">{r.decision_note}</span>}
                    {r.status === "pending" && <Button className="ml-auto" onClick={() => void withdraw(r.id)}>Withdraw</Button>}
                  </div>
                ))}
              </Card>
            )}
          </>
        )}
      </div>
      {asking && child && (
        <RequestModal tenantId={tenant.id} studentId={child.id} first={child.first}
          onClose={() => setAsking(false)} onSent={() => { setAsking(false); setReloadKey((k) => k + 1); toast("Sent to the school nurse."); }} />
      )}
    </>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-white">
      <header className="border-b border-line px-4 py-3"><h2 className="text-body font-semibold">{title}</h2></header>
      {children}
    </section>
  );
}

const input = "w-full rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-forest";
const label = "mb-1 block text-[11.5px] font-semibold";

function RequestModal({ tenantId, studentId, first, onClose, onSent }: {
  tenantId: string; studentId: string; first: string; onClose: () => void; onSent: () => void;
}) {
  const [d, setD] = useState<MedicationRequestDraft>({
    drug: "", dose: "", times_per_day: 3, starts_on: localDay(new Date()), ends_on: null, instructions: "", prescriber: "",
  });
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<MedicationRequestDraft>) => setD((x) => ({ ...x, ...patch }));

  async function send() {
    const p = requestDraftProblem(d) ?? (file && file.size > UPLOAD_LIMIT_BYTES ? "That photo is too big to send." : null);
    if (p) { setProblem(p); return; }
    setBusy(true);
    try {
      const path = file ? await uploadPrescription({ tenantId, studentId, file }) : null;
      await requestMedication(tenantId, studentId, d, path);
      onSent();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Could not send the request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} eyebrow="Medication" title={`Ask the nurse to give ${first} a medicine`} footNote={problem ?? undefined}
      blurb="For medicine a doctor prescribed, or that you want the school to give. The nurse checks it and puts it on the medication round."
      actions={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={() => void send()}>Send to the nurse</Button></>}>
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <label className="block"><span className={label}>Medicine</span><input className={input} maxLength={120} value={d.drug} onChange={(e) => set({ drug: e.target.value })} placeholder="e.g. Amoxicillin" /></label>
        <label className="block"><span className={label}>Dose</span><input className={input} maxLength={120} value={d.dose} onChange={(e) => set({ dose: e.target.value })} placeholder="e.g. 250mg" /></label>
        <label className="block">
          <span className={label}>Times a day</span>
          <input type="number" min={1} max={8} className={input} value={d.times_per_day} onChange={(e) => set({ times_per_day: Math.round(Number(e.target.value)) })} />
        </label>
        <label className="block"><span className={label}>Doctor or clinic (if prescribed)</span><input className={input} maxLength={120} value={d.prescriber} onChange={(e) => set({ prescriber: e.target.value })} /></label>
        <label className="block"><span className={label}>First day</span><input type="date" className={input} value={d.starts_on} onChange={(e) => set({ starts_on: e.target.value })} /></label>
        <label className="block"><span className={label}>Last day</span><input type="date" className={input} value={d.ends_on ?? ""} onChange={(e) => set({ ends_on: e.target.value || null })} /></label>
        <label className="col-span-2 block"><span className={label}>Instructions</span><input className={input} maxLength={1000} value={d.instructions} onChange={(e) => set({ instructions: e.target.value })} placeholder="e.g. After meals, finish the course" /></label>
        <label className="col-span-2 block">
          <span className={label}>Photo of the prescription (optional)</span>
          <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-[12.5px]" />
        </label>
      </div>
    </Modal>
  );
}
