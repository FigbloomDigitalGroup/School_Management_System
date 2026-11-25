import { apiFetchClassAttendanceDetail, apiFetchOverviewBasics, apiFetchRegisterDays, apiRemindClassTeacher } from "./api/adminOverviewApi";
import { apiFetchTermReport } from "./api/reportsApi";
import { onApi } from "./backend";
import { supabase } from "./supabase";
import { fetchAllPages, fetchAllRows } from "./paging";
import { today } from "./attendance";
import { fetchAttendanceSettings, REGISTER_TABLE, type AttendanceSettings, type PercentageMode } from "./attendanceSession";
import { fetchCollectorDetails, fetchEarlySignOutsForStudents, signOutList, type EarlySignOut, type EarlySignOutCollector } from "./earlySignOut";
import { gradingSchemeFor, type GradingSchemeId } from "./gradingSchemes";
import type { AttendanceMark, ClassGroup, Exam, Term } from "./types";

/**
 * What the school's admin console opens on: the overview a principal reads at 07:30 (is the school running today,
 * is anything on fire) and each class's register. It was inline in the web's Dashboard, AttendanceDetail and
 * AreasHome; it lives here so the phone's admin console says the same things, the same way.
 */

/** What term_fee_totals() returns: the term's invoices added up in the database (the API cannot be read past 1,000 rows). */
export interface FeeTotals {
  billed: number;
  paid: number;
  invoices: number;
  nothing_paid: number;
  part_paid: number;
  full_paid: number;
  owing: number;
}
export const NO_FEES: FeeTotals = { billed: 0, paid: 0, invoices: 0, nothing_paid: 0, part_paid: 0, full_paid: 0, owing: 0 };

export type OverviewClass = Pick<ClassGroup, "id" | "name" | "class_teacher_id">;

export interface SchoolOverview {
  term: Term | null;
  classes: OverviewClass[];
  studentsByClass: Map<string, number>;
  activeStudents: number;
  staffCount: number;
  fees: FeeTotals;
  /**
   * The day the registers above are from. Asked for "today": today in the school's time zone, always (FIG-1401). Otherwise the newest day any
   * class took a register this term (not always today), or null when none has.
   */
  attendanceDate: string | null;
  presentByClass: Map<string, number>;
  lateByClass: Map<string, number>;
  absentByClass: Map<string, number>;
  submittedClasses: Set<string>;
}

/** Which day an overview's registers are from. */
export type OverviewDay = "today" | "latest";

export interface OverviewBasics {
  term: Term | null;
  classes: OverviewClass[];
  /** Every active learner and the class they are in. */
  students: { id: string; class_id: string }[];
  staffCount: number;
  fees: FeeTotals;
}

/**
 * What every overview opens with: the current term, the school's classes, its active learners, how many school admins and
 * teachers it has, and the term's fee totals. (The admin Dashboard on the web and fetchSchoolOverview both start here.)
 * A failed read of the term, the classes, the learners or the staff reads as nothing; a failed read of the fee totals throws.
 */
export async function fetchOverviewBasics(tenantId: string): Promise<OverviewBasics> {
  if (onApi()) return apiFetchOverviewBasics(tenantId);
  const sb = supabase();

  const { data: term } = await sb.from("terms").select("*").eq("tenant_id", tenantId).eq("is_current", true).maybeSingle<Term>();
  const termId = term?.id ?? null;

  const [{ data: classRows }, { data: studentRows }, { data: staffRows }, feesRes] = await Promise.all([
    sb.from("classes").select("id,name,class_teacher_id").eq("tenant_id", tenantId).order("name").returns<OverviewClass[]>(),
    // Read a page at a time: the API stops at 1,000 rows without saying so, which made the Learners card read 1,000 (FIG-1416).
    fetchAllRows<{ id: string; class_id: string }>((from, to) => sb
      .from("students").select("id,class_id").eq("tenant_id", tenantId).eq("active", true)
      .order("id").range(from, to).returns<{ id: string; class_id: string }[]>()),
    sb.from("profiles").select("id").eq("tenant_id", tenantId).in("role", ["school_admin", "teacher"]).returns<{ id: string }[]>(),
    termId
      ? sb.rpc("term_fee_totals", { p_tenant_id: tenantId, p_term_id: termId })
      : Promise.resolve({ data: [] as FeeTotals[], error: null }),
  ]);
  if (feesRes.error) throw new Error(feesRes.error.message);

  return {
    term: term ?? null,
    classes: classRows ?? [],
    students: studentRows ?? [],
    staffCount: staffRows?.length ?? 0,
    fees: ((feesRes.data ?? []) as FeeTotals[])[0] ?? NO_FEES,
  };
}

/**
 * The overview for a full admin: the current term, every class's register, fee totals, headcounts.
 *
 * `day` is which register day it reads. "latest" (the default, and what the phone shows, with a note that names the day when it is not today)
 * is the newest day any class took a register. "today" is today in the school's time zone whether or not any class has taken one yet, so
 * a class that has not taken today's register reads as Not taken instead of the overview showing an earlier day as today (FIG-1401).
 */
export async function fetchSchoolOverview(tenantId: string, day: OverviewDay = "latest"): Promise<SchoolOverview> {
  const sb = supabase();

  const { term, classes, students, staffCount, fees } = await fetchOverviewBasics(tenantId);
  const termId = term?.id ?? null;

  const studentsByClass = new Map<string, number>();
  for (const s of students) studentsByClass.set(s.class_id, (studentsByClass.get(s.class_id) ?? 0) + 1);

  let attendanceDate: string | null = null;
  const presentByClass = new Map<string, number>();
  const lateByClass = new Map<string, number>();
  const absentByClass = new Map<string, number>();
  const submittedClasses = new Set<string>();

  if (termId) {
    if (day === "today") {
      attendanceDate = today();
    } else {
      const { data: latest } = await sb
        .from("attendance").select("taken_on").eq("tenant_id", tenantId).eq("term_id", termId)
        .order("taken_on", { ascending: false }).limit(1)
        .returns<{ taken_on: string }[]>();
      attendanceDate = latest?.[0]?.taken_on ?? null;
    }

    if (attendanceDate) {
      type Row = { class_id: string; mark: string; students: { active: boolean } | null };
      const rows = await fetchAllPages<Row>((from, to) => sb
        .from("attendance").select("class_id,mark,students(active)")
        .eq("tenant_id", tenantId).eq("term_id", termId).eq("taken_on", attendanceDate)
        .order("id").range(from, to).returns<Row[]>());
      for (const r of rows) {
        // A register is in once any row of it is, whoever the learner is now.
        submittedClasses.add(r.class_id);
        // "here / on roll" counts the same learners on both sides (FIG-1409): the roll is the learners on it now, so a learner archived after the
        // register was taken is in neither number. (The roll side comes from the active learners, above.)
        if (r.students?.active === false) continue;
        // A late arrival still attended — only "absent"/"excused" should read as not-here.
        if (r.mark === "present" || r.mark === "late") presentByClass.set(r.class_id, (presentByClass.get(r.class_id) ?? 0) + 1);
        if (r.mark === "late") lateByClass.set(r.class_id, (lateByClass.get(r.class_id) ?? 0) + 1);
        if (r.mark === "absent") absentByClass.set(r.class_id, (absentByClass.get(r.class_id) ?? 0) + 1);
      }
    }
  }

  return {
    term,
    classes,
    studentsByClass,
    activeStudents: students.length,
    staffCount,
    fees,
    attendanceDate,
    presentByClass,
    lateByClass,
    absentByClass,
    submittedClasses,
  };
}

/** The share of learners in the classes that took a register who were here (late counts as here); null when none has. */
export function overviewAttendanceRate(o: SchoolOverview): number | null {
  if (o.submittedClasses.size === 0) return null;
  const here = [...o.presentByClass.values()].reduce((a, b) => a + b, 0);
  const onRoll = [...o.submittedClasses].reduce((a, id) => a + (o.studentsByClass.get(id) ?? 0), 0);
  return Math.round((here / Math.max(onRoll, 1)) * 100);
}

/** What share of this term's billing has been paid, as a whole percentage. */
export function feeCollectedPct(fees: FeeTotals): number {
  return fees.billed > 0 ? Math.round((fees.paid / fees.billed) * 100) : 0;
}

/** The classes that have not taken the register for the overview's day. */
export function classesWithoutRegister(o: SchoolOverview): OverviewClass[] {
  return o.classes.filter((c) => !o.submittedClasses.has(c.id));
}

/** "Needs you": what a principal has to act on, most pressing first. */
export function needsYou(o: SchoolOverview): { title: string; body: string }[] {
  const missing = classesWithoutRegister(o);
  const owing = o.fees.owing;
  return [
    ...(missing.length > 0
      ? [{
          title: `${missing.length} class${missing.length === 1 ? "" : "es"} ${missing.length === 1 ? "has" : "have"} not taken attendance`,
          body: `${missing.map((c) => c.name).join(", ") || "No classes"}${o.attendanceDate ? ` for ${o.attendanceDate}` : ""}.`,
        }]
      : []),
    ...(owing > 0
      ? [{
          title: `${o.term ? o.term.name + " fee" : "Fee"} balances are outstanding`,
          body: `${owing} learner${owing === 1 ? " still owes" : "s still owe"} a balance this term.`,
        }]
      : []),
  ];
}

/** An in-app note to a class's teacher that its register has not been taken yet. Throws the database's message when it fails. */
export async function remindClassTeacher(tenantId: string, authorId: string, cls: Pick<OverviewClass, "name" | "class_teacher_id">): Promise<void> {
  if (onApi()) return apiRemindClassTeacher(tenantId, cls);
  if (!cls.class_teacher_id) throw new Error(`${cls.name} has no class teacher assigned yet.`);
  const { error } = await supabase().from("announcements").insert({
    tenant_id: tenantId,
    author_id: authorId,
    subject: `Attendance not yet taken — ${cls.name}`,
    body: `${cls.name} hasn't submitted today's attendance register yet. Please take it as soon as you can.`,
    audience: { kind: "user", user_id: cls.class_teacher_id },
    channels: ["in_app"],
    published_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

export interface RosterMark { id: string; name: string; admissionNo: string; mark: AttendanceMark }

/** One class's register for a day: every active learner with their mark (no mark on file reads as present, as the register does). */
export async function fetchClassRegister(classId: string, date: string): Promise<RosterMark[]> {
  const sb = supabase();
  const [{ data: students, error: e1 }, { data: marks, error: e2 }] = await Promise.all([
    sb.from("students").select("id, full_name, admission_no").eq("class_id", classId).eq("active", true).order("full_name")
      .returns<{ id: string; full_name: string; admission_no: string }[]>(),
    sb.from("attendance").select("student_id, mark").eq("class_id", classId).eq("taken_on", date)
      .returns<{ student_id: string; mark: AttendanceMark }[]>(),
  ]);
  if (e1) throw new Error(e1.message);
  if (e2) throw new Error(e2.message);

  const markByStudent = new Map((marks ?? []).map((m) => [m.student_id, m.mark]));
  return (students ?? []).map((s) => ({
    id: s.id,
    name: s.full_name,
    admissionNo: s.admission_no,
    mark: markByStudent.get(s.id) ?? "present",
  }));
}

/** The learners who were not here and on time: late arrivals, absences and excusals (those marked present are left off). */
export function awayFromRegister(rows: readonly RosterMark[]): RosterMark[] {
  return rows.filter((r) => r.mark !== "present");
}

export interface LatestRegisters {
  date: string | null;
  classes: Pick<ClassGroup, "id" | "name">[];
  learners: Map<string, number>;
  present: Map<string, number>;
  taken: Set<string>;
}

/** Every class's most recent register, for someone who holds the attendance area but is not a full admin. */
export async function fetchLatestRegisters(tenantId: string): Promise<LatestRegisters> {
  const sb = supabase();
  const [{ data: classes, error: e1 }, { data: students, error: e2 }, { data: latest, error: e3 }] = await Promise.all([
    sb.from("classes").select("id,name").eq("tenant_id", tenantId).order("name").returns<Pick<ClassGroup, "id" | "name">[]>(),
    sb.from("students").select("class_id").eq("tenant_id", tenantId).eq("active", true).returns<{ class_id: string }[]>(),
    sb.from("attendance").select("taken_on").eq("tenant_id", tenantId).order("taken_on", { ascending: false }).limit(1).returns<{ taken_on: string }[]>(),
  ]);
  for (const e of [e1, e2, e3]) if (e) throw new Error(e.message);

  const learners = new Map<string, number>();
  for (const s of students ?? []) learners.set(s.class_id, (learners.get(s.class_id) ?? 0) + 1);
  const date = latest?.[0]?.taken_on ?? null;
  const present = new Map<string, number>();
  const taken = new Set<string>();
  if (date) {
    const { data: rows, error } = await sb.from("attendance").select("class_id,mark").eq("tenant_id", tenantId).eq("taken_on", date)
      .returns<{ class_id: string; mark: string }[]>();
    if (error) throw new Error(error.message);
    for (const r of rows ?? []) {
      taken.add(r.class_id);
      // a late arrival still attended
      if (r.mark === "present" || r.mark === "late") present.set(r.class_id, (present.get(r.class_id) ?? 0) + 1);
    }
  }
  return { date, classes: classes ?? [], learners, present, taken };
}

/**
 * Which day a register is for, in words: "today" and "yesterday" when it is, else "Wed 4 Nov". The date is the school's
 * own day (YYYY-MM-DD), compared with today in the school's time zone, never shifted by the phone's.
 */
export function registerDayLabel(date: string, now: Date = new Date(), timeZone?: string): string {
  const todayIso = today(timeZone, now);
  if (date === todayIso) return "today";
  const yesterday = new Date(Date.parse(`${todayIso}T00:00:00Z`) - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (date === yesterday) return "yesterday";
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", "");
}

// ---------------------------------------------------------------- the web admin console's registers and term report (FIG-1899)

export interface RegisterDays {
  classes: Pick<ClassGroup, "id" | "name">[];
  /** The newest day any class took the morning register; null when none has. */
  latestMorning: string | null;
  /** The newest day any class took an afternoon register; null when none has, and when that read fails (it must not hide the morning figures). */
  latestAfternoon: string | null;
  settings: AttendanceSettings;
}

/** Every class, the newest day each register was taken on, and the school's attendance settings: what the "latest registers" list opens with. */
export async function fetchRegisterDays(tenantId: string): Promise<RegisterDays> {
  if (onApi()) return apiFetchRegisterDays(tenantId);
  const sb = supabase();
  const [{ data: classes, error: e1 }, { data: latest, error: e3 }, latestAfternoon, settings] = await Promise.all([
    sb.from("classes").select("id,name").eq("tenant_id", tenantId).order("name").returns<Pick<ClassGroup, "id" | "name">[]>(),
    sb.from("attendance").select("taken_on").eq("tenant_id", tenantId).order("taken_on", { ascending: false }).limit(1).returns<{ taken_on: string }[]>(),
    // An afternoon read that fails must not hide the morning figures.
    sb.from(REGISTER_TABLE.afternoon).select("taken_on").eq("tenant_id", tenantId).order("taken_on", { ascending: false }).limit(1)
      .returns<{ taken_on: string }[]>().then((r) => (r.error ? null : r.data?.[0]?.taken_on ?? null)),
    fetchAttendanceSettings(tenantId),
  ]);
  for (const e of [e1, e3]) if (e) throw new Error(e.message);
  return { classes: classes ?? [], latestMorning: latest?.[0]?.taken_on ?? null, latestAfternoon, settings };
}

/** `mark` is the morning register; `pmMark` the afternoon one (null when no afternoon register is shown or none was taken). */
export interface ClassAttendanceRow { id: string; name: string; admissionNo: string; mark: AttendanceMark; pmMark: AttendanceMark | null }

export interface ClassAttendanceDetail {
  rows: ClassAttendanceRow[];
  /** The afternoon column is shown while the school takes an afternoon register, or the class has one for this date (it stays visible once turned off). */
  showPm: boolean;
  pmTaken: boolean;
  classTeacherId: string | null;
  signOuts: EarlySignOut[];
  details: Map<string, EarlySignOutCollector>;
}

/**
 * One class's registers for one day, with the class teacher and who left early: what the admin's "who wasn't here" window shows. A learner with no
 * mark on file reads as present. A failed read of the afternoon register, of the sign-outs or of their collectors must not hide the morning register,
 * so those read as nothing; the other reads throw the database's message.
 */
export async function fetchClassAttendanceDetail(classId: string, date: string, tenantId: string): Promise<ClassAttendanceDetail> {
  if (onApi()) return apiFetchClassAttendanceDetail(classId, date, tenantId);
  const sb = supabase();
  const [{ data: students, error: e1 }, { data: marks, error: e2 }, { data: cls, error: e3 }, settings, pm] = await Promise.all([
    sb.from("students").select("id, full_name, admission_no").eq("class_id", classId).eq("active", true).order("full_name")
      .returns<{ id: string; full_name: string; admission_no: string }[]>(),
    sb.from("attendance").select("student_id, mark").eq("class_id", classId).eq("taken_on", date)
      .returns<{ student_id: string; mark: AttendanceMark }[]>(),
    sb.from("classes").select("class_teacher_id").eq("id", classId).maybeSingle<{ class_teacher_id: string | null }>(),
    fetchAttendanceSettings(tenantId),
    // A failed afternoon read must not hide the morning register.
    sb.from(REGISTER_TABLE.afternoon).select("student_id, mark").eq("class_id", classId).eq("taken_on", date)
      .returns<{ student_id: string; mark: AttendanceMark }[]>().then((r) => (r.error ? [] : r.data ?? [])),
  ]);
  if (e1) throw new Error(e1.message);
  if (e2) throw new Error(e2.message);
  if (e3) throw new Error(e3.message);

  const markByStudent = new Map((marks ?? []).map((m) => [m.student_id, m.mark]));
  const pmByStudent = new Map(pm.map((m) => [m.student_id, m.mark]));
  const pmTaken = pm.length > 0;
  const showPm = settings.afternoon_enabled || pmTaken;
  const rows: ClassAttendanceRow[] = (students ?? []).map((s) => ({
    id: s.id,
    name: s.full_name,
    admissionNo: s.admission_no,
    mark: markByStudent.get(s.id) ?? "present",
    pmMark: showPm && pmTaken ? pmByStudent.get(s.id) ?? "present" : null,
  }));
  // A failed read of the sign-outs must not hide the register: the register is what this window is for.
  const signOuts = signOutList(await fetchEarlySignOutsForStudents(rows.map((r) => r.id), date).catch(() => [] as EarlySignOut[]));
  const details = await fetchCollectorDetails(signOuts.map((s) => s.id)).catch(() => new Map<string, EarlySignOutCollector>());
  return { rows, showPm, pmTaken, classTeacherId: cls?.class_teacher_id ?? null, signOuts, details };
}

export interface TermReport {
  term: Term | null;
  /** How the school counts attendance: one unit per register entry ("session") or per learner-day ("day"). term_class_figures() uses the same mode. */
  percentageMode: PercentageMode;
  classes: Pick<ClassGroup, "id" | "name" | "form_level" | "level">[];
  attendanceByClass: Map<string, { present: number; total: number }>;
  attendanceOverall: { present: number; total: number };
  feeByClass: Map<string, { billed: number; paid: number }>;
  feeOverall: { billed: number; paid: number };
  latestExam: Exam | null;
  meanByClass: Map<string, { mean: number; marked: number; roster: number; scheme: GradingSchemeId }>;
}

/** One row of term_class_figures(): a class's term, added up in the database (supabase/migrations/20261105500000). */
interface ClassFigures {
  class_id: string;
  roster: number;
  att_here: number;
  att_total: number;
  billed: number;
  paid: number;
  mark_sum: number;
  mark_count: number;
  /** Learners with at least one score in the exam, each counted once (mark_count is one per learner per subject). */
  learners_marked: number;
}

/**
 * The current term looked back over, class by class: attendance, fee collection and the mean of the latest published exam. `country` picks each
 * class's grading scheme. The figures are added up in the database (term_class_figures): the API answers at most 1,000 rows and says nothing when it
 * stops, so a term's register entries, invoices and marks cannot be read here and summed (FIG-1438, FIG-1402, FIG-1439). A failed read of the term, the
 * classes or the latest exam reads as nothing; a failed read of the figures throws the database's message.
 */
export async function fetchTermReport(tenantId: string, country: string): Promise<TermReport> {
  if (onApi()) return apiFetchTermReport(tenantId, country);
  const sb = supabase();
  const { data: term } = await sb.from("terms").select("*").eq("tenant_id", tenantId).eq("is_current", true).maybeSingle<Term>();
  const termId = term?.id ?? null;

  const { data: classRows } = await sb
    .from("classes").select("id,name,form_level,level").eq("tenant_id", tenantId).order("form_level").order("name")
    .returns<Pick<ClassGroup, "id" | "name" | "form_level" | "level">[]>();
  const classes = classRows ?? [];

  const attendanceByClass = new Map<string, { present: number; total: number }>();
  const attendanceOverall = { present: 0, total: 0 };
  const feeByClass = new Map<string, { billed: number; paid: number }>();
  const feeOverall = { billed: 0, paid: 0 };
  let latestExam: Exam | null = null;
  const meanByClass = new Map<string, { mean: number; marked: number; roster: number; scheme: GradingSchemeId }>();

  if (termId) {
    const { data: examRows } = await sb
      .from("exams").select("*").eq("tenant_id", tenantId).eq("term_id", termId).not("published_at", "is", null)
      .order("published_at", { ascending: false }).limit(1).returns<Exam[]>();
    latestExam = examRows?.[0] ?? null;

    const { data: figureRows, error: figureError } = await sb
      .rpc("term_class_figures", { p_tenant_id: tenantId, p_term_id: termId, p_exam_id: latestExam?.id ?? null });
    if (figureError) throw new Error(figureError.message);
    const figures = new Map<string, ClassFigures>(((figureRows ?? []) as ClassFigures[]).map((f) => [f.class_id, f] as const));

    for (const c of classes) {
      const f = figures.get(c.id);
      const here = f?.att_here ?? 0;
      const total = f?.att_total ?? 0;
      attendanceByClass.set(c.id, { present: here, total });
      attendanceOverall.present += here;
      attendanceOverall.total += total;

      const billed = f?.billed ?? 0;
      const paid = f?.paid ?? 0;
      feeByClass.set(c.id, { billed, paid });
      feeOverall.billed += billed;
      feeOverall.paid += paid;

      if (f && f.mark_count > 0) {
        meanByClass.set(c.id, {
          mean: Math.round(f.mark_sum / f.mark_count),
          marked: f.learners_marked,
          roster: f.roster,
          scheme: gradingSchemeFor(country, c.level),
        });
      }
    }
  }

  const { percentage_mode: percentageMode } = await fetchAttendanceSettings(tenantId);
  return { term: term ?? null, percentageMode, classes, attendanceByClass, attendanceOverall, feeByClass, feeOverall, latestExam, meanByClass };
}
