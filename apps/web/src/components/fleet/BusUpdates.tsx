import { useEffect, useState } from "react";
import { listBusUpdates, personaliseBusTitle, subscribeBusUpdates, type BusUpdate, type ChildInfo } from "@figbloom/shared";
import { Skeleton } from "../ui/Skeleton";
import { useToast } from "../ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";
import { useParentData } from "../../lib/parentContext";

/** The children of this family an update is about, by first name. */
export function namesFor(u: BusUpdate, children: ChildInfo[]): string[] {
  return children.filter((c) => u.student_ids.includes(c.id)).map((c) => c.first);
}

const canNotify = () => typeof window !== "undefined" && "Notification" in window;

/**
 * Mounted once in ParentShell: every new update about this family's children
 * pops up as a toast on whatever page they're on, and as a system
 * notification when the tab is in the background (if they've allowed it).
 * Phones get the same updates as push from bus-tick, app open or not.
 */
export function BusUpdatesListener() {
  const { tenant } = useTenantSession();
  const { children } = useParentData();
  const toast = useToast();
  const key = children.map((c) => c.id).join(",");

  useEffect(() => {
    if (!children.length) return;
    return subscribeBusUpdates(tenant.id, (u) => {
      const names = namesFor(u, children);
      if (!names.length) return;
      const title = personaliseBusTitle(u.title, names);
      toast(`${title} · ${u.body}`);
      if (canNotify() && Notification.permission === "granted" && document.hidden) {
        // Same tag per child's stop: a newer update replaces the last, like the phone push.
        new Notification(title, { body: u.body, tag: `bus-${u.trip_id}-${u.stop_id}`, icon: "/figbloom-mark.png" });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- children are keyed by id
  }, [tenant.id, key]);

  return null;
}

/** Today's updates for these children, kept live. `loading` is only the
 *  first fetch — a realtime insert never puts the feed back into loading. */
export function useTodaysBusUpdates(studentIds: string[]): { updates: BusUpdate[]; loading: boolean } {
  const { tenant } = useTenantSession();
  const [updates, setUpdates] = useState<BusUpdate[]>([]);
  const key = studentIds.join(",");
  // The id list the first fetch has come back for; until then the feed is loading, not empty.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  useEffect(() => {
    if (!studentIds.length) return;
    let alive = true;
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    listBusUpdates(studentIds, midnight)
      .then((u) => { if (alive) setUpdates(u); })
      .catch(() => {})
      .finally(() => { if (alive) setLoadedFor(key); });
    const off = subscribeBusUpdates(tenant.id, (u) => {
      if (u.student_ids.some((id) => studentIds.includes(id))) setUpdates((prev) => [u, ...prev.filter((p) => p.id !== u.id)]);
    });
    return () => { alive = false; off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by id list
  }, [tenant.id, key]);

  return { updates, loading: studentIds.length > 0 && loadedFor !== key };
}

/** Offer browser notifications once, for when the bus page is in a background tab. */
export function NotifyButton() {
  const [perm, setPerm] = useState(() => (canNotify() ? Notification.permission : "denied"));
  if (perm !== "default") return null;
  return (
    <button
      type="button"
      onClick={() => void Notification.requestPermission().then(setPerm)}
      className="rounded-full border border-line bg-white px-3 py-1.5 text-[12px] font-semibold text-ink hover:border-forest"
    >
      🔔 Notify me on this computer
    </button>
  );
}

const ICON: Record<BusUpdate["kind"], string> = { trip_started: "🚌", distance: "📍", arrived: "✅", delay: "⏱" };

/** A child's updates today, newest first: the trail of what the family was told. */
export function UpdateFeed({ updates, limit = 4, loading = false }: { updates: BusUpdate[]; limit?: number; loading?: boolean }) {
  if (loading && !updates.length) {
    return (
      <div className="grid gap-1.5" aria-busy="true">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton className="h-3.5 w-4 shrink-0" />
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-2.5 w-9 shrink-0" />
          </div>
        ))}
      </div>
    );
  }
  if (!updates.length) return null;
  return (
    <ol className="grid gap-1.5">
      {updates.slice(0, limit).map((u) => (
        <li key={u.id} className="flex gap-2 text-[12px] leading-snug">
          <span aria-hidden className="w-4 shrink-0 text-center">{ICON[u.kind]}</span>
          <span className="min-w-0 flex-1">
            <span className={u.kind === "delay" ? "font-semibold text-warn-ink" : "font-semibold"}>{u.title}</span>
            <span className="text-ink-muted"> · {u.body}</span>
          </span>
          <time className="shrink-0 font-mono text-[11px] text-ink-faint" dateTime={u.created_at}>
            {new Date(u.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time>
        </li>
      ))}
    </ol>
  );
}
