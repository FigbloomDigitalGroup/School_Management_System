import { today, type Register } from "../attendance";
import { DEFAULT_ATTENDANCE_SETTINGS, type AttendanceSession, type AttendanceSettings, type EntryFilter, type SessionEntry, type SignOutDay } from "../attendanceSession";
import type { EarlySignOut, EarlySignOutCollector, EarlySignOutDraft } from "../earlySignOut";
import { WriteError } from "../queue";
import type { ClassProgress } from "../teacherData";
import type { AttendanceMark, ClassGroup, Student, Term } from "../types";
import { apiClient } from "./client";
import { isApiError } from "./errors";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import { settlePool } from "./pool";
import type { components } from "./schema";
import { classGroupFromApi, currentAcademicYear, listAcademicTerms, listAcademicYears, listClasses, termFromApi } from "./setupApi";

/**
 * Attendance on apps/api (FIG-1891): the API side of attendanceSession.ts, earlySignOut.ts, and the attendance
 * functions in teacherData.ts.
 *
 * Differences from Supabase, handled here rather than in the screens:
 *  - The API writes registers one learner per request until A4 adds a bulk write; we fan out with settlePool at
 *    concurrency 4 (max 4 requests in flight, per FIG-1891) and classify network/5xx errors as retryable WriteErrors.
 *  - Early sign-outs return `{ sign_out, collector }` together on list/get; `collector` is null for callers without
 *    `resource.early_sign_out.collector.read`.
 *  - `learner_id` / `learner_name` / `tenantId` are mapped to the shared `student_id` / `student_name` / `tenant_id`.
 */

type ApiRegister = components["schemas"]["AttendanceRegister"];
type ApiEarlySignOut = components["schemas"]["EarlySignOut"];
type ApiEarlySignOutRecord = components["schemas"]["EarlySignOutRecord"];

/** Max concurrent register POSTs while writing a class register (FIG-1891). */
export const ATTENDANCE_WRITE_CONCURRENCY = 4;

function tenantIdOrThrow(tenantId?: string): string {
  const id = tenantId ?? apiClient().activeTenant();
  if (!id) throw new Error("No active school selected.");
  return id;
}

export function earlySignOutFromApi(s: ApiEarlySignOut): EarlySignOut {
  return {
    id: s.id,
    tenant_id: s.tenantId,
    student_id: s.learner_id,
    class_id: s.class_id,
    student_name: s.learner_name,
    class_name: s.class_name,
    taken_on: s.taken_on,
    signed_out_at: s.signed_out_at,
    signed_out_local: s.signed_out_local,
    reason: s.reason,
    collected_by_name: s.collected_by_name,
    collected_by_relationship: s.collected_by_relationship,
    recorded_by: s.recorded_by,
    recorded_at: s.signed_out_at,
    voided_at: s.voided_at,
  };
}

// ---------------------------------------------------------------- attendance settings

export async function apiFetchAttendanceSettings(tenantId: string): Promise<AttendanceSettings> {
  try {
    const res = await apiClient().get("/v1/tenants/{tenantId}/attendance-settings", {
      path: { tenantId },
      tenantId,
    });
    return {
      afternoon_enabled: !!res.settings.afternoon_enabled,
      percentage_mode: res.settings.percentage_mode === "day" ? "day" : "session",
    };
  } catch {
    return { ...DEFAULT_ATTENDANCE_SETTINGS };
  }
}

export async function apiFetchMyAttendanceSettings(): Promise<AttendanceSettings> {
  const tid = apiClient().activeTenant();
  if (!tid) return { ...DEFAULT_ATTENDANCE_SETTINGS };
  return apiFetchAttendanceSettings(tid);
}

export async function apiSaveAttendanceSettings(tenantId: string, settings: AttendanceSettings): Promise<AttendanceSettings> {
  const res = await apiClient().put("/v1/tenants/{tenantId}/attendance-settings", {
    path: { tenantId },
    body: { afternoon_enabled: settings.afternoon_enabled, percentage_mode: settings.percentage_mode },
    tenantId,
  });
  return {
    afternoon_enabled: !!res.settings.afternoon_enabled,
    percentage_mode: res.settings.percentage_mode === "day" ? "day" : "session",
  };
}

// ---------------------------------------------------------------- reading & writing registers

async function listRegisters(
  tenantId: string,
  query: { classId?: string; takenOn?: string; session?: AttendanceSession },
): Promise<ApiRegister[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/attendance-registers", {
      path: { tenantId },
      query: { ...query, limit: API_PAGE_LIMIT, cursor },
      tenantId,
    });
    return { items: r.registers, page: r.page };
  });
}

export async function apiFetchSessionEntries(f: EntryFilter): Promise<SessionEntry[]> {
  if (f.studentIds && f.studentIds.length === 0) return [];
  const tid = tenantIdOrThrow(f.tenantId);
  const takenOn = f.from && f.to && f.from === f.to ? f.from : undefined;
  const rows = await listRegisters(tid, { classId: f.classId, takenOn });
  const allowedStudents = f.studentIds ? new Set(f.studentIds) : null;

  return rows
    .filter((r) => {
      if (allowedStudents && !allowedStudents.has(r.learner_id)) return false;
      if (f.termId && r.term_id !== f.termId) return false;
      if (f.from && r.taken_on < f.from) return false;
      if (f.to && r.taken_on > f.to) return false;
      return true;
    })
    .map((r) => ({
      student_id: r.learner_id,
      taken_on: r.taken_on,
      session: r.session,
      mark: r.mark,
      class_id: r.class_id,
    }));
}

export async function apiFetchTodayAttendanceMarks(
  classId: string,
  session: AttendanceSession = "morning",
  timeZone?: string,
  tenantId?: string,
): Promise<{ student_id: string; mark: AttendanceMark }[]> {
  const tid = tenantIdOrThrow(tenantId);
  const rows = await listRegisters(tid, { classId, takenOn: today(timeZone), session });
  return rows.map((r) => ({ student_id: r.learner_id, mark: r.mark }));
}

export async function apiWriteAttendance(
  reg: Register,
  tenantId: string,
  session: AttendanceSession = "morning",
  markedAt: string = new Date().toISOString(),
): Promise<void> {
  const entries = Object.entries(reg.marks);
  if (entries.length === 0) return;

  const settled = await settlePool(entries, ATTENDANCE_WRITE_CONCURRENCY, async ([learnerId, mark]) => {
    await apiClient().post("/v1/tenants/{tenantId}/attendance-registers", {
      path: { tenantId },
      body: {
        learner_id: learnerId,
        class_id: reg.classId,
        term_id: reg.termId,
        taken_on: reg.date,
        mark,
        note: reg.notes[learnerId] ?? null,
        marked_at: markedAt,
        session,
      },
      tenantId,
    });
  });

  const failed = settled.filter((s): s is { ok: false; error: unknown } => !s.ok);
  if (failed.length === 0) return;

  const firstErr = failed[0]!.error;
  const retryable = failed.some((f) => isApiError(f.error) && (f.error.status === 0 || f.error.status >= 500 || f.error.status === 429));
  const detail = firstErr instanceof Error ? firstErr.message : "Could not save register.";
  const message =
    failed.length === entries.length
      ? detail
      : `Saved ${entries.length - failed.length} of ${entries.length} marks (${failed.length} failed: ${detail})`;
  throw new WriteError(message, retryable);
}

export async function apiFetchCurrentTerm(tenantId?: string): Promise<Term | null> {
  const tid = tenantIdOrThrow(tenantId);
  const [years, terms] = await Promise.all([listAcademicYears(tid), listAcademicTerms(tid)]);
  const current = terms.find((t) => t.is_current);
  if (!current) return null;
  const yearById = new Map(years.map((y) => [y.id, y]));
  return termFromApi(current, yearById.get(current.academic_year_id), tid);
}

// ---------------------------------------------------------------- early sign-outs

async function listSignOutRecords(tenantId: string, takenOn?: string): Promise<ApiEarlySignOutRecord[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/early-sign-outs", {
      path: { tenantId },
      query: { takenOn, limit: API_PAGE_LIMIT, cursor },
      tenantId,
    });
    return { items: r.sign_outs, page: r.page };
  });
}

export async function apiFetchSignOutDays(f: Pick<EntryFilter, "studentIds" | "tenantId" | "from" | "to">): Promise<SignOutDay[]> {
  if (f.studentIds && f.studentIds.length === 0) return [];
  const tid = f.tenantId ?? apiClient().activeTenant();
  if (!tid) return [];
  try {
    const takenOn = f.from && f.to && f.from === f.to ? f.from : undefined;
    const rows = await listSignOutRecords(tid, takenOn);
    const allowedStudents = f.studentIds ? new Set(f.studentIds) : null;
    return rows
      .map((r) => r.sign_out)
      .filter((s) => {
        if (allowedStudents && !allowedStudents.has(s.learner_id)) return false;
        if (f.from && s.taken_on < f.from) return false;
        if (f.to && s.taken_on > f.to) return false;
        return true;
      })
      .map((s) => ({ student_id: s.learner_id, taken_on: s.taken_on, voided_at: s.voided_at }));
  } catch {
    return [];
  }
}

export async function apiRecordEarlySignOut(draft: EarlySignOutDraft, tenantId?: string): Promise<string> {
  const tid = tenantIdOrThrow(tenantId);
  const res = await apiClient().post("/v1/tenants/{tenantId}/early-sign-outs", {
    path: { tenantId: tid },
    body: {
      learner_id: draft.student_id,
      reason: draft.reason.trim(),
      collected_by_name: draft.collected_by_name.trim(),
      collected_by_relationship: draft.collected_by_relationship.trim(),
      id_number: draft.collected_by_id_number.trim(),
      phone: draft.collected_by_phone.trim(),
      authorised_by: draft.authorised_by.trim(),
      note: draft.note?.trim() ? draft.note.trim() : null,
      signed_out_time: draft.signed_out_time?.trim() ? draft.signed_out_time.trim() : null,
    },
    tenantId: tid,
  });
  return res.sign_out.id;
}

export async function apiVoidEarlySignOut(id: string, reason: string, tenantId?: string): Promise<void> {
  const tid = tenantIdOrThrow(tenantId);
  await apiClient().post("/v1/tenants/{tenantId}/early-sign-outs/{signOutId}/void", {
    path: { tenantId: tid, signOutId: id },
    body: { reason: reason.trim() },
    tenantId: tid,
  });
}

export async function apiFetchEarlySignOuts(tenantId: string, day: string = today()): Promise<EarlySignOut[]> {
  const rows = await listSignOutRecords(tenantId, day);
  return rows.map((r) => earlySignOutFromApi(r.sign_out)).sort((a, b) => a.signed_out_at.localeCompare(b.signed_out_at));
}

export async function apiFetchEarlySignOutsForStudents(studentIds: string[], day: string = today(), tenantId?: string): Promise<EarlySignOut[]> {
  if (!studentIds.length) return [];
  const tid = tenantIdOrThrow(tenantId);
  const allowed = new Set(studentIds);
  const rows = await apiFetchEarlySignOuts(tid, day);
  return rows.filter((r) => allowed.has(r.student_id));
}

export async function apiFetchStudentEarlySignOuts(studentId: string, limit = 50, tenantId?: string): Promise<EarlySignOut[]> {
  const tid = tenantIdOrThrow(tenantId);
  const rows = await listSignOutRecords(tid);
  return rows
    .map((r) => earlySignOutFromApi(r.sign_out))
    .filter((r) => r.student_id === studentId)
    .sort((a, b) => b.signed_out_at.localeCompare(a.signed_out_at))
    .slice(0, limit);
}

export async function apiFetchCollectorDetails(signOutIds: string[], tenantId?: string): Promise<Map<string, EarlySignOutCollector>> {
  const out = new Map<string, EarlySignOutCollector>();
  if (!signOutIds.length) return out;
  const tid = tenantIdOrThrow(tenantId);
  const settled = await settlePool(signOutIds, ATTENDANCE_WRITE_CONCURRENCY, async (signOutId) => {
    const res = await apiClient().get("/v1/tenants/{tenantId}/early-sign-outs/{signOutId}", {
      path: { tenantId: tid, signOutId },
      tenantId: tid,
    });
    return { signOutId, collector: res.collector };
  });
  for (const s of settled) {
    if (s.ok && s.value.collector) {
      out.set(s.value.signOutId, { sign_out_id: s.value.signOutId, ...s.value.collector });
    }
  }
  return out;
}

// ---------------------------------------------------------------- teacher attendance console helpers

type ApiLearner = components["schemas"]["Learner"];

export function studentFromApiLearner(l: ApiLearner, classId: string | null): Student {
  return {
    id: l.id,
    tenant_id: l.tenantId,
    admission_no: l.admission_no,
    full_name: l.full_name,
    class_id: classId,
    date_of_birth: l.date_of_birth,
    gender: l.gender,
    boarding: l.boarding,
    active: l.active,
  };
}

/**
 * Classes a teacher may mark attendance for on the API: classes where their linked staff record
 * is the class teacher or holds an active teaching assignment. Falls back to all current-year
 * active classes when the user has no linked staff record (e.g. a school admin or a newly invited teacher).
 */
export async function apiFetchTeacherClasses(teacherUserId: string, tenantId?: string): Promise<ClassGroup[]> {
  const tid = tenantIdOrThrow(tenantId);
  const year = await currentAcademicYear(tid).catch(() => null);
  const [classes, staff, assignments] = await Promise.all([
    listClasses(tid, year?.id),
    listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/staff", {
        path: { tenantId: tid },
        query: { active: true, limit: API_PAGE_LIMIT, cursor },
        tenantId: tid,
      });
      return { items: r.staff, page: r.page };
    }).catch((err) => {
      if (isApiError(err) && err.code === "forbidden") return [];
      throw err;
    }),
    listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/teaching-assignments", {
        path: { tenantId: tid },
        query: { active: true, limit: API_PAGE_LIMIT, cursor },
        tenantId: tid,
      });
      return { items: r.assignments, page: r.page };
    }).catch((err) => {
      if (isApiError(err) && err.code === "forbidden") return [];
      throw err;
    }),
  ]);

  const myStaff = staff.find((s) => s.userId === teacherUserId);
  const filtered = myStaff
    ? (() => {
        const assignedClassIds = new Set(assignments.filter((a) => a.staff_member_id === myStaff.id).map((a) => a.class_id));
        const mine = classes.filter((c) => c.class_teacher_staff_id === myStaff.id || assignedClassIds.has(c.id));
        return mine.length > 0 ? mine : classes;
      })()
    : classes;

  return filtered.map((c) => classGroupFromApi(c, tid)).sort((a, b) => a.name.localeCompare(b.name));
}

/** Active learners currently enrolled in `classId`, sorted alphabetically by full name. */
export async function apiFetchClassRoster(classId: string, tenantId?: string): Promise<Student[]> {
  const tid = tenantIdOrThrow(tenantId);
  const [memberships, learners] = await Promise.all([
    listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/class-memberships", {
        path: { tenantId: tid },
        query: { classId, active: true, limit: API_PAGE_LIMIT, cursor },
        tenantId: tid,
      });
      return { items: r.memberships, page: r.page };
    }),
    listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/learners", {
        path: { tenantId: tid },
        query: { active: true, limit: API_PAGE_LIMIT, cursor },
        tenantId: tid,
      });
      return { items: r.learners, page: r.page };
    }),
  ]);
  const memberIds = new Set(memberships.map((m) => m.learner_id));
  return learners
    .filter((l) => l.active && memberIds.has(l.id))
    .map((l) => studentFromApiLearner(l, classId))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

/** Today's attendance progress across a teacher's classes on the API. */
export async function apiFetchTeacherClassProgress(
  classes: Pick<ClassGroup, "id" | "name">[],
  session: AttendanceSession,
  timeZone?: string,
  tenantId?: string,
): Promise<Map<string, ClassProgress>> {
  const out = new Map<string, ClassProgress>();
  if (classes.length === 0) return out;
  const tid = tenantIdOrThrow(tenantId);
  const wantedClassIds = new Set(classes.map((c) => c.id));

  const [memberships, learners, registers] = await Promise.all([
    listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/class-memberships", {
        path: { tenantId: tid },
        query: { active: true, limit: API_PAGE_LIMIT, cursor },
        tenantId: tid,
      });
      return { items: r.memberships, page: r.page };
    }),
    listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/learners", {
        path: { tenantId: tid },
        query: { active: true, limit: API_PAGE_LIMIT, cursor },
        tenantId: tid,
      });
      return { items: r.learners, page: r.page };
    }),
    listRegisters(tid, { takenOn: today(timeZone), session }),
  ]);

  const learnerNames = new Map(learners.filter((l) => l.active).map((l) => [l.id, l.full_name]));
  const totalByClass = new Map<string, number>();
  for (const m of memberships) {
    if (wantedClassIds.has(m.class_id) && learnerNames.has(m.learner_id)) {
      totalByClass.set(m.class_id, (totalByClass.get(m.class_id) ?? 0) + 1);
    }
  }
  for (const c of classes) {
    out.set(c.id, { present: 0, absent: 0, late: 0, total: totalByClass.get(c.id) ?? 0, submitted: false, submittedAt: null, away: [] });
  }

  for (const r of registers) {
    const row = out.get(r.class_id);
    if (!row) continue;
    row.submitted = true;
    if (r.marked_at && (!row.submittedAt || r.marked_at < row.submittedAt)) row.submittedAt = r.marked_at;
    if (r.mark === "present") row.present += 1;
    else if (r.mark === "absent" || r.mark === "late") {
      if (r.mark === "absent") row.absent += 1;
      else row.late += 1;
      row.away.push({ name: learnerNames.get(r.learner_id) ?? "Unknown", mark: r.mark, note: r.note ?? null });
    }
  }
  for (const row of out.values()) row.away.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
