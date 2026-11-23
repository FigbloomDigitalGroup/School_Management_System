import { Link } from "react-router-dom";
import { fetchTermReport, formatMoney, gradeFor, type TermReport } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { StatRow } from "../../components/ui/StatCard";
import { Skeleton, TableSkeleton } from "../../components/ui/Skeleton";
import { DataTable, Mono } from "../../components/ui/DataTable";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { CbeReport } from "./CbeReport";

/**
 * Where a principal looks back over the term instead of at today — attendance
 * and fee collection here are term-wide totals, not the Dashboard's "today"
 * snapshot, plus the one thing Dashboard never shows: academic performance.
 */
export function AdminReports() {
  const { tenant } = useTenantSession();
  const { data, loading, error } = useAsync(() => fetchTermReport(tenant.id, tenant.country), [tenant.id, tenant.country]);

  const overallAttendance = data && data.attendanceOverall.total > 0
    ? Math.round((data.attendanceOverall.present / data.attendanceOverall.total) * 100)
    : null;
  const overallFeePct = data && data.feeOverall.billed > 0
    ? Math.round((data.feeOverall.paid / data.feeOverall.billed) * 100)
    : null;

  return (
    <>
      <PageHead
        eyebrow="School · reports"
        title="Reports"
        blurb={data?.term ? `${data.term.name} so far — attendance, fee collection and the latest published exam.` : "Loading reports…"}
      />

      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load reports: {error.message}
          </p>
        ) : loading || !data ? (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-line bg-white px-4 py-3.5">
                <Skeleton className="h-2.5 w-20" />
                <Skeleton className="mt-2 h-6 w-16" />
                <Skeleton className="mt-1.5 h-2.5 w-24" />
              </div>
            ))}
          </div>
        ) : (
          <StatRow
            stats={[
              {
                label: "Attendance", value: overallAttendance !== null ? `${overallAttendance}%` : "—",
                sub: `${data.attendanceOverall.total.toLocaleString()} ${data.percentageMode === "day" ? "learner-days" : "register entries"} this term`,
              },
              {
                label: "Fees collected", value: overallFeePct !== null ? `${overallFeePct}%` : "—",
                sub: `${formatMoney(data.feeOverall.paid, tenant.country)} of ${formatMoney(data.feeOverall.billed, tenant.country)}`,
              },
              {
                label: "Latest exam", value: data.latestExam?.name ?? "None published",
                sub: data.latestExam ? `Out of ${data.latestExam.out_of}` : "Publish an exam in Gradebook to see it here",
              },
            ]}
          />
        )}

        {/* Until the report lands, the tables would read "No classes yet." —
            hold their place instead. */}
        {!error && (loading || !data) ? (
          <>
            <div className="mt-5 grid gap-4" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
              <TableSkeleton rows={5} />
              <TableSkeleton rows={5} />
            </div>
            <div className="mt-4"><TableSkeleton rows={5} /></div>
          </>
        ) : (
          <>
            <div className="mt-5 grid gap-4" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
              <DataTable
                title="Attendance by class · this term"
                columns={[
                  { key: "name", header: "Class", render: (c: TermReport["classes"][number]) => <span className="text-[13px] font-medium">{c.name}</span> },
                  {
                    key: "rate", header: "Rate", align: "right",
                    render: (c: TermReport["classes"][number]) => {
                      const a = data?.attendanceByClass.get(c.id);
                      if (!a || a.total === 0) return <span className="text-[12.5px] text-ink-faint">No data</span>;
                      return <Mono>{Math.round((a.present / a.total) * 100)}%</Mono>;
                    },
                  },
                  {
                    key: "entries", header: data?.percentageMode === "day" ? "Learner-days" : "Entries", align: "right",
                    render: (c: TermReport["classes"][number]) => <Mono>{data?.attendanceByClass.get(c.id)?.total ?? 0}</Mono>,
                  },
                ]}
                rows={data?.classes ?? []}
                rowKey={(c) => c.id}
                minWidth="360px"
                empty={{ title: "No classes yet.", body: "Add classes under School settings first." }}
              />

              <DataTable
                title="Fee collection by class · this term"
                columns={[
                  { key: "name", header: "Class", render: (c: TermReport["classes"][number]) => <span className="text-[13px] font-medium">{c.name}</span> },
                  {
                    key: "pct", header: "Collected", align: "right",
                    render: (c: TermReport["classes"][number]) => {
                      const f = data?.feeByClass.get(c.id);
                      if (!f || f.billed === 0) return <span className="text-[12.5px] text-ink-faint">Not billed</span>;
                      return <Mono>{Math.round((f.paid / f.billed) * 100)}%</Mono>;
                    },
                  },
                  {
                    key: "balance", header: "Balance", align: "right",
                    render: (c: TermReport["classes"][number]) => {
                      const f = data?.feeByClass.get(c.id);
                      return <Mono>{formatMoney(Math.max((f?.billed ?? 0) - (f?.paid ?? 0), 0), tenant.country)}</Mono>;
                    },
                  },
                ]}
                rows={data?.classes ?? []}
                rowKey={(c) => c.id}
                minWidth="360px"
                empty={{ title: "No classes yet.", body: "Add classes under School settings first." }}
              />
            </div>

            <div className="mt-4">
              <DataTable
                title={data?.latestExam ? `Academic performance · ${data.latestExam.name}` : "Academic performance"}
                columns={[
                  { key: "name", header: "Class", render: (c: TermReport["classes"][number]) => <span className="text-[13px] font-medium">{c.name}</span> },
                  {
                    key: "mean", header: "Class mean", align: "right",
                    render: (c: TermReport["classes"][number]) => {
                      const m = data?.meanByClass.get(c.id);
                      if (!m) return <span className="text-[12.5px] text-ink-faint">No marks</span>;
                      return <Mono>{m.mean} · {gradeFor(m.mean, m.scheme)}</Mono>;
                    },
                  },
                  {
                    key: "entered", header: "Learners marked", align: "right",
                    render: (c: TermReport["classes"][number]) => {
                      const m = data?.meanByClass.get(c.id);
                      return <span className="text-[12.5px] text-ink-muted">{m ? `${m.marked} of ${m.roster} learners` : "—"}</span>;
                    },
                  },
                ]}
                rows={data?.classes ?? []}
                rowKey={(c) => c.id}
                minWidth="420px"
                empty={{
                  title: "No published exam yet.",
                  body: "Once a teacher publishes marks in Gradebook, the class means appear here.",
                }}
              />
              {tenant.institution_type !== "higher_ed" && (
                <p className="mt-2 text-[12.5px] text-ink-muted">
                  How means, subjects and grades have moved from exam to exam: <Link to="../admin/performance" className="font-medium">Performance over time →</Link>
                </p>
              )}
            </div>
          </>
        )}

        <CbeReport tenantId={tenant.id} termId={data?.term?.id ?? null} country={tenant.country} />
      </div>
    </>
  );
}
