import type { AttendanceMark } from "./types";
import { DEFAULT_SCHOOL_TIME_ZONE } from "./attendance";
import { supabase } from "./supabase";

/**
 * FIG-1514: a morning and an afternoon register per class and day.
 *
 * The morning register is the `attendance` table (unchanged, so phones already installed keep working: whatever they send is a
 * morning register). The afternoon register is `attendance_afternoon`, the same columns and key. A school turns the afternoon register
 * on in its attendance settings, and chooses how percentages count.
 *
 * Twins in supabase/migrations/20261106000200_afternoon_attendance.sql: sessionAt() ~ attendance_session_at(),
 * countAttendance() ~ attendance_counted(). Keep them the same.
 */

export type AttendanceSession = "morning" | "afternoon";
export const ATTENDANCE_SESSIONS: readonly AttendanceSession[] = ["morning", "afternoon"];
export const SESSION_LABEL: Record<AttendanceSession, string> = { morning: "Morning", afternoon: "Afternoon" };

/** The table that holds each register. Old phone builds only know `attendance`. */
export const REGISTER_TABLE: Record<AttendanceSession, "attendance" | "attendance_afternoon"> = {
  morning: "attendance",
  afternoon: "attendance_afternoon",
};

/** School time from which the afternoon register is the default (when the school takes one). */
export const AFTERNOON_STARTS = "12:00";

export type PercentageMode = "session" | "day";

export interface AttendanceSettings {
  afternoon_enabled: boolean;
  percentage_mode: PercentageMode;
}

/** What a school without a settings row gets (the database has the same defaults). */
export const DEFAULT_ATTENDANCE_SETTINGS: AttendanceSettings = { afternoon_enabled: false, percentage_mode: "session" };

export const PERCENTAGE_MODE_LABEL: Record<PercentageMode, string> = {
  session: "By session: the morning and the afternoon register each count",
  day: "By day: a day counts once, as present if the learner was present in either register",
};

/** The wall-clock time at the school, "HH:MM". Falls back to Nairobi's fixed UTC+3 on a device without time-zone support. */
export function schoolClock(timeZone: string = DEFAULT_SCHOOL_TIME_ZONE, now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const h = parts.find((p) => p.type === "hour")?.value;
    const m = parts.find((p) => p.type === "minute")?.value;
    if (h && m && /^\d{2}$/.test(h) && /^\d{2}$/.test(m)) return `${h}:${m}`;
  } catch {
    // no time-zone support on this device: the fixed offset below
  }
  return new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

/**
 * The register a moment belongs to: from 12:00 school time it is the afternoon's, if the school takes one; otherwise the morning's.
 * The teacher can still switch (to any session the school takes).
 */
export function sessionAt(afternoonEnabled: boolean, timeZone: string = DEFAULT_SCHOOL_TIME_ZONE, now: Date = new Date()): AttendanceSession {
  return afternoonEnabled && schoolClock(timeZone, now) >= AFTERNOON_STARTS ? "afternoon" : "morning";
}

/** The sessions a teacher can open today: the afternoon only while the school takes it. */
export function sessionsOffered(settings: AttendanceSettings): AttendanceSession[] {
  return settings.afternoon_enabled ? ["morning", "afternoon"] : ["morning"];
}

/** A school's attendance settings; the defaults when it has none or the read fails (the apps must still open a register). */
export async function fetchAttendanceSettings(tenantId: string): Promise<AttendanceSettings> {
  const { data, error } = await supabase()
    .from("attendance_settings").select("afternoon_enabled, percentage_mode").eq("tenant_id", tenantId)
    .maybeSingle<AttendanceSettings>();
  if (error || !data) return { ...DEFAULT_ATTENDANCE_SETTINGS };
  return { afternoon_enabled: !!data.afternoon_enabled, percentage_mode: data.percentage_mode === "day" ? "day" : "session" };
}

/** The signed-in person's own school's settings (a parent or learner: the read rule only shows their school's row). */
export async function fetchMyAttendanceSettings(): Promise<AttendanceSettings> {
  const { data, error } = await supabase()
    .from("attendance_settings").select("afternoon_enabled, percentage_mode").limit(1).maybeSingle<AttendanceSettings>();
  if (error || !data) return { ...DEFAULT_ATTENDANCE_SETTINGS };
  return { afternoon_enabled: !!data.afternoon_enabled, percentage_mode: data.percentage_mode === "day" ? "day" : "session" };
}

/**
 * Saves them and returns what the database now holds. The database lets the attendance area and full admins do this, nobody else.
 * It resolves only when the stored row reads back exactly as asked: a refusal, or a write that left no matching row, throws, so a
 * screen never reports "saved" for settings that are not in the database.
 */
export async function saveAttendanceSettings(tenantId: string, settings: AttendanceSettings): Promise<AttendanceSettings> {
  const { data, error } = await supabase()
    .from("attendance_settings")
    .upsert({ tenant_id: tenantId, afternoon_enabled: settings.afternoon_enabled, percentage_mode: settings.percentage_mode }, { onConflict: "tenant_id" })
    .select("afternoon_enabled, percentage_mode")
    .maybeSingle<AttendanceSettings>();
  if (error) throw new Error(error.message);
  if (!data || data.afternoon_enabled !== settings.afternoon_enabled || data.percentage_mode !== settings.percentage_mode) {
    throw new Error("The settings were not saved. Reload the page and try again.");
  }
  return { afternoon_enabled: data.afternoon_enabled, percentage_mode: data.percentage_mode };
}

// ---------------------------------------------------------------- counting (decisions D, J, K)

/** One register entry, from either register. */
export interface SessionEntry {
  student_id: string;
  taken_on: string;
  session: AttendanceSession;
  mark: AttendanceMark;
  class_id?: string | null;
}

/** An early sign-out, as much of it as counting needs. */
export interface SignOutDay {
  student_id: string;
  taken_on: string;
  voided_at: string | null;
}

/** A counted unit: one entry (by session) or one learner-day (by day). */
export interface AttendanceUnit {
  student_id: string;
  taken_on: string;
  class_id: string | null;
  here: boolean;
}

const isHere = (m: AttendanceMark) => m === "present" || m === "late";

/**
 * What counts, in the school's mode:
 *   - a session is an opportunity on a date only if there is an entry for it;
 *   - an afternoon absent or excused entry of a learner with a live early sign-out that day is left out (leaving early is not an
 *     absence), from the top and the bottom of the figure;
 *   - 'session': each remaining entry is a unit; 'day': each learner-date is one unit, here if here in any session.
 * The SQL twin is attendance_counted().
 */
export function countAttendance(entries: SessionEntry[], mode: PercentageMode, signOuts: SignOutDay[] = []): AttendanceUnit[] {
  const leftEarly = new Set(signOuts.filter((s) => !s.voided_at).map((s) => `${s.student_id}|${s.taken_on}`));
  const kept = entries.filter((e) => !(e.session === "afternoon" && (e.mark === "absent" || e.mark === "excused")
    && leftEarly.has(`${e.student_id}|${e.taken_on}`)));
  if (mode === "session") {
    return kept.map((e) => ({ student_id: e.student_id, taken_on: e.taken_on, class_id: e.class_id ?? null, here: isHere(e.mark) }));
  }
  const days = new Map<string, AttendanceUnit & { fromMorning: boolean }>();
  for (const e of kept) {
    const key = `${e.student_id}|${e.taken_on}`;
    const d = days.get(key);
    if (!d) {
      days.set(key, { student_id: e.student_id, taken_on: e.taken_on, class_id: e.class_id ?? null, here: isHere(e.mark), fromMorning: e.session === "morning" });
    } else {
      d.here = d.here || isHere(e.mark);
      if (e.session === "morning" && !d.fromMorning) { d.class_id = e.class_id ?? null; d.fromMorning = true; }
    }
  }
  return [...days.values()].map(({ fromMorning: _f, ...u }) => u);
}

/** Here and total over counted units, and the rounded percentage (null when there is nothing to count). */
export function attendanceFigures(units: AttendanceUnit[]): { here: number; total: number; pct: number | null } {
  const here = units.filter((u) => u.here).length;
  return { here, total: units.length, pct: units.length ? Math.round((here / units.length) * 100) : null };
}

/** Learners present (or late) in the morning and absent in the afternoon of a date, leaving out live early sign-outs. */
export function presentAmMissingPm(entries: SessionEntry[], signOuts: SignOutDay[] = []): { student_id: string; taken_on: string }[] {
  const leftEarly = new Set(signOuts.filter((s) => !s.voided_at).map((s) => `${s.student_id}|${s.taken_on}`));
  const am = new Set(entries.filter((e) => e.session === "morning" && isHere(e.mark)).map((e) => `${e.student_id}|${e.taken_on}`));
  return entries
    .filter((e) => e.session === "afternoon" && e.mark === "absent")
    .map((e) => `${e.student_id}|${e.taken_on}`)
    .filter((k) => am.has(k) && !leftEarly.has(k))
    .map((k) => { const [student_id, taken_on] = k.split("|") as [string, string]; return { student_id, taken_on }; });
}

// ---------------------------------------------------------------- reading both registers

export interface EntryFilter {
  studentIds?: string[];
  classId?: string;
  termId?: string;
  tenantId?: string;
  from?: string;
  to?: string;
}

/**
 * Entries from both registers with the same filter, tagged with their session. Pages through each table (1,000-row cap). An afternoon
 * read that fails (say, an older database) gives none, so morning figures still show.
 */
export async function fetchSessionEntries(f: EntryFilter): Promise<SessionEntry[]> {
  const read = async (session: AttendanceSession): Promise<SessionEntry[]> => {
    const out: SessionEntry[] = [];
    for (let from = 0; ; from += 1000) {
      let q = supabase().from(REGISTER_TABLE[session]).select("student_id, taken_on, mark, class_id");
      if (f.studentIds) q = q.in("student_id", f.studentIds);
      if (f.classId) q = q.eq("class_id", f.classId);
      if (f.termId) q = q.eq("term_id", f.termId);
      if (f.tenantId) q = q.eq("tenant_id", f.tenantId);
      if (f.from) q = q.gte("taken_on", f.from);
      if (f.to) q = q.lte("taken_on", f.to);
      const { data, error } = await q.order("taken_on").order("student_id").range(from, from + 999)
        .returns<{ student_id: string; taken_on: string; mark: AttendanceMark; class_id: string | null }[]>();
      if (error) throw new Error(error.message);
      for (const r of data ?? []) out.push({ ...r, session });
      if (!data || data.length < 1000) break;
    }
    return out;
  };
  if (f.studentIds && f.studentIds.length === 0) return [];
  const [am, pm] = await Promise.all([read("morning"), read("afternoon").catch(() => [] as SessionEntry[])]);
  return [...am, ...pm];
}

/** Early sign-outs (live and voided) for the same learners and dates, for counting. A failed read gives none. */
export async function fetchSignOutDays(f: Pick<EntryFilter, "studentIds" | "tenantId" | "from" | "to">): Promise<SignOutDay[]> {
  if (f.studentIds && f.studentIds.length === 0) return [];
  let q = supabase().from("early_sign_outs").select("student_id, taken_on, voided_at");
  if (f.studentIds) q = q.in("student_id", f.studentIds);
  if (f.tenantId) q = q.eq("tenant_id", f.tenantId);
  if (f.from) q = q.gte("taken_on", f.from);
  if (f.to) q = q.lte("taken_on", f.to);
  const { data, error } = await q.returns<SignOutDay[]>();
  if (error) return [];
  return data ?? [];
}
