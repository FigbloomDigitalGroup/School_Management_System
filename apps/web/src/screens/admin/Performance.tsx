import { useMemo, useState } from "react";
import {
  cbeLevelTrend, describeChange, examsOf, fetchCbeLevels, fetchClassLearnerMeans, fetchClassPerformance, fetchTeacherClasses,
  GRADE_BANDS, gradeDistributions, gradingSchemeFor, movers, overallMeans, RUBRIC_BANDS, subjectComparison, subjectMeans, supabase,
  teachingResults, type ClassGroup, type Mover, type TeachingResult,
} from "@figbloom/shared";
import { BarList } from "../../components/analytics/BarList";
import { fmt } from "../../components/analytics/ChartFrame";
import { DistributionChart } from "../../components/analytics/DistributionChart";
import { Change, LearnerProgress } from "../../components/analytics/LearnerProgress";
import { LineChart } from "../../components/analytics/LineChart";
import { SeriesPicker } from "../../components/analytics/SeriesPicker";
import { PageHead } from "../../components/ConsoleShell";
import { Cell, DataTable, EmptyState, Mono } from "../../components/ui/DataTable";
import { SelectField } from "../../components/ui/Field";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { StatRow } from "../../components/ui/StatCard";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";

type ClassOption = Pick<ClassGroup, "id" | "name" | "level" | "form_level">;

async function fetchSchoolClasses(tenantId: string): Promise<ClassOption[]> {
  const { data, error } = await supabase().from("classes").select("id, name, level, form_level")
    .eq("tenant_id", tenantId).order("form_level").order("name").returns<ClassOption[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function fetchRoster(classId: string): Promise<{ id: string; full_name: string }[]> {
  const { data, error } = await supabase().from("students").select("id, full_name")
    .eq("class_id", classId).eq("active", true).order("full_name").returns<{ id: string; full_name: string }[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Results over time for a class or the whole school: the mean exam by exam,
 * each subject's line, how subjects compare in one exam, how grades spread,
 * who moved most, and (for the office) each class and subject's latest mean
 * beside who teaches it. Then any one learner's own progress.
 *
 * Published results only, like everything families see, so an exam still
 * being entered never pulls a mean down. A teacher sees the classes they
 * teach or are class teacher of; the office sees every class and the school.
 */
export function Performance({ teacher = false }: { teacher?: boolean }) {
  const { tenant, profile } = useTenantSession();
  const classesQ = useAsync(
    () => (teacher ? fetchTeacherClasses(profile.id) : fetchSchoolClasses(tenant.id)),
    [teacher, profile.id, tenant.id],
  );
  const classes = classesQ.data ?? [];
  const [pickedClass, setPickedClass] = useState<string | null>(null);
  // The office starts on the whole school (""); a teacher on their first class.
  const classId = pickedClass ?? (teacher ? classes[0]?.id ?? "" : "");
  const cls = classes.find((c) => c.id === classId) ?? null;

  const rowsQ = useAsync(
    () => (teacher && !classId ? Promise.resolve([]) : fetchClassPerformance(tenant.id, classId || null)),
    [tenant.id, classId, teacher],
  );
  const cbeQ = useAsync(
    () => (teacher && !classId ? Promise.resolve([]) : fetchCbeLevels(classId ? { classId } : { tenantId: tenant.id })),
    [tenant.id, classId, teacher],
  );
  const meansQ = useAsync(() => (classId ? fetchClassLearnerMeans(classId) : Promise.resolve([])), [classId]);
  const rosterQ = useAsync(() => (classId ? fetchRoster(classId) : Promise.resolve([])), [classId]);

  const rows = useMemo(() => rowsQ.data ?? [], [rowsQ.data]);
  const exams = useMemo(() => examsOf(rows), [rows]);
  const [pickedExam, setPickedExam] = useState<string | null>(null);
  const found = pickedExam ? exams.findIndex((e) => e.id === pickedExam) : -1;
  const examIdx = found >= 0 ? found : exams.length - 1;
  const exam = exams[examIdx] ?? null;
  const prevExam = examIdx > 0 ? exams[examIdx - 1]! : null;

  const overall = useMemo(() => overallMeans(rows, exams), [rows, exams]);
  const subjects = useMemo(() => subjectMeans(rows, exams), [rows, exams]);
  const [pickedSubjects, setPickedSubjects] = useState<string[] | null>(null);
  const chosen = (pickedSubjects ?? subjects.slice(0, 3).map((s) => s.id)).filter((id) => subjects.some((s) => s.id === id));
  const comparison = useMemo(() => (exam ? subjectComparison(rows, exam.id) : []), [rows, exam]);

  // One grading scale per distribution: a whole school mixing KCSE and CBC
  // classes needs a class picked first.
  const schemes = new Set((cls ? [cls] : classes).map((c) => gradingSchemeFor(tenant.country, c.level)));
  const scheme = schemes.size === 1 ? [...schemes][0]! : null;
  const distributions = useMemo(() => (scheme ? gradeDistributions(rows, exams, scheme) : []), [rows, exams, scheme]);
  const cbe = useMemo(() => cbeLevelTrend(cbeQ.data ?? []), [cbeQ.data]);
  const moved = useMemo(
    () => (exam && prevExam ? movers(meansQ.data ?? [], prevExam.id, exam.id) : { improved: [], dropped: [] }),
    [meansQ.data, exam, prevExam],
  );
  const teaching = useMemo(() => (teacher ? [] : teachingResults(rows)), [rows, teacher]);
  const [learnerId, setLearnerId] = useState("");
  const learner = (rosterQ.data ?? []).find((s) => s.id === learnerId) ?? null;

  const scopeName = cls?.name ?? (teacher ? "your classes" : "the whole school");
  const points = exams.map((e) => ({ label: e.name, sublabel: e.termName }));
  const latestMean = exam ? overall[examIdx] ?? null : null;
  const prevMean = prevExam ? overall[examIdx - 1] ?? null : null;
  const loading = classesQ.loading || rowsQ.loading || cbeQ.loading;
  const error = classesQ.error ?? rowsQ.error ?? cbeQ.error;

  return (
    <>
      <PageHead
        eyebrow={teacher ? "Teaching · performance" : "School · performance"}
        title="Performance over time"
        blurb="Published results only: how means, subjects and grades have moved from exam to exam."
      />

      <div className="viz-root space-y-4 px-7 py-6">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-[220px]">
            <SelectField
              id="perf-class"
              label="Class"
              value={classId}
              onChange={(e) => { setPickedClass(e.target.value); setPickedExam(null); setLearnerId(""); setPickedSubjects(null); }}
              options={[
                ...(teacher ? [] : [{ value: "", label: "Whole school" }]),
                ...classes.map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
          </div>
          {exams.length > 0 && (
            <div className="w-[240px]">
              <SelectField
                id="perf-exam"
                label="Exam"
                value={exam?.id ?? ""}
                onChange={(e) => setPickedExam(e.target.value)}
                options={[...exams].reverse().map((e) => ({ value: e.id, label: `${e.name} · ${e.termName}` }))}
              />
            </div>
          )}
        </div>

        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load performance: {error.message}
          </p>
        ) : loading ? (
          <TableSkeleton rows={6} />
        ) : teacher && classes.length === 0 ? (
          <EmptyState title="No classes yet" body="Once the office assigns you a class or subject, its results over time appear here." />
        ) : exams.length === 0 && cbe.length === 0 ? (
          <EmptyState
            title="Nothing published yet"
            body={`Trends for ${scopeName} appear once teachers publish marks in Gradebook.`}
          />
        ) : (
          <>
            {exam && (
              <StatRow
                stats={[
                  { label: "Mean mark", value: fmt(latestMean), sub: `${exam.name} · ${exam.termName}` },
                  {
                    label: "Since the exam before",
                    value: latestMean !== null && prevMean !== null ? `${latestMean - prevMean >= 0 ? "+" : "−"}${fmt(Math.abs(latestMean - prevMean))}` : "—",
                    sub: prevExam ? `Against ${prevExam.name}` : "This is the first published exam",
                  },
                  { label: "Subjects out", value: String(comparison.length), sub: `${comparison.reduce((a, s) => a + s.learners, 0).toLocaleString()} marks` },
                ]}
              />
            )}

            {exams.length > 0 && (
              <>
                <LineChart
                  title={`Mean mark over time · ${scopeName}`}
                  summary={describeChange(overall, exams) ?? "Every published mark, exam by exam."}
                  points={points}
                  series={[{ key: "mean", name: "Mean mark", values: overall }]}
                />
                <LineChart
                  title="Subjects over time"
                  summary="Each subject's mean, exam by exam. Pick up to four."
                  points={points}
                  series={subjects.filter((s) => chosen.includes(s.id)).map((s) => ({ key: s.id, name: s.name, values: s.means }))}
                  controls={<SeriesPicker label="Subjects to show" options={subjects} chosen={chosen} onChange={setPickedSubjects} />}
                />
                <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))" }}>
                  {exam && (
                    <BarList
                      title={`Subjects compared · ${exam.name}`}
                      summary={comparison.length > 1 ? `${comparison[0]!.name} is strongest; ${comparison[comparison.length - 1]!.name} is weakest.` : null}
                      bars={comparison.map((s) => ({ key: s.id, label: s.name, value: s.mean, detail: `${s.learners} marks` }))}
                      valueHeader="Mean"
                    />
                  )}
                  {scheme ? (
                    distributions.length > 0 && (
                      <DistributionChart
                        title="Grade distribution by exam"
                        summary={`Every published mark, grouped by ${scheme === "kcse" ? "KCSE letter" : "CBC level"}.`}
                        bands={GRADE_BANDS[scheme]}
                        rows={distributions}
                        noun="marks"
                      />
                    )
                  ) : (
                    <EmptyState title="Pick a class for grade bands" body="This school grades some classes on KCSE and others on CBC, so grades are spread one class at a time." />
                  )}
                </div>
              </>
            )}

            {classId && exam && (
              prevExam ? (
                <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))" }}>
                  <MoverTable title={`Most improved since ${prevExam.name}`} rows={moved.improved} empty="Nobody's mean rose between these two exams." />
                  <MoverTable title={`Biggest drops since ${prevExam.name}`} rows={moved.dropped} empty="Nobody's mean fell between these two exams." />
                </div>
              ) : (
                <p className="rounded-lg border border-line bg-sunken px-3 py-2.5 text-[12.5px] text-ink-muted">
                  Most improved and biggest drops need two published exams for {scopeName}.
                </p>
              )
            )}

            {!teacher && teaching.length > 0 && (
              <DataTable
                title="Each class and subject's latest mean"
                columns={[
                  { key: "class", header: "Class", width: "0.8fr", render: (r: TeachingResult) => <Cell>{r.className}</Cell> },
                  { key: "subject", header: "Subject", width: "1.1fr", render: (r: TeachingResult) => <Cell>{r.subjectName}</Cell> },
                  { key: "teacher", header: "Taught by", width: "1.2fr", render: (r: TeachingResult) => <span className="text-[12.5px]">{r.teacherName ?? <span className="text-ink-faint">Nobody assigned</span>}</span> },
                  { key: "exam", header: "Latest exam", width: "1.2fr", render: (r: TeachingResult) => <Cell sub={r.latestExam.termName}>{r.latestExam.name}</Cell> },
                  { key: "mean", header: "Mean", align: "right", width: "0.6fr", render: (r: TeachingResult) => <Mono>{fmt(r.latest)}</Mono> },
                  { key: "change", header: "Change", align: "right", width: "0.7fr", render: (r: TeachingResult) => <Change value={r.change} /> },
                ]}
                rows={teaching}
                rowKey={(r) => r.key}
                minWidth="720px"
                empty={{ title: "No results yet", body: "Published results appear here." }}
              />
            )}
            {!teacher && teaching.length > 0 && (
              <p className="-mt-2 text-[11.5px] text-ink-faint">
                "Taught by" is whoever teaches the subject in that class today. A subject that changed hands mid-year is shown under its current teacher.
              </p>
            )}

            {cbe.length > 0 && (
              <DistributionChart
                title={`CBE rubric levels over time · ${scopeName}`}
                summary="Every published strand judgement, by month. EE1 and EE2 count as EE, and so on."
                bands={RUBRIC_BANDS}
                rows={cbe}
                noun="judgements"
              />
            )}
          </>
        )}

        {classId && !loading && !error && (rosterQ.data?.length ?? 0) > 0 && (
          <section className="space-y-3 pt-2">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-lead font-semibold">One learner</h2>
                <p className="text-[12.5px] text-ink-muted">Their published results over time, as their family sees them.</p>
              </div>
              <div className="w-[260px]">
                <SelectField
                  id="perf-learner"
                  label="Learner"
                  value={learnerId}
                  onChange={(e) => setLearnerId(e.target.value)}
                  options={[{ value: "", label: "Choose a learner…" }, ...(rosterQ.data ?? []).map((s) => ({ value: s.id, label: s.full_name }))]}
                />
              </div>
            </div>
            {learner && <LearnerProgress key={learner.id} studentId={learner.id} meanLabel={`${learner.full_name.split(" ")[0] || learner.full_name}'s mean`} />}
          </section>
        )}
      </div>
    </>
  );
}

function MoverTable({ title, rows, empty }: { title: string; rows: Mover[]; empty: string }) {
  return (
    <DataTable
      title={title}
      columns={[
        { key: "name", header: "Learner", width: "1.6fr", render: (m: Mover) => <Cell>{m.name}</Cell> },
        { key: "from", header: "Was", align: "right", width: "0.6fr", render: (m: Mover) => <Mono>{fmt(m.from)}</Mono> },
        { key: "to", header: "Now", align: "right", width: "0.6fr", render: (m: Mover) => <Mono>{fmt(m.to)}</Mono> },
        { key: "change", header: "Change", align: "right", width: "0.7fr", render: (m: Mover) => <Change value={m.change} /> },
      ]}
      rows={rows}
      rowKey={(m) => m.studentId}
      minWidth="360px"
      empty={{ title: "No change to show", body: empty }}
    />
  );
}
