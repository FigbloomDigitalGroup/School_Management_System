import { useState } from "react";
import {
  decideLeaveRequest, fetchAllLeaveRequests, formatShortDate, LEAVE_STATUS_LABEL, LEAVE_STATUS_TONE, splitLeaveRequests, type LeaveRequestRow,
} from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable } from "../../components/ui/DataTable";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";

/**
 * Every leave request in the school, pending ones first. Approving or
 * rejecting also sends the teacher an in-app notice (same `user`-audience
 * mechanism as a promotion notice) — nobody finds out only by asking.
 */
export function AdminLeave() {
  const toast = useToast();
  const { profile, tenant } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  const { data: requests, loading, error } = useAsync(() => fetchAllLeaveRequests(tenant.id), [tenant.id, reloadKey]);
  // A reloadKey refetch keeps what's already on screen; switching to a different school's
  // data must not show the previous one's meanwhile — skeleton for those only.
  const [loadedFor, setLoadedFor] = useState(tenant.id);
  if (!loading && loadedFor !== tenant.id) setLoadedFor(tenant.id);
  const showSkeleton = loading && (!requests || loadedFor !== tenant.id);
  const reload = () => setReloadKey((k) => k + 1);

  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  async function review(r: LeaveRequestRow, status: "approved" | "rejected") {
    setReviewingId(r.id);
    try {
      const { notifyError } = await decideLeaveRequest({
        tenantId: tenant.id, reviewerId: profile.id, request: r, status, note: noteDrafts[r.id] ?? "",
      });

      if (notifyError) toast(`Recorded, but ${r.teacherName} could not be notified: ${notifyError}`, "error");
      else toast(`${status === "approved" ? "Approved" : "Rejected"} — ${r.teacherName} notified.`);
      reload();
    } catch (err) {
      toast(err instanceof Error ? `Could not update: ${err.message}` : "Could not update.", "error");
    } finally {
      setReviewingId(null);
    }
  }

  const { pending, decided } = splitLeaveRequests(requests ?? []);

  return (
    <>
      <PageHead
        eyebrow="Staff"
        title="Leave requests"
        blurb="Approve or reject a teacher's time off — they're notified in-app either way."
      />

      <div className="grid gap-5 px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load leave requests: {error.message}
          </p>
        ) : showSkeleton || !requests ? (
          <TableSkeleton rows={6} />
        ) : (
          <>
            <DataTable
              title={`Awaiting review · ${pending.length}`}
              columns={[
                { key: "teacher", header: "Teacher", width: "1.2fr", render: (r: LeaveRequestRow) => <Cell sub={r.reason ?? undefined}>{r.teacherName}</Cell> },
                { key: "dates", header: "Dates", render: (r: LeaveRequestRow) => <span className="text-[13px]">{formatShortDate(r.starts_on)} – {formatShortDate(r.ends_on)}</span> },
                {
                  key: "note", header: "Note (optional)", width: "1.4fr",
                  render: (r: LeaveRequestRow) => (
                    <input
                      value={noteDrafts[r.id] ?? ""}
                      onChange={(e) => setNoteDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                      placeholder="e.g. Cover arranged with Given Jim"
                      aria-label={`Note for ${r.teacherName}'s request`}
                      className="w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-[12.5px] outline-none"
                    />
                  ),
                },
                {
                  key: "actions", header: "", align: "right", width: "1.2fr",
                  render: (r: LeaveRequestRow) => (
                    <div className="flex justify-end gap-2">
                      <Button disabled={reviewingId === r.id} onClick={() => void review(r, "rejected")}>Reject</Button>
                      <Button variant="accent" disabled={reviewingId === r.id} onClick={() => void review(r, "approved")}>Approve</Button>
                    </div>
                  ),
                },
              ]}
              rows={pending}
              rowKey={(r) => r.id}
              minWidth="760px"
              empty={{ title: "Nothing awaiting review", body: "Leave requests from teachers will show up here." }}
            />

            <DataTable
              title="Past requests"
              columns={[
                { key: "teacher", header: "Teacher", width: "1.2fr", render: (r: LeaveRequestRow) => <Cell sub={r.reason ?? undefined}>{r.teacherName}</Cell> },
                { key: "dates", header: "Dates", render: (r: LeaveRequestRow) => <span className="text-[13px]">{formatShortDate(r.starts_on)} – {formatShortDate(r.ends_on)}</span> },
                { key: "note", header: "Note", width: "1.4fr", render: (r: LeaveRequestRow) => <span className="text-[12.5px] text-ink-faint">{r.review_note ?? "—"}</span> },
                { key: "status", header: "", align: "right", render: (r: LeaveRequestRow) => <Badge tone={LEAVE_STATUS_TONE[r.status]}>{LEAVE_STATUS_LABEL[r.status]}{r.source === "hr" ? " · Figbloom HR" : ""}</Badge> },
              ]}
              rows={decided}
              rowKey={(r) => r.id}
              minWidth="760px"
              empty={{ title: "No history yet", body: "Reviewed and withdrawn requests will show up here." }}
            />
          </>
        )}
      </div>
    </>
  );
}
