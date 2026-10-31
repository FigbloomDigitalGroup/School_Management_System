import { useState } from "react";
import {
  approveRequest, declineRequest, fetchPendingRequests, parseTimes, suggestTimes, type MedicationRequest,
} from "@figbloom/shared";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/DataTable";
import { Modal } from "../ui/Modal";
import { TableSkeleton } from "../ui/Skeleton";
import { useToast } from "../ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { privateDocUrl } from "../../lib/uploads";
import { ErrorLine, when } from "./common";
import { confirmDialog, promptDialog } from "../ui/Confirm";

const input = "w-full rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-forest";
const label = "mb-1 block text-[11.5px] font-semibold";

/**
 * Families' requests to give their child a prescribed medicine, with the
 * prescription photo if they sent one. Approving one makes a schedule (the
 * nurse sets the round times and can correct the details from the
 * prescription); declining one says why.
 */
export function MedicationRequests({ onChanged }: { onChanged: () => void }) {
  const toast = useToast();
  const { tenant } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading, error } = useAsync(() => fetchPendingRequests(tenant.id), [tenant.id, reloadKey]);
  const [deciding, setDeciding] = useState<MedicationRequest | null>(null);

  async function openPhoto(path: string) {
    try {
      window.open(await privateDocUrl(path, 300), "_blank", "noopener");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not open the photo.", "error");
    }
  }

  if (error) return <ErrorLine what="requests" error={error} />;
  if (loading || !data) return <TableSkeleton rows={3} />;

  return (
    <section className="overflow-hidden rounded-lg border border-line bg-white">
      <header className="border-b border-line px-4 py-3"><h2 className="text-body font-semibold">Waiting for you · {data.length}</h2></header>
      {data.length === 0 ? (
        <EmptyState title="No requests waiting" body="When a parent asks the school to give their child a prescribed medicine, it comes here for you to approve." />
      ) : data.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center gap-3 border-b border-line-soft px-4 py-3 last:border-0">
          <div className="min-w-[200px] flex-1">
            <div className="text-[13.5px] font-medium">{r.students?.full_name} <span className="font-mono text-[11px] text-ink-faint">{r.students?.classes?.name}</span></div>
            <div className="text-[12.5px]">{r.drug} {r.dose}, {r.times_per_day}× a day, {r.starts_on} to {r.ends_on ?? "no end date"}</div>
            {(r.instructions || r.prescriber) && <div className="text-[12px] text-ink-muted">{[r.prescriber, r.instructions].filter(Boolean).join(" · ")}</div>}
            <div className="font-mono text-[10.5px] text-ink-faint">Asked {when(r.created_at)}</div>
          </div>
          {r.prescription_path && <Button onClick={() => void openPhoto(r.prescription_path!)}>Prescription</Button>}
          <Button variant="primary" onClick={() => setDeciding(r)}>Review</Button>
        </div>
      ))}
      {deciding && (
        <DecideModal request={deciding} onClose={() => setDeciding(null)}
          onDone={() => { setDeciding(null); setReloadKey((k) => k + 1); onChanged(); }} />
      )}
    </section>
  );
}

function DecideModal({ request: r, onClose, onDone }: { request: MedicationRequest; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [drug, setDrug] = useState(r.drug);
  const [dose, setDose] = useState(r.dose);
  const [times, setTimes] = useState(suggestTimes(r.times_per_day).join(", "));
  const [startsOn, setStartsOn] = useState(r.starts_on);
  const [endsOn, setEndsOn] = useState(r.ends_on ?? "");
  const [notes, setNotes] = useState(r.instructions ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function approve() {
    const parsed = parseTimes(times);
    if (!parsed) { setProblem("Give the round times as 24-hour times, e.g. 07:00, 13:00, 19:00."); return; }
    if (parsed.length !== r.times_per_day && !(await confirmDialog({ title: "Approve with a different number of doses?", body: `The family asked for ${r.times_per_day} a day; you've set ${parsed.length}.`, confirmLabel: "Approve anyway" }))) return;
    setBusy(true);
    try {
      await approveRequest(r.id, { drug, dose, times: parsed, starts_on: startsOn, ends_on: endsOn || null, notes });
      toast("Approved. It's on the round.");
      onDone();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Could not approve.");
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    const why = await promptDialog({ title: "Decline this request?", body: "The family sees your reason.", label: "Tell the family why", confirmLabel: "Decline" });
    if (why === null) return;
    setBusy(true);
    try {
      await declineRequest(r.id, why);
      onDone();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Could not decline.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} eyebrow="Medication request" title={r.students?.full_name ?? "Request"} footNote={problem ?? undefined}
      blurb="Check it against the prescription, set the times of the round, and approve. Or decline it and say why."
      actions={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" disabled={busy} onClick={() => void decline()}>Decline</Button>
        <Button variant="primary" disabled={busy} onClick={() => void approve()}>Approve</Button>
      </>}>
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <label className="block"><span className={label}>Medicine</span><input className={input} value={drug} maxLength={120} onChange={(e) => setDrug(e.target.value)} /></label>
        <label className="block"><span className={label}>Dose</span><input className={input} value={dose} maxLength={120} onChange={(e) => setDose(e.target.value)} /></label>
        <label className="block"><span className={label}>Times of day ({r.times_per_day}× asked)</span><input className={input} value={times} onChange={(e) => setTimes(e.target.value)} /></label>
        <label className="block"><span className={label}>Notes for the round</span><input className={input} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} /></label>
        <label className="block"><span className={label}>First day</span><input type="date" className={input} value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></label>
        <label className="block"><span className={label}>Last day</span><input type="date" className={input} value={endsOn} onChange={(e) => setEndsOn(e.target.value)} /></label>
      </div>
    </Modal>
  );
}
