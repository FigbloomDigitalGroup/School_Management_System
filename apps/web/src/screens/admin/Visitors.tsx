import { useState } from "react";
import { visitQueue } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { useDayVisits, VisitTable } from "../../components/visitors/Visits";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useDeskActions } from "../frontdesk/Desk";

const dateInput = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * The school's visitor log, a day at a time. Visits escalated to the
 * principal's office and still on the premises come first: those are the
 * people waiting for this office. Live, like the desk's own screens.
 */
export function AdminVisitors() {
  const [day, setDay] = useState(() => new Date());
  const { visits, loading, error } = useDayVisits(day);
  const actions = useDeskActions();
  const waiting = visitQueue(visits).filter((v) => v.escalated);

  return (
    <>
      <PageHead
        eyebrow="Gate & reception"
        title="Visitors"
        blurb="Everyone recorded at the gate or reception. Visits for the principal, or escalated by reception, come to you."
        actions={
          <input
            type="date"
            aria-label="Day"
            value={dateInput(day)}
            max={dateInput(new Date())}
            onChange={(e) => { if (e.target.value) setDay(new Date(`${e.target.value}T00:00:00`)); }}
            className="rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none focus:border-forest"
          />
        }
      />
      <div className="grid gap-5 px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load visitors: {error.message}
          </p>
        ) : loading ? (
          <TableSkeleton rows={6} />
        ) : (
          <>
            <VisitTable
              title={`Waiting for the principal's office · ${waiting.length}`}
              visits={waiting}
              actions={actions}
              empty={{ title: "Nobody waiting for you", body: "A visitor for the principal, or one reception escalates, appears here and pops up wherever you are." }}
            />
            <VisitTable
              title={`All visitors · ${visits.length}`}
              visits={visits}
              actions={actions}
              empty={{ title: "No visitors on this day", body: "The gate and reception record everyone who comes in." }}
            />
          </>
        )}
      </div>
    </>
  );
}
