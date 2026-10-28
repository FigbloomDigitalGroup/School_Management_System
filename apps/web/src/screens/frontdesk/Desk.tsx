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
import { confirmDialog } from "../../components/ui/Confirm";

/** The step buttons for one visit, and escalation to the principal's office. */
export function useDeskActions() {
  const toast = useToast();
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
    if (!(await confirmDialog({ title: `Tell the principal's office that ${v.visitor_name} is here?`, confirmLabel: "Tell the office" }))) return;
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
      {!v.escalated && v.status !== "left" && (
        <Button disabled={busy === v.id} onClick={() => void escalate(v)}>Escalate</Button>
      )}
      {nextVisitSteps(v.status).map((s) => (
        <Button key={s} variant={s === "left" ? "secondary" : "primary"} disabled={busy === v.id} onClick={() => void step(v, s)}>
          {VISIT_STEP_LABEL[s]}
        </Button>
      ))}
    </>
  );
}

const ENTRY_POINTS: { key: Visit["entry_point"]; label: string }[] = [
  { key: "gate", label: "At the gate" },
  { key: "reception", label: "Walk-in at the office" },
];

/**
 * The visitor log, for other staff the office has given it
 * (handles_visitors): the gate's work and reception's in one screen. Record
 * each visitor where they came in, move them along (arrived, with their
 * host, signed out) and escalate anything the principal's office should
 * handle. Whoever else keeps the log sees each visit live.
 */
export function DeskVisitors() {
  const toast = useToast();
  const { tenant, profile } = useTenantSession();
  const today = useToday();
  const { visits, loading, error, replace } = useDayVisits(today);
  const actions = useDeskActions();
  const [entryPoint, setEntryPoint] = useState<Visit["entry_point"]>("gate");

  // A visitor someone else recorded at the gate is announced before they reach the door.
  useEffect(() => subscribeVisits(tenant.id, (v, isNew) => {
    if (isNew && v.entry_point === "gate" && v.recorded_by !== profile.id) {
      toast(`${v.visitor_name} is on the way from the gate, for ${visitHostLabel(v)}.`);
    }
  }), [tenant.id, profile.id, toast]);

  const onSite = visitQueue(visits);
  const left = visits.filter((v) => v.status === "left");

  return (
    <>
      <PageHead
        eyebrow={profile.staff_title ?? "Visitors"}
        title="Visitors today"
        blurb="Record everyone who comes in, at the gate or the office. Escalate anything the principal's office should handle."
      />
      <div className="grid gap-5 px-7 py-6">
        <section className="rounded-lg border border-line bg-white p-5">
          <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-body font-semibold">New visitor</h2>
            <div role="group" aria-label="Where they came in" className="flex w-fit rounded-md border border-[#D3DAD5] bg-white p-0.5">
              {ENTRY_POINTS.map((e) => (
                <button key={e.key} type="button" aria-pressed={entryPoint === e.key} className="rounded px-3 py-1.5 text-small"
                  onClick={() => setEntryPoint(e.key)}
                  style={entryPoint === e.key ? { background: "#17402A", color: "#fff", fontWeight: 600 } : {}}>
                  {e.label}
                </button>
              ))}
            </div>
          </div>
          <VisitForm entryPoint={entryPoint} onRecorded={replace} />
        </section>
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
