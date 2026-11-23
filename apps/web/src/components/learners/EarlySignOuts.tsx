import { fetchCollectorDetails, fetchStudentEarlySignOuts, signOutTime, type EarlySignOutCollector } from "@figbloom/shared";
import { authorisedByText, collectorContactText, collectorLine, noteText, voidReasonText } from "../../lib/earlySignOutView";
import { useAsync } from "../../lib/useAsync";
import { Skeleton } from "../ui/Skeleton";

/**
 * One learner's early sign-outs, newest first (FIG-1513 stage A), on their record. The collector's ID number and phone show only
 * where the database returned them; otherwise "restricted". Voided sign-outs stay, struck through, with the reason.
 */
export function StudentEarlySignOuts({ studentId }: { studentId: string }) {
  const { data, loading, error } = useAsync(async () => {
    const rows = await fetchStudentEarlySignOuts(studentId);
    const details = await fetchCollectorDetails(rows.map((r) => r.id)).catch(() => new Map<string, EarlySignOutCollector>());
    return { rows, details };
  }, [studentId]);

  return (
    <section className="mt-5">
      <h3 className="mb-2 text-small font-semibold">Early sign-outs</h3>
      {error ? (
        <p className="text-[12.5px] text-warn-ink">Could not load the sign-outs: {error.message}</p>
      ) : loading || !data ? (
        <Skeleton className="h-3 w-2/3" />
      ) : data.rows.length === 0 ? (
        <p className="text-[12.5px] text-ink-muted">No early sign-outs on record.</p>
      ) : (
        <ul className="grid gap-2">
          {data.rows.map((r) => {
            const voided = !!r.voided_at;
            const strike = voided ? "text-ink-faint line-through" : "";
            const note = noteText(data.details.get(r.id));
            return (
              <li key={r.id} className="rounded-lg border border-line-soft px-3 py-2.5 text-[12.5px]">
                <div className={`font-medium ${strike}`}>{r.taken_on} at {signOutTime(r)} · {r.reason}</div>
                <div className={`text-ink-muted ${voided ? "line-through" : ""}`}>
                  Authorised by {authorisedByText(data.details.get(r.id))}. Collected by {collectorLine(r)}.
                </div>
                <div className={`text-[11.5px] text-ink-muted ${voided ? "line-through" : ""}`}>{collectorContactText(data.details.get(r.id))}</div>
                {note && <div className={`text-[11.5px] text-ink-muted ${voided ? "line-through" : ""}`}>Note: {note}</div>}
                {voided && <div className="text-[11.5px] text-warn-ink">Voided: {voidReasonText(data.details.get(r.id))}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
