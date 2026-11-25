import { apiFetchChildMaterials, formatShortDate, localIsoDate, type FamilyMaterialView } from "@figbloom/shared";
import { EmptyState } from "./ui/DataTable";
import { Skeleton } from "./ui/Skeleton";
import { useAsync } from "../lib/useAsync";

/**
 * The materials of a learner's class on the new API: the title, subject, date and the teacher's note. The files themselves cannot be
 * opened yet (they need file storage, which is not set up), and the page says so once, above the list, rather than on every card.
 * Shown to a parent for the selected child (`first` is the child's first name) and to a learner for themselves (`first` is null).
 */
export function FamilyMaterials({ learnerId, first }: { learnerId: string; first: string | null }) {
  const { data, loading, error } = useAsync(() => apiFetchChildMaterials(learnerId), [learnerId]);

  if (error) {
    return (
      <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
        <span aria-hidden>✕</span>Could not load learning materials: {error.message}
      </p>
    );
  }
  if (loading && !data) {
    return (
      <div className="grid gap-3">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-16 rounded-lg" />
      </div>
    );
  }
  if (!data?.length) {
    return (
      <div className="rounded-lg border border-line bg-white">
        <EmptyState
          title="Nothing shared yet"
          body={`When ${first ? `${first}'s` : "your"} teachers share notes, worksheets or videos with ${first ? "the" : "your"} class, they'll be here.`}
        />
      </div>
    );
  }

  const bySubject = new Map<string, FamilyMaterialView[]>();
  for (const m of data) bySubject.set(m.subject, [...(bySubject.get(m.subject) ?? []), m]);
  const groups = [...bySubject.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="grid max-w-[860px] gap-6">
      {!data.some((m) => m.fileAvailable) && (
        <p role="note" className="rounded-lg border border-line bg-page px-4 py-3 text-[12.5px] leading-relaxed text-ink-muted">
          Files cannot be opened here yet. The school's file storage is not on the new system, so for now you see what was shared and when.
        </p>
      )}
      {groups.map(([subject, items]) => (
        <section key={subject}>
          <h2 className="mb-2.5 font-mono text-micro tracking-[0.12em] text-ink-faint">{subject.toUpperCase()} · {items.length}</h2>
          <div className="grid gap-2.5">
            {items.map((m) => (
              <article key={m.id} className="rounded-lg border border-line bg-white px-4 py-3">
                <div className="text-[14px] font-semibold">{m.title}</div>
                <div className="text-[12px] text-ink-faint">Shared {formatShortDate(localIsoDate(new Date(m.createdAt)))}</div>
                {m.description && <p className="mt-2 whitespace-pre-line text-[13px] leading-relaxed">{m.description}</p>}
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
