import { GRADE_INK, againstMean, gradeFor, gradingSchemeFor, loadPublishedCbeResults } from "@figbloom/shared";
import { CbeResults } from "../../components/CbeResults";
import { ExamSwitcher } from "../../components/ExamSwitcher";
import { useAsync } from "../../lib/useAsync";
import { useExamView } from "../../lib/useExamView";
import { PageHead } from "../../components/ConsoleShell";
import { Skeleton, TableSkeleton } from "../../components/ui/Skeleton";
import { Cell, DataTable, EmptyState, Mono } from "../../components/ui/DataTable";
import { useParentData } from "../../lib/parentContext";
import { useTenantSession } from "../../lib/sessionContext";
import type { ChildSubject } from "@figbloom/shared";
import { ChildSwitcher } from "./ChildSwitcher";
import { ChildExamPapers } from "./ExamPapers";

/**
 * An exam for the selected child, the newest one with results out unless the
 * parent picks another: one subject per row, each measured against the class
 * mean rather than a class rank.
 */
export function ParentResults() {
  const { tenant } = useTenantSession();
  const { data, loading, error, child } = useParentData();
  const scheme = gradingSchemeFor(tenant.country, child?.classLevel ?? "secondary");
  // CBE strand results (published assessments), alongside any exam marks.
  const { data: cbeByStudent, loading: cbeLoading } = useAsync(
    () => (child ? loadPublishedCbeResults([child.id], tenant.country) : Promise.resolve(new Map())),
    [child?.id, tenant.country],
  );
  const cbe = (child && cbeByStudent?.get(child.id)) || [];
  const view = useExamView(child ? { id: child.id, classId: child.classId, examId: child.examId, exams: child.exams, subjects: child.subjects } : null);
  const mean = view.subjects.length ? Math.round(view.subjects.reduce((sum, s) => sum + s.score, 0) / view.subjects.length) : null;

  const strongestWeakest = view.subjects.length > 1
    ? (() => {
        const sorted = [...view.subjects].sort((a, b) => b.score - a.score);
        return { strongest: sorted[0]!.name, weakest: sorted[sorted.length - 1]!.name };
      })()
    : null;

  return (
    <>
      <PageHead
        eyebrow={child ? `${child.cls} · ADM ${child.adm}` : "Results"}
        title={child ? `${child.first}'s results` : "Results"}
        blurb={view.examName && mean !== null ? (view.examId === child?.examId ? `Most recently published: ${view.examName}.` : `${view.examName}.`) : undefined}
        actions={<ChildSwitcher />}
      />

      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load results: {error.message}
          </p>
        ) : loading || !data || cbeLoading ? (
          <>
            <Skeleton className="h-24 rounded-lg" />
            <div className="mt-5"><TableSkeleton rows={5} /></div>
          </>
        ) : !child ? (
          <EmptyState
            title="No child linked"
            body="This account is not yet linked to a learner. Contact the school office."
          />
        ) : child.exams.length === 0 && !cbe.length ? (
          <EmptyState
            title="Not published yet"
            body={`${child.first}'s results will appear here as soon as the school publishes them.`}
          />
        ) : (
          <>
            <ExamSwitcher exams={child.exams} value={view.examId} onPick={view.pick} />
            {cbe.length > 0 && <div className="mb-6"><CbeResults results={cbe} /></div>}
            {view.error ? (
              <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load these results: {view.error.message}
          </p>
            ) : view.loading ? (
              <TableSkeleton rows={5} />
            ) : mean !== null && (<>
            <div className="rounded-lg p-5 text-white" style={{ background: "var(--accent-deep)" }}>
              <div className="font-mono text-micro tracking-[0.12em] text-white/70">
                MEAN GRADE{view.examName ? ` · ${view.examName.toUpperCase()}` : ""}
              </div>
              <div className="mt-1.5 flex items-baseline gap-3">
                <span className="text-[34px] font-bold tracking-tight">{gradeFor(mean, scheme)}</span>
                <span className="font-mono text-[14px] text-white/80">{mean} marks</span>
              </div>
              {strongestWeakest && (
                <p className="mt-2 max-w-[560px] text-[12.5px] leading-relaxed text-white/85">
                  {strongestWeakest.strongest} is the strongest; {strongestWeakest.weakest} is the one to watch.
                </p>
              )}
            </div>

            <div className="mt-5">
              <DataTable
                title={view.examName ? `${view.examName} results` : "Results"}
                columns={[
                  { key: "name", header: "Subject", width: "1.6fr", render: (r: ChildSubject) => <Cell>{r.name}</Cell> },
                  { key: "score", header: "Score", align: "right", width: "0.7fr", render: (r: ChildSubject) => <Mono>{r.score}</Mono> },
                  {
                    key: "grade", header: "Grade", align: "right", width: "0.7fr",
                    render: (r: ChildSubject) => (
                      <span className="font-mono text-[12.5px] font-semibold" style={{ color: GRADE_INK[gradeFor(r.score, scheme)] }}>
                        {gradeFor(r.score, scheme)}
                      </span>
                    ),
                  },
                  {
                    key: "mean", header: "Against class mean", width: "1.8fr",
                    render: (r: ChildSubject) => (
                      <span className="text-[12.5px] text-ink-muted">
                        {r.classMean !== null ? againstMean(r.score, r.classMean) : "Class mean not available"}
                      </span>
                    ),
                  },
                ]}
                rows={view.subjects}
                rowKey={(r) => r.name}
                minWidth="640px"
                empty={{ title: "No subjects marked yet", body: "Scores will appear here once teachers submit them for this exam." }}
              />
            </div>
            </>)}
          </>
        )}
        {child && child.classId && data && !error && (
          <div className="mt-6"><ChildExamPapers child={child} /></div>
        )}
      </div>
    </>
  );
}
