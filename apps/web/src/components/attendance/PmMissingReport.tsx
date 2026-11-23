import { useState } from "react";
import {
  fetchPmMissingLearners, fetchSessionEntries, fetchSignOutDays, presentAmMissingPm, today, type PmMissingRow,
} from "@figbloom/shared";
import { TextField } from "../ui/Field";
import { Skeleton } from "../ui/Skeleton";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";

interface Report { afternoonTaken: boolean; rows: PmMissingRow[] }

async function fetchReport(tenantId: string, date: string): Promise<Report> {
  const filter = { tenantId, from: date, to: date };
  const [entries, signOuts] = await Promise.all([fetchSessionEntries(filter), fetchSignOutDays(filter)]);
  const afternoonTaken = entries.some((e) => e.session === "afternoon");
  const ids = presentAmMissingPm(entries, signOuts).map((r) => r.student_id);
  if (ids.length === 0) return { afternoonTaken, rows: [] };
  const rows = await fetchPmMissingLearners(tenantId, ids);
  return { afternoonTaken, rows };
}

/**
 * Learners marked present (or late) in the morning and absent in the afternoon of a date: who left without being signed out.
 * Learners with a live early sign-out that day are left out.
 */
export function PmMissingReport({ tenantId }: { tenantId: string }) {
  const { tenant } = useTenantSession();
  const [date, setDate] = useState(() => today(tenant.timezone));
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const { data, loading, error } = useAsync(
    () => (valid ? fetchReport(tenantId, date) : Promise.resolve<Report>({ afternoonTaken: false, rows: [] })),
    [tenantId, date, valid],
  );

  return (
    <section className="mt-5 overflow-hidden rounded-lg border border-line bg-white" aria-label="Present in the morning, missing in the afternoon">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-body font-semibold">Present in the morning, missing in the afternoon</h2>
          <p className="mt-0.5 text-[12px] text-ink-muted">Learners with an early sign-out that day are left out.</p>
        </div>
        <div className="w-44">
          <TextField id="pm-missing-date" label="Date" type="date" value={date} max={today(tenant.timezone)} onChange={(e) => setDate(e.target.value)} />
        </div>
      </header>
      {error ? (
        <p className="px-4 py-3.5 text-[12.5px] text-warn-ink">Could not load the report: {error.message}</p>
      ) : loading || !data ? (
        Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="border-b border-line-soft px-4 py-2.5 last:border-0"><Skeleton className="h-3 w-full" /></div>
        ))
      ) : !valid ? (
        <p className="px-4 py-3.5 text-[12.5px] text-ink-muted">Pick a date.</p>
      ) : !data.afternoonTaken ? (
        <p className="px-4 py-3.5 text-[12.5px] text-ink-muted">No afternoon register was taken on {date}, so there is nothing to compare.</p>
      ) : data.rows.length === 0 ? (
        <p className="px-4 py-3.5 text-[12.5px] text-ink-muted">Nobody who was here in the morning was missing in the afternoon on {date}.</p>
      ) : (
        <ul>
          {data.rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 border-b border-line-soft px-4 py-2.5 text-[13px] last:border-0">
              <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
              <span className="font-mono text-[11px] text-ink-faint">ADM {r.admissionNo}</span>
              <span className="w-28 truncate text-right text-[12.5px] text-ink-muted">{r.className}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
