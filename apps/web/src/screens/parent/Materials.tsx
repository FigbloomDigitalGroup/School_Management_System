import { apiFetchChildMaterials, formatShortDate, localIsoDate, parentCapabilities, type FamilyMaterialView } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { EmptyState } from "../../components/ui/DataTable";
import { Skeleton, TableSkeleton } from "../../components/ui/Skeleton";
import { useParentData } from "../../lib/parentContext";
import { useAsync } from "../../lib/useAsync";
import { ClassMaterials } from "../student/Materials";
import { ChildSwitcher } from "./ChildSwitcher";

/** The selected child's class materials: what the teachers have shared, by subject, the same list the child sees. */
export function ParentMaterials() {
  const { child, loading } = useParentData();
  const can = parentCapabilities();

  return (
    <>
      <PageHead
        eyebrow={child ? `${child.cls} · ADM ${child.adm}` : "Learning materials"}
        title={child ? `${child.first}'s learning materials` : "Learning materials"}
        blurb="Notes, worksheets and videos the teachers have shared with the class."
        actions={<ChildSwitcher />}
      />
      <div className="px-7 py-6">
        {loading ? (
          <TableSkeleton rows={4} />
        ) : !child ? (
          <EmptyState title="No child linked" body="This account is not yet linked to a learner. Contact the school office." />
        ) : can.materialFiles ? (
          <ClassMaterials classId={child.classId} emptyBody={`When ${child.first}'s teachers share notes, worksheets or videos with the class, they'll be here.`} />
        ) : (
          <FamilyMaterials key={child.id} learnerId={child.id} first={child.first} />
        )}
      </div>
    </>
  );
}

/**
 * The materials of a child's class on the new API: the title, subject, date and the teacher's note. The files themselves cannot be
 * opened yet (they need file storage, which is not set up), and the page says so once, above the list, rather than on every card.
 */
function FamilyMaterials({ learnerId, first }: { learnerId: string; first: string }) {
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
        <EmptyState title="Nothing shared yet" body={`When ${first}'s teachers share notes, worksheets or videos with the class, they'll be here.`} />
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
