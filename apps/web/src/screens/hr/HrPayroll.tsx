// HR & Payroll (HR_CONNECT_SPEC.md): Figbloom HR for the school. When it's there, one click opens it in a new tab,
// signed in as yourself (/hr/launch). While it's being set up, say so; when it isn't there, the school can ask
// Figbloom for it (open-hr {action: "request"}; staff switch it on in the console).
import { useState } from "react";
import { EdgeError, HR_STATUS_HIDDEN, hrLaunchUrl, requestFigbloomHr } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { openHrLaunchTab } from "../../lib/hrLaunch";
import { useHrStatus } from "../../lib/useHrItem";
import { useTenantSession } from "../../lib/sessionContext";
import { HrPayrollCard } from "./HrPayrollViews";

export function HrPayroll() {
  const session = useTenantSession();
  const hr = useHrStatus(session);
  const [requesting, setRequesting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function request() {
    setError(null);
    setRequesting(true);
    try {
      await requestFigbloomHr(session.tenant.id);
      await hr.reload();
    } catch (err) {
      // already_connected: HR was switched on meanwhile; the card follows the new answer
      if (err instanceof EdgeError && err.code === "already_connected") await hr.reload();
      else setError(err instanceof Error ? err.message : "Couldn't send the request. Try again.");
    } finally {
      setRequesting(false);
    }
  }

  async function checkAgain() {
    setChecking(true);
    try {
      await hr.reload();
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <PageHead eyebrow="Staff" title="HR & Payroll" blurb="Payroll, payslips, leave and attendance for your team, in Figbloom HR." />
      <div className="grid gap-4 px-7 py-6">
        <HrPayrollCard
          schoolName={session.tenant.name}
          status={hr.eligible ? hr.status : HR_STATUS_HIDDEN}
          failed={hr.failed}
          requesting={requesting}
          checking={checking}
          error={error}
          onOpen={() => { openHrLaunchTab(hrLaunchUrl(session.tenant.id, session.tenant.slug)); }}
          onRequest={() => void request()}
          onCheckAgain={() => void checkAgain()}
        />
      </div>
    </>
  );
}
