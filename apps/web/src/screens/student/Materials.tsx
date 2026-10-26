import { useState } from "react";
import { fetchClassMaterials, formatShortDate, groupBySubject, localIsoDate, mediaSummary, type MaterialRow } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { MediaGlyph, MediaPlayer } from "../../components/Media";
import { EmptyState } from "../../components/ui/DataTable";
import { Skeleton, TableSkeleton } from "../../components/ui/Skeleton";
import { useStudentData } from "../../lib/studentContext";
import { useAsync } from "../../lib/useAsync";

/**
 * A class's published learning materials, by subject: notes and worksheets
 * open, videos and recordings play in the page, YouTube / Vimeo / Drive
 * links play in an embedded player. Shared by the student screen below and
 * the parent's (per child).
 */
export function ClassMaterials({ classId, emptyBody }: { classId: string; emptyBody: string }) {
  const { data, loading, error } = useAsync(() => fetchClassMaterials(classId), [classId]);
  const [openId, setOpenId] = useState<string | null>(null);

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
        <EmptyState title="Nothing shared yet" body={emptyBody} />
      </div>
    );
  }

  return (
    <div className="grid max-w-[860px] gap-6">
      {groupBySubject(data).map(({ subject, items }) => (
        <section key={subject}>
          <h2 className="mb-2.5 font-mono text-micro tracking-[0.12em] text-ink-faint">{subject.toUpperCase()} · {items.length}</h2>
          <div className="grid gap-2.5">
            {items.map((m) => <MaterialCard key={m.id} m={m} open={openId === m.id} onToggle={() => setOpenId((id) => (id === m.id ? null : m.id))} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function MaterialCard({ m, open, onToggle }: { m: MaterialRow; open: boolean; onToggle: () => void }) {
  return (
    <article className="rounded-lg border border-line bg-white">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <MediaGlyph kind={m.kind} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold">{m.title}</span>
          <span className="block truncate text-[12px] text-ink-faint">
            {mediaSummary(m)} · {formatShortDate(localIsoDate(new Date(m.publishedAt ?? m.createdAt)))}
          </span>
        </span>
        <span className="shrink-0 text-[12.5px] font-semibold text-forest">{open ? "Close" : m.kind === "video" ? "Watch" : "Open"}</span>
      </button>
      {open && (
        <div className="grid gap-3 border-t border-line-soft px-4 py-3.5">
          {m.description && <p className="whitespace-pre-line text-[13px] leading-relaxed">{m.description}</p>}
          <MediaPlayer item={m} />
        </div>
      )}
    </article>
  );
}

export function StudentMaterials() {
  const { data, loading, error } = useStudentData();

  return (
    <>
      <PageHead eyebrow="Learning materials" title="Learning materials" blurb="Notes, worksheets and videos your teachers have shared with your class." />
      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load your class: {error.message}
          </p>
        ) : loading ? (
          <TableSkeleton rows={4} />
        ) : !data?.classId ? (
          <EmptyState title="No class yet" body="This login isn't linked to a class yet. Contact the school office." />
        ) : (
          <ClassMaterials classId={data.classId} emptyBody="When your teachers share notes, worksheets or videos with your class, they'll be here." />
        )}
      </div>
    </>
  );
}
