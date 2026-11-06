import type { AttendanceMark, AttendanceRecord } from "./types";

/**
 * The attendance flow is the one that has to be under 60 seconds.
 * Default everyone present, mark the exceptions, submit once.
 */

export const DEFAULT_MARK: AttendanceMark = "present";

export const MARK_CYCLE: AttendanceMark[] = ["present", "absent", "late"];

export function nextMark(current: AttendanceMark): AttendanceMark {
  const i = MARK_CYCLE.indexOf(current);
  return MARK_CYCLE[(i + 1) % MARK_CYCLE.length]!;
}

export const MARK_LABEL: Record<AttendanceMark, string> = {
  present: "Present", absent: "Absent", late: "Late", excused: "Excused",
};

export const MARK_SHORT: Record<AttendanceMark, string> = {
  present: "P", absent: "A", late: "L", excused: "E",
};

export const MARK_STYLE: Record<AttendanceMark, { bg: string; ink: string }> = {
  present: { bg: "#E3EFE7", ink: "#1B4D2E" },
  absent: { bg: "#FDEBDF", ink: "#B8460A" },
  late: { bg: "#FDF1E8", ink: "#8A3D08" },
  excused: { bg: "#EEF1EE", ink: "#5F6B62" },
};

export interface Register {
  classId: string;
  termId: string;
  date: string;
  marks: Record<string, AttendanceMark>;   // studentId -> mark
  notes: Record<string, string>;
}

export function newRegister(classId: string, termId: string, studentIds: string[], date = today()): Register {
  const marks: Record<string, AttendanceMark> = {};
  for (const id of studentIds) marks[id] = DEFAULT_MARK;
  return { classId, termId, date, marks, notes: {} };
}

export function tally(r: Register): { present: number; absent: number; late: number; excused: number; total: number } {
  const t = { present: 0, absent: 0, late: 0, excused: 0, total: 0 };
  for (const m of Object.values(r.marks)) { t[m] += 1; t.total += 1; }
  return t;
}

/** Submitting an all-present register is legitimate, but worth one confirmation. */
export function submitWarning(r: Register): string | null {
  const t = tally(r);
  if (t.total === 0) return "There is nobody on this roster yet.";
  if (t.absent === 0 && t.late === 0) return `Marking all ${t.total} learners present. Correct?`;
  return null;
}

/**
 * The rows to save for a register. `markedAt` is when the teacher took it (now, unless a caller says otherwise): the database
 * keeps the NEWEST register for a learner and day by this time, not by which one arrives last, so a register held on a phone
 * with no signal cannot overwrite a correction made meanwhile (FIG-1410).
 */
export function toRecords(r: Register, tenantId: string, takenBy: string, markedAt: string = new Date().toISOString()): Omit<AttendanceRecord, "id">[] {
  return Object.entries(r.marks).map(([student_id, mark]) => ({
    tenant_id: tenantId,
    student_id,
    class_id: r.classId,
    term_id: r.termId,
    taken_by: takenBy,
    taken_on: r.date,
    mark,
    note: r.notes[student_id] ?? null,
    marked_at: markedAt,
  }));
}

/** The time zone of a school unless it says otherwise (tenants.timezone has the same default): every school so far is in Kenya. */
export const DEFAULT_SCHOOL_TIME_ZONE = "Africa/Nairobi";
/** Nairobi has no daylight saving: UTC+3 all year. Used when the device cannot name a time zone. */
const NAIROBI_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Today's date in the school's own time zone, as YYYY-MM-DD (FIG-1400). It used to be the UTC date of the phone's clock, so from
 * 00:00 to 02:59 in Nairobi a register was filed under yesterday, over the top of yesterday's real one. A device that cannot
 * format a date in a named time zone falls back to Nairobi's fixed UTC+3; the database also refuses a date in the future.
 */
export function today(timeZone: string = DEFAULT_SCHOOL_TIME_ZONE, now: Date = new Date()): string {
  try {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  } catch {
    // This device has no time-zone support (or does not know the name): use the fixed offset below.
  }
  return new Date(now.getTime() + NAIROBI_OFFSET_MS).toISOString().slice(0, 10);
}

export function attendanceRate(records: Pick<AttendanceRecord, "mark">[]): number | null {
  if (!records.length) return null;
  const here = records.filter((r) => r.mark === "present" || r.mark === "late").length;
  return Math.round((here / records.length) * 100);
}
