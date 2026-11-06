import { Link } from "react-router-dom";
import { formatMoney, gradeFor, gradingSchemeFor, supabase, type GradingSchemeId } from "@figbloom/shared";
import type { ClassGroup, Exam, Term } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { StatRow } from "../../components/ui/StatCard";
import { Skeleton, TableSkeleton } from "../../components/ui/Skeleton";
import { DataTable, Mono } from "../../components/ui/DataTable";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { CbeReport } from "./CbeReport";

interface ReportsData {
  term: Term | null;
  classes: Pick<ClassGroup, "id" | "name" | "form_level" | "level">[];
  attendanceByClass: Map<string, { present: number; total: number }>;
  attendanceOverall: { present: number; total: number };
  feeByClass: Map<string, { billed: number; paid: number }>;
  feeOverall: { billed: number; paid: number };
  latestExam: Exam | null;
  meanByClass: Map<string, { mean: number; entered: number; total: number; scheme: GradingSchemeId }>;
}

/** One row of term_class_figures(): a class's term, added up in the database (supabase/migrations/20261105500000). */
interface ClassFigures {
  class_id: string;
  roster: number;
  att_here: number;
  att_total: number;
  billed: number;
  paid: number;
  mark_sum: number;
  mark_count: number;
}

async function fetchReports(tenantId: string, country: string): Promise<ReportsData> {
  const sb = supabase();
  const { data: term } = await sb.from("terms").select("*").eq("tenant_id", tenantId).eq("is_current", true).maybeSingle<Term>();
  const termId = term?.id ?? null;

  const { data: classRows } = await sb
    .from("classes").select("id,name,form_level,level").eq("tenant_id", tenantId).order("form_level").order("name")
    .returns<Pick<ClassGroup, "id" | "name" | "form_level" | "level">[]>();
  const classes = classRows ?? [];

  const attendanceByClass = new Map<string, { present: number; total: number }>();
  const attendanceOverall = { present: 0, total: 0 };
  const feeByClass = new Map<string, { billed: number; paid: number }>();
  const feeOverall = { billed: 0, paid: 0 };
  let latestExam: Exam | null = null;
  const meanByClass = new Map<string, { mean: number; entered: number; total: number; scheme: GradingSchemeId }>();

  if (termId) {
    const { data: examRows } = await sb
      .from("exams").select("*").eq("tenant_id", tenantId).eq("term_id", termId).not("published_at", "is", null)
      .order("published_at", { ascending: false }).limit(1).returns<Exam[]>();
    latestExam = examRows?.[0] ?? null;

    // Added up in the database: the API answers at most 1,000 rows and says nothing when it stops, so a term's register entries,
    // invoices and marks cannot be read here and summed (FIG-1438, FIG-1402, FIG-1439).
    const { data: figureRows, error: figureError } = await sb
      .rpc("term_class_figures", { p_tenant_id: tenantId, p_term_id: termId, p_exam_id: latestExam?.id ?? null });
    if (figureError) throw new Error(figureError.message);
    const figures = new Map<string, ClassFigures>(((figureRows ?? []) as ClassFigures[]).map((f) => [f.class_id, f] as const));

    for (const c of classes) {
      const f = figures.get(c.id);
      const here = f?.att_here ?? 0;
      const total = f?.att_total ?? 0;
      attendanceByClass.set(c.id, { present: here, total });
      attendanceOverall.present += here;
      attendanceOverall.total += total;

      const billed = f?.billed ?? 0;
      const paid = f?.paid ?? 0;
      feeByClass.set(c.id, { billed, paid });
      feeOverall.billed += billed;
      feeOverall.paid += paid;

      if (f && f.mark_count > 0) {
        meanByClass.set(c.id, {
          mean: Math.round(f.mark_sum / f.mark_count),
          entered: f.mark_count,
          total: f.roster,
          scheme: gradingSchemeFor(country, c.level),
        });
      }
    }
  }

  return { term: term ?? null, classes, attendanceByClass, attendanceOverall, feeByClass, feeOverall, latestExam, meanByClass };
}

/**
 * Where a principal looks back over the term instead of at today — attendance
 * and fee collection here are term-wide totals, not the Dashboard's "today"
 * snapshot, plus the one thing Dashboard never shows: academic performance.
 */
export function AdminReports() {
  const { tenant } = useTenantSession();
  const { data, loading, error } = useAsync(() => fetchReports(tenant.id, tenant.country), [tenant.id, tenant.country]);

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
                sub: `${data.attendanceOverall.total.toLocaleString()} register entries this term`,
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
                  { key: "name", header: "Class", render: (c: ReportsData["classes"][number]) => <span className="text-[13px] font-medium">{c.name}</span> },
                  {
                    key: "rate", header: "Rate", align: "right",
                    render: (c: ReportsData["classes"][number]) => {
                      const a = data?.attendanceByClass.get(c.id);
                      if (!a || a.total === 0) return <span className="text-[12.5px] text-ink-faint">No data</span>;
                      return <Mono>{Math.round((a.present / a.total) * 100)}%</Mono>;
                    },
                  },
                  {
                    key: "entries", header: "Entries", align: "right",
                    render: (c: ReportsData["classes"][number]) => <Mono>{data?.attendanceByClass.get(c.id)?.total ?? 0}</Mono>,
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
                  { key: "name", header: "Class", render: (c: ReportsData["classes"][number]) => <span className="text-[13px] font-medium">{c.name}</span> },
                  {
                    key: "pct", header: "Collected", align: "right",
                    render: (c: ReportsData["classes"][number]) => {
                      const f = data?.feeByClass.get(c.id);
                      if (!f || f.billed === 0) return <span className="text-[12.5px] text-ink-faint">Not billed</span>;
                      return <Mono>{Math.round((f.paid / f.billed) * 100)}%</Mono>;
                    },
                  },
                  {
                    key: "balance", header: "Balance", align: "right",
                    render: (c: ReportsData["classes"][number]) => {
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
                  { key: "name", header: "Class", render: (c: ReportsData["classes"][number]) => <span className="text-[13px] font-medium">{c.name}</span> },
                  {
                    key: "mean", header: "Class mean", align: "right",
                    render: (c: ReportsData["classes"][number]) => {
                      const m = data?.meanByClass.get(c.id);
                      if (!m) return <span className="text-[12.5px] text-ink-faint">No marks</span>;
                      return <Mono>{m.mean} · {gradeFor(m.mean, m.scheme)}</Mono>;
                    },
                  },
                  {
                    key: "entered", header: "Marks entered", align: "right",
                    render: (c: ReportsData["classes"][number]) => {
                      const m = data?.meanByClass.get(c.id);
                      return <span className="text-[12.5px] text-ink-muted">{m ? `${m.entered} of ${m.total || "—"}` : "—"}</span>;
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
