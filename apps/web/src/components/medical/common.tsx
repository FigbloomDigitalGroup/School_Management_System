import { Link } from "react-router-dom";
import {
  fetchDoses, fetchSchedules, localDay, VISIT_OUTCOME_LABEL, overdueDoses, type StudentHealth, type VisitOutcome,
} from "@figbloom/shared";
import { Badge, type Tone } from "../ui/Badge";
import { useAsync } from "../../lib/useAsync";

/**
 * Small pieces the sick bay screens share (screens/admin/Medical.tsx and the
 * parent's Health page): the allergy banner, outcome badges, the school
 * clock in form fields, CSV download, and the overdue-medication card on the
 * nurse's home.
 */

export function downloadCsv(text: string, filename: string): void {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "14:05" on this device's clock. */
export const hm = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** "Tue 27 Oct, 14:05" (the time only, for today). */
export function when(iso: string): string {
  const d = new Date(iso);
  if (localDay(d) === localDay(new Date())) return hm(iso);
  return `${d.toLocaleDateString("en-KE", { weekday: "short", day: "numeric", month: "short" })}, ${hm(iso)}`;
}

/** An instant as a datetime-local field's value, on this device's clock. */
export const toLocalInput = (iso: string) => { const d = new Date(iso); return `${localDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
/** A datetime-local field's value as an instant. */
export const fromLocalInput = (v: string) => new Date(v).toISOString();

export const VISIT_OUTCOME_TONE: Record<VisitOutcome, Tone> = { class: "ok", rest: "info", home: "warn", hospital: "warn", admitted: "warn" };

export function OutcomeBadge({ outcome }: { outcome: VisitOutcome | null }) {
  return outcome ? <Badge tone={VISIT_OUTCOME_TONE[outcome]}>{VISIT_OUTCOME_LABEL[outcome]}</Badge> : <Badge tone="info">Being seen</Badge>;
}

export function ErrorLine({ what, error }: { what: string; error: Error }) {
  return (
    <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
      <span aria-hidden>✕</span>Could not load {what}: {error.message}
    </p>
  );
}

/**
 * Allergies and chronic conditions, loud: the first thing the nurse sees on
 * a learner, before giving anything. A quiet line when there are none on
 * file, so "nothing shown" never reads as "no allergies".
 */
export function HealthAlerts({ health, loading }: { health: StudentHealth | null; loading?: boolean }) {
  if (loading) return <div className="h-[46px] animate-pulse rounded-lg bg-sunken" />;
  const allergies = health?.allergies ?? [];
  const conditions = health?.medical_conditions ?? [];
  if (!allergies.length && !conditions.length && !health?.medications?.trim()) {
    return (
      <p className="rounded-lg border border-line bg-page px-3 py-2.5 text-[12.5px] text-ink-muted">
        No allergies or conditions on file. Ask the learner, and tell the office if the record is missing something.
      </p>
    );
  }
  return (
    <div role="alert" className="grid gap-1.5 rounded-lg border-2 border-warn-ink/60 bg-warn-ink/5 px-3.5 py-3">
      {allergies.length > 0 && (
        <p className="text-[14px] font-bold text-warn-ink">Allergies: {allergies.join(", ")}</p>
      )}
      {conditions.length > 0 && (
        <p className="text-[13.5px] font-semibold text-warn-ink">Conditions: {conditions.join(", ")}</p>
      )}
      {health?.medications?.trim() && <p className="text-[12.5px] text-ink">Takes: {health.medications.trim()}</p>}
    </div>
  );
}

/** Doses more than an hour past their time with nothing recorded, today. On the nurse's home and the sick bay page. */
export function OverdueMedication({ tenantId, slug, compact }: { tenantId: string; slug: string; compact?: boolean }) {
  const today = localDay(new Date());
  const { data, error } = useAsync(async () => {
    const [schedules, doses] = await Promise.all([fetchSchedules(tenantId, today, today), fetchDoses(tenantId, today, today)]);
    return overdueDoses(schedules, doses, new Date());
  }, [tenantId, today]);
  if (error || !data?.length) return null;
  return (
    <section role="alert" className="rounded-lg border-2 border-warn-ink/50 bg-warn-ink/5 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-body font-semibold text-warn-ink">
          {data.length === 1 ? "1 dose" : `${data.length} doses`} not given for over an hour
        </h2>
        {compact && (
          <Link to={`/s/${slug}/admin/medical?tab=round`} className="text-[12.5px] font-semibold text-forest underline">Open the round</Link>
        )}
      </div>
      <ul className="mt-1.5 grid gap-0.5 text-[12.5px]">
        {data.slice(0, compact ? 5 : 20).map((s) => (
          <li key={`${s.schedule.id}-${s.time}`}>
            <span className="font-mono">{s.time}</span> · {s.schedule.students?.full_name ?? "A learner"}: {s.schedule.drug} {s.schedule.dose}
          </li>
        ))}
      </ul>
    </section>
  );
}
