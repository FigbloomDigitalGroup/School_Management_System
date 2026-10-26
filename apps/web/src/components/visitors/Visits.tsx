import { useEffect, useState, type ReactNode } from "react";
import {
  listVisits, subscribeVisits, visitAlert, visitHostLabel, VISIT_STATUS_LABEL, type Visit, type VisitStatus,
} from "@figbloom/shared";
import { Badge, type Tone } from "../ui/Badge";
import { Cell, DataTable } from "../ui/DataTable";
import { useToast } from "../ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";

const canNotify = () => typeof window !== "undefined" && "Notification" in window;

/**
 * Mounted in the admin and teacher shells: a visitor for this person, or one
 * escalated to the principal's office, pops up on whatever page they're on,
 * and as a system notification when the tab is in the background. Phones
 * get the same words as push from visit-notify.
 */
export function VisitAlertsListener() {
  const { tenant, profile, actingForTenant } = useTenantSession();
  const toast = useToast();
  // an org admin acting inside the school is told what its own admins are
  const role = actingForTenant ? "school_admin" : profile.role;

  useEffect(() => {
    return subscribeVisits(tenant.id, (v, isNew) => {
      const alert = visitAlert(v, { profileId: profile.id, role }, isNew);
      if (!alert) return;
      toast(`${alert.title} · ${alert.body}`);
      if (canNotify() && Notification.permission === "granted" && document.hidden) {
        new Notification(alert.title, { body: alert.body, tag: `visit-${v.id}`, icon: "/figbloom-mark.png" });
      }
    });
  }, [tenant.id, profile.id, role, toast]);

  return null;
}

/** Midnight at the start of `day` (local time). */
export function startOfDay(day = new Date()): Date {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * The visits that arrived on `day`, kept live: a visit recorded or moved
 * along anywhere shows up here without a reload. RLS decides whose visits a
 * person gets, so the same hook serves the desk, the office and a teacher.
 */
export function useDayVisits(day: Date): { visits: Visit[]; loading: boolean; error: Error | null; replace: (v: Visit) => void } {
  const { tenant } = useTenantSession();
  const from = startOfDay(day);
  const key = from.getTime();
  const [visits, setVisits] = useState<Visit[]>([]);
  const [loadedFor, setLoadedFor] = useState<number | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const replace = (v: Visit) => setVisits((prev) => [v, ...prev.filter((p) => p.id !== v.id)].sort((a, b) => b.arrived_at.localeCompare(a.arrived_at)));

  useEffect(() => {
    let alive = true;
    const until = new Date(key);
    until.setDate(until.getDate() + 1);
    setError(null);
    listVisits(tenant.id, new Date(key), until)
      .then((rows) => { if (alive) setVisits(rows); })
      .catch((err: Error) => { if (alive) setError(err); })
      .finally(() => { if (alive) setLoadedFor(key); });
    const off = subscribeVisits(tenant.id, (v) => {
      const at = new Date(v.arrived_at).getTime();
      if (at >= key && at < until.getTime()) replace(v);
    });
    return () => { alive = false; off(); };
  }, [tenant.id, key]);

  return { visits, loading: loadedFor !== key, error, replace };
}

const STATUS_TONE: Record<VisitStatus, Tone> = { expected: "info", at_reception: "warn", with_host: "ok", left: "muted" };

const clock = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—");

/** One list of visits for every console; `actions` adds the desk's buttons. */
export function VisitTable({ title, visits, actions, empty, showContact = true }: {
  title?: string;
  visits: Visit[];
  actions?: (v: Visit) => ReactNode;
  empty: { title: string; body: string };
  /** Phone, ID and plate: the desk and the office need them; a teacher doesn't. */
  showContact?: boolean;
}) {
  return (
    <DataTable
      title={title}
      columns={[
        {
          key: "visitor", header: "Visitor", width: "1.4fr",
          render: (v: Visit) => (
            <Cell sub={showContact ? [v.visitor_phone, v.id_number && `ID ${v.id_number}`, v.vehicle_plate].filter(Boolean).join(" · ") || undefined : undefined}>
              {v.visitor_name}
            </Cell>
          ),
        },
        { key: "for", header: "Here to see", width: "1.2fr", render: (v: Visit) => <Cell sub={v.purpose}>{visitHostLabel(v)}</Cell> },
        {
          key: "status", header: "Status",
          render: (v: Visit) => (
            <div className="flex flex-wrap gap-1">
              <Badge tone={STATUS_TONE[v.status]}>{VISIT_STATUS_LABEL[v.status]}</Badge>
              {v.escalated && <Badge tone="warn">Principal's office</Badge>}
            </div>
          ),
        },
        {
          key: "times", header: "In · out", width: "0.8fr",
          render: (v: Visit) => <span className="font-mono text-[12px] text-ink-muted">{clock(v.arrived_at)} · {clock(v.left_at)}</span>,
        },
        ...(actions ? [{ key: "actions", header: "", align: "right" as const, width: "1.4fr", render: (v: Visit) => <div className="flex flex-wrap justify-end gap-1.5">{actions(v)}</div> }] : []),
      ]}
      rows={visits}
      rowKey={(v) => v.id}
      minWidth={actions ? "900px" : "720px"}
      empty={empty}
    />
  );
}
