import type { TeacherTimetableRow } from "../teacherData";
import type { Weekday } from "../types";
import { apiClient } from "./client";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import type { components } from "./schema";
import { apiListTeachingAssignments, apiMyStaffId, apiStaffNames, apiSubjectNames } from "./teachingLookups";

/**
 * Class timetables on apps/api (the API side of timetable.ts and fetchTeacherClassTimetable in teacherData.ts).
 *
 * The API's timetable is not Supabase's, and the differences are handled here, not in the screens:
 *  - A slot is a SUBJECT's period with a start and an end time and a day number (1 Monday ... 7 Sunday). It has no free-text
 *    label, so a period is named by its subject; "Games", "Library" or "Break" cannot be a period unless the school makes them
 *    subjects. Saturday and Sunday slots are not shown (the screens' week is Monday to Friday).
 *  - Who teaches a period is the teaching assignment of that subject in that class (the slot's own link when it has one).
 *  - Slots can be made and listed, not changed or removed.
 */

type ApiSlot = components["schemas"]["TimetableSlot"];
type TeachingAssignment = components["schemas"]["TeachingAssignment"];

const DAYS: readonly Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri"];

/** 1 (Monday) to 5 (Friday) as a weekday; Saturday, Sunday and anything else as null. */
export function weekdayFromApi(dayOfWeek: number): Weekday | null {
  return DAYS[dayOfWeek - 1] ?? null;
}

/** A time as the screens show it: "08:00:00" and "08:00" are both "08:00". */
export function hhmm(time: string): string {
  return time.slice(0, 5);
}

function tenantIdOrThrow(tenantId?: string): string {
  const id = tenantId ?? apiClient().activeTenant();
  if (!id) throw new Error("No active school selected.");
  return id;
}

async function listSlots(tenantId: string, classId: string): Promise<ApiSlot[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/timetable-slots", {
      path: { tenantId }, query: { classId, active: true, limit: API_PAGE_LIMIT, cursor }, tenantId,
    });
    return { items: r.slots, page: r.page };
  });
}

/** The teaching assignment behind a slot: the one it is linked to, else the one for its subject in its class. */
function assignmentOf(slot: ApiSlot, assignments: TeachingAssignment[]): TeachingAssignment | undefined {
  const linked = slot.teaching_assignment_id ? assignments.find((a) => a.id === slot.teaching_assignment_id) : undefined;
  return linked ?? assignments.find((a) => a.subject_id === slot.subject_id && a.class_id === slot.class_id);
}

const emptyWeek = <T>(): Record<Weekday, T[]> => ({ Mon: [], Tue: [], Wed: [], Thu: [], Fri: [] });

/** The label of a period whose subject the person may not read the name of. */
export const UNNAMED_PERIOD = "Lesson";

// ---------------------------------------------------------------- a teacher's view

/**
 * A class's timetable for one teacher, the same rule as on Supabase: a subject teacher sees only their own periods; the class
 * teacher sees the whole week, each period saying whose it is. "Mine" is found through the person's own staff id
 * (`GET .../staff/me`); a person with no staff record has no periods of their own. A colleague's name needs the staff list: a
 * plain teacher cannot read it, so their view of other teachers' periods has no name.
 */
export async function apiFetchTeacherClassTimetable(
  classId: string, _teacherUserId: string, tenantId?: string,
): Promise<{ byDay: Record<Weekday, TeacherTimetableRow[]>; isClassTeacher: boolean }> {
  const tid = tenantIdOrThrow(tenantId);
  const [slots, cls, assignments, subjectNames, staffNames, myStaffId] = await Promise.all([
    listSlots(tid, classId),
    apiClient().get("/v1/tenants/{tenantId}/classes/{classId}", { path: { tenantId: tid, classId }, tenantId: tid }),
    apiListTeachingAssignments(tid, classId),
    apiSubjectNames(tid),
    apiStaffNames(tid),
    apiMyStaffId(tid),
  ]);
  const isClassTeacher = !!myStaffId && cls.school_class.class_teacher_staff_id === myStaffId;

  const byDay = emptyWeek<TeacherTimetableRow>();
  for (const s of slots) {
    const day = weekdayFromApi(s.day_of_week);
    if (!day) continue;
    const teacherId = assignmentOf(s, assignments)?.staff_member_id ?? null;
    const mine = !!myStaffId && teacherId === myStaffId;
    if (!isClassTeacher && !mine) continue;
    byDay[day].push({
      time: hhmm(s.starts_at), label: subjectNames.get(s.subject_id) ?? UNNAMED_PERIOD, room: s.room ?? "",
      subjectId: s.subject_id, teacherId, teacherName: teacherId ? staffNames.get(teacherId) ?? null : null, mine,
    });
  }
  for (const d of DAYS) byDay[d].sort((a, b) => a.time.localeCompare(b.time));
  return { byDay, isClassTeacher };
}

// ---------------------------------------------------------------- an administrator's view

export interface ClassPeriod {
  id: string;
  day: Weekday;
  startsAt: string;
  endsAt: string;
  subjectId: string;
  subjectName: string;
  teacherName: string | null;
  room: string | null;
}

/** A class's periods, Monday to Friday, in time order: the list the class's Timetable window shows. */
export async function apiFetchClassPeriods(classId: string, tenantId?: string): Promise<ClassPeriod[]> {
  const tid = tenantIdOrThrow(tenantId);
  const [slots, assignments, subjectNames, staffNames] = await Promise.all([
    listSlots(tid, classId), apiListTeachingAssignments(tid, classId), apiSubjectNames(tid), apiStaffNames(tid),
  ]);
  const out: ClassPeriod[] = [];
  for (const s of slots) {
    const day = weekdayFromApi(s.day_of_week);
    if (!day) continue;
    const teacherId = assignmentOf(s, assignments)?.staff_member_id ?? null;
    out.push({
      id: s.id, day, startsAt: hhmm(s.starts_at), endsAt: hhmm(s.ends_at),
      subjectId: s.subject_id, subjectName: subjectNames.get(s.subject_id) ?? UNNAMED_PERIOD,
      teacherName: teacherId ? staffNames.get(teacherId) ?? null : null, room: s.room,
    });
  }
  return out.sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.startsAt.localeCompare(b.startsAt));
}

export interface NewClassPeriod {
  classId: string;
  day: Weekday;
  startsAt: string;
  endsAt: string;
  subjectId: string;
  room: string | null;
}

/**
 * Adds one period. When the subject already has a teacher in this class the period is linked to that teaching assignment (the
 * API accepts a link only to the active assignment for the same class and subject). The API refuses a period that overlaps
 * another of the class on the same day (409); that answer is passed on.
 */
export async function apiAddClassPeriod(p: NewClassPeriod, tenantId?: string): Promise<void> {
  const tid = tenantIdOrThrow(tenantId);
  const assignment = (await apiListTeachingAssignments(tid, p.classId)).find((a) => a.subject_id === p.subjectId);
  await apiClient().post("/v1/tenants/{tenantId}/timetable-slots", {
    path: { tenantId: tid }, tenantId: tid,
    body: {
      class_id: p.classId, subject_id: p.subjectId, teaching_assignment_id: assignment?.id ?? null,
      day_of_week: DAYS.indexOf(p.day) + 1, starts_at: p.startsAt, ends_at: p.endsAt, room: p.room?.trim() ? p.room.trim() : null,
    },
  });
}
