import { supabase } from "./supabase";
import { invokeEdge } from "./edge";
import { toCsv } from "./csv";
import type { StudentHealth } from "./studentHealth";

/**
 * The sick bay (20261101300000_medical.sql): visits, medicine given, the
 * medication round, guardians' requests and what guardians are told.
 * Clinical details are read only by the medical area's holders, full admins
 * and the learner's own guardians; a class teacher gets "in the sick bay" or
 * "sent home" from fetchClassSickBay() and nothing else. Opening one
 * learner's record (openMedicalRecord) is logged to the audit trail by the
 * database.
 *
 * The pure parts (what a visit's outcome means, which doses are due, the
 * office's report numbers) are here so the web console and, later, the
 * mobile apps agree.
 */

// ---------------------------------------------------------------- outcomes
export const VISIT_OUTCOMES = ["class", "rest", "home", "hospital", "admitted"] as const;
export type VisitOutcome = (typeof VISIT_OUTCOMES)[number];

export const VISIT_OUTCOME_LABEL: Record<VisitOutcome, string> = {
  class: "Back to class",
  rest: "Resting in the sick bay",
  home: "Sent home",
  hospital: "Referred to hospital",
  admitted: "Admitted",
};

/** What the school tells guardians about: every visit, or only these. */
export const SERIOUS_OUTCOMES: readonly VisitOutcome[] = ["home", "hospital", "admitted"];

export type NotifyPolicy = "all" | "serious";

export const NOTIFY_POLICY_LABEL: Record<NotifyPolicy, string> = {
  serious: "Only when a learner is sent home, referred to hospital or admitted",
  all: "After every sick bay visit",
};

/** Whether guardians hear about a visit with this outcome. The database's medical_outcome_notifies() is the same rule. */
export function notifiesGuardians(outcome: VisitOutcome | null, policy: NotifyPolicy | null | undefined): boolean {
  if (!outcome) return false;
  return (policy ?? "serious") === "all" || SERIOUS_OUTCOMES.includes(outcome);
}

/** Whether the learner has left the sick bay with this outcome, so the visit gets a time out. Admitted elsewhere (a hospital named) has; admitted to the school's own sick bay hasn't. */
export function outcomeClosesVisit(outcome: VisitOutcome | null, referredTo?: string | null): boolean {
  if (!outcome || outcome === "rest") return false;
  if (outcome === "admitted") return !!referredTo?.trim();
  return true;
}

/** Whether the nurse is offered "mark in the register" for this outcome (medical_mark_attendance). */
export function offersAttendanceMark(outcome: VisitOutcome | null): boolean {
  return !!outcome && SERIOUS_OUTCOMES.includes(outcome);
}

// ---------------------------------------------------------------- visits
export interface VisitMedication {
  id: string;
  visit_id: string;
  drug: string;
  dose: string;
  given_at: string;
  given_by: string | null;
  inventory_item_id: string | null;
  stock_quantity: number | null;
}

export interface VisitLearnerRef {
  full_name: string;
  admission_no: string;
  classes?: { name: string } | null;
}

export interface SickBayVisit {
  id: string;
  tenant_id: string;
  student_id: string;
  time_in: string;
  complaint: string;
  temperature_c: number | null;
  pulse_bpm: number | null;
  observations: string | null;
  assessment: string | null;
  treatment: string | null;
  outcome: VisitOutcome | null;
  referred_to: string | null;
  time_out: string | null;
  follow_up: string | null;
  attendance_mark: "excused" | "absent" | null;
  attendance_marked_at: string | null;
  logged_by: string | null;
  updated_at: string;
  students?: VisitLearnerRef | null;
  visit_medications?: VisitMedication[];
}

/** What the nurse's form edits. Times are ISO strings. */
export interface SickBayVisitDraft {
  student_id: string | null;
  time_in: string;
  complaint: string;
  temperature_c: number | null;
  pulse_bpm: number | null;
  observations: string;
  assessment: string;
  treatment: string;
  outcome: VisitOutcome | null;
  referred_to: string;
  time_out: string | null;
  follow_up: string;
}

/** What is wrong with a draft, in words for the nurse; null when it can be saved. */
export function sickBayVisitProblem(d: SickBayVisitDraft): string | null {
  if (!d.student_id) return "Pick the learner.";
  if (!d.complaint.trim()) return "Say what brought them in.";
  if (d.temperature_c != null && (d.temperature_c < 30 || d.temperature_c > 45)) return "Temperature should be in °C, between 30 and 45.";
  if (d.pulse_bpm != null && (d.pulse_bpm < 20 || d.pulse_bpm > 250)) return "Pulse should be beats per minute, between 20 and 250.";
  if (d.outcome === "hospital" && !d.referred_to.trim()) return "Say which hospital or clinic they were referred to.";
  if (d.time_out && d.time_out < d.time_in) return "They can't leave before they came in.";
  return null;
}

/** Still in the sick bay (no time out): the board, oldest first. A boarder admitted yesterday is still here. */
export function sickBayBoard<T extends Pick<SickBayVisit, "time_out" | "time_in">>(visits: T[]): T[] {
  return visits.filter((v) => !v.time_out).sort((a, b) => a.time_in.localeCompare(b.time_in));
}

// ---------------------------------------------------------------- the school clock
/** 'YYYY-MM-DD' on this device's clock (the school's, in practice), not UTC. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Minutes since midnight on this device's clock. */
export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "08:00" -> 480; null for anything else. */
export function timeToMinutes(t: string): number | null {
  const m = TIME_RE.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** "8:00, 14:00; 20:00" -> ["08:00", "14:00", "20:00"]; null when any part isn't a time or there are none, or more than 8. */
export function parseTimes(text: string): string[] | null {
  const parts = text.split(/[,;\s]+/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length || parts.length > 8) return null;
  const out = new Set<string>();
  for (const p of parts) {
    const m = /^(\d{1,2})[:.h]?(\d{2})$/.exec(p);
    if (!m) return null;
    const t = `${m[1]!.padStart(2, "0")}:${m[2]}`;
    if (timeToMinutes(t) == null) return null;
    out.add(t);
  }
  return [...out].sort();
}

/** The round times a nurse starts from for "N times a day". */
export function suggestTimes(perDay: number): string[] {
  switch (perDay) {
    case 1: return ["08:00"];
    case 2: return ["08:00", "20:00"];
    case 3: return ["07:00", "13:00", "19:00"];
    case 4: return ["06:00", "12:00", "18:00", "22:00"];
    default: return [];
  }
}

/** 'YYYY-MM-DD' plus n days. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- medication
export interface MedicationSchedule {
  id: string;
  tenant_id: string;
  student_id: string;
  drug: string;
  dose: string;
  times: string[];
  starts_on: string;
  ends_on: string | null;
  prescribed_by: "doctor" | "parent";
  prescriber: string | null;
  notes: string | null;
  stopped_at: string | null;
  created_at: string;
  students?: VisitLearnerRef | null;
}

export type DoseStatus = "given" | "refused" | "missed";

export const DOSE_STATUS_LABEL: Record<DoseStatus, string> = { given: "Given", refused: "Refused", missed: "Missed" };

export interface MedicationDose {
  id: string;
  schedule_id: string;
  student_id: string;
  due_on: string;
  due_time: string;
  status: DoseStatus;
  recorded_at: string;
  given_by: string | null;
  note: string | null;
}

/** A dose is "due now" from this long before its time... */
export const DUE_BEFORE_MIN = 30;
/** ...and overdue (flagged on the nurse's home) once this long after it passes unrecorded. */
export const OVERDUE_AFTER_MIN = 60;

export type SlotState = DoseStatus | "upcoming" | "due" | "overdue" | "unrecorded";

export interface DoseSlot {
  schedule: MedicationSchedule;
  day: string;
  time: string;
  dose: MedicationDose | null;
  state: SlotState;
}

/** Whether a schedule runs on this day: inside its dates, and not stopped on or before it. */
export function scheduleActiveOn(s: Pick<MedicationSchedule, "starts_on" | "ends_on" | "stopped_at">, day: string, stoppedDay?: string | null): boolean {
  if (day < s.starts_on) return false;
  if (s.ends_on && day > s.ends_on) return false;
  const stopped = stoppedDay ?? (s.stopped_at ? localDay(new Date(s.stopped_at)) : null);
  return !stopped || day < stopped;
}

/** Where an unrecorded dose stands at this minute of its day; null minute = a day that's over. */
export function slotState(time: string, nowMinutes: number | null): SlotState {
  if (nowMinutes == null) return "unrecorded";
  const t = timeToMinutes(time) ?? 0;
  if (nowMinutes < t - DUE_BEFORE_MIN) return "upcoming";
  if (nowMinutes <= t + OVERDUE_AFTER_MIN) return "due";
  return "overdue";
}

const doseKey = (scheduleId: string, day: string, time: string) => `${scheduleId}|${day}|${time}`;

/**
 * Every dose slot on these days, with its record if there is one. `today`
 * and `nowMinutes` say which slots are still to come: a slot on an earlier
 * day with no record is "unrecorded"; one today is upcoming, due or overdue.
 */
export function expandSlots(
  schedules: MedicationSchedule[], doses: MedicationDose[], from: string, to: string,
  today: string, nowMinutes: number,
): DoseSlot[] {
  const recorded = new Map(doses.map((d) => [doseKey(d.schedule_id, d.due_on, d.due_time), d]));
  const out: DoseSlot[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (day > today) break;
    for (const s of schedules) {
      if (!scheduleActiveOn(s, day)) continue;
      for (const time of s.times) {
        const dose = recorded.get(doseKey(s.id, day, time)) ?? null;
        out.push({ schedule: s, day, time, dose, state: dose ? dose.status : slotState(time, day === today ? nowMinutes : null) });
      }
    }
  }
  return out;
}

/** Today's round: every dose of the day in time order, then learner name. */
export function roundList(schedules: MedicationSchedule[], doses: MedicationDose[], now: Date): DoseSlot[] {
  const today = localDay(now);
  return expandSlots(schedules, doses, today, today, today, minutesOfDay(now))
    .sort((a, b) => a.time.localeCompare(b.time)
      || (a.schedule.students?.full_name ?? "").localeCompare(b.schedule.students?.full_name ?? ""));
}

/** Doses past their time by more than OVERDUE_AFTER_MIN with nothing recorded: the alert on the nurse's home. */
export function overdueDoses(schedules: MedicationSchedule[], doses: MedicationDose[], now: Date): DoseSlot[] {
  return roundList(schedules, doses, now).filter((s) => s.state === "overdue");
}

// ---------------------------------------------------------------- reports
export interface DayCount { day: string; count: number }

/** Visits per day (by time in, on this device's clock), every day in the range, oldest first. */
export function visitsPerDay(visits: Pick<SickBayVisit, "time_in">[], from: string, to: string): DayCount[] {
  const counts = new Map<string, number>();
  for (const v of visits) {
    const d = localDay(new Date(v.time_in));
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const out: DayCount[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) out.push({ day, count: counts.get(day) ?? 0 });
  return out;
}

/** The Monday of a day's week. */
export function weekOf(day: string): string {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

/** Visits per week (weeks starting Monday), from per-day counts. */
export function visitsPerWeek(days: DayCount[]): DayCount[] {
  const weeks = new Map<string, number>();
  for (const d of days) weeks.set(weekOf(d.day), (weeks.get(weekOf(d.day)) ?? 0) + d.count);
  return [...weeks].map(([day, count]) => ({ day, count })).sort((a, b) => a.day.localeCompare(b.day));
}

export interface ComplaintCount { complaint: string; count: number }

/** The most common complaints, matched ignoring case and spacing; the first spelling seen names each. */
export function commonComplaints(visits: Pick<SickBayVisit, "complaint">[], limit = 10): ComplaintCount[] {
  const groups = new Map<string, ComplaintCount>();
  for (const v of visits) {
    const label = v.complaint.trim().replace(/\s+/g, " ");
    if (!label) continue;
    const key = label.toLowerCase();
    const g = groups.get(key);
    if (g) g.count += 1;
    else groups.set(key, { complaint: label, count: 1 });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.complaint.localeCompare(b.complaint)).slice(0, limit);
}

export interface FrequentVisitor { student_id: string; name: string; admission_no: string; count: number; last: string }

/** Learners with at least `min` visits in the list, most visits first. */
export function frequentVisitors(visits: Pick<SickBayVisit, "student_id" | "time_in" | "students">[], min = 3): FrequentVisitor[] {
  const by = new Map<string, FrequentVisitor>();
  for (const v of visits) {
    const f = by.get(v.student_id) ?? { student_id: v.student_id, name: v.students?.full_name ?? "", admission_no: v.students?.admission_no ?? "", count: 0, last: v.time_in };
    f.count += 1;
    if (v.time_in > f.last) f.last = v.time_in;
    by.set(v.student_id, f);
  }
  return [...by.values()].filter((f) => f.count >= min).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export interface ComplianceRow {
  schedule: MedicationSchedule;
  due: number;
  given: number;
  refused: number;
  missed: number;
  /** past doses nobody recorded */
  unrecorded: number;
  /** given / due, as a whole percent; null with nothing due */
  rate: number | null;
}

/** Per schedule: of the doses due so far in the range, how many were given. Doses later today aren't counted yet. */
export function medicationCompliance(slots: DoseSlot[]): ComplianceRow[] {
  const by = new Map<string, ComplianceRow>();
  for (const s of slots) {
    if (s.state === "upcoming" || s.state === "due") continue;
    const r = by.get(s.schedule.id) ?? { schedule: s.schedule, due: 0, given: 0, refused: 0, missed: 0, unrecorded: 0, rate: null };
    r.due += 1;
    if (s.state === "given") r.given += 1;
    else if (s.state === "refused") r.refused += 1;
    else if (s.state === "missed") r.missed += 1;
    else r.unrecorded += 1;
    by.set(s.schedule.id, r);
  }
  return [...by.values()]
    .map((r) => ({ ...r, rate: r.due ? Math.round((r.given / r.due) * 100) : null }))
    .sort((a, b) => (a.rate ?? 101) - (b.rate ?? 101) || (a.schedule.students?.full_name ?? "").localeCompare(b.schedule.students?.full_name ?? ""));
}

const clock = (iso: string | null) => (iso ? `${localDay(new Date(iso))} ${String(new Date(iso).getHours()).padStart(2, "0")}:${String(new Date(iso).getMinutes()).padStart(2, "0")}` : "");

export function visitsCsv(visits: SickBayVisit[]): string {
  return toCsv(
    ["time_in", "learner", "admission_no", "class", "complaint", "temperature_c", "outcome", "referred_to", "time_out"],
    visits.map((v) => [clock(v.time_in), v.students?.full_name, v.students?.admission_no, v.students?.classes?.name,
      v.complaint, v.temperature_c, v.outcome ? VISIT_OUTCOME_LABEL[v.outcome] : "", v.referred_to, clock(v.time_out)]),
  );
}

export function visitCountsCsv(days: DayCount[], unit: "day" | "week"): string {
  return toCsv([unit === "day" ? "day" : "week_starting", "visits"], days.map((d) => [d.day, d.count]));
}

export function complaintsCsv(rows: ComplaintCount[]): string {
  return toCsv(["complaint", "visits"], rows.map((r) => [r.complaint, r.count]));
}

export function frequentVisitorsCsv(rows: FrequentVisitor[]): string {
  return toCsv(["learner", "admission_no", "visits", "last_visit"], rows.map((r) => [r.name, r.admission_no, r.count, clock(r.last)]));
}

export function complianceCsv(rows: ComplianceRow[]): string {
  return toCsv(
    ["learner", "admission_no", "drug", "dose", "due", "given", "refused", "missed", "not_recorded", "given_percent"],
    rows.map((r) => [r.schedule.students?.full_name, r.schedule.students?.admission_no, r.schedule.drug, r.schedule.dose,
      r.due, r.given, r.refused, r.missed, r.unrecorded, r.rate]),
  );
}

// ---------------------------------------------------------------- requests, notices
export type RequestStatus = "pending" | "approved" | "declined" | "withdrawn";

export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  pending: "Waiting for the nurse", approved: "Approved", declined: "Declined", withdrawn: "Withdrawn",
};

export interface MedicationRequest {
  id: string;
  tenant_id: string;
  student_id: string;
  requested_by: string;
  drug: string;
  dose: string;
  times_per_day: number;
  starts_on: string;
  ends_on: string | null;
  instructions: string | null;
  prescriber: string | null;
  prescription_path: string | null;
  status: RequestStatus;
  decided_at: string | null;
  decision_note: string | null;
  schedule_id: string | null;
  created_at: string;
  students?: VisitLearnerRef | null;
}

export interface MedicationRequestDraft {
  drug: string;
  dose: string;
  times_per_day: number;
  starts_on: string;
  ends_on: string | null;
  instructions: string;
  prescriber: string;
}

export function requestDraftProblem(d: MedicationRequestDraft): string | null {
  if (!d.drug.trim()) return "Name the medicine.";
  if (!d.dose.trim()) return "Give the dose, e.g. 250mg or 5ml.";
  if (!Number.isInteger(d.times_per_day) || d.times_per_day < 1 || d.times_per_day > 8) return "How many times a day, 1 to 8.";
  if (!d.starts_on) return "When should the school start giving it?";
  if (d.ends_on && d.ends_on < d.starts_on) return "The last day can't be before the first.";
  return null;
}

export interface MedicalNotice {
  id: string;
  student_id: string;
  visit_id: string;
  outcome: VisitOutcome;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

export type ClassSickBayStatus = "in_sick_bay" | "sent_home" | "away";

export const CLASS_SICK_BAY_LABEL: Record<ClassSickBayStatus, string> = {
  in_sick_bay: "In sick bay",
  sent_home: "Sent home",
  away: "Away (sick bay)",
};

// ---------------------------------------------------------------- database: the nurse
const VISIT_SELECT = "*, students(full_name, admission_no, classes(name)), visit_medications(*)";
const SCHEDULE_SELECT = "*, students(full_name, admission_no, classes(name))";

export interface LearnerHit { id: string; full_name: string; admission_no: string; class_name: string | null }

/** Learners by name or admission number, for the nurse's "who is it" box. */
export async function findMedicalLearners(tenantId: string, query: string): Promise<LearnerHit[]> {
  const q = query.trim().replace(/[%,()]/g, " ");
  if (q.length < 2) return [];
  const { data, error } = await supabase().from("students").select("id, full_name, admission_no, classes(name)")
    .eq("tenant_id", tenantId).eq("active", true)
    .or(`full_name.ilike.%${q}%,admission_no.ilike.${q}%`).order("full_name").limit(8);
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as (Omit<LearnerHit, "class_name"> & { classes: { name: string } | null })[])
    .map((s) => ({ id: s.id, full_name: s.full_name, admission_no: s.admission_no, class_name: s.classes?.name ?? null }));
}

/** Everyone still in the sick bay, whatever day they came in. */
export async function fetchOpenVisits(tenantId: string): Promise<SickBayVisit[]> {
  const { data, error } = await supabase().from("sick_bay_visits").select(VISIT_SELECT)
    .eq("tenant_id", tenantId).is("time_out", null).order("time_in");
  if (error) throw new Error(error.message);
  return (data ?? []) as SickBayVisit[];
}

/** Visits that came in between these instants, newest first. */
export async function fetchVisits(tenantId: string, since: Date, until: Date): Promise<SickBayVisit[]> {
  const { data, error } = await supabase().from("sick_bay_visits").select(VISIT_SELECT)
    .eq("tenant_id", tenantId).gte("time_in", since.toISOString()).lt("time_in", until.toISOString())
    .order("time_in", { ascending: false }).limit(2000);
  if (error) throw new Error(error.message);
  return (data ?? []) as SickBayVisit[];
}

function draftRow(d: SickBayVisitDraft) {
  return {
    student_id: d.student_id, time_in: d.time_in, complaint: d.complaint.trim(),
    temperature_c: d.temperature_c, pulse_bpm: d.pulse_bpm,
    observations: d.observations, assessment: d.assessment, treatment: d.treatment,
    outcome: d.outcome, referred_to: d.referred_to, time_out: d.time_out, follow_up: d.follow_up,
  };
}

export async function logVisit(tenantId: string, draft: SickBayVisitDraft): Promise<SickBayVisit> {
  const { data, error } = await supabase().from("sick_bay_visits").insert({ tenant_id: tenantId, ...draftRow(draft) })
    .select(VISIT_SELECT).single<SickBayVisit>();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateVisit(id: string, draft: SickBayVisitDraft): Promise<SickBayVisit> {
  // the learner is fixed once logged (the database refuses a move too)
  const row: Partial<ReturnType<typeof draftRow>> = draftRow(draft);
  delete row.student_id;
  const { data, error } = await supabase().from("sick_bay_visits").update(row).eq("id", id)
    .select(VISIT_SELECT).single<SickBayVisit>();
  if (error) throw new Error(error.message);
  return data;
}

/** Medicine given at a visit, optionally taken off a Medical stock line. Never edited afterwards. */
export async function addVisitMedication(tenantId: string, visitId: string, med: {
  drug: string; dose: string; given_at: string; inventory_item_id: string | null; stock_quantity: number | null;
}): Promise<void> {
  const { error } = await supabase().from("visit_medications").insert({ tenant_id: tenantId, visit_id: visitId, ...med });
  if (error) throw new Error(error.message);
}

export interface MedicalStockLine { id: string; name: string; quantity: number }

export async function fetchMedicalStock(tenantId: string): Promise<MedicalStockLine[]> {
  const { data, error } = await supabase().rpc("medical_stock", { p_tenant_id: tenantId });
  if (error) throw new Error(error.message);
  return (data ?? []) as MedicalStockLine[];
}

/** Marks a learner sent home, referred or admitted as excused (or absent) in that day's register. */
export async function markVisitAttendance(visitId: string, mark: "excused" | "absent"): Promise<void> {
  const { error } = await supabase().rpc("medical_mark_attendance", { p_visit_id: visitId, p_mark: mark });
  if (error) throw new Error(error.message);
}

/** Asks medical-notify to push the visit's notices to guardians' phones. Fire and forget: they're in the app either way. */
export async function pushMedicalNotices(visitId: string): Promise<void> {
  await invokeEdge("medical-notify", { visit_id: visitId }, { timeoutMs: 15_000 }).catch(() => {});
}

export interface MedicalRecord {
  health: StudentHealth | null;
  visits: SickBayVisit[];
  schedules: MedicationSchedule[];
  doses: MedicationDose[];
  requests: MedicationRequest[];
}

/** One learner's whole record for the nurse. The database writes who opened it to the audit trail. */
export async function openMedicalRecord(studentId: string): Promise<MedicalRecord> {
  const { data, error } = await supabase().rpc("medical_record", { p_student_id: studentId });
  if (error) throw new Error(error.message);
  const r = data as { health: StudentHealth | null; visits: (SickBayVisit & { medications: VisitMedication[] })[]; schedules: MedicationSchedule[]; doses: MedicationDose[]; requests: MedicationRequest[] };
  return { ...r, visits: r.visits.map(({ medications, ...v }) => ({ ...v, visit_medications: medications })) };
}

/** Schedules running on any day in the range (stopped ones included, for their history). */
export async function fetchSchedules(tenantId: string, from: string, to: string): Promise<MedicationSchedule[]> {
  const { data, error } = await supabase().from("medication_schedules").select(SCHEDULE_SELECT)
    .eq("tenant_id", tenantId).lte("starts_on", to).or(`ends_on.is.null,ends_on.gte.${from}`).order("starts_on");
  if (error) throw new Error(error.message);
  return (data ?? []) as MedicationSchedule[];
}

export async function fetchDoses(tenantId: string, from: string, to: string): Promise<MedicationDose[]> {
  const { data, error } = await supabase().from("medication_doses").select("*")
    .eq("tenant_id", tenantId).gte("due_on", from).lte("due_on", to);
  if (error) throw new Error(error.message);
  return (data ?? []) as MedicationDose[];
}

export interface ScheduleDraft {
  student_id: string;
  drug: string;
  dose: string;
  times: string[];
  starts_on: string;
  ends_on: string | null;
  prescribed_by: "doctor" | "parent";
  prescriber: string;
  notes: string;
}

export function scheduleDraftProblem(d: Partial<ScheduleDraft>): string | null {
  if (!d.student_id) return "Pick the learner.";
  if (!d.drug?.trim()) return "Name the medicine.";
  if (!d.dose?.trim()) return "Give the dose.";
  if (!d.times?.length) return "Give the times of day, e.g. 08:00, 20:00.";
  if (!d.starts_on) return "Give the first day.";
  if (d.ends_on && d.ends_on < d.starts_on) return "The last day can't be before the first.";
  return null;
}

export async function saveSchedule(tenantId: string, d: ScheduleDraft): Promise<void> {
  const { error } = await supabase().from("medication_schedules").insert({ tenant_id: tenantId, ...d });
  if (error) throw new Error(error.message);
}

export async function stopSchedule(id: string): Promise<void> {
  const { error } = await supabase().from("medication_schedules").update({ stopped_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

/** Records (or corrects) one dose on the round. */
export async function recordDose(tenantId: string, slot: Pick<DoseSlot, "schedule" | "day" | "time">, status: DoseStatus, note?: string): Promise<void> {
  const { error } = await supabase().from("medication_doses").upsert({
    tenant_id: tenantId, schedule_id: slot.schedule.id, student_id: slot.schedule.student_id,
    due_on: slot.day, due_time: slot.time, status, note: note ?? null,
  }, { onConflict: "schedule_id,due_on,due_time" });
  if (error) throw new Error(error.message);
}

export async function fetchPendingRequests(tenantId: string): Promise<MedicationRequest[]> {
  const { data, error } = await supabase().from("medication_requests").select("*, students(full_name, admission_no, classes(name))")
    .eq("tenant_id", tenantId).eq("status", "pending").order("created_at");
  if (error) throw new Error(error.message);
  return (data ?? []) as MedicationRequest[];
}

export async function approveRequest(id: string, s: { drug: string; dose: string; times: string[]; starts_on: string; ends_on: string | null; notes: string }): Promise<void> {
  const { error } = await supabase().rpc("approve_medication_request", {
    p_request_id: id, p_drug: s.drug, p_dose: s.dose, p_times: s.times, p_starts_on: s.starts_on, p_ends_on: s.ends_on, p_notes: s.notes,
  });
  if (error) throw new Error(error.message);
}

export async function declineRequest(id: string, note: string): Promise<void> {
  const { error } = await supabase().rpc("decline_medication_request", { p_request_id: id, p_note: note });
  if (error) throw new Error(error.message);
}

export async function fetchNotifyPolicy(tenantId: string): Promise<NotifyPolicy> {
  const { data, error } = await supabase().from("medical_settings").select("notify_guardians").eq("tenant_id", tenantId)
    .maybeSingle<{ notify_guardians: NotifyPolicy }>();
  if (error) throw new Error(error.message);
  return data?.notify_guardians ?? "serious";
}

export async function saveNotifyPolicy(tenantId: string, policy: NotifyPolicy): Promise<void> {
  const { error } = await supabase().from("medical_settings")
    .upsert({ tenant_id: tenantId, notify_guardians: policy, updated_at: new Date().toISOString() }, { onConflict: "tenant_id" });
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------- database: teachers
/** Who in a class is in the sick bay or was sent home today; nothing clinical. Learners with neither are absent. */
export async function fetchClassSickBay(classId: string): Promise<Map<string, ClassSickBayStatus>> {
  const { data, error } = await supabase().rpc("sick_bay_class_status", { p_class_id: classId });
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as { student_id: string; status: ClassSickBayStatus }[]).map((r) => [r.student_id, r.status]));
}

// ---------------------------------------------------------------- database: guardians
export interface ChildMedical {
  visits: SickBayVisit[];
  schedules: MedicationSchedule[];
  doses: MedicationDose[];
  requests: MedicationRequest[];
  notices: MedicalNotice[];
}

/** A guardian's view of their own child: visits, medication and its record, requests, and what they were told. */
export async function fetchChildMedical(studentId: string): Promise<ChildMedical> {
  const sb = supabase();
  const since = addDays(localDay(new Date()), -60);
  const [visits, schedules, doses, requests, notices] = await Promise.all([
    sb.from("sick_bay_visits").select("*, visit_medications(*)").eq("student_id", studentId).order("time_in", { ascending: false }).limit(100),
    sb.from("medication_schedules").select("*").eq("student_id", studentId).order("starts_on", { ascending: false }),
    sb.from("medication_doses").select("*").eq("student_id", studentId).gte("due_on", since).order("due_on", { ascending: false }),
    sb.from("medication_requests").select("*").eq("student_id", studentId).order("created_at", { ascending: false }),
    sb.from("medical_notices").select("id, student_id, visit_id, outcome, title, body, created_at, read_at").eq("student_id", studentId)
      .order("created_at", { ascending: false }).limit(50),
  ]);
  for (const r of [visits, schedules, doses, requests, notices]) if (r.error) throw new Error(r.error.message);
  return {
    visits: (visits.data ?? []) as SickBayVisit[],
    schedules: (schedules.data ?? []) as MedicationSchedule[],
    doses: (doses.data ?? []) as MedicationDose[],
    requests: (requests.data ?? []) as MedicationRequest[],
    notices: (notices.data ?? []) as MedicalNotice[],
  };
}

/** Unread sick bay notices for this guardian, across their children: the badge. */
export async function fetchUnreadMedicalNotices(profileId: string): Promise<number> {
  const { count, error } = await supabase().from("medical_notices").select("id", { count: "exact", head: true })
    .eq("profile_id", profileId).is("read_at", null);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function markMedicalNoticesRead(studentId: string): Promise<void> {
  const { error } = await supabase().rpc("mark_medical_notices_read", { p_student_id: studentId });
  if (error) throw new Error(error.message);
}

/** A guardian asks the nurse to give a prescribed medicine. The photo, if any, is already uploaded (prescriptionPath). */
export async function requestMedication(tenantId: string, studentId: string, d: MedicationRequestDraft, prescriptionPath: string | null): Promise<void> {
  const { error } = await supabase().from("medication_requests").insert({
    tenant_id: tenantId, student_id: studentId, drug: d.drug.trim(), dose: d.dose.trim(), times_per_day: d.times_per_day,
    starts_on: d.starts_on, ends_on: d.ends_on || null, instructions: d.instructions.trim() || null,
    prescriber: d.prescriber.trim() || null, prescription_path: prescriptionPath,
  });
  if (error) throw new Error(error.message);
}

export async function withdrawMedicationRequest(id: string): Promise<void> {
  const { error } = await supabase().from("medication_requests").update({ status: "withdrawn" }).eq("id", id);
  if (error) throw new Error(error.message);
}
