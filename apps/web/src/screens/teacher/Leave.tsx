import { useState } from "react";
import { formatShortDate } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { TextArea, TextField } from "../../components/ui/Field";
import { EmptyState } from "../../components/ui/DataTable";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { cancelLeaveRequest, fetchMyLeaveRequests, requestLeave, type LeaveStatus } from "../../lib/leave";

const STATUS_TONE: Record<LeaveStatus, "ok" | "warn" | "muted"> = {
  pending: "warn", approved: "ok", rejected: "muted", cancelled: "muted",
};
const STATUS_LABEL: Record<LeaveStatus, string> = {
  pending: "Awaiting review", approved: "Approved", rejected: "Rejected", cancelled: "Cancelled",
};

/**
 * A teacher's own leave history plus a form to request more — the principal
 * reviews everything from Admin → Leave requests. Nothing here touches the
 * timetable yet (that's the next phase); this is just the request/approve
 * record itself.
 */
export function TeacherLeave() {
  const toast = useToast();
  const { profile, tenant } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  const { data: requests, loading, error } = useAsync(() => fetchMyLeaveRequests(profile.id), [profile.id, reloadKey]);
  const reload = () => setReloadKey((k) => k + 1);

  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!startsOn || !endsOn) { toast("Pick a start and end date."); return; }
    if (endsOn < startsOn) { toast("The end date is before the start date."); return; }
    setSaving(true);
    try {
      await requestLeave({ tenantId: tenant.id, teacherId: profile.id, startsOn, endsOn, reason });
      toast("Leave requested — the principal will review it.");
      setStartsOn("");
      setEndsOn("");
      setReason("");
      reload();
    } catch (err) {
      toast(err instanceof Error ? `Could not request leave: ${err.message}` : "Could not request leave.");
    } finally {
      setSaving(false);
    }
  }

  async function cancel(id: string) {
    if (!window.confirm("Withdraw this leave request?")) return;
    try {
      await cancelLeaveRequest(id);
      toast("Request withdrawn.");
      reload();
    } catch (err) {
      toast(err instanceof Error ? `Could not withdraw: ${err.message}` : "Could not withdraw.");
    }
  }

  return (
    <>
      <PageHead eyebrow="Leave" title="Leave" blurb="Request time off — the principal approves or rejects it, and you'll be notified either way." />

      <div className="grid gap-5 px-7 py-6" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.3fr)" }}>
        <div className="grid content-start gap-3.5 rounded-lg border border-line bg-white p-4">
          <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <TextField id="leave-start" label="From" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
            <TextField id="leave-end" label="To" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
          </div>
          <TextArea
            id="leave-reason" label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Family event out of town"
          />
          <Button variant="accent" disabled={!startsOn || !endsOn || saving} onClick={() => void submit()}>
            {saving ? "Requesting…" : "Request leave"}
          </Button>
        </div>

        <div className="overflow-hidden rounded-lg border border-line bg-white">
          <header className="border-b border-line px-4 py-3">
            <h2 className="text-body font-semibold">Your requests</h2>
          </header>
          <div>
            {error ? (
              <p className="px-4 py-3.5 text-[12.5px] text-warn-ink">Could not load your leave requests: {error.message}</p>
            ) : loading || !requests ? (
              <div className="p-4"><TableSkeleton rows={4} /></div>
            ) : requests.length === 0 ? (
              <EmptyState title="Nothing requested yet" body="Your leave requests will show up here once you submit one." />
            ) : (
              requests.map((r) => (
                <div key={r.id} className="border-b border-line-soft px-4 py-3 last:border-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium">{formatShortDate(r.starts_on)} – {formatShortDate(r.ends_on)}</div>
                      {r.reason && <p className="mt-0.5 text-[12px] text-ink-faint">{r.reason}</p>}
                      {r.review_note && <p className="mt-1 text-[12px] italic text-ink-muted">"{r.review_note}"</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                      {r.status === "pending" && (
                        <button type="button" onClick={() => void cancel(r.id)} className="text-[12px] font-semibold text-warn-ink hover:underline">
                          Withdraw
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}
