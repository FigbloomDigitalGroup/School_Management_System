import { apiFetchChildReportCards, formatShortDate, type FamilyReportCardView } from "@figbloom/shared";
import { Skeleton } from "../../components/ui/Skeleton";
import { useAsync } from "../../lib/useAsync";

/**
 * The report cards the school has published for one child, newest first, as the API gives them to a parent: the child's own total and
 * average and grade for the term, the strand levels and the competency ratings. The API sends this summary, not the subject-by-subject
 * card, so there is no PDF here (parentCapabilities().reportCardPdf) and nothing of another learner's is in it. Says nothing at all
 * until there is a card, as the Supabase page does.
 */
export function FamilyReportCards({ studentId, first }: { studentId: string; first: string }) {
  const { data, loading, error } = useAsync(() => apiFetchChildReportCards(studentId), [studentId]);

  if (error) {
    return (
      <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
        <span aria-hidden>✕</span>Could not load report cards: {error.message}
      </p>
    );
  }
  if (loading && !data) return <Skeleton className="h-20 rounded-lg" />;
  if (!data?.length) return null;

  return (
    <section className="rounded-lg border border-line bg-white" aria-label="Report cards">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-[14px] font-semibold">Report cards</h2>
        <p className="mt-0.5 text-[12px] text-ink-faint">
          What the school published for {first}. The downloadable PDF is not on the new system yet.
        </p>
      </header>
      <ul>
        {data.map((c) => <Card key={c.id} card={c} first={first} />)}
      </ul>
    </section>
  );
}

function Card({ card, first }: { card: FamilyReportCardView; first: string }) {
  const s = card.summary;
  return (
    <li className="border-b border-line px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[13.5px] font-medium">{card.termLabel}</div>
        <div className="text-[12px] text-ink-faint">{card.className} · published {formatShortDate(card.publishedAt.slice(0, 10))}</div>
      </div>
      {s ? (
        <div className="mt-1 text-[12.5px] text-ink-muted">
          {s.average !== null ? `Average ${s.average}%` : "No average"}
          {s.grade ? `, grade ${s.grade}` : ""}
          {` · ${s.count} subject${s.count === 1 ? "" : "s"}`}
          {card.gradingSchemeName ? ` · ${card.gradingSchemeName}` : ""}
        </div>
      ) : (
        <div className="mt-1 text-[12.5px] text-ink-faint">{first} had no marks on this report card.</div>
      )}
      {card.cbe.length > 0 && (
        <ul className="mt-2 grid gap-1">
          {card.cbe.map((r, i) => (
            <li key={`${r.title}-${i}`} className="flex items-baseline justify-between gap-3 text-[12.5px]">
              <span className="min-w-0">{r.title}{r.feedback ? <span className="text-ink-muted"> · {r.feedback}</span> : null}</span>
              <span className="shrink-0 font-mono font-semibold">{r.levelCode}</span>
            </li>
          ))}
        </ul>
      )}
      {card.competencies.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {card.competencies.map((r, i) => (
            <span key={`${r.item}-${i}`} className="rounded-full bg-page px-2.5 py-1 text-[11.5px] text-ink-muted">{r.item}: <span className="font-mono font-semibold text-ink">{r.levelCode}</span></span>
          ))}
        </div>
      )}
    </li>
  );
}
