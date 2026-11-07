import { fetchDoses, fetchOpenVisits, fetchSchedules, fetchVisits, localDay, overdueDoses, sickBayBoard, type DoseSlot, type SickBayVisit } from "./medical";

/**
 * The sick bay as the principal and the nurse look at it on the move: what needs doing now (doses not given for over an
 * hour), who is in, and today's visits. It is the web's sick bay board and its overdue-medication alert, read together.
 * Logging a visit and giving the medication round are desk work, on the web.
 */
export interface SickBayOverview {
  /** Doses more than an hour past their time with nothing recorded, today. */
  overdue: DoseSlot[];
  /** Everyone still in the sick bay, whatever day they came in, longest-waiting first. */
  open: SickBayVisit[];
  /** Every visit that came in today, newest first. */
  today: SickBayVisit[];
}

export async function fetchSickBayBoard(tenantId: string, now: Date = new Date()): Promise<SickBayOverview> {
  const day = localDay(now);
  const start = new Date(`${day}T00:00:00`);
  const [schedules, doses, open, today] = await Promise.all([
    fetchSchedules(tenantId, day, day),
    fetchDoses(tenantId, day, day),
    fetchOpenVisits(tenantId),
    fetchVisits(tenantId, start, new Date(start.getTime() + 86_400_000)),
  ]);
  return { overdue: overdueDoses(schedules, doses, now), open: sickBayBoard(open), today };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "14:05" on this device's clock. */
export function visitClock(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "14:05" for today, "Tue 27 Oct, 14:05" for another day (a learner who has been in the sick bay since yesterday). */
export function visitWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (localDay(d) === localDay(now)) return visitClock(iso);
  return `${d.toLocaleDateString("en-KE", { weekday: "short", day: "numeric", month: "short" })}, ${visitClock(iso)}`;
}

/** "ADM 1042 · Form 1A", the line under a learner's name in a visit; empty when the visit names no learner. */
export function visitLearnerLine(v: Pick<SickBayVisit, "students">): string {
  return [v.students?.admission_no && `ADM ${v.students.admission_no}`, v.students?.classes?.name].filter(Boolean).join(" · ");
}
