import {
  formatPay, formatShortDate, hrStatusLabel, isMyHrPending, MY_HR_NOT_READY, MY_HR_TABS, readAttendance, readKpis, readLeave,
  readPayslip, readPayslips, type MyHrSummary, type MyHrTab, type PayslipLine,
} from "@figbloom/shared";
import type { ReactNode } from "react";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/DataTable";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { StatRow } from "../../components/ui/StatCard";

/**
 * The parts of the My HR page that only show what they're given (no calls), so the tests can render them:
 * the tab bar, the HR record card, the "not ready" state, each tab's body from HR's raw answer, and a payslip laid
 * out for printing.
 */

export function MyHrTabBar({ tab, onTab }: { tab: MyHrTab; onTab: (t: MyHrTab) => void }) {
  return (
    <div role="tablist" aria-label="My HR" className="flex overflow-x-auto border-b border-line bg-white px-7 print:hidden">
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
    summary.branch && ["Branch", summary.branch],
    summary.startDate && ["Started", date(summary.startDate)],
  ].filter(Boolean) as [string, string][];
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-line bg-white px-4 py-3 print:hidden">
      <div className="min-w-0">
        <div className="font-mono text-micro tracking-[0.1em] text-ink-faint">{(summary.company ?? "HR record").toUpperCase()}</div>
        <div className="mt-0.5 text-[14px] font-semibold">{summary.name ?? "Your HR record"}</div>
      </div>
      {facts.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <div className="text-[11px] text-ink-faint">{k}</div>
          <div className="text-[13px]">{v}</div>
        </div>
      ))}
      <div className="ml-auto flex items-center gap-2">
        {!!summary.leavePending && <Badge tone="warn">{summary.leavePending} leave {summary.leavePending === 1 ? "request" : "requests"} pending</Badge>}
        <Badge tone="ok">Linked to Figbloom HR</Badge>
      </div>
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
  /** Open one payslip (Payslips tab). */
  onOpen?: (payslipId: string) => void;
}

/** One tab's content: loading, an error, "not ready", empty, or HR's data. */
export function TabBody({ tab, loading, error, data, onOpen }: TabBodyProps) {
  if (loading) return <TableSkeleton rows={4} />;
  if (error) return <ErrorNote message={error} />;
  if (isMyHrPending(data)) return <NotReady />;
  switch (tab) {
    case "payslips": return <PayslipsView data={data} onOpen={onOpen} />;
    case "leave": return <LeaveView data={data} />;
    case "attendance": return <AttendanceView data={data} />;
    case "kpis": return <KpisView data={data} />;
  }
}

export const ErrorNote = ({ message }: { message: string }) => (
  <p role="alert" className="rounded-lg border border-line bg-white px-4 py-3.5 text-[12.5px] text-warn-ink">{message}</p>
);

const Panel = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="overflow-hidden rounded-lg border border-line bg-white">
    <header className="border-b border-line px-4 py-3"><h2 className="text-body font-semibold">{title}</h2></header>
    {children}
  </section>
);

const TH = "px-4 py-2 font-semibold";
const TD = "px-4 py-2.5";
function date(d: string | null): string {
  if (!d) return "—";
  return /^\d{4}-\d{2}-\d{2}/.test(d) ? formatShortDate(d.slice(0, 10)) : d;
}
/** "07:42" from "2026-10-01T07:42:00+03:00" or "07:42:00". */
const time = (t: string | null) => (t ? (/(?:T|^)(\d{2}:\d{2})/.exec(t)?.[1] ?? t) : "—");
const dayCount = (n: number | null) => (n === null ? "—" : `${n} ${n === 1 ? "day" : "days"}`);

function tone(status: string): Tone {
  const s = status.toLowerCase();
  if (/(approved|present|paid|resolved|accepted)/.test(s)) return "ok";
  if (/(pending|late|current|review|open|submitted)/.test(s)) return "warn";
  if (/(absent|rejected|declined|cancel)/.test(s)) return "info";
  return "muted";
}

function PayslipsView({ data, onOpen }: { data: unknown; onOpen?: (id: string) => void }) {
  const payslips = readPayslips(data);
  if (payslips.length === 0) {
    return <Panel title="Payslips"><EmptyState title="No payslips yet" body="Your payslips show here once HR runs a payroll and approves it." /></Panel>;
  }
  return (
    <Panel title="Payslips">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[12.5px]">
          <thead className="bg-sunken text-[11px] text-ink-faint">
            <tr><th className={TH}>Month</th><th className={TH}>Gross</th><th className={TH}>Deductions</th><th className={TH}>Net pay</th><th className={TH}>Status</th><th className={TH}><span className="sr-only">Open</span></th></tr>
          </thead>
          <tbody>
            {payslips.map((p) => (
              <tr key={p.id} className="border-t border-line-soft">
                <td className={`${TD} font-medium`}>{p.period}</td>
                <td className={`${TD} font-mono`}>{formatPay(p.gross, p.currency)}</td>
                <td className={`${TD} font-mono`}>{formatPay(p.deductions, p.currency)}</td>
                <td className={`${TD} font-mono font-semibold`}>{formatPay(p.net, p.currency)}</td>
                <td className={TD}>{p.paidOn ? `Paid ${date(p.paidOn)}` : p.runStatus ? hrStatusLabel(p.runStatus) : "—"}</td>
                <td className={`${TD} text-right`}>
                  {onOpen && <Button onClick={() => onOpen(p.id)} aria-label={`Open the ${p.period} payslip`}>Open</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Lines({ title, lines, total, totalLabel, currency }: { title: string; lines: PayslipLine[]; total: number | null; totalLabel: string; currency: string }) {
  return (
    <div>
      <div className="border-b border-line pb-1.5 text-[11px] font-semibold tracking-[0.08em] text-ink-faint">{title.toUpperCase()}</div>
      <table className="w-full text-[12.5px]">
        <tbody>
          {lines.map((l, i) => (
            <tr key={`${l.label}-${i}`}><td className="py-1">{l.label}</td><td className="py-1 text-right font-mono">{formatPay(l.amount, currency)}</td></tr>
          ))}
          <tr className="border-t border-line font-semibold"><td className="py-1.5">{totalLabel}</td><td className="py-1.5 text-right font-mono">{formatPay(total, currency)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * One payslip, laid out from every saved figure HR sent (GET payslips/:id). HR makes its PDFs in the browser only, so
 * this is what Print / Save as PDF prints: the class "my-hr-payslip" is the only thing on the page when printing
 * (index.css).
 */
export function PayslipDocument({ data, schoolName }: { data: unknown; schoolName?: string }) {
  const p = readPayslip(data);
  if (!p) return <ErrorNote message="This payslip couldn't be read. Try again, or ask the school's HR administrator." />;
  const facts = [
    ["Employee", p.employeeName], ["Employee no.", p.employeeNumber], ["KRA PIN", p.taxPin], ["NSSF no.", p.nssfNumber],
    ["SHIF no.", p.shifNumber], ["Bank", p.bank ? `${p.bank}${p.accountLast4 ? ` ····${p.accountLast4}` : ""}` : p.accountLast4 ? `····${p.accountLast4}` : null],
    ["Paid on", p.paidOn ? date(p.paidOn) : null],
  ].filter(([, v]) => v) as [string, string][];
  return (
    <article className="my-hr-payslip rounded-lg border border-line bg-white p-6 print:border-0 print:p-0" aria-label={`Payslip ${p.period}`}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
        <div>
          <div className="font-mono text-micro tracking-[0.12em] text-ink-faint">PAYSLIP</div>
          <h2 className="mt-1 text-[18px] font-semibold">{p.period}</h2>
          {schoolName && <div className="mt-0.5 text-[12.5px] text-ink-muted">{schoolName}</div>}
        </div>
        <div className="text-right">
          <div className="text-[11px] text-ink-faint">Net pay</div>
          <div className="font-mono text-2xl font-semibold">{formatPay(p.net, p.currency)}</div>
        </div>
      </header>
      <dl className="grid gap-x-6 gap-y-2 py-4 text-[12.5px]" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
        {facts.map(([k, v]) => (
          <div key={k}><dt className="text-[11px] text-ink-faint">{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
      <div className="grid gap-6 sm:grid-cols-2 print:grid-cols-2">
        <Lines title="Earnings" lines={p.earnings} total={p.gross} totalLabel="Gross pay" currency={p.currency} />
        <Lines title="Deductions" lines={p.deductions} total={p.totalDeductions} totalLabel="Total deductions" currency={p.currency} />
      </div>
      {p.taxRelief ? <p className="mt-3 text-[12px] text-ink-muted">Tax relief applied: {formatPay(p.taxRelief, p.currency)}</p> : null}
      <div className="mt-4 flex items-center justify-between rounded-md bg-sunken px-4 py-3">
        <span className="text-[13px] font-semibold">Net pay</span>
        <span className="font-mono text-[15px] font-semibold">{formatPay(p.net, p.currency)}</span>
      </div>
      {p.note && <p className="mt-3 text-[12px] text-ink-muted">{p.note}</p>}
      <p className="mt-4 text-[11px] text-ink-faint">From Figbloom HR{p.runStatus ? ` (payroll ${hrStatusLabel(p.runStatus).toLowerCase()})` : ""}. Ask the school's HR administrator about anything on it.</p>
    </article>
  );
}

function LeaveView({ data }: { data: unknown }) {
  const { balances, applications } = readLeave(data);
  return (
    <div className="grid gap-4">
      {balances.length === 0 ? (
        <Panel title="Balances"><EmptyState title="No leave balances yet" body="HR hasn't set up your leave entitlements yet." /></Panel>
      ) : (
        <StatRow stats={balances.map((b) => ({
          label: b.type,
          value: b.available === null ? "—" : String(b.available),
          sub: ["days free to book", b.used !== null && `${b.used} used`, b.pending ? `${b.pending} pending` : null].filter(Boolean).join(" · "),
        }))} />
      )}
      <Panel title="Applications">
        {applications.length === 0 ? (
          <EmptyState title="No leave applications" body="Leave you apply for in HR shows here, with who approves it." />
        ) : applications.map((a) => (
          <div key={a.id} className="border-b border-line-soft px-4 py-3 last:border-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13px] font-medium">{a.type}: {date(a.from)} – {date(a.to)}</div>
                <p className="mt-0.5 text-[12px] text-ink-faint">{dayCount(a.days)}{a.approver ? ` · ${a.status === "pending" ? "Waiting on" : "Decided by"} ${a.approver}` : ""}</p>
                {a.reason && <p className="mt-0.5 text-[12px] text-ink-muted">{a.reason}</p>}
              </div>
              <Badge tone={tone(a.status)}>{hrStatusLabel(a.status)}</Badge>
            </div>
            {a.steps.length > 1 && (
              <ol className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-ink-muted">
                {a.steps.map((s, i) => <li key={i}>{i + 1}. {s.label}: {hrStatusLabel(s.status)}{s.who ? ` (${s.who})` : ""}</li>)}
              </ol>
            )}
          </div>
        ))}
      </Panel>
    </div>
  );
}

function NoticeList({ title, items }: { title: string; items: { date: string | null; text: string; status: string | null }[] }) {
  if (items.length === 0) return null;
  return (
    <Panel title={title}>
      {items.map((n, i) => (
        <div key={i} className="flex items-start justify-between gap-3 border-b border-line-soft px-4 py-3 last:border-0">
          <div className="text-[13px]"><span className="font-medium">{date(n.date)}</span>{n.text ? ` · ${n.text}` : ""}</div>
          {n.status && <Badge tone={tone(n.status)}>{hrStatusLabel(n.status)}</Badge>}
        </div>
      ))}
    </Panel>
  );
}

function AttendanceView({ data }: { data: unknown }) {
  const { days: rows, notices, missedScans, absences } = readAttendance(data);
  return (
    <div className="grid gap-4">
      <NoticeList title="Possible absences" items={notices} />
      <Panel title="Days">
        {rows.length === 0 ? (
          <EmptyState title="No attendance for this month" body="Clock-ins recorded in HR (the fingerprint scanners or the clock-in button) show here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead className="bg-sunken text-[11px] text-ink-faint">
                <tr><th className={TH}>Date</th><th className={TH}>Status</th><th className={TH}>In</th><th className={TH}>Out</th><th className={TH}>Hours</th><th className={TH}>Late</th></tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.date} className="border-t border-line-soft">
                    <td className={`${TD} font-medium`}>{date(d.date)}</td>
                    <td className={TD}><Badge tone={tone(d.status)}>{hrStatusLabel(d.status)}</Badge></td>
                    <td className={`${TD} font-mono`}>{time(d.clockIn)}</td>
                    <td className={`${TD} font-mono`}>{time(d.clockOut)}</td>
                    <td className={`${TD} font-mono`}>{d.hours === null ? "—" : d.hours.toFixed(1)}</td>
                    <td className={TD}>{d.lateMinutes ? `${d.lateMinutes} min` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <NoticeList title="Missed-scan requests" items={missedScans} />
      <NoticeList title="Absences recorded" items={absences} />
    </div>
  );
}

function KpisView({ data }: { data: unknown }) {
  const { period, targets, overall, measures } = readKpis(data);
  const stats = [
    ...(overall !== null ? [{ label: "Overall score", value: `${overall}%` }] : []),
    ...measures.map((m) => ({ label: m.label, value: m.value })),
  ];
  return (
    <div className="grid gap-4">
      {stats.length > 0 && <StatRow stats={stats} />}
      <Panel title={period ? `KPIs: ${period}` : "KPIs"}>
        {targets.length === 0 ? (
          <EmptyState title="No KPIs for this period" body="Targets HR sets for you, and your scores against them, show here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead className="bg-sunken text-[11px] text-ink-faint">
                <tr><th className={TH}>KPI</th><th className={TH}>Target</th><th className={TH}>Your rating</th><th className={TH}>Actual</th><th className={TH}>Achievement</th><th className={TH}>Weight</th></tr>
              </thead>
              <tbody>
                {targets.map((t, i) => (
                  <tr key={i} className="border-t border-line-soft">
                    <td className={`${TD} font-medium`}>{t.name}</td>
                    <td className={TD}>{t.target ?? "—"}</td>
                    <td className={TD}>{t.self ?? "—"}</td>
                    <td className={`${TD} font-mono`}>{t.actual ?? "Not scored yet"}</td>
                    <td className={`${TD} font-mono`}>{t.achievement === null ? "—" : `${t.achievement}%`}</td>
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
