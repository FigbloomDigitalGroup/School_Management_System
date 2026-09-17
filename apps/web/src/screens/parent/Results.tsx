import { GRADE_INK, againstMean, gradeFor, gradingSchemeFor } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Skeleton, TableSkeleton } from "../../components/ui/Skeleton";
import { Cell, DataTable, EmptyState, Mono } from "../../components/ui/DataTable";
import { useParentData } from "../../lib/parentContext";
import { useTenantSession } from "../../lib/sessionContext";
import type { ChildSubject } from "@figbloom/shared";
import { ChildSwitcher } from "./ChildSwitcher";

/**
 * The most recently published exam for the selected child: one subject per
 * row, each measured against the class mean rather than a class rank.
 */
export function ParentResults() {
  const { tenant } = useTenantSession();
  const { data, loading, error, child } = useParentData();
  const scheme = gradingSchemeFor(tenant.country, child?.classLevel ?? "secondary");

  const strongestWeakest = child && child.subjects.length > 0
    ? (() => {
        const sorted = [...child.subjects].sort((a, b) => b.score - a.score);
        return { strongest: sorted[0]!.name, weakest: sorted[sorted.length - 1]!.name };
      })()
    : null;

  return (
    <>
      <PageHead
        eyebrow={child ? `${child.cls} · ADM ${child.adm}` : "Results"}
        title={child ? `${child.first}'s results` : "Results"}
        blurb={child?.examName ? `Most recently published: ${child.examName}.` : undefined}
        actions={<ChildSwitcher />}
      />

      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load results: {error.message}
          </p>
        ) : loading || !data ? (
          <>
            <Skeleton className="h-24 rounded-lg" />
            <div className="mt-5"><TableSkeleton rows={5} /></div>
          </>
        ) : !child ? (
          <EmptyState
            title="No child linked"
            body="This account is not yet linked to a learner. Contact the school office."
          />
        ) : child.mean === null ? (
          <EmptyState
            title="Not published yet"
            body={`${child.first}'s results will appear here as soon as the school publishes them.`}
          />
        ) : (
          <>
            <div className="rounded-lg p-5 text-white" style={{ background: "var(--accent-deep)" }}>
              <div className="font-mono text-micro tracking-[0.12em] text-white/70">
                MEAN GRADE{child.examName ? ` · ${child.examName.toUpperCase()}` : ""}
              </div>
              <div className="mt-1.5 flex items-baseline gap-3">
                <span className="text-[34px] font-bold tracking-tight">{gradeFor(child.mean, scheme)}</span>
                <span className="font-mono text-[14px] text-white/80">{child.mean} marks</span>
              </div>
              {strongestWeakest && (
                <p className="mt-2 max-w-[560px] text-[12.5px] leading-relaxed text-white/85">
                  {strongestWeakest.strongest} is the strongest; {strongestWeakest.weakest} is the one to watch.
                </p>
              )}
            </div>

            <div className="mt-5">
              <DataTable
                title={child.examName ? `${child.examName} results` : "Results"}
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
                rows={child.subjects}
                rowKey={(r) => r.name}
                minWidth="640px"
                empty={{ title: "No subjects marked yet", body: "Scores will appear here once teachers submit them for this exam." }}
              />
            </div>
          </>
        )}
      </div>
    </>
  );
}
