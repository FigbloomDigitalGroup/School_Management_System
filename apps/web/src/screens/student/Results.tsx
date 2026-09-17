import { againstMean, GRADE_INK, gradeFor, gradingSchemeFor, pointsFor } from "@figbloom/shared";
import type { ResultSubject } from "@figbloom/shared";
import { useStudentData } from "../../lib/studentContext";
import { useTenantSession } from "../../lib/sessionContext";
import { PageHead } from "../../components/ConsoleShell";
import { Cell, DataTable, EmptyState, Mono } from "../../components/ui/DataTable";
import { StatRow } from "../../components/ui/StatCard";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { StudentCourseResults } from "./CourseResults";

/**
 * No class position anywhere — the same product decision StudentApp.tsx (the
 * phone preview) makes. Marks are shown against the class mean instead, and
 * the footer note carries the same copy forward onto desktop.
 *
 * A higher-ed tenant has no class mean or KCSE letter grade at all — it gets
 * the credit/GPA equivalent (CourseResults) instead, under this same "Results"
 * nav entry rather than a second one.
 */
export function StudentResults() {
  const { tenant } = useTenantSession();
  const { data, loading, error } = useStudentData();

  if (tenant.institution_type === "higher_ed") return <StudentCourseResults />;

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

  if (!data) {
    return (
      <>
        <PageHead eyebrow="Results" title="Results" />
        <div className="px-7 py-6">
          <EmptyState title="No learner record" body="This login is not yet linked to a learner record. Contact the school office." />
        </div>
      </>
    );
  }

  const scheme = gradingSchemeFor(tenant.country, data.classLevel ?? "secondary");
  const subjects = data.subjects;
  const meanMark = subjects.length ? Math.round(subjects.reduce((a, s) => a + s.score, 0) / subjects.length) : null;
  const points = subjects.reduce((a, s) => a + pointsFor(s.score, scheme), 0);

  return (
    <>
      <PageHead
        eyebrow={data.examName ?? "Results"}
        title={data.className || "Results"}
        blurb={subjects.length > 0 ? "Marks shown against the class mean — never a class rank." : undefined}
      />

      <div className="px-7 py-6">
        {subjects.length === 0 || meanMark === null ? (
          <EmptyState title="Not published yet" body="Your results will appear here as soon as the school publishes them." />
        ) : (
          <>
            <StatRow
              stats={[
                { label: data.examName ?? "Latest exam", value: gradeFor(meanMark, scheme), sub: `${meanMark} marks · ${points} points` },
                { label: "Subjects assessed", value: String(subjects.length) },
              ]}
            />

            {subjects.length > 1 && (() => {
              const sorted = [...subjects].sort((a, b) => b.score - a.score);
              const strongest = sorted[0]!.name;
              const weakest = sorted[sorted.length - 1]!.name;
              return (
                <p className="mt-4 text-[12.5px] leading-relaxed text-ink-muted">
                  {strongest} is carrying the mean; {weakest} is the one pulling it down.
                </p>
              );
            })()}

            <div className="mt-5">
              <DataTable
                title="By subject"
                minWidth="640px"
                columns={[
                  { key: "name", header: "Subject", width: "1.6fr", render: (s: ResultSubject) => <Cell>{s.name}</Cell> },
                  { key: "score", header: "Score", align: "right", width: "0.7fr", render: (s: ResultSubject) => <Mono>{s.score}</Mono> },
                  {
                    key: "grade", header: "Grade", align: "right", width: "0.7fr",
                    render: (s: ResultSubject) => (
                      <span className="font-mono text-[13px] font-semibold" style={{ color: GRADE_INK[gradeFor(s.score, scheme)] }}>
                        {gradeFor(s.score, scheme)}
                      </span>
                    ),
                  },
                  {
                    key: "mean", header: "Against class mean", width: "1.8fr",
                    render: (s: ResultSubject) => (
                      <span className="text-[12.5px] text-ink-muted">
                        {s.classMean !== null ? againstMean(s.score, s.classMean) : "Class mean not available"}
                      </span>
                    ),
                  },
                ]}
                rows={subjects}
                rowKey={(s) => s.name}
                empty={{ title: "Not published yet", body: "Your results will appear here as soon as the school publishes them." }}
              />
            </div>

            <p className="mt-4 max-w-[620px] text-[12px] leading-relaxed text-ink-faint">
              Class position is not shown here. Ask your class teacher if you want it — they will give it with the
              context that goes around it.
            </p>
          </>
        )}
      </div>
    </>
  );
}
