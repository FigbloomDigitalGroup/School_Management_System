import { useState } from "react";
import type { NoticeInfo } from "@figbloom/shared";
import { useStudentData } from "../../lib/studentContext";
import { PageHead } from "../../components/ConsoleShell";
import { EmptyState } from "../../components/ui/DataTable";
import { TableSkeleton } from "../../components/ui/Skeleton";

/**
 * Master-detail, same pattern as platform/Tenants.tsx: the list stays put
 * while a notice is read, so a student working through several announcements
 * never loses their place.
 */
export function StudentNotices() {
  const { data, loading, error } = useStudentData();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (error) {
    return (
      <>
        <PageHead eyebrow="Notices" title="Notices" />
        <div className="px-7 py-6">
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load notices: {error.message}
          </p>
        </div>
      </>
    );
  }

  if (loading) {
    return (
      <>
        <PageHead eyebrow="Notices" title="Loading…" />
        <div className="px-7 py-6"><TableSkeleton rows={6} /></div>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <PageHead eyebrow="Notices" title="Notices" />
        <div className="px-7 py-6">
          <EmptyState title="No learner record" body="This login is not yet linked to a learner record. Contact the school office." />
        </div>
      </>
    );
  }

  const notices = data.notices;
  const selected = notices.find((n) => n.id === selectedId) ?? notices[0] ?? null;

  return (
    <>
      <PageHead eyebrow="Notices" title="Notices" blurb={notices.length ? `${notices.length} notice${notices.length === 1 ? "" : "s"}.` : undefined} />

      {notices.length === 0 ? (
        <div className="px-7 py-6">
          <EmptyState title="Nothing here yet" body="Announcements from your teachers and the school office will appear here." />
        </div>
      ) : (
        <div className="flex" style={{ height: "calc(100vh - 130px)" }}>
          <div className="w-[340px] shrink-0 overflow-y-auto border-r border-line bg-[#FAFBFA]">
            {notices.map((n: NoticeInfo) => {
              const active = n.id === selected?.id;
              return (
                <button
                  key={n.id}
                  onClick={() => setSelectedId(n.id)}
                  className="flex w-full items-start gap-3 border-b border-line-soft px-4 py-3 text-left"
                  style={{ background: active ? "#F1F5F2" : "transparent", borderLeft: `3px solid ${active ? "#F26A1B" : "transparent"}` }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[13px] font-semibold">{n.subject}</span>
                      <span className="shrink-0 text-[11px] text-ink-faint">{n.when}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[11.5px] text-ink-faint">{n.from}</div>
                    <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-ink-muted">{n.body.split("\n")[0]}</p>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="min-w-0 flex-1 overflow-y-auto p-7">
            {selected ? (
              <>
                <h2 className="text-[18px] font-semibold leading-snug tracking-tight">{selected.subject}</h2>
                <div className="mt-1.5 text-[12.5px] text-ink-faint">{selected.from} · {selected.when}</div>
                <p className="mt-4 max-w-[620px] whitespace-pre-line text-[14px] leading-relaxed">{selected.body}</p>
              </>
            ) : (
              <EmptyState title="No notice selected" body="Choose a notice from the list on the left." />
            )}
          </div>
        </div>
      )}
    </>
  );
}
