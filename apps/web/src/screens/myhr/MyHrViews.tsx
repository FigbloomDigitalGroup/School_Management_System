import {
  formatPay, formatShortDate, hrStatusLabel, isMyHrPending, MY_HR_NOT_READY, MY_HR_TABS, readAttendance, readKpis, readLeave,
  readPayslips, type MyHrSummary, type MyHrTab,
} from "@figbloom/shared";
import type { ReactNode } from "react";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/DataTable";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { StatRow } from "../../components/ui/StatCard";

/**
 * The parts of the My HR page that only show what they're given (no calls), so the tests can render them:
 * the tab bar, the HR record card, the "not ready" state, and each tab's body from HR's raw answer.
 */

export function MyHrTabBar({ tab, onTab }: { tab: MyHrTab; onTab: (t: MyHrTab) => void }) {
  return (
    <div role="tablist" aria-label="My HR" className="flex overflow-x-auto border-b border-line bg-white px-7">
      {MY_HR_TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          id={`my-hr-tab-${t.key}`}
          aria-selected={t.key === tab}
          aria-controls="my-hr-panel"
          onClick={() => onTab(t.key)}
          className="mr-6 whitespace-nowrap py-2.5 text-[13px]"
          style={{
            fontWeight: t.key === tab ? 600 : 400,
            color: t.key === tab ? "#16201A" : "#5F6B62",
            boxShadow: t.key === tab ? "inset 0 -2px 0 #F26A1B" : undefined,
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function HrRecordCard({ summary }: { summary: MyHrSummary }) {
  const facts = [
    summary.employeeNumber && ["Employee no.", summary.employeeNumber],
    summary.jobTitle && ["Job", summary.jobTitle],
    summary.department && ["Department", summary.department],
  ].filter(Boolean) as [string, string][];
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-line bg-white px-4 py-3">
      <div className="min-w-0">
        <div className="font-mono text-micro tracking-[0.1em] text-ink-faint">HR RECORD</div>
        <div className="mt-0.5 text-[14px] font-semibold">{summary.name ?? "Your HR record"}</div>
      </div>
      {facts.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <div className="text-[11px] text-ink-faint">{k}</div>
          <div className="text-[13px]">{v}</div>
        </div>
      ))}
      <div className="ml-auto"><Badge tone="ok">Linked to Figbloom HR</Badge></div>
    </div>
  );
}

/** HR has no record for this person yet, or their onboarding isn't approved. */
export function NotReady({ message = MY_HR_NOT_READY }: { message?: string }) {
  return (
    <div className="rounded-lg border border-line bg-white">
      <EmptyState title="Your HR record isn't ready yet" body={message} />
    </div>
  );
}

export interface TabBodyProps {
  tab: MyHrTab;
  loading: boolean;
  error: string | null;
  /** HR's answer as my-hr passed it on. */
  data: unknown;
  onDownload?: (payslipId: string, period: string) => void;
  /** The payslip being downloaded. */
  downloading?: string | null;
}

/** One tab's content: loading, an error, "not ready", empty, or HR's data. */
export function TabBody({ tab, loading, error, data, onDownload, downloading }: TabBodyProps) {
  if (loading) return <TableSkeleton rows={4} />;
  if (error) return <p role="alert" className="rounded-lg border border-line bg-white px-4 py-3.5 text-[12.5px] text-warn-ink">{error}</p>;
  if (isMyHrPending(data)) return <NotReady />;
  switch (tab) {
    case "payslips": return <PayslipsView data={data} onDownload={onDownload} downloading={downloading ?? null} />;
    case "leave": return <LeaveView data={data} />;
    case "attendance": return <AttendanceView data={data} />;
    case "kpis": return <KpisView data={data} />;
  }
}

const Panel = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="overflow-hidden rounded-lg border border-line bg-white">
    <header className="border-b border-line px-4 py-3"><h2 className="text-body font-semibold">{title}</h2></header>
    {children}
  </section>
);

const TH = "px-4 py-2 font-semibold";
const TD = "px-4 py-2.5";
const date = (d: string | null) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? formatShortDate(d.slice(0, 10)) : d ?? "—");
const time = (t: string | null) => (t ? (/T(\d{2}:\d{2})/.exec(t)?.[1] ?? t) : "—");

function tone(status: string): Tone {
  const s = status.toLowerCase();
  if (/(approved|present|on_time|ok|paid|published|resolved|accepted)/.test(s)) return "ok";
  if (/(pending|late|review|open|awaiting|submitted)/.test(s)) return "warn";
  if (/(absent|rejected|declined|missed)/.test(s)) return "info";
  return "muted";
}

function PayslipsView({ data, onDownload, downloading }: { data: unknown; onDownload?: (id: string, period: string) => void; downloading: string | null }) {
  const payslips = readPayslips(data);
  if (payslips.length === 0) {
    return <Panel title="Payslips"><EmptyState title="No payslips yet" body="Your payslips show here once HR runs a payroll and publishes it." /></Panel>;
  }
  return (
    <Panel title="Payslips">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[12.5px]">
          <thead className="bg-sunken text-[11px] text-ink-faint">
            <tr><th className={TH}>Month</th><th className={TH}>Gross</th><th className={TH}>Deductions</th><th className={TH}>Net pay</th><th className={TH}>Paid on</th><th className={TH}><span className="sr-only">PDF</span></th></tr>
          </thead>
          <tbody>
            {payslips.map((p) => (
              <tr key={p.id} className="border-t border-line-soft">
                <td className={`${TD} font-medium`}>{p.period}</td>
                <td className={`${TD} font-mono`}>{formatPay(p.gross, p.currency)}</td>
                <td className={`${TD} font-mono`}>{formatPay(p.deductions, p.currency)}</td>
                <td className={`${TD} font-mono font-semibold`}>{formatPay(p.net, p.currency)}</td>
                <td className={TD}>{date(p.paidOn)}</td>
                <td className={`${TD} text-right`}>
                  {p.hasPdf && onDownload && (
                    <Button disabled={downloading === p.id} onClick={() => onDownload(p.id, p.period)} aria-label={`Download the ${p.period} payslip (PDF)`}>
                      {downloading === p.id ? "Downloading…" : "PDF"}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

const days = (n: number | null) => (n === null ? "—" : `${n} ${n === 1 ? "day" : "days"}`);

function LeaveView({ data }: { data: unknown }) {
  const { balances, applications } = readLeave(data);
  return (
    <div className="grid gap-4">
      {balances.length === 0 ? (
        <Panel title="Balances"><EmptyState title="No leave balances yet" body="HR hasn't set up your leave entitlements yet." /></Panel>
      ) : (
        <StatRow stats={balances.map((b) => ({
          label: b.type,
          value: b.balance === null ? "—" : String(b.balance),
          sub: [b.entitled !== null && `of ${b.entitled} days`, b.taken !== null && `${b.taken} taken`, b.pending ? `${b.pending} pending` : null].filter(Boolean).join(" · ") || "days left",
        }))} />
      )}
      <Panel title="Applications">
        {applications.length === 0 ? (
          <EmptyState title="No leave applications" body="Leave you apply for in HR shows here, with who approves it." />
        ) : applications.map((a) => (
          <div key={a.id} className="flex items-start justify-between gap-3 border-b border-line-soft px-4 py-3 last:border-0">
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{a.type}: {date(a.from)} – {date(a.to)}</div>
              <p className="mt-0.5 text-[12px] text-ink-faint">{days(a.days)}{a.approver ? ` · Approver: ${a.approver}` : ""}</p>
            </div>
            <Badge tone={tone(a.status)}>{hrStatusLabel(a.status)}</Badge>
          </div>
        ))}
      </Panel>
    </div>
  );
}

function AttendanceView({ data }: { data: unknown }) {
  const { days: rows, notices, missedScans } = readAttendance(data);
  return (
    <div className="grid gap-4">
      {notices.length > 0 && (
        <Panel title="Possible absences">
          {notices.map((n, i) => (
            <div key={i} className="flex items-start justify-between gap-3 border-b border-line-soft px-4 py-3 last:border-0">
              <div className="text-[13px]"><span className="font-medium">{date(n.date)}</span>{n.text ? ` · ${n.text}` : ""}</div>
              {n.status && <Badge tone={tone(n.status)}>{hrStatusLabel(n.status)}</Badge>}
            </div>
          ))}
        </Panel>
      )}
      <Panel title="Days">
        {rows.length === 0 ? (
          <EmptyState title="No attendance for this month" body="Clock-ins recorded in HR (the fingerprint scanners or the clock-in button) show here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead className="bg-sunken text-[11px] text-ink-faint">
                <tr><th className={TH}>Date</th><th className={TH}>Status</th><th className={TH}>In</th><th className={TH}>Out</th><th className={TH}>Late</th></tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.date} className="border-t border-line-soft">
                    <td className={`${TD} font-medium`}>{date(d.date)}</td>
                    <td className={TD}><Badge tone={tone(d.status)}>{hrStatusLabel(d.status)}</Badge></td>
                    <td className={`${TD} font-mono`}>{time(d.clockIn)}</td>
                    <td className={`${TD} font-mono`}>{time(d.clockOut)}</td>
                    <td className={TD}>{d.lateMinutes ? `${d.lateMinutes} min` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {missedScans.length > 0 && (
        <Panel title="Missed-scan requests">
          {missedScans.map((n, i) => (
            <div key={i} className="flex items-start justify-between gap-3 border-b border-line-soft px-4 py-3 last:border-0">
              <div className="text-[13px]"><span className="font-medium">{date(n.date)}</span>{n.text ? ` · ${n.text}` : ""}</div>
              {n.status && <Badge tone={tone(n.status)}>{hrStatusLabel(n.status)}</Badge>}
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}

function KpisView({ data }: { data: unknown }) {
  const { period, targets, measures } = readKpis(data);
  return (
    <div className="grid gap-4">
      {measures.length > 0 && <StatRow stats={measures.map((m) => ({ label: m.label, value: m.value }))} />}
      <Panel title={period ? `Targets: ${period}` : "Targets"}>
        {targets.length === 0 ? (
          <EmptyState title="No KPIs for this period" body="Targets HR sets for you, and your scores against them, show here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead className="bg-sunken text-[11px] text-ink-faint">
                <tr><th className={TH}>KPI</th><th className={TH}>Target</th><th className={TH}>Score</th><th className={TH}>Weight</th></tr>
              </thead>
              <tbody>
                {targets.map((t, i) => (
                  <tr key={i} className="border-t border-line-soft">
                    <td className={`${TD} font-medium`}>{t.name}</td>
                    <td className={TD}>{t.target ?? "—"}</td>
                    <td className={`${TD} font-mono`}>{t.score ?? "Not scored yet"}</td>
                    <td className={TD}>{t.weight === null ? "—" : `${t.weight}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
