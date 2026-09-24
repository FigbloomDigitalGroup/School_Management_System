import { GRADE_INK, formatShortDate, type CbeLearningAreaResult } from "@figbloom/shared";

/**
 * A learner's published CBE results: per learning area, the overall rubric
 * level, each strand's level and the teacher's comment. Shared by the parent
 * and student Results screens. Levels are words as well as codes — "ME2"
 * means nothing to a parent on its own.
 */
export function CbeResults({ results, heading = "Learning areas" }: { results: CbeLearningAreaResult[]; heading?: string }) {
  if (!results.length) return null;
  return (
    <section>
      <h2 className="mb-2.5 text-[14px] font-semibold">{heading}</h2>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
        {results.map((r) => (
          <article key={r.subjectId} className="rounded-lg border border-line bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-[14px] font-semibold">{r.subjectName}</h3>
                <p className="mt-0.5 text-[11.5px] text-ink-faint">{r.assessmentTitle} · {formatShortDate(r.assessedOn)}</p>
              </div>
              {r.overall && (
                <div className="shrink-0 text-right">
                  <div className="font-mono text-[20px] font-bold leading-none" style={{ color: GRADE_INK[r.overall.code] }}>{r.overall.code}</div>
                  <div className="mt-1 max-w-[140px] text-[11px] leading-tight text-ink-muted">{r.overall.label}</div>
                </div>
              )}
            </div>
            <ul className="mt-3 grid gap-1.5 border-t border-line-soft pt-3">
              {r.strands.map((s) => (
                <li key={s.strandId} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                  <span className="min-w-0 text-ink">{s.name}</span>
                  <span className="shrink-0 font-mono font-semibold" style={{ color: GRADE_INK[s.code] }} title={s.label}>{s.code}</span>
                </li>
              ))}
            </ul>
            {r.comment && (
              <p className="mt-3 rounded-md bg-sunken px-3 py-2 text-[12.5px] leading-relaxed text-ink-muted">“{r.comment}”</p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
