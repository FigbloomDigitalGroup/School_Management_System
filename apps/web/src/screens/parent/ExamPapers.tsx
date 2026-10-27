import {
  PAPER_KIND_LABEL, fetchClassPapers, fetchLearnerExamStates, fetchPaperTotals, fetchReleasedAttempts, paperWindow, scoreLabel,
  windowLabel,
  type ChildInfo, type ExamPaperRow, type LearnerExamState,
} from "@figbloom/shared";
import { Badge } from "../../components/ui/Badge";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useAsync } from "../../lib/useAsync";

/** The child's own window where their teacher gave them one (an extension or a resit), else the paper's. */
const windowOf = (p: ExamPaperRow, s: LearnerExamState | undefined) => (s ? { opensAt: s.terms.opensAt, closesAt: s.terms.closesAt } : p);

/**
 * Exam papers and tests for the selected child's class: what's coming up,
 * and their score and the teacher's feedback once results are released.
 * Questions and answers stay with the learner; a parent sees the outcome.
 * An online paper the child missed or was excused from says so: it has no
 * score, and is never shown as 0.
 */
export function ChildExamPapers({ child }: { child: ChildInfo }) {
  const { data, loading, error } = useAsync(async () => {
    const [papers, results, states] = await Promise.all([fetchClassPapers(child.classId), fetchReleasedAttempts(child.id), fetchLearnerExamStates(child.id)]);
    const totals = await fetchPaperTotals(papers.filter((p) => results.has(p.id)).map((p) => p.id));
    return { papers, results, totals, states };
  }, [child.id, child.classId]);

  const now = Date.now();
  const stateOf = (p: ExamPaperRow) => data?.states.get(p.id);
  const upcoming = (data?.papers ?? [])
    .filter((p) => !data?.results.has(p.id) && paperWindow(windowOf(p, stateOf(p)), now) !== "closed"
      && stateOf(p)?.status !== "excused" && stateOf(p)?.status !== "submitted" && stateOf(p)?.status !== "marked")
    .sort((a, b) => a.opensAt.localeCompare(b.opensAt))
    .slice(0, 6);
  const notSat = (data?.papers ?? [])
    .filter((p) => !data?.results.has(p.id) && (stateOf(p)?.status === "missed" || stateOf(p)?.status === "excused"))
    .slice(0, 6);
  const released = (data?.papers ?? []).filter((p) => data?.results.has(p.id)).slice(0, 10);

  if (error) {
    return (
      <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
        <span aria-hidden>✕</span>Could not load exams and tests: {error.message}
      </p>
    );
  }
  if (loading && !data) return <TableSkeleton rows={2} />;
  if (!upcoming.length && !notSat.length && !released.length) return null;

  return (
    <section className="rounded-lg border border-line bg-white">
      <header className="border-b border-line-soft px-4 py-3">
        <h2 className="text-[14px] font-semibold">Exams & tests</h2>
      </header>
      <ul className="divide-y divide-line-soft">
        {upcoming.map((p) => {
          const win = windowOf(p, stateOf(p));
          return (
            <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold">{p.title}</div>
                <div className="text-[12px] text-ink-faint">{PAPER_KIND_LABEL[p.kind]} · {p.subjectName} · {windowLabel(win, now)}</div>
              </div>
              <Badge tone={paperWindow(win, now) === "open" ? "warn" : "info"}>{paperWindow(win, now) === "open" ? "Open now" : "Coming up"}</Badge>
            </li>
          );
        })}
        {notSat.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold">{p.title}</div>
              <div className="text-[12px] text-ink-faint">
                {PAPER_KIND_LABEL[p.kind]} · {p.subjectName} · {stateOf(p)?.status === "excused" ? "excused by the teacher, no mark" : "not sat, no mark (not a 0)"}
              </div>
            </div>
            <Badge tone="muted">{stateOf(p)?.status === "excused" ? "Excused" : "Missed"}</Badge>
          </li>
        ))}
        {released.map((p) => {
          const r = data!.results.get(p.id)!;
          return (
            <li key={p.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold">{p.title}</div>
                  <div className="text-[12px] text-ink-faint">{PAPER_KIND_LABEL[p.kind]} · {p.subjectName}</div>
                </div>
                <span className="shrink-0 font-mono text-[12.5px] font-semibold">{scoreLabel(r.finalScore, data!.totals.get(p.id) ?? 0)}</span>
              </div>
              {r.feedback && <p className="mt-1.5 whitespace-pre-line text-[12.5px] leading-relaxed text-ink-muted">{r.feedback}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
