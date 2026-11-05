import { useState, type ReactNode } from "react";
import { EdgeError, fetchMyHr, fetchPayslip, isMyHrPending, monthRange, MY_HR_NOT_READY, readSummary, showsMyHr, type MyHrTab } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/DataTable";
import { TextField } from "../../components/ui/Field";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useAsync } from "../../lib/useAsync";
import { useMyHrStatus } from "../../lib/useMyHr";
import { useTenantSession } from "../../lib/sessionContext";
import { ErrorNote, HrRecordCard, MyHrTabBar, NotReady, PayslipDocument, TabBody } from "./MyHrViews";

const NOT_READY_CODES = new Set(["not_linked", "pending_hr"]);

/** "2026-11" for today. */
const thisMonth = () => new Date().toISOString().slice(0, 7);

/** Prints the payslip on the page, alone (index.css hides everything else while body.printing-payslip is set). */
function printPayslip() {
  document.body.classList.add("printing-payslip");
  const done = () => { document.body.classList.remove("printing-payslip"); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  window.print();
  // browsers whose print() returns only after the dialog closes, and those that never fire afterprint
  setTimeout(done, 1000);
}

/**
 * "My HR" (SCHOOLS_HR_PHASE2_CONTRACT.md section 3): a staff member's own payslips, leave, attendance and KPIs from
 * Figbloom HR, read only. Everything comes through the my-hr function, which uses the signed-in person's own
 * school and profile; this page never says whose record to show. Shown in the teacher, staff and (for the school's
 * own admins) admin consoles while my_hr_status() is "available". A payslip opens on the page, laid out from HR's
 * figures, with Print / Save as PDF through the browser (HR has no server-side PDF).
 */
export function MyHr() {
  const session = useTenantSession();
  const status = useMyHrStatus(session);
  const available = showsMyHr(status);
  const [tab, setTab] = useState<MyHrTab>("payslips");
  const [month, setMonth] = useState(thisMonth);
  const [payslipId, setPayslipId] = useState<string | null>(null);

  const summary = useAsync(() => (available ? fetchMyHr("summary") : Promise.resolve(null)), [available]);
  const section = useAsync(
    () => (available ? fetchMyHr(tab, tab === "attendance" ? monthRange(month) : {}) : Promise.resolve(null)),
    [available, tab, tab === "attendance" ? month : ""],
  );
  const payslip = useAsync(() => (available && payslipId ? fetchPayslip(payslipId) : Promise.resolve(null)), [available, payslipId]);

  const head = <PageHead eyebrow="Figbloom HR" title="My HR" blurb="Your own payslips, leave, attendance and KPIs from Figbloom HR. To apply for leave or change anything, use HR for now." />;
  const page = (body: ReactNode) => <><div className="print:hidden">{head}</div>{body}</>;

  if (status === null) return page(<div className="px-7 py-6"><TableSkeleton rows={4} /></div>);
  if (!available) {
    return page(
      <div className="px-7 py-6">
        <div className="rounded-lg border border-line bg-white">
          <EmptyState title="My HR isn't available here yet" body="Your school's HR records aren't connected to Figbloom Schools yet. Ask the school office." />
        </div>
      </div>,
    );
  }

  const summaryCode = summary.error instanceof EdgeError ? summary.error.code : undefined;
  if (isMyHrPending(summary.data) || (summaryCode !== undefined && NOT_READY_CODES.has(summaryCode))) {
    return page(<div className="px-7 py-6"><NotReady message={summary.error?.message ?? MY_HR_NOT_READY} /></div>);
  }

  const sectionCode = section.error instanceof EdgeError ? section.error.code : undefined;
  return page(
    <>
      <div className="grid gap-4 px-7 pt-5">
        {summary.loading ? null : summary.error ? (
          <ErrorNote message={summary.error.message} />
        ) : summary.data ? (
          <HrRecordCard summary={readSummary(summary.data)} />
        ) : null}
      </div>
      <div className="mt-4"><MyHrTabBar tab={tab} onTab={(t) => { setTab(t); setPayslipId(null); }} /></div>
      <div id="my-hr-panel" role="tabpanel" aria-labelledby={`my-hr-tab-${tab}`} className="grid gap-4 px-7 py-5">
        {tab === "payslips" && payslipId ? (
          <>
            <div className="flex flex-wrap items-center gap-2 print:hidden">
              <Button onClick={() => setPayslipId(null)}>‹ All payslips</Button>
              <Button variant="primary" disabled={!payslip.data || isMyHrPending(payslip.data)} onClick={printPayslip}>Print / Save as PDF</Button>
            </div>
            {payslip.loading ? <TableSkeleton rows={6} />
              : payslip.error ? <ErrorNote message={payslip.error.message} />
              : isMyHrPending(payslip.data) ? <NotReady />
              : <PayslipDocument data={payslip.data} schoolName={session.tenant.name} />}
          </>
        ) : (
          <>
            {tab === "attendance" && (
              <div className="max-w-[220px]">
                <TextField id="my-hr-month" label="Month" type="month" value={month} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} />
              </div>
            )}
            {sectionCode && NOT_READY_CODES.has(sectionCode) ? (
              <NotReady message={section.error?.message} />
            ) : (
              <TabBody tab={tab} loading={section.loading} error={section.error?.message ?? null} data={section.data} onOpen={setPayslipId} />
            )}
          </>
        )}
      </div>
    </>,
  );
}
