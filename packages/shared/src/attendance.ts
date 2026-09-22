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

export function toRecords(r: Register, tenantId: string, takenBy: string): Omit<AttendanceRecord, "id">[] {
  return Object.entries(r.marks).map(([student_id, mark]) => ({
    tenant_id: tenantId,
    student_id,
    class_id: r.classId,
    term_id: r.termId,
    taken_by: takenBy,
    taken_on: r.date,
    mark,
    note: r.notes[student_id] ?? null,
  }));
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function attendanceRate(records: Pick<AttendanceRecord, "mark">[]): number | null {
  if (!records.length) return null;
  const here = records.filter((r) => r.mark === "present" || r.mark === "late").length;
  return Math.round((here / records.length) * 100);
}
