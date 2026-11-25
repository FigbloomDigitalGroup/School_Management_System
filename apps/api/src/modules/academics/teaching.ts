import type { Tx } from "../../db/sql.js";
import { listHomework, listLearningMaterials, type PublicHomework, type PublicMaterial } from "./assessments.js";
import { listOnlinePapers } from "./higherEd.js";
import { pageQuery, type Page, type PageInput } from "./pagination.js";

/**
 * Teacher reads (docs/TEACHER-READS.md). A plain teacher reads the names of the learners in the classes they teach, the
 * staff who teach those classes, and those classes' academic years and terms. Every read is decided by `teachingClassIds`
 * on every request; the caller must also hold `resource.teaching.read` (checked by the route). Read only: no write uses it.
 */
export const TEACHING_READ = "resource.teaching.read" as const;

/**
 * The ACTIVE classes of this school whose class teacher, or an ACTIVE teaching assignment, is the caller's linked ACTIVE staff
 * record. Stricter than `teacherClassIds` (structure.ts, the OD-2 helper of the older routes): an archived class, an ended
 * assignment or an archived staff record never counts here.
 */
export async function teachingClassIds(tx: Tx, input: { tenantId: string; userId: string }): Promise<string[]> {
  const res = await tx.query<{ id: string }>(
    `SELECT DISTINCT c.id
       FROM staff_members sm
       JOIN classes c ON c.tenant_id = sm.tenant_id AND c.active = true AND c.archived_at IS NULL
      WHERE sm.tenant_id = $1 AND sm.user_id = $2 AND sm.active = true AND sm.archived_at IS NULL
        AND (c.class_teacher_staff_id = sm.id
             OR EXISTS (SELECT 1 FROM teaching_assignments ta
                         WHERE ta.tenant_id = c.tenant_id AND ta.class_id = c.id AND ta.staff_member_id = sm.id
                           AND ta.active = true AND ta.archived_at IS NULL))
      ORDER BY c.id`,
    [input.tenantId, input.userId],
  );
  return res.rows.map((r) => r.id);
}

/** The academic years of `classIds` (the calendar a teacher may read). */
export async function teachingYearIds(tx: Tx, input: { tenantId: string; classIds: string[] }): Promise<string[]> {
  if (input.classIds.length === 0) return [];
  const res = await tx.query<{ academic_year_id: string }>(
    `SELECT DISTINCT academic_year_id FROM classes WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY academic_year_id`,
    [input.tenantId, input.classIds],
  );
  return res.rows.map((r) => r.academic_year_id);
}

export interface TeachingLearner {
  learner_id: string;
  full_name: string;
  admission_no: string;
  class_id: string;
}

const emptyPage = <T>(page: PageInput): Page<T> => ({ items: [], page: { next_cursor: null, limit: page.limit } });

/**
 * One row per ACTIVE membership of an ACTIVE learner in `classIds` (optionally narrowed to `classId`, which must be one of
 * them, or the list is empty). Names and admission numbers only: no date of birth, gender, boarding or contacts.
 */
export async function listTeachingLearners(
  tx: Tx,
  input: { tenantId: string; classIds: string[]; classId?: string; page: PageInput },
): Promise<Page<TeachingLearner>> {
  const scope = input.classId === undefined ? input.classIds : input.classIds.filter((id) => id === input.classId);
  if (scope.length === 0) return emptyPage(input.page);
  const res = await pageQuery<{ id: string; learner_id: string; full_name: string; admission_no: string; class_id: string }>(
    tx,
    `SELECT cm.id, cm.learner_id, l.full_name, l.admission_no, cm.class_id
       FROM class_memberships cm
       JOIN learners l ON l.tenant_id = cm.tenant_id AND l.id = cm.learner_id AND l.active = true AND l.archived_at IS NULL
      WHERE cm.tenant_id = $1 AND cm.active = true AND cm.archived_at IS NULL AND cm.class_id = ANY($2::uuid[])`,
    [input.tenantId, scope],
    { name: "teaching_learners", expr: "lower(q.full_name)", type: "text", dir: "asc" },
    input.page,
  );
  return {
    items: res.rows.map((r) => ({ learner_id: r.learner_id, full_name: r.full_name, admission_no: r.admission_no, class_id: r.class_id })),
    page: res.page,
  };
}

export interface TeachingColleague {
  staff_member_id: string;
  full_name: string;
}

/**
 * The ACTIVE staff records that are class teacher, or hold an ACTIVE teaching assignment, in `classIds` (the caller's own
 * record included). The name only: no phone, e-mail, title or account id.
 */
export async function listTeachingColleagues(
  tx: Tx,
  input: { tenantId: string; classIds: string[]; page: PageInput },
): Promise<Page<TeachingColleague>> {
  if (input.classIds.length === 0) return emptyPage(input.page);
  const res = await pageQuery<{ id: string; full_name: string }>(
    tx,
    `SELECT sm.id, sm.full_name
       FROM staff_members sm
      WHERE sm.tenant_id = $1 AND sm.active = true AND sm.archived_at IS NULL
        AND (EXISTS (SELECT 1 FROM classes c
                      WHERE c.tenant_id = sm.tenant_id AND c.id = ANY($2::uuid[]) AND c.class_teacher_staff_id = sm.id)
             OR EXISTS (SELECT 1 FROM teaching_assignments ta
                         WHERE ta.tenant_id = sm.tenant_id AND ta.class_id = ANY($2::uuid[]) AND ta.staff_member_id = sm.id
                           AND ta.active = true AND ta.archived_at IS NULL))`,
    [input.tenantId, input.classIds],
    { name: "teaching_colleagues", expr: "lower(q.full_name)", type: "text", dir: "asc" },
    input.page,
  );
  return { items: res.rows.map((r) => ({ staff_member_id: r.id, full_name: r.full_name })), page: res.page };
}

/** `classId` narrows the scope to that class when the caller teaches it (otherwise nothing); no `classId` keeps every class they teach. */
function narrowToClass(classIds: readonly string[], classId: string | undefined): string[] {
  return classId === undefined ? [...classIds] : classIds.filter((id) => id === classId);
}

/**
 * Homework set for the classes the caller teaches (all subjects of those classes, not only the caller's own: the scope is the
 * class, as for every other teacher read). The same rows and shape as `GET /homework-items`.
 */
export async function listTeachingHomework(
  tx: Tx,
  input: { tenantId: string; classIds: readonly string[]; classId?: string; page: PageInput },
): Promise<Page<PublicHomework>> {
  const scope = narrowToClass(input.classIds, input.classId);
  if (scope.length === 0) return emptyPage(input.page);
  return listHomework(tx, { tenantId: input.tenantId, classIds: scope, page: input.page });
}

/**
 * Learning materials of the classes the caller teaches. A material that names no class is shared with every class, so a
 * teacher of at least one class reads those too, unless the list is narrowed to one class. The same rows and shape as
 * `GET /learning-materials`.
 */
export async function listTeachingMaterials(
  tx: Tx,
  input: { tenantId: string; classIds: readonly string[]; classId?: string; page: PageInput },
): Promise<Page<PublicMaterial>> {
  const scope = narrowToClass(input.classIds, input.classId);
  if (scope.length === 0) return emptyPage(input.page);
  return listLearningMaterials(tx, {
    tenantId: input.tenantId,
    classIds: scope,
    includeSchoolWide: input.classId === undefined,
    page: input.page,
  });
}

/** Online exam papers of the classes the caller teaches. The same rows and shape as `GET /online-exam-papers`. */
export async function listTeachingPapers(
  tx: Tx,
  input: { tenantId: string; classIds: readonly string[]; classId?: string; page: PageInput },
) {
  const scope = narrowToClass(input.classIds, input.classId);
  if (scope.length === 0) return emptyPage<Awaited<ReturnType<typeof listOnlinePapers>>["items"][number]>(input.page);
  return listOnlinePapers(tx, { tenantId: input.tenantId, classIds: scope, page: input.page });
}
