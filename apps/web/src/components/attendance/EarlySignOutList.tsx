import { fetchCollectorDetails, fetchEarlySignOuts, signOutList, signOutTime, today, type EarlySignOutCollector } from "@figbloom/shared";
import { authorisedByText, collectorContactText, collectorLine, voidReasonText } from "../../lib/earlySignOutView";
import { useAsync } from "../../lib/useAsync";
import { Skeleton } from "../ui/Skeleton";

/**
 * Today's early sign-outs for the gate and the office (FIG-1513 stage A): who left, when, why, who authorised it and who collected
 * them. The collector's ID number and phone show only where the database returned them (the attendance area and the recorder);
 * everyone else sees "restricted". A voided sign-out stays on the list, struck through, with the reason it was voided.
 * Show it only to people maySeeSignOutList() allows; RLS limits the rows anyway.
 */
export function EarlySignOutList({ tenantId }: { tenantId: string }) {
  const day = today();
  const { data, loading, error } = useAsync(async () => {
    const rows = signOutList(await fetchEarlySignOuts(tenantId, day));
    // A failed read of the details just shows "restricted": the list itself is what matters.
    const details = await fetchCollectorDetails(rows.map((r) => r.id)).catch(() => new Map<string, EarlySignOutCollector>());
    return { rows, details };
  }, [tenantId, day]);

  return (
    <section className="mt-5 overflow-hidden rounded-lg border border-line bg-white">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-body font-semibold">Early sign-outs · {day}</h2>
      </header>
      {error ? (
        <p className="px-4 py-3.5 text-[12.5px] text-warn-ink">Could not load the sign-outs: {error.message}</p>
      ) : loading || !data ? (
        Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="border-b border-line-soft px-4 py-2.5 last:border-0"><Skeleton className="h-3 w-full" /></div>
        ))
      ) : data.rows.length === 0 ? (
        <p className="px-4 py-3.5 text-[12.5px] text-ink-muted">Nobody has been signed out early today.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12.5px]">
            <thead>
              <tr className="border-b border-line-soft text-[11px] uppercase tracking-wide text-ink-faint">
                <th className="px-4 py-2 font-semibold">Learner</th>
                <th className="px-2 py-2 font-semibold">Class</th>
                <th className="px-2 py-2 font-semibold">Time</th>
                <th className="px-2 py-2 font-semibold">Reason</th>
                <th className="px-2 py-2 font-semibold">Authorised by</th>
                <th className="px-4 py-2 font-semibold">Collected by</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const voided = !!r.voided_at;
                return (
                  <tr key={r.id} className="border-b border-line-soft align-top last:border-0">
                    <td className={`px-4 py-2.5 font-medium ${voided ? "text-ink-faint line-through" : ""}`}>{r.student_name}</td>
                    <td className={`px-2 py-2.5 ${voided ? "text-ink-faint line-through" : ""}`}>{r.class_name ?? "—"}</td>
                    <td className={`px-2 py-2.5 font-mono ${voided ? "text-ink-faint line-through" : ""}`}>{signOutTime(r)}</td>
                    <td className={`px-2 py-2.5 ${voided ? "text-ink-faint line-through" : ""}`}>{r.reason}</td>
                    <td className={`px-2 py-2.5 ${voided ? "text-ink-faint line-through" : ""}`}>{authorisedByText(data.details.get(r.id))}</td>
                    <td className="px-4 py-2.5">
                      <span className={voided ? "text-ink-faint line-through" : ""}>{collectorLine(r)}</span>
                      <span className={`block text-[11.5px] text-ink-muted ${voided ? "line-through" : ""}`}>{collectorContactText(data.details.get(r.id))}</span>
                      {voided && <span className="block text-[11.5px] text-warn-ink">Voided: {voidReasonText(data.details.get(r.id))}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
