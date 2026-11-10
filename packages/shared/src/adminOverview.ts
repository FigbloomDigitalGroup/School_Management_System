import { supabase } from "./supabase";
import { fetchAllPages, fetchAllRows } from "./paging";
import { today } from "./attendance";
import type { AttendanceMark, ClassGroup, Term } from "./types";

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
  /** The newest day any class took a register this term (not always today), or null when none has. */
  attendanceDate: string | null;
  presentByClass: Map<string, number>;
  lateByClass: Map<string, number>;
  absentByClass: Map<string, number>;
  submittedClasses: Set<string>;
}

/** The overview for a full admin: the current term, every class's latest register, fee totals, headcounts. */
export async function fetchSchoolOverview(tenantId: string): Promise<SchoolOverview> {
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

  const studentsByClass = new Map<string, number>();
  for (const s of studentRows ?? []) studentsByClass.set(s.class_id, (studentsByClass.get(s.class_id) ?? 0) + 1);

  let attendanceDate: string | null = null;
  const presentByClass = new Map<string, number>();
  const lateByClass = new Map<string, number>();
  const absentByClass = new Map<string, number>();
  const submittedClasses = new Set<string>();

  if (termId) {
    const { data: latest } = await sb
      .from("attendance").select("taken_on").eq("tenant_id", tenantId).eq("term_id", termId)
      .order("taken_on", { ascending: false }).limit(1)
      .returns<{ taken_on: string }[]>();
    attendanceDate = latest?.[0]?.taken_on ?? null;

    if (attendanceDate) {
      const rows = await fetchAllPages<{ class_id: string; mark: string }>((from, to) => sb
        .from("attendance").select("class_id,mark")
        .eq("tenant_id", tenantId).eq("term_id", termId).eq("taken_on", attendanceDate)
        .order("id").range(from, to).returns<{ class_id: string; mark: string }[]>());
      for (const r of rows) {
        submittedClasses.add(r.class_id);
        // A late arrival still attended — only "absent"/"excused" should read as not-here.
        if (r.mark === "present" || r.mark === "late") presentByClass.set(r.class_id, (presentByClass.get(r.class_id) ?? 0) + 1);
        if (r.mark === "late") lateByClass.set(r.class_id, (lateByClass.get(r.class_id) ?? 0) + 1);
        if (r.mark === "absent") absentByClass.set(r.class_id, (absentByClass.get(r.class_id) ?? 0) + 1);
      }
    }
  }

  return {
    term: term ?? null,
    classes: classRows ?? [],
    studentsByClass,
    activeStudents: studentRows?.length ?? 0,
    staffCount: staffRows?.length ?? 0,
    fees: ((feesRes.data ?? []) as FeeTotals[])[0] ?? NO_FEES,
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
