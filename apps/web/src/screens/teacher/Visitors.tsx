import { PageHead } from "../../components/ConsoleShell";
import { useDayVisits, VisitTable } from "../../components/visitors/Visits";
import { TableSkeleton } from "../../components/ui/Skeleton";

/** Today's visitors for this teacher, live from the gate and reception. They pop up on any page too. */
export function TeacherVisitors() {
  const { visits, loading, error } = useDayVisits(new Date());
  return (
    <>
      <PageHead eyebrow="Gate & reception" title="Your visitors" blurb="Anyone who asks for you at the gate or reception today. Reception brings them to you." />
      <div className="grid gap-5 px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load your visitors: {error.message}
          </p>
        ) : loading ? (
          <TableSkeleton rows={3} />
        ) : (
          <VisitTable
            visits={visits}
            showContact={false}
            empty={{ title: "No visitors for you today", body: "When someone asks for you at the gate, they appear here and you're told straight away." }}
          />
        )}
      </div>
    </>
  );
}
