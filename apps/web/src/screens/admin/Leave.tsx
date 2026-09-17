import { useState } from "react";
import { formatShortDate, supabase } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable } from "../../components/ui/DataTable";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { fetchAllLeaveRequests, reviewLeaveRequest, type LeaveRequestRow, type LeaveStatus } from "../../lib/leave";

const STATUS_TONE: Record<LeaveStatus, "ok" | "warn" | "muted"> = {
  pending: "warn", approved: "ok", rejected: "muted", cancelled: "muted",
};
const STATUS_LABEL: Record<LeaveStatus, string> = {
  pending: "Awaiting review", approved: "Approved", rejected: "Rejected", cancelled: "Cancelled",
};

/**
 * Every leave request in the school, pending ones first. Approving or
 * rejecting also sends the teacher an in-app notice (same `user`-audience
 * mechanism as a promotion notice) — nobody finds out only by asking.
 */
export function AdminLeave() {
  const toast = useToast();
  const { profile, tenant } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  const { data: requests, loading, error } = useAsync(() => fetchAllLeaveRequests(), [reloadKey]);
  const reload = () => setReloadKey((k) => k + 1);

  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  async function review(r: LeaveRequestRow, status: "approved" | "rejected") {
    setReviewingId(r.id);
    try {
      const note = noteDrafts[r.id] ?? "";
      await reviewLeaveRequest(r.id, profile.id, status, note);

      const { error: notifyErr } = await supabase().from("announcements").insert({
        tenant_id: tenant.id,
        author_id: profile.id,
        subject: status === "approved" ? "Your leave request was approved" : "Your leave request was not approved",
        body: (status === "approved"
          ? `Your leave from ${formatShortDate(r.starts_on)} to ${formatShortDate(r.ends_on)} has been approved.`
          : `Your leave from ${formatShortDate(r.starts_on)} to ${formatShortDate(r.ends_on)} was not approved.`
        ) + (note.trim() ? ` Note: ${note.trim()}` : ""),
        audience: { kind: "user", user_id: r.teacher_id },
        channels: ["in_app"],
        published_at: new Date().toISOString(),
      });

      if (notifyErr) toast(`Recorded, but ${r.teacherName} could not be notified: ${notifyErr.message}`);
      else toast(`${status === "approved" ? "Approved" : "Rejected"} — ${r.teacherName} notified.`);
      reload();
    } catch (err) {
      toast(err instanceof Error ? `Could not update: ${err.message}` : "Could not update.");
    } finally {
      setReviewingId(null);
    }
  }

  const pending = (requests ?? []).filter((r) => r.status === "pending");
  const decided = (requests ?? []).filter((r) => r.status !== "pending");

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
        ) : loading || !requests ? (
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
                { key: "status", header: "", align: "right", render: (r: LeaveRequestRow) => <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge> },
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
