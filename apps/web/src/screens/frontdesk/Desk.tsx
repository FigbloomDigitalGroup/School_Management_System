import { useEffect, useState } from "react";
import {
  escalateVisit, nextVisitSteps, pushVisit, setVisitStatus, subscribeVisits, visitHostLabel, visitQueue, VISIT_STEP_LABEL,
  type Visit, type VisitStatus,
} from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { VisitForm } from "../../components/visitors/VisitForm";
import { useDayVisits, VisitTable } from "../../components/visitors/Visits";
import { Button } from "../../components/ui/Button";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";

/** The step buttons for one visit, and escalation for reception and the office. */
export function useDeskActions() {
  const toast = useToast();
  const { profile } = useTenantSession();
  const [busy, setBusy] = useState<string | null>(null);

  async function step(v: Visit, status: VisitStatus) {
    setBusy(v.id);
    try {
      await setVisitStatus(v.id, status);
    } catch (err) {
      toast(err instanceof Error ? `Could not update: ${err.message}` : "Could not update.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function escalate(v: Visit) {
    if (!window.confirm(`Tell the principal's office that ${v.visitor_name} is here?`)) return;
    setBusy(v.id);
    try {
      await escalateVisit(v.id);
      void pushVisit(v.id);
      toast("The principal's office has been told.");
    } catch (err) {
      toast(err instanceof Error ? `Could not escalate: ${err.message}` : "Could not escalate.", "error");
    } finally {
      setBusy(null);
    }
  }

  return (v: Visit) => (
    <>
      {profile.role !== "guard" && !v.escalated && v.status !== "left" && (
        <Button disabled={busy === v.id} onClick={() => void escalate(v)}>Escalate</Button>
      )}
      {nextVisitSteps(v.status, profile.role).map((s) => (
        <Button key={s} variant={s === "left" ? "secondary" : "primary"} disabled={busy === v.id} onClick={() => void step(v, s)}>
          {VISIT_STEP_LABEL[s]}
        </Button>
      ))}
    </>
  );
}

/**
 * The guard's console: record each visitor at the gate, and sign them out
 * on the way out. Everything recorded here reaches reception live.
 */
export function Gate() {
  const today = useToday();
  const { visits, loading, error, replace } = useDayVisits(today);
  const actions = useDeskActions();
  const onSite = visitQueue(visits);
  const left = visits.filter((v) => v.status === "left");

  return (
    <>
      <PageHead eyebrow="Gate" title="Visitors" blurb="Record everyone who comes in. Reception sees them before they reach the office." />
      <div className="grid gap-5 px-7 py-6">
        <section className="rounded-lg border border-line bg-white p-5">
          <h2 className="mb-3.5 text-body font-semibold">New visitor</h2>
          <VisitForm entryPoint="gate" onRecorded={replace} />
        </section>
        <DeskLists loading={loading} error={error} onSite={onSite} left={left} actions={actions} />
      </div>
    </>
  );
}

/**
 * Reception's console: the queue of visitors still on the premises, live
 * from the gate, each moved along until they leave. Walk-ins who didn't
 * come through the gate are recorded here.
 */
export function Reception() {
  const toast = useToast();
  const { tenant } = useTenantSession();
  const today = useToday();
  const { visits, loading, error, replace } = useDayVisits(today);
  const actions = useDeskActions();
  const [walkIn, setWalkIn] = useState(false);

  // A visitor recorded at the gate is announced here before they reach the door.
  useEffect(() => subscribeVisits(tenant.id, (v, isNew) => {
    if (isNew && v.entry_point === "gate") toast(`${v.visitor_name} is on the way from the gate, for ${visitHostLabel(v)}.`);
  }), [tenant.id, toast]);

  const onSite = visitQueue(visits);
  const left = visits.filter((v) => v.status === "left");

  return (
    <>
      <PageHead
        eyebrow="Reception"
        title="Visitors today"
        blurb="Everyone the gate lets in appears here as they're recorded. Escalate anything the principal's office should handle."
        actions={<Button variant="accent" onClick={() => setWalkIn((w) => !w)}>{walkIn ? "Close" : "Record a walk-in"}</Button>}
      />
      <div className="grid gap-5 px-7 py-6">
        {walkIn && (
          <section className="rounded-lg border border-line bg-white p-5">
            <h2 className="mb-3.5 text-body font-semibold">Walk-in</h2>
            <VisitForm entryPoint="reception" onRecorded={(v) => { replace(v); setWalkIn(false); }} />
          </section>
        )}
        <DeskLists loading={loading} error={error} onSite={onSite} left={left} actions={actions} />
      </div>
    </>
  );
}

function DeskLists({ loading, error, onSite, left, actions }: {
  loading: boolean; error: Error | null; onSite: Visit[]; left: Visit[]; actions: (v: Visit) => JSX.Element;
}) {
  if (error) {
    return (
      <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
        <span aria-hidden>✕</span>Could not load today's visitors: {error.message}
      </p>
    );
  }
  if (loading) return <TableSkeleton rows={4} />;
  return (
    <>
      <VisitTable
        title={`On the premises · ${onSite.length}`}
        visits={onSite}
        actions={actions}
        empty={{ title: "Nobody waiting", body: "Visitors recorded at the gate or reception appear here until they sign out." }}
      />
      <VisitTable
        title={`Signed out today · ${left.length}`}
        visits={left}
        empty={{ title: "Nobody has left yet", body: "Visitors you sign out move here." }}
      />
    </>
  );
}

/** Today, rolling over at midnight for a desk left open all night. */
function useToday(): Date {
  const [day, setDay] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = new Date();
      if (now.toDateString() !== day.toDateString()) setDay(now);
    }, 60_000);
    return () => window.clearInterval(id);
  }, [day]);
  return day;
}
