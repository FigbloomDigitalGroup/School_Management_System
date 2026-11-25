import type { ClassLevel, Weekday } from "../types";
import type { InventoryIssueRow } from "../inventory";
import type { NoticeInfo, StudentData, WorkItem } from "../studentData";
import type { TimetableRow } from "../timetable";
import { apiClient } from "./client";
import { apiFetchLearnerInventory, apiFetchChildResults, apiFetchParentMessages, familyTenantId, groupExams, levelOfChildClass } from "./parentApi";
import { apiFetchOwnLearner, isNoLearnerError } from "./ownLearner";
import type { components } from "./schema";
import { UNNAMED_PERIOD, weekdayFromApi } from "./timetableApi";

/**
 * What a learner reads about themselves on apps/api: the API side of studentData.ts, timetable.ts and inventory.ts for the student
 * pages (docs/web-on-api/student-pages.md). A learner signed in with a student account reads the same `/me/children/{learnerId}/...`
 * paths a parent does, with their own learner id from `GET /me/learner` (apps/api/docs/STUDENT-ACCOUNTS.md); nothing here asks the
 * server about any other learner, and a login with no live learner behind it is a 404 that the pages show as "No learner record".
 *
 * Differences from Supabase, handled here rather than in the screens (the family-read ones are the parent's, parentApi.ts):
 *  - The API records no hand-in or done state for homework, so a piece of work is never "done" or "late" here: the work is listed by
 *    its due date and the screens (studentCapabilities().homeworkDone) do not claim to know what was handed in.
 *  - A piece of work has no teacher name and no hand-in method on the family read (finding parent-5).
 *  - Notices carry the audience, not the author: a class notice is "Class teacher", every other one "School office".
 */

type FamilyHomework = components["schemas"]["FamilyHomework"];
type FamilyTimetable = components["schemas"]["FamilyTimetable"];

export function workItemFromFamily(h: FamilyHomework): WorkItem {
  return { id: h.id, title: h.title, subject: h.subject.name, teacher: "", dueOn: h.due_on, state: "open", how: "", body: h.body, needs: [], minutes: null, hasFile: false };
}

/** Homework of the learner's class due in the last three weeks or later (the API's default window), soonest first. */
export async function apiFetchOwnHomework(learnerId: string): Promise<WorkItem[]> {
  const tenantId = familyTenantId();
  const res = await apiClient().get("/v1/tenants/{tenantId}/me/children/{learnerId}/homework", { path: { tenantId, learnerId }, tenantId });
  return res.homework.map(workItemFromFamily).sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.title.localeCompare(b.title));
}

/** The notices that reach this learner (their class, year group, the whole school, or them by name), newest first. */
export async function apiFetchOwnNotices(): Promise<NoticeInfo[]> {
  const messages = await apiFetchParentMessages(familyTenantId());
  return messages.map((m): NoticeInfo => ({ id: m.id, subject: m.subject, from: m.from, when: m.when, unread: m.unread, body: m.body }));
}

/** Everything the learner's own pages need, once: the record, their class, work, notices and the marks they have out. Null for a login with no live learner. */
export async function apiLoadStudentData(): Promise<StudentData | null> {
  let learner;
  try {
    learner = await apiFetchOwnLearner(true);
  } catch (err) {
    if (isNoLearnerError(err)) return null;
    throw err;
  }
  const id = learner.learner_id;
  const [work, results, notices] = await Promise.all([apiFetchOwnHomework(id), apiFetchChildResults(id), apiFetchOwnNotices()]);

  const exams = groupExams(results.marks);
  const subjects = exams[0]?.subjects ?? [];
  const level: ClassLevel | null = learner.class ? levelOfChildClass(learner.class, { cbe: results.cbe_results.length > 0, marks: results.marks.length > 0 }) : null;
  return {
    studentId: id,
    classId: learner.class?.id ?? null,
    classLevel: level,
    className: learner.class?.name ?? "",
    work,
    notices,
    subjects,
    examId: exams[0]?.exam.id ?? null,
    examName: exams[0]?.exam.name ?? null,
    exams: exams.map((g) => g.exam),
  };
}

// ---------------------------------------------------------------- timetable

const emptyWeek = (): Record<Weekday, TimetableRow[]> => ({ Mon: [], Tue: [], Wed: [], Thu: [], Fri: [] });

/**
 * The newest PUBLISHED timetable of the learner's class as the screens read it (day -> rows of [start, subject, room, teacher]).
 * Saturday and Sunday periods are left out, as everywhere (the screens' week is Monday to Friday). A class with no published
 * timetable is an empty week. The week's rows are named by their subject: the API's period has no free-text label.
 */
export function weekFromFamilyTimetable(t: FamilyTimetable | null): Record<Weekday, TimetableRow[]> {
  const week = emptyWeek();
  if (!t) return week;
  for (const s of t.slots) {
    const day = weekdayFromApi(s.day_of_week);
    if (day) week[day].push([s.starts_at, s.subject.name ?? UNNAMED_PERIOD, s.room ?? "", s.teacher_name]);
  }
  for (const rows of Object.values(week)) rows.sort((a, b) => a[0].localeCompare(b[0]));
  return week;
}

export async function apiFetchOwnTimetable(): Promise<Record<Weekday, TimetableRow[]>> {
  const tenantId = familyTenantId();
  const learner = await apiFetchOwnLearner();
  const res = await apiClient().get("/v1/tenants/{tenantId}/me/children/{learnerId}/timetable", { path: { tenantId, learnerId: learner.learner_id }, tenantId });
  return weekFromFamilyTimetable(res.timetable);
}

// ---------------------------------------------------------------- issued items

export async function apiFetchOwnLearnerInventory(): Promise<InventoryIssueRow[]> {
  const learner = await apiFetchOwnLearner();
  return apiFetchLearnerInventory([learner.learner_id]);
}
