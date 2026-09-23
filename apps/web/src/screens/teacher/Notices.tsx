import { useEffect, useRef, useState } from "react";
import { fetchTeacherNotices, markNoticeRead, subscribeAnnouncements, type NoticeInfo } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { EmptyState } from "../../components/ui/DataTable";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useTenantSession } from "../../lib/sessionContext";
import { useNoticeRead } from "../../lib/teacherNoticesContext";

const NOTICE_POLL_MS = 20_000;

/**
 * Master-detail, same pattern as parent/Inbox.tsx and student/Notices.tsx —
 * whole-school announcements plus anything sent to this teacher personally,
 * such as a principal's "remind teacher" nudge from the morning dashboard.
 * Opening one clears it from the sidebar's unread badge, same as any inbox.
 * Streams new announcements in real time (subscribeAnnouncements), with a
 * poll as a fallback — a reminder sent while this screen is already open
 * just appears, no navigating away and back, no page refresh.
 */
export function TeacherNotices() {
  const { profile, tenant } = useTenantSession();
  const notifyRead = useNoticeRead();
  const [notices, setNotices] = useState<NoticeInfo[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Only the very first load is allowed to surface an error screen — once
  // something's on screen, a later poll hiccup shouldn't blank it out.
  const loadedOnce = useRef(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetchTeacherNotices(profile.id)
        .then((fresh) => {
          if (!alive) return;
          loadedOnce.current = true;
          setNotices(fresh);
          setError(null);
        })
        .catch((err: Error) => { if (alive && !loadedOnce.current) setError(err); });
    };
    load();
    const id = window.setInterval(load, NOTICE_POLL_MS);
    const unsubscribe = subscribeAnnouncements(tenant.id, load);
    return () => { alive = false; window.clearInterval(id); unsubscribe(); };
  }, [profile.id, tenant.id]);

  function open(id: string) {
    setSelectedId(id);
    setNotices((ns) => {
      if (!ns) return ns;
      const target = ns.find((n) => n.id === id);
      if (!target?.unread) return ns;
      void markNoticeRead(profile.id, id).catch(() => {});
      notifyRead();
      return ns.map((n) => (n.id === id ? { ...n, unread: false } : n));
    });
  }

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

  if (!notices) {
    return (
      <>
        <PageHead eyebrow="Notices" title="Loading…" />
        <div className="px-7 py-6"><TableSkeleton rows={6} /></div>
      </>
    );
  }

  const selected = notices.find((n) => n.id === selectedId) ?? notices[0] ?? null;

  return (
    <>
      <PageHead eyebrow="Notices" title="Notices" blurb={notices.length ? `${notices.length} notice${notices.length === 1 ? "" : "s"}.` : undefined} />

      {notices.length === 0 ? (
        <div className="px-7 py-6">
          <EmptyState title="Nothing here yet" body="Announcements from the school office will appear here." />
        </div>
      ) : (
        <div className="flex" style={{ height: "calc(100vh - 130px)" }}>
          <div className="w-[340px] shrink-0 overflow-y-auto border-r border-line bg-[#FAFBFA]">
            {notices.map((n) => {
              const active = n.id === selected?.id;
              return (
                <button
                  key={n.id}
                  onClick={() => open(n.id)}
                  className="flex w-full items-start gap-3 border-b border-line-soft px-4 py-3 text-left"
                  style={{ background: active ? "#F1F5F2" : "transparent", borderLeft: `3px solid ${active ? "var(--accent)" : "transparent"}` }}
                >
                  {n.unread && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-orange" aria-hidden />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[13px]" style={{ fontWeight: n.unread ? 700 : 500 }}>{n.subject}</span>
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
