// "Leave to approve" (SCHOOLS_HR_LEAVE_CONTRACT.md section 3): leave applications waiting on this person in Figbloom HR.
import { useState } from "react";
import { approvalsState, decideApproval, EdgeError, fetchApprovals, LEAVE_TO_APPROVE_LABEL, showsLeaveToApprove, type ApprovalItem } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Button } from "../../components/ui/Button";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useHrItem } from "../../lib/useHrItem";
import { useHrLeaveAccess } from "../../lib/useHrLeave";
import { useTenantSession } from "../../lib/sessionContext";
import { ApprovalsView } from "./HrLeaveViews";

/**
 * For the head teacher, deputies, the bursar and the school's admins at a school whose leave runs in HR. HR decides
 * whose turn it is (its own "waiting on me" rule) and the decision is made in HR as this person's HR user, so HR's
 * permissions, delegation and audit apply. Someone HR can't match to one of its users yet (they never opened HR &
 * Payroll from Schools) is asked to do that once, with the HR & Payroll button when they have it.
 */
export function LeaveToApprove() {
  const toast = useToast();
  const session = useTenantSession();
  const access = useHrLeaveAccess(session);
  const hrItem = useHrItem(session)[0];
  const allowed = showsLeaveToApprove(access);
  const [reloadKey, setReloadKey] = useState(0);
  const result = useAsync(() => (allowed ? fetchApprovals() : Promise.resolve(null)), [allowed, reloadKey]);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const error = result.error ? { message: result.error.message, code: result.error instanceof EdgeError ? result.error.code : undefined } : null;
  const state = approvalsState(access, { loading: result.loading && !result.data, error, data: result.data });

  async function decide(item: ApprovalItem, decision: "approve" | "decline") {
    setBusyId(item.id);
    try {
      await decideApproval(item.id, decision, comments[item.id] ?? "");
      toast(decision === "approve" ? `Approved — ${item.employee}'s leave goes on in Figbloom HR.` : `Declined — ${item.employee} will see your comment in HR.`);
      setComments((c) => { const next = { ...c }; delete next[item.id]; return next; });
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not record the decision.", "error");
      setReloadKey((k) => k + 1);
    } finally {
      setBusyId(null);
    }
  }

  const hrButton = hrItem ? (
    <Button variant="accent" disabled={hrItem.busy} onClick={hrItem.onClick} title={hrItem.title}>{hrItem.label}</Button>
  ) : undefined;

  return (
    <>
      <PageHead eyebrow="Staff" title={LEAVE_TO_APPROVE_LABEL} blurb="Leave applications from Figbloom HR that are waiting on you. Your decision is made in HR, as you." />
      <div className="grid gap-4 px-7 py-6">
        <ApprovalsView
          state={state} comments={comments} onComment={(id, text) => setComments((c) => ({ ...c, [id]: text }))}
          onDecide={(item, d) => void decide(item, d)} busyId={busyId} hrButton={hrButton}
        />
      </div>
    </>
  );
}
