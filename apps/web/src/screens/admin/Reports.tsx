import { gradeFor, gradingSchemeFor, KES, summarise, supabase, type GradingSchemeId } from "@figbloom/shared";
import type { AttendanceMark, ClassGroup, Exam, Term } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { StatRow } from "../../components/ui/StatCard";
import { Skeleton } from "../../components/ui/Skeleton";
import { DataTable, Mono } from "../../components/ui/DataTable";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";

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

async function fetchReports(country: string): Promise<ReportsData> {
  const sb = supabase();
  const { data: term } = await sb.from("terms").select("*").eq("is_current", true).maybeSingle<Term>();
  const termId = term?.id ?? null;

  const { data: classRows } = await sb
    .from("classes").select("id,name,form_level,level").order("form_level").order("name")
    .returns<Pick<ClassGroup, "id" | "name" | "form_level" | "level">[]>();
  const classes = classRows ?? [];

  const { data: studentRows } = await sb
    .from("students").select("id,class_id").eq("active", true)
    .returns<{ id: string; class_id: string }[]>();
  const classIdByStudent = new Map((studentRows ?? []).map((s) => [s.id, s.class_id]));
  const rosterSizeByClass = new Map<string, number>();
  for (const s of studentRows ?? []) rosterSizeByClass.set(s.class_id, (rosterSizeByClass.get(s.class_id) ?? 0) + 1);

  const attendanceByClass = new Map<string, { present: number; total: number }>();
  let attendanceOverall = { present: 0, total: 0 };
  const feeByClass = new Map<string, { billed: number; paid: number }>();
  const feeOverall = { billed: 0, paid: 0 };
  let latestExam: Exam | null = null;
  const meanByClass = new Map<string, { mean: number; entered: number; total: number; scheme: GradingSchemeId }>();

  if (termId) {
    const [{ data: attRows }, { data: invRows }, { data: examRows }] = await Promise.all([
      sb.from("attendance").select("class_id,mark").eq("term_id", termId).returns<{ class_id: string; mark: AttendanceMark }[]>(),
      sb.from("fee_invoices").select("student_id,total_cents,paid_cents").eq("term_id", termId)
        .returns<{ student_id: string; total_cents: number; paid_cents: number }[]>(),
      sb.from("exams").select("*").eq("term_id", termId).not("published_at", "is", null)
        .order("published_at", { ascending: false }).limit(1).returns<Exam[]>(),
    ]);

    for (const c of classes) {
      const rows = (attRows ?? []).filter((r) => r.class_id === c.id);
      const here = rows.filter((r) => r.mark === "present" || r.mark === "late").length;
      attendanceByClass.set(c.id, { present: here, total: rows.length });
    }
    if (attRows?.length) {
      const overallHere = attRows.filter((r) => r.mark === "present" || r.mark === "late").length;
      attendanceOverall = { present: overallHere, total: attRows.length };
    }

    for (const c of classes) feeByClass.set(c.id, { billed: 0, paid: 0 });
    for (const inv of invRows ?? []) {
      const classId = classIdByStudent.get(inv.student_id);
      if (!classId) continue;
      const cur = feeByClass.get(classId) ?? { billed: 0, paid: 0 };
      cur.billed += inv.total_cents;
      cur.paid += inv.paid_cents;
      feeByClass.set(classId, cur);
      feeOverall.billed += inv.total_cents;
      feeOverall.paid += inv.paid_cents;
    }

    latestExam = examRows?.[0] ?? null;
    if (latestExam) {
      const { data: markRows } = await sb
        .from("marks").select("student_id,score").eq("exam_id", latestExam.id)
        .returns<{ student_id: string; score: number | null }[]>();
      const byClass = new Map<string, { subject: string; score: number | null }[]>();
      for (const m of markRows ?? []) {
        const classId = classIdByStudent.get(m.student_id);
        if (!classId) continue;
        const list = byClass.get(classId) ?? [];
        list.push({ subject: "", score: m.score });
        byClass.set(classId, list);
      }
      for (const c of classes) {
        const list = byClass.get(c.id) ?? [];
        const scheme = gradingSchemeFor(country, c.level);
        const s = summarise(list, scheme);
        if (s.meanScore !== null) meanByClass.set(c.id, { mean: s.meanScore, entered: s.entered, total: rosterSizeByClass.get(c.id) ?? 0, scheme });
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
  const { data, loading, error } = useAsync(() => fetchReports(tenant.country), [tenant.country]);

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
                sub: `${KES(data.feeOverall.paid)} of ${KES(data.feeOverall.billed)}`,
              },
              {
                label: "Latest exam", value: data.latestExam?.name ?? "None published",
                sub: data.latestExam ? `Out of ${data.latestExam.out_of}` : "Publish an exam in Gradebook to see it here",
              },
            ]}
          />
        )}

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
                  return <Mono>{KES(Math.max((f?.billed ?? 0) - (f?.paid ?? 0), 0))}</Mono>;
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
        </div>
      </div>
    </>
  );
}
