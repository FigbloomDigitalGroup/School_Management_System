import { useState, type ReactNode } from "react";
import {
  addDays, commonComplaints, complaintsCsv, complianceCsv, expandSlots, fetchDoses, fetchSchedules, fetchVisits,
  frequentVisitors, frequentVisitorsCsv, localDay, medicationCompliance, minutesOfDay, visitCountsCsv, visitsCsv,
  visitsPerDay, visitsPerWeek,
} from "@figbloom/shared";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/DataTable";
import { TableSkeleton } from "../ui/Skeleton";
import { StatRow } from "../ui/StatCard";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { downloadCsv, ErrorLine } from "./common";

const RANGES = [{ days: 7, label: "Last 7 days" }, { days: 30, label: "Last 30 days" }, { days: 90, label: "Last 90 days" }];

/**
 * The sick bay's numbers for the office, over the last week, month or
 * term: visits per day or week, the most common complaints, learners who
 * keep coming back, and how much prescribed medicine was actually given.
 * Each table exports to CSV.
 */
export function MedicalReports() {
  const { tenant } = useTenantSession();
  const [days, setDays] = useState(30);
  const today = localDay(new Date());
  const from = addDays(today, -(days - 1));
  const { data, loading, error } = useAsync(async () => {
    const [visits, schedules, doses] = await Promise.all([
      fetchVisits(tenant.id, new Date(`${from}T00:00:00`), new Date(`${addDays(today, 1)}T00:00:00`)),
      fetchSchedules(tenant.id, from, today),
      fetchDoses(tenant.id, from, today),
    ]);
    const perDay = visitsPerDay(visits, from, today);
    return {
      visits, perDay, perWeek: visitsPerWeek(perDay),
      complaints: commonComplaints(visits, 10),
      frequent: frequentVisitors(visits, 3),
      compliance: medicationCompliance(expandSlots(schedules, doses, from, today, today, minutesOfDay(new Date()))),
    };
  }, [tenant.id, from, today]);

  if (error) return <ErrorLine what="the reports" error={error} />;

  const totals = data?.compliance.reduce((a, r) => ({ due: a.due + r.due, given: a.given + r.given }), { due: 0, given: 0 });
  const byWeek = days > 30;
  const counts = data ? (byWeek ? data.perWeek : data.perDay) : [];
  const peak = Math.max(1, ...counts.map((c) => c.count));

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Period" className="flex rounded-md border border-[#D3DAD5] bg-white p-0.5">
          {RANGES.map((r) => (
            <button key={r.days} type="button" aria-pressed={days === r.days} onClick={() => setDays(r.days)} className="rounded px-3 py-1.5 text-small"
              style={days === r.days ? { background: "#17402A", color: "#fff", fontWeight: 600 } : {}}>
              {r.label}
            </button>
          ))}
        </div>
        {data && <Button onClick={() => downloadCsv(visitsCsv(data.visits), `sick-bay-visits-${from}-to-${today}.csv`)}>Export all visits</Button>}
      </div>

      <StatRow stats={[
        { label: "Visits", value: data ? String(data.visits.length) : "", sub: `since ${from}`, loading: !data },
        { label: "Sent home or referred", value: data ? String(data.visits.filter((v) => v.outcome === "home" || v.outcome === "hospital" || v.outcome === "admitted").length) : "", loading: !data },
        { label: "Frequent visitors", value: data ? String(data.frequent.length) : "", sub: "3 visits or more", alarming: (data?.frequent.length ?? 0) > 0, loading: !data },
        { label: "Doses given", value: totals?.due ? `${Math.round((totals.given / totals.due) * 100)}%` : "–", sub: totals ? `${totals.given} of ${totals.due} due` : undefined, loading: !data },
      ]} />

      {loading || !data ? <TableSkeleton rows={6} /> : (
        <>
          <Panel title={byWeek ? "Visits per week" : "Visits per day"} onExport={() => downloadCsv(visitCountsCsv(counts, byWeek ? "week" : "day"), `sick-bay-visits-per-${byWeek ? "week" : "day"}.csv`)}>
            <div className="flex h-28 items-end gap-1 px-4 py-3" role="img" aria-label={counts.map((c) => `${c.day}: ${c.count}`).join(", ")}>
              {counts.map((c) => (
                <div key={c.day} title={`${c.day}: ${c.count}`} className="min-w-[4px] flex-1 rounded-t bg-forest/70" style={{ height: `${Math.max(2, (c.count / peak) * 100)}%` }} />
              ))}
            </div>
          </Panel>

          <div className="grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
            <Panel title="Common complaints" onExport={() => downloadCsv(complaintsCsv(data.complaints), "sick-bay-complaints.csv")}>
              {data.complaints.length === 0 ? <EmptyState title="No visits in this period" body="Complaints are counted from each visit's complaint." /> : data.complaints.map((c) => (
                <Row key={c.complaint} left={c.complaint} right={String(c.count)} />
              ))}
            </Panel>
            <Panel title="Learners with frequent visits" onExport={() => downloadCsv(frequentVisitorsCsv(data.frequent), "sick-bay-frequent-visitors.csv")}>
              {data.frequent.length === 0 ? <EmptyState title="Nobody with 3 or more visits" body="A learner who keeps coming back may need a word with their family or a doctor." /> : data.frequent.map((f) => (
                <Row key={f.student_id} left={`${f.name} · ADM ${f.admission_no}`} right={String(f.count)} />
              ))}
            </Panel>
          </div>

          <Panel title="Medication compliance" onExport={() => downloadCsv(complianceCsv(data.compliance), "medication-compliance.csv")}>
            {data.compliance.length === 0 ? <EmptyState title="No prescribed medicine in this period" body="Doses on the round are counted here once their time has passed." /> : data.compliance.map((r) => (
              <Row key={r.schedule.id}
                left={`${r.schedule.students?.full_name ?? ""}: ${r.schedule.drug} ${r.schedule.dose}`}
                right={`${r.given}/${r.due} given${r.refused ? ` · ${r.refused} refused` : ""}${r.missed ? ` · ${r.missed} missed` : ""}${r.unrecorded ? ` · ${r.unrecorded} not recorded` : ""} · ${r.rate ?? "–"}%`} />
            ))}
          </Panel>
        </>
      )}
    </div>
  );
}

function Panel({ title, onExport, children }: { title: string; onExport: () => void; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-white">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="text-body font-semibold">{title}</h2>
        <Button onClick={onExport}>CSV</Button>
      </header>
      {children}
    </section>
  );
}

const Row = ({ left, right }: { left: string; right: string }) => (
  <div className="flex items-center gap-3 border-b border-line-soft px-4 py-2 text-[13px] last:border-0">
    <span className="min-w-0 flex-1 truncate">{left}</span>
    <span className="shrink-0 font-mono text-[12.5px] text-ink-muted">{right}</span>
  </div>
);
