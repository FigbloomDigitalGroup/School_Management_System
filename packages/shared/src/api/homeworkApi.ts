import { cleanGuide, normaliseGuide, type HomeworkInput, type HomeworkRow } from "../homework";
import { newIdempotencyKey } from "../queue";
import type { Subject } from "../types";
import { apiFetchCurrentTerm, apiFetchTeacherClasses } from "./attendanceApi";
import { apiClient } from "./client";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import type { components } from "./schema";
import { listApiSubjects, subjectFromApi } from "./setupApi";
import { apiListTeachingAssignments, apiMyStaffId, whenRefused } from "./teachingLookups";

/**
 * Teacher homework on apps/api: the API side of `homework.ts`.
 *
 * Differences from Supabase, handled here rather than in the screens:
 *  - `GET/POST /v1/tenants/{tenantId}/homework-items` require `resource.academics.read` / `resource.academics.write`
 *    (school_admin or holders of the Academics area).
 *  - `POST /homework-items` requires `term_id` (resolved from the current academic term) and uses strict validation
 *    (`z.strictObject`).
 *  - Homework can be edited and archived; the archive route never deletes the record.
 *  - Submission counts and attachments remain unavailable on the API build.
 */

type ApiHomework = components["schemas"]["Homework"];

const TITLE_MAX = 160;
const BODY_MAX = 8000;

function tenantIdOrThrow(tenantId?: string): string {
  const id = tenantId ?? apiClient().activeTenant();
  if (!id) throw new Error("No active school selected.");
  return id;
}

function mapHomework(
  h: ApiHomework,
  classById: ReadonlyMap<string, string>,
  subjectById: ReadonlyMap<string, string>,
): HomeworkRow {
  return {
    id: h.id,
    classId: h.class_id,
    subjectId: h.subject_id,
    title: h.title,
    body: h.body,
    dueOn: h.due_on,
    handIn: h.hand_in,
    className: classById.get(h.class_id) ?? "—",
    subjectName: subjectById.get(h.subject_id) ?? "—",
    handedIn: 0,
    guide: normaliseGuide(h.parent_guide),
  };
}

/** Homework set for the classes this teacher teaches or leads, newest due date first. */
export async function apiFetchMyHomework(teacherId: string, tenantId?: string): Promise<HomeworkRow[]> {
  const tid = tenantIdOrThrow(tenantId);
  const teacherClasses = await apiFetchTeacherClasses(teacherId, tid);
  if (teacherClasses.length === 0) return [];

  const [items, subjects] = await Promise.all([
    listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/homework-items", {
        path: { tenantId: tid },
        query: { limit: API_PAGE_LIMIT, cursor },
        tenantId: tid,
      });
      return { items: r.homework, page: r.page };
    }),
    listApiSubjects(tid).catch(whenRefused([])),
  ]);

  const classById = new Map(teacherClasses.map((c) => [c.id, c.name]));
  const subjectById = new Map(subjects.map((s) => [s.id, s.name]));

  return items
    .filter((h) => classById.has(h.class_id))
    .sort((a, b) => b.due_on.localeCompare(a.due_on) || b.created_at.localeCompare(a.created_at))
    .map((h) => mapHomework(h, classById, subjectById));
}

/** Creates a homework item for the active term on apps/api and returns its id. */
export async function apiCreateHomework(tenantId: string, input: HomeworkInput): Promise<string> {
  if (!input.classId) throw new Error("Pick the class.");
  if (!input.subjectId) throw new Error("Pick the subject.");

  const title = input.title.trim().replace(/\s+/g, " ");
  if (!title) throw new Error("Give the homework a title, e.g. Exercise 4.2, page 61.");
  if (title.length > TITLE_MAX) throw new Error(`Keep the title to ${TITLE_MAX} characters or fewer.`);

  const body = input.body.trim();
  if (body.length > BODY_MAX) throw new Error(`Keep the instructions to ${BODY_MAX} characters or fewer.`);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueOn) || Number.isNaN(Date.parse(input.dueOn))) {
    throw new Error("Pick a due date.");
  }

  const term = await apiFetchCurrentTerm(tenantId);
  if (!term) throw new Error("Start a term in School settings before setting homework.");

  const res = await apiClient().post("/v1/tenants/{tenantId}/homework-items", {
    path: { tenantId },
    body: {
      class_id: input.classId,
      subject_id: input.subjectId,
      term_id: term.id,
      title,
      due_on: input.dueOn,
      body,
      hand_in: input.handIn,
      ...(input.guide !== undefined ? { parent_guide: input.guide ? cleanGuide(input.guide) : null } : {}),
    },
    tenantId,
  });
  return res.homework.id;
}

/** Updates the editable fields of an existing homework item on apps/api. */
export async function apiUpdateHomework(id: string, input: HomeworkInput): Promise<void> {
  const tenantId = tenantIdOrThrow();
  const body = input.body.trim();
  if (body.length > BODY_MAX) throw new Error(`Keep the instructions to ${BODY_MAX} characters or fewer.`);

  await apiClient().patch("/v1/tenants/{tenantId}/homework-items/{homeworkId}", {
    path: { tenantId, homeworkId: id },
    body: {
      class_id: input.classId,
      subject_id: input.subjectId,
      title: input.title.trim().replace(/\s+/g, " "),
      due_on: input.dueOn,
      body,
      hand_in: input.handIn,
      ...(input.guide !== undefined ? { parent_guide: input.guide ? cleanGuide(input.guide) : null } : {}),
    },
    tenantId,
  });
}

/** Archives homework on apps/api; the record remains available to the school's audit history. */
export async function apiArchiveHomework(id: string): Promise<void> {
  const tenantId = tenantIdOrThrow();
  await apiClient().post("/v1/tenants/{tenantId}/homework-items/{homeworkId}/archive", {
    path: { tenantId, homeworkId: id },
    tenantId,
    idempotencyKey: newIdempotencyKey(),
  });
}

/**
 * Subjects the signed-in teacher teaches in one class, using `GET /staff/me` + `GET /teaching-assignments` +
 * `GET /subjects` so an Academics-area teacher does not need `resource.staff.read`.
 */
export async function apiFetchHomeworkSubjectsForClass(classId: string, tenantId?: string): Promise<Subject[]> {
  const tid = tenantIdOrThrow(tenantId);
  const myStaffId = await apiMyStaffId(tid);
  if (!myStaffId) return [];

  const [assignments, subjects] = await Promise.all([
    apiListTeachingAssignments(tid, classId).catch(whenRefused([])),
    listApiSubjects(tid).catch(whenRefused([])),
  ]);

  const subjectIds = new Set(
    assignments
      .filter((a) => a.class_id === classId && a.staff_member_id === myStaffId && a.active)
      .map((a) => a.subject_id),
  );
  return subjects
    .filter((s) => subjectIds.has(s.id))
    .map((s) => subjectFromApi(s, tid))
    .sort((a, b) => a.name.localeCompare(b.name));
}
