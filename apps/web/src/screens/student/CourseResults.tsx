import { creditWeightedGpa, fetchStudentCourseResults, type StudentCourseResult } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Cell, DataTable, EmptyState, Mono } from "../../components/ui/DataTable";
import { StatRow } from "../../components/ui/StatCard";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useAsync } from "../../lib/useAsync";
import { useStudentData } from "../../lib/studentContext";

/**
 * The higher-ed results screen — credit/GPA instead of K-12's class-mean
 * letter grade (see student/Results.tsx for that version; Results.tsx
 * chooses between the two based on tenant.institution_type). One row per
 * enrolled course; a course shows a finalized grade only once its lecturer
 * has run "Finalize grades" — until then it just lists whatever assessments
 * have been published, same draft/publish gate as K-12.
 */
export function StudentCourseResults() {
  const { data: studentData, loading: studentLoading, error: studentError } = useStudentData();
  const { data: results, loading: resultsLoading, error: resultsError } = useAsync(
    () => (studentData ? fetchStudentCourseResults(studentData.studentId) : Promise.resolve([] as StudentCourseResult[])),
    [studentData?.studentId],
  );

  const error = studentError ?? resultsError;
  const loading = studentLoading || (!!studentData && resultsLoading);

  if (error) {
    return (
      <>
        <PageHead eyebrow="Results" title="Results" />
        <div className="px-7 py-6">
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load results: {error.message}
          </p>
        </div>
      </>
    );
  }

  if (loading) {
    return (
      <>
        <PageHead eyebrow="Results" title="Loading…" />
        <div className="px-7 py-6"><TableSkeleton rows={6} /></div>
      </>
    );
  }

  if (!studentData) {
    return (
      <>
        <PageHead eyebrow="Results" title="Results" />
        <div className="px-7 py-6">
          <EmptyState title="No learner record" body="This login is not yet linked to a learner record. Contact the school office." />
        </div>
      </>
    );
  }

  const courses = results ?? [];
  const graded = courses.filter((c) => c.grade);
  const gpa = creditWeightedGpa(graded.map((c) => ({ grade_points: c.grade!.points, credits: c.credits })));

  return (
    <>
      <PageHead eyebrow="Results" title="Results" blurb={courses.length ? `${courses.length} enrolled course${courses.length === 1 ? "" : "s"} this semester.` : undefined} />

      <div className="px-7 py-6">
        {courses.length === 0 ? (
          <EmptyState title="Not enrolled yet" body="Once you're enrolled in a course section, your results will appear here." />
        ) : (
          <>
            <StatRow
              stats={[
                { label: "GPA", value: gpa === null ? "—" : gpa.toFixed(2), sub: gpa === null ? "no finalized grades yet" : `across ${graded.length} finalized course${graded.length === 1 ? "" : "s"}` },
                { label: "Enrolled courses", value: String(courses.length) },
              ]}
            />

            <div className="mt-5 grid gap-3.5">
              {courses.map((c) => (
                <section key={c.courseSectionId} className="overflow-hidden rounded-lg border border-line bg-white">
                  <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
                    <div>
                      <div className="text-body font-semibold">{c.courseName}</div>
                      <div className="text-[12px] text-ink-faint">{c.courseCode} · Section {c.sectionLabel} · {c.semesterName}</div>
                    </div>
                    {c.grade ? (
                      <div className="text-right">
                        <div className="font-mono text-[18px] font-bold">{c.grade.letter}</div>
                        <div className="text-[11.5px] text-ink-faint">{c.grade.weightedScore}% · {c.grade.points.toFixed(1)} pts</div>
                      </div>
                    ) : (
                      <span className="text-[12px] text-ink-faint">Not finalized yet</span>
                    )}
                  </header>
                  {c.assessments.length === 0 ? (
                    <div className="px-4 py-6 text-center text-[12.5px] text-ink-faint">Nothing published yet.</div>
                  ) : (
                    <DataTable
                      columns={[
                        { key: "name", header: "Assessment", width: "1.6fr", render: (a: StudentCourseResult["assessments"][number]) => <Cell>{a.name}</Cell> },
                        { key: "weight", header: "Weight", align: "right", render: (a: StudentCourseResult["assessments"][number]) => <Mono>{a.weightPct}%</Mono> },
                        { key: "score", header: "Score", align: "right", render: (a: StudentCourseResult["assessments"][number]) => <Mono>{a.score === null ? "—" : `${a.score} / ${a.outOf}`}</Mono> },
                      ]}
                      rows={c.assessments}
                      rowKey={(a) => a.name}
                      minWidth="0"
                      empty={{ title: "Nothing published yet.", body: "Assessment scores appear here once your instructor publishes them." }}
                    />
                  )}
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
