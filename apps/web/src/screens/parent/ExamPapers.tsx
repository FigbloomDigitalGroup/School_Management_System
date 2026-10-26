import {
  PAPER_KIND_LABEL, fetchClassPapers, fetchPaperTotals, fetchReleasedAttempts, paperWindow, scoreLabel, windowLabel,
  type ChildInfo,
} from "@figbloom/shared";
import { Badge } from "../../components/ui/Badge";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useAsync } from "../../lib/useAsync";

/**
 * Exam papers and tests for the selected child's class: what's coming up,
 * and their score and the teacher's feedback once results are released.
 * Questions and answers stay with the learner; a parent sees the outcome.
 */
export function ChildExamPapers({ child }: { child: ChildInfo }) {
  const { data, loading, error } = useAsync(async () => {
    const [papers, results] = await Promise.all([fetchClassPapers(child.classId), fetchReleasedAttempts(child.id)]);
    const totals = await fetchPaperTotals(papers.filter((p) => results.has(p.id)).map((p) => p.id));
    return { papers, results, totals };
  }, [child.id, child.classId]);

  const now = Date.now();
  const upcoming = (data?.papers ?? [])
    .filter((p) => !data?.results.has(p.id) && paperWindow(p, now) !== "closed")
    .sort((a, b) => a.opensAt.localeCompare(b.opensAt))
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
  if (!upcoming.length && !released.length) return null;

  return (
    <section className="rounded-lg border border-line bg-white">
      <header className="border-b border-line-soft px-4 py-3">
        <h2 className="text-[14px] font-semibold">Exams & tests</h2>
      </header>
      <ul className="divide-y divide-line-soft">
        {upcoming.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold">{p.title}</div>
              <div className="text-[12px] text-ink-faint">{PAPER_KIND_LABEL[p.kind]} · {p.subjectName} · {windowLabel(p, now)}</div>
            </div>
            <Badge tone={paperWindow(p, now) === "open" ? "warn" : "info"}>{paperWindow(p, now) === "open" ? "Open now" : "Coming up"}</Badge>
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
