import { useState } from "react";
import { EdgeError, fetchMyHr, fetchPayslipPdf, isMyHrPending, monthRange, MY_HR_NOT_READY, readSummary, showsMyHr, type MyHrTab } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { EmptyState } from "../../components/ui/DataTable";
import { TextField } from "../../components/ui/Field";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useMyHrStatus } from "../../lib/useMyHr";
import { useTenantSession } from "../../lib/sessionContext";
import { HrRecordCard, MyHrTabBar, NotReady, TabBody } from "./MyHrViews";

const NOT_READY_CODES = new Set(["not_linked", "pending_hr"]);

/** "2026-11" for today. */
const thisMonth = () => new Date().toISOString().slice(0, 7);

/** Hands a file to the browser as a download. */
function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * "My HR" (SCHOOLS_HR_PHASE2_CONTRACT.md section 3): a staff member's own payslips, leave, attendance and KPIs from
 * Figbloom HR, read only. Everything comes through the my-hr function, which uses the signed-in person's own
 * school and profile; this page never says whose record to show. Shown in the teacher, staff and (for the school's
 * own admins) admin consoles while my_hr_status() is "available".
 */
export function MyHr() {
  const session = useTenantSession();
  const toast = useToast();
  const status = useMyHrStatus(session);
  const available = showsMyHr(status);
  const [tab, setTab] = useState<MyHrTab>("payslips");
  const [month, setMonth] = useState(thisMonth);
  const [downloading, setDownloading] = useState<string | null>(null);

  const summary = useAsync(() => (available ? fetchMyHr("summary") : Promise.resolve(null)), [available]);
  const section = useAsync(
    () => (available ? fetchMyHr(tab, tab === "attendance" ? monthRange(month) : {}) : Promise.resolve(null)),
    [available, tab, tab === "attendance" ? month : ""],
  );

  async function download(id: string, period: string) {
    setDownloading(id);
    try {
      saveBlob(await fetchPayslipPdf(id), `Payslip ${period}.pdf`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "The payslip couldn't be downloaded.", "error");
    } finally {
      setDownloading(null);
    }
  }

  const head = <PageHead eyebrow="Figbloom HR" title="My HR" blurb="Your own payslips, leave, attendance and KPIs from Figbloom HR. To apply for leave or change anything, use HR for now." />;

  if (status === null) return <>{head}<div className="px-7 py-6"><TableSkeleton rows={4} /></div></>;
  if (!available) {
    return (
      <>
        {head}
        <div className="px-7 py-6">
          <div className="rounded-lg border border-line bg-white">
            <EmptyState title="My HR isn't available here yet" body="Your school's HR records aren't connected to Figbloom Schools yet. Ask the school office." />
          </div>
        </div>
      </>
    );
  }

  const summaryCode = summary.error instanceof EdgeError ? summary.error.code : undefined;
  const notReady = isMyHrPending(summary.data) || (summaryCode !== undefined && NOT_READY_CODES.has(summaryCode));
  if (notReady) {
    return <>{head}<div className="px-7 py-6"><NotReady message={summary.error?.message ?? MY_HR_NOT_READY} /></div></>;
  }

  const sectionCode = section.error instanceof EdgeError ? section.error.code : undefined;
  return (
    <>
      {head}
      <div className="grid gap-4 px-7 pt-5">
        {summary.loading ? null : summary.error ? (
          <p role="alert" className="text-[12.5px] text-warn-ink">{summary.error.message}</p>
        ) : summary.data ? (
          <HrRecordCard summary={readSummary(summary.data)} />
        ) : null}
      </div>
      <div className="mt-4"><MyHrTabBar tab={tab} onTab={setTab} /></div>
      <div id="my-hr-panel" role="tabpanel" aria-labelledby={`my-hr-tab-${tab}`} className="grid gap-4 px-7 py-5">
        {tab === "attendance" && (
          <div className="max-w-[220px]">
            <TextField id="my-hr-month" label="Month" type="month" value={month} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          </div>
        )}
        {sectionCode && NOT_READY_CODES.has(sectionCode) ? (
          <NotReady message={section.error?.message} />
        ) : (
          <TabBody
            tab={tab}
            loading={section.loading}
            error={section.error?.message ?? null}
            data={section.data}
            onDownload={(id, period) => void download(id, period)}
            downloading={downloading}
          />
        )}
      </div>
    </>
  );
}
