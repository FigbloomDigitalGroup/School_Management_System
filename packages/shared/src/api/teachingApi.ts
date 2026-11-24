import type { ClassGroup } from "../types";
import type { MyClassRow } from "../teacherData";
import { apiClient } from "./client";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import { apiFetchTeacherClasses } from "./attendanceApi";
import { listActiveLearnerIds } from "./setupApi";
import { apiListTeachingAssignments, apiMyStaffId, apiSubjectNames, whenRefused } from "./teachingLookups";

function tenantIdOrThrow(tenantId?: string): string {
  const id = tenantId ?? apiClient().activeTenant();
  if (!id) throw new Error("No active school selected.");
  return id;
}

// ---------------------------------------------------------------- my classes

/** The learner count of each class: active memberships, counting only active learners when the person may read learners. */
async function learnerCounts(tenantId: string, classIds: Set<string>): Promise<Map<string, number>> {
  const [memberships, active] = await Promise.all([
    listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/class-memberships", { path: { tenantId }, query: { active: true, limit: API_PAGE_LIMIT, cursor }, tenantId });
      return { items: r.memberships, page: r.page };
    }).catch(whenRefused([])),
    listActiveLearnerIds(tenantId),
  ]);
  const counts = new Map<string, number>();
  for (const m of memberships) {
    if (!classIds.has(m.class_id)) continue;
    if (active && !active.has(m.learner_id)) continue;
    counts.set(m.class_id, (counts.get(m.class_id) ?? 0) + 1);
  }
  return counts;
}

/**
 * "My classes" on the API: each class the person teaches or leads, the subjects they teach there, and the roll size. The
 * subjects are the person's OWN teaching assignments (found through their own staff id) named from the subject list; a subject
 * whose name they may not read is left out rather than guessed.
 */
export async function apiFetchMyClasses(teacherUserId: string, tenantId?: string): Promise<MyClassRow[]> {
  const tid = tenantIdOrThrow(tenantId);
  const classes: ClassGroup[] = await apiFetchTeacherClasses(teacherUserId, tid);
  if (classes.length === 0) return [];
  const ids = new Set(classes.map((c) => c.id));
  const [myStaffId, assignments, names, counts] = await Promise.all([
    apiMyStaffId(tid), apiListTeachingAssignments(tid), apiSubjectNames(tid), learnerCounts(tid, ids),
  ]);
  const subjectsByClass = new Map<string, string[]>();
  for (const a of assignments) {
    if (!myStaffId || a.staff_member_id !== myStaffId || !ids.has(a.class_id)) continue;
    const name = names.get(a.subject_id);
    if (name) subjectsByClass.set(a.class_id, [...(subjectsByClass.get(a.class_id) ?? []), name]);
  }
  return classes.map((c) => ({
    ...c,
    subjects: (subjectsByClass.get(c.id) ?? []).sort((a, b) => a.localeCompare(b)),
    learnerCount: counts.get(c.id) ?? 0,
  }));
}
