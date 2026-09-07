import { useMemo, useState } from "react";
import { PageHead } from "../../components/ConsoleShell";
import { Skeleton, TableSkeleton } from "../../components/ui/Skeleton";
import { EmptyState } from "../../components/ui/DataTable";
import { useParentData } from "../../lib/parentContext";
import { ChildSwitcher } from "./ChildSwitcher";

/**
 * Master-detail inbox: the list stays put on the left while a message is
 * read on the right, so a parent working through several notices never
 * loses their place — the same pattern as the platform Tenants screen.
 */
export function ParentInbox() {
  const { data, loading, error } = useParentData();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const messages = useMemo(() => data?.messages ?? [], [data]);
  const selected = messages.find((m) => m.id === selectedId) ?? messages[0] ?? null;

  return (
    <div className="flex h-full flex-col">
      <PageHead
        eyebrow="Inbox"
        title="Messages from the school"
        blurb="Announcements from the school office and your child's class teacher."
        actions={<ChildSwitcher />}
      />

      {error ? (
        <div className="px-7 py-6">
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load messages: {error.message}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex w-[340px] shrink-0 flex-col overflow-hidden border-r border-line bg-[#FAFBFA]">
            <div className="min-h-0 flex-1 overflow-auto">
              {loading || !data ? (
                <TableSkeleton rows={6} />
              ) : messages.length === 0 ? (
                <EmptyState title="Nothing here yet." body="Announcements from the school will appear here." />
              ) : (
                messages.map((m) => {
                  const active = m.id === selected?.id;
                  return (
                    <button
                      key={m.id}
                      onClick={() => setSelectedId(m.id)}
                      className="flex w-full items-start gap-3 border-b border-line-soft px-4 py-3 text-left"
                      style={{ background: active ? "#F1F5F2" : "transparent", borderLeft: `3px solid ${active ? "var(--accent)" : "transparent"}` }}
                    >
                      <div
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[12px]"
                        style={{ background: m.who === "school" ? "var(--accent-deep)" : "#EEF1EE", color: m.who === "school" ? "#fff" : "#5F6B62" }}
                      >
                        {m.who === "school" ? "◈" : "✎"}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-[12px] font-medium text-ink-muted">{m.from}</span>
                          <span className="shrink-0 text-[11px] text-ink-faint">{m.when}</span>
                        </div>
                        <div className="truncate text-[13px] font-medium">{m.subject}</div>
                        <p className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-ink-muted">{m.body.split("\n")[0]}</p>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="min-w-0 flex-1 overflow-auto px-7 py-6">
            {loading || !data ? (
              <div className="max-w-[640px]">
                <Skeleton className="h-6 w-2/3" />
                <Skeleton className="mt-3 h-3 w-1/3" />
                <Skeleton className="mt-5 h-3 w-full" />
                <Skeleton className="mt-2 h-3 w-full" />
                <Skeleton className="mt-2 h-3 w-2/3" />
              </div>
            ) : selected ? (
              <div className="max-w-[640px]">
                <div className="font-mono text-micro tracking-[0.12em] text-ink-faint">
                  {selected.who === "school" ? "SCHOOL OFFICE" : "CLASS TEACHER"}
                </div>
                <h2 className="mt-1.5 text-h2 font-semibold leading-snug tracking-tight">{selected.subject}</h2>
                <div className="mt-1.5 text-[12.5px] text-ink-muted">{selected.from} · {selected.when}</div>
                <p className="mt-4 whitespace-pre-line text-[14px] leading-relaxed">{selected.body}</p>
              </div>
            ) : (
              <EmptyState title="Nothing here yet." body="Announcements from the school and your child's class teacher will appear here." />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
