import type { Tx } from "../../db/sql.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { getClassById, getSubjectById, getTermById } from "./structure.js";
import { pgCode } from "./pgError.js";
import { ONE_ROW, pageQuery, type PageInput } from "./pagination.js";

function isoStamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value : value.toISOString();
}

function trim(value: string, field: string, max: number): string {
  const t = value.trim();
  if (t.length < 1 || t.length > max) throw validationError(`${field} must be 1–${max} characters`);
  return t;
}

async function assertHigherEd(tx: Tx, tenantId: string): Promise<void> {
  const res = await tx.query<{ institution_type: string | null }>(
    `SELECT institution_type FROM school_profiles WHERE tenant_id = $1`,
    [tenantId],
  );
  if (res.rows[0]?.institution_type !== "higher_ed") {
    throw validationError("Higher-education records require school profile institution_type higher_ed");
  }
}

export async function createHeCourse(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; code: string; title: string; credit_hours?: number; ip?: string | null },
) {
  await assertHigherEd(tx, input.tenantId);
  const code = trim(input.code, "code", 32);
  const title = trim(input.title, "title", 160);
  const credit_hours = input.credit_hours ?? 3;
  if (!(credit_hours > 0) || credit_hours > 60) throw validationError("credit_hours must be greater than 0 and at most 60");
  try {
    const res = await tx.query<{ id: string; tenant_id: string; code: string; title: string; credit_hours: string; created_at: Date | string }>(
      `INSERT INTO he_courses (tenant_id, code, title, credit_hours, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, tenant_id, code, title, credit_hours::text AS credit_hours, created_at`,
      [input.tenantId, code, title, credit_hours, input.actorUserId],
    );
    const row = res.rows[0]!;
    await recordSecurityEvent(tx, {
      eventType: "academics.he.course.created",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { courseId: row.id, code: row.code },
      ip: input.ip,
    });
    return { id: row.id, tenantId: row.tenant_id, code: row.code, title: row.title, credit_hours: row.credit_hours, created_at: isoStamp(row.created_at) };
  } catch (err) {
    if (pgCode(err) === "23505") throw conflict("A course with this code already exists");
    throw err;
  }
}

export async function listHeCourses(tx: Tx, input: { tenantId: string; page: PageInput; id?: string }) {
  await assertHigherEd(tx, input.tenantId);
  const res = await pageQuery<{ id: string }>(
    tx,
    `SELECT id, tenant_id, code, title, credit_hours::text AS credit_hours, created_at
       FROM he_courses WHERE tenant_id = $1`,
    [input.tenantId],
    { name: "he_courses", expr: "lower(q.code)", type: "text", dir: "asc" },
    input.page,
    input.id,
  );
  const items = (res.rows as unknown as Array<{ id: string; tenant_id: string; code: string; title: string; credit_hours: string; created_at: Date | string }>).map((row) => ({
    id: row.id, tenantId: row.tenant_id, code: row.code, title: row.title, credit_hours: row.credit_hours, created_at: isoStamp(row.created_at),
  }));
  return { items, page: res.page };
}

/** A9-6: by-id lookup through the same query and scope as the list. */
export async function getHeCourseById(tx: Tx, input: { tenantId: string; id: string }) {
  return (await listHeCourses(tx, { ...input, page: ONE_ROW })).items[0] ?? null;
}

export async function createHeSection(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; course_id: string; term_id: string; label: string },
) {
  await assertHigherEd(tx, input.tenantId);
  await getTermById(tx, { tenantId: input.tenantId, termId: input.term_id });
  const course = await tx.query(`SELECT id FROM he_courses WHERE tenant_id = $1 AND id = $2`, [input.tenantId, input.course_id]);
  if (course.rowCount === 0) throw notFound("Course not found");
  const label = trim(input.label, "label", 32);
  try {
    const res = await tx.query<{ id: string; tenant_id: string; course_id: string; term_id: string; label: string; created_at: Date | string }>(
      `INSERT INTO he_sections (tenant_id, course_id, term_id, label, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, tenant_id, course_id, term_id, label, created_at`,
      [input.tenantId, input.course_id, input.term_id, label, input.actorUserId],
    );
    const row = res.rows[0]!;
    return { id: row.id, tenantId: row.tenant_id, course_id: row.course_id, term_id: row.term_id, label: row.label, created_at: isoStamp(row.created_at) };
  } catch (err) {
    if (pgCode(err) === "23505") throw conflict("A section with this label already exists for the course and term");
    throw err;
  }
}

export async function listHeSections(tx: Tx, input: { tenantId: string; courseId?: string; page: PageInput; id?: string }) {
  await assertHigherEd(tx, input.tenantId);
  const params: unknown[] = [input.tenantId];
  const extra = input.courseId ? " AND course_id = $2" : "";
  if (input.courseId) params.push(input.courseId);
  const res = await pageQuery<{ id: string }>(
    tx,
    `SELECT id, tenant_id, course_id, term_id, label, created_at FROM he_sections WHERE tenant_id = $1${extra}`,
    params,
    { name: "he_sections", expr: "q.label", type: "text", dir: "asc" },
    input.page,
    input.id,
  );
  const items = (res.rows as unknown as Array<{ id: string; tenant_id: string; course_id: string; term_id: string; label: string; created_at: Date | string }>).map((row) => ({
    id: row.id, tenantId: row.tenant_id, course_id: row.course_id, term_id: row.term_id, label: row.label, created_at: isoStamp(row.created_at),
  }));
  return { items, page: res.page };
}

/** A9-6: by-id lookup through the same query and scope as the list. */
export async function getHeSectionById(tx: Tx, input: { tenantId: string; id: string }) {
  return (await listHeSections(tx, { ...input, page: ONE_ROW })).items[0] ?? null;
}

export async function createHeEnrolment(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; section_id: string; learner_id: string; ip?: string | null },
) {
  await assertHigherEd(tx, input.tenantId);
  const section = await tx.query(`SELECT id FROM he_sections WHERE tenant_id = $1 AND id = $2`, [input.tenantId, input.section_id]);
  if (section.rowCount === 0) throw notFound("Section not found");
  const learner = await tx.query(`SELECT id FROM learners WHERE tenant_id = $1 AND id = $2 AND active = true`, [input.tenantId, input.learner_id]);
  if (learner.rowCount === 0) throw validationError("learner_id must be an active learner in this school");
  try {
    const res = await tx.query<{ id: string; tenant_id: string; section_id: string; learner_id: string; status: string; created_at: Date | string }>(
      `INSERT INTO he_enrolments (tenant_id, section_id, learner_id, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, tenant_id, section_id, learner_id, status, created_at`,
      [input.tenantId, input.section_id, input.learner_id, input.actorUserId],
    );
    const row = res.rows[0]!;
    await recordSecurityEvent(tx, {
      eventType: "academics.he.enrolment.created",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { enrolmentId: row.id, sectionId: row.section_id, learnerId: row.learner_id },
      ip: input.ip,
    });
    return { id: row.id, tenantId: row.tenant_id, section_id: row.section_id, learner_id: row.learner_id, status: row.status, created_at: isoStamp(row.created_at) };
  } catch (err) {
    if (pgCode(err) === "23505") throw conflict("Learner is already enrolled in this section");
    throw err;
  }
}

export async function listHeEnrolments(tx: Tx, input: { tenantId: string; sectionId?: string; page: PageInput; id?: string }) {
  await assertHigherEd(tx, input.tenantId);
  const params: unknown[] = [input.tenantId];
  const extra = input.sectionId ? " AND section_id = $2" : "";
  if (input.sectionId) params.push(input.sectionId);
  const res = await pageQuery<{ id: string }>(
    tx,
    `SELECT id, tenant_id, section_id, learner_id, status, created_at FROM he_enrolments WHERE tenant_id = $1${extra}`,
    params,
    { name: "he_enrolments", expr: "q.created_at", type: "timestamptz", dir: "asc" },
    input.page,
    input.id,
  );
  const items = (res.rows as unknown as Array<{ id: string; tenant_id: string; section_id: string; learner_id: string; status: string; created_at: Date | string }>).map((row) => ({
    id: row.id, tenantId: row.tenant_id, section_id: row.section_id, learner_id: row.learner_id, status: row.status, created_at: isoStamp(row.created_at),
  }));
  return { items, page: res.page };
}

/** A9-6: by-id lookup through the same query and scope as the list. */
export async function getHeEnrolmentById(tx: Tx, input: { tenantId: string; id: string }) {
  return (await listHeEnrolments(tx, { ...input, page: ONE_ROW })).items[0] ?? null;
}

export interface PublicHeGrade {
  id: string;
  tenantId: string;
  enrolment_id: string;
  score: string;
  grade: string | null;
  graded_at: string;
  graded_by: string | null;
  row_version: number;
}

type HeGradeRow = {
  id: string;
  tenant_id: string;
  enrolment_id: string;
  score: string;
  grade: string | null;
  graded_at: Date | string;
  graded_by: string | null;
  row_version: number;
};

const HE_GRADE_COLS = `id, tenant_id, enrolment_id, score::text AS score, grade, graded_at, graded_by, row_version`;

function mapHeGrade(row: HeGradeRow): PublicHeGrade {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    enrolment_id: row.enrolment_id,
    score: row.score,
    grade: row.grade,
    graded_at: isoStamp(row.graded_at)!,
    graded_by: row.graded_by,
    row_version: row.row_version,
  };
}

function gradeInput(score: number, grade: string | null | undefined): string | null {
  if (!(score >= 0) || score > 10000) throw validationError("score must be between 0 and 10000");
  return grade === undefined || grade === null || grade.trim() === "" ? null : trim(grade, "grade", 16);
}

async function gradeRef(tx: Tx, tenantId: string, row: HeGradeRow): Promise<{ type: string; id: string }> {
  if (row.row_version === 1) return { type: "he_grade", id: row.id };
  const rev = await tx.query<{ id: string }>(
    `SELECT id FROM he_grade_revisions WHERE tenant_id = $1 AND grade_id = $2 AND resulting_row_version = $3`,
    [tenantId, row.id, row.row_version],
  );
  return { type: "he_grade_revision", id: rev.rows[0]!.id };
}

/**
 * OD-5 ordinary grade submission. One current grade per enrolment (unique index, migration 035).
 * Refused for a withdrawn enrolment. Resending the same grade is safe (outcome "unchanged");
 * a different grade on an existing one is refused: use correctHeGrade.
 */
export async function recordHeGrade(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; enrolmentId: string; score: number; grade?: string | null; ip?: string | null },
): Promise<{ grade: PublicHeGrade; outcome: "created" | "unchanged"; ref: { type: string; id: string } }> {
  await assertHigherEd(tx, input.tenantId);
  // No row lock: the runtime role cannot change enrolment status (no UPDATE grant), and the
  // he_grades_guard trigger re-checks 'enrolled' at insert time (migration 035).
  const enrolment = await tx.query<{ status: string }>(
    `SELECT status FROM he_enrolments WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.enrolmentId],
  );
  if (enrolment.rowCount === 0) throw notFound("Enrolment not found");
  if (enrolment.rows[0]!.status !== "enrolled") {
    throw conflict("This enrolment is withdrawn. Grades cannot be submitted for it; an existing grade can only be corrected.");
  }
  const grade = gradeInput(input.score, input.grade);
  const current = await tx.query<HeGradeRow>(
    `SELECT ${HE_GRADE_COLS} FROM he_grades WHERE tenant_id = $1 AND enrolment_id = $2 FOR UPDATE`,
    [input.tenantId, input.enrolmentId],
  );
  const existing = current.rows[0];
  if (existing) {
    const same = await tx.query<{ same: boolean }>(`SELECT ($1::numeric = $2::numeric) AS same`, [existing.score, input.score]);
    if (same.rows[0]?.same && existing.grade === grade) {
      return { grade: mapHeGrade(existing), outcome: "unchanged", ref: await gradeRef(tx, input.tenantId, existing) };
    }
    throw conflict("A grade already exists for this enrolment. Record a correction to change it.");
  }
  try {
    const res = await tx.query<HeGradeRow>(
      `INSERT INTO he_grades (tenant_id, enrolment_id, score, grade, graded_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${HE_GRADE_COLS}`,
      [input.tenantId, input.enrolmentId, input.score, grade, input.actorUserId],
    );
    const row = res.rows[0]!;
    // Review A9-12: grades are audited (ids only, no score).
    await recordSecurityEvent(tx, {
      eventType: "academics.he.grade.recorded",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { gradeId: row.id, enrolmentId: row.enrolment_id },
      ip: input.ip,
    });
    return { grade: mapHeGrade(row), outcome: "created", ref: { type: "he_grade", id: row.id } };
  } catch (err) {
    const code = pgCode(err);
    if (code === "23505") throw conflict("A grade was recorded for this enrolment at the same time");
    if (code === "23514") throw conflict("This enrolment is withdrawn. Grades cannot be submitted for it.");
    throw err;
  }
}

/**
 * OD-5 authorised correction of an existing grade, against its current row_version, with a reason.
 * Allowed on a withdrawn enrolment (historical correction); it never creates a first grade, so it
 * cannot re-open a withdrawn enrolment. The previous grade stays in he_grade_revisions.
 */
export async function correctHeGrade(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    enrolmentId: string;
    score: number;
    grade?: string | null;
    reason: string;
    rowVersion: number;
    ip?: string | null;
  },
): Promise<{ grade: PublicHeGrade; ref: { type: string; id: string } }> {
  await assertHigherEd(tx, input.tenantId);
  const enrolment = await tx.query(`SELECT 1 FROM he_enrolments WHERE tenant_id = $1 AND id = $2`, [input.tenantId, input.enrolmentId]);
  if (enrolment.rowCount === 0) throw notFound("Enrolment not found");
  const grade = gradeInput(input.score, input.grade);
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500) throw validationError("reason must be 5–500 characters");
  const current = await tx.query<HeGradeRow>(
    `SELECT ${HE_GRADE_COLS} FROM he_grades WHERE tenant_id = $1 AND enrolment_id = $2 FOR UPDATE`,
    [input.tenantId, input.enrolmentId],
  );
  const existing = current.rows[0];
  if (!existing) throw conflict("There is no grade to correct for this enrolment");
  if (input.rowVersion !== existing.row_version) throw conflict("The grade was changed by someone else");
  const same = await tx.query<{ same: boolean }>(`SELECT ($1::numeric = $2::numeric) AS same`, [existing.score, input.score]);
  if (same.rows[0]?.same && existing.grade === grade) throw validationError("The correction does not change the grade");
  try {
    const revision = await tx.query<{ id: string }>(
      `INSERT INTO he_grade_revisions
         (tenant_id, grade_id, previous_score, previous_grade, new_score, new_grade, resulting_row_version, reason, revised_by)
       VALUES ($1, $2, $3::numeric, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [input.tenantId, existing.id, existing.score, existing.grade, input.score, grade, existing.row_version + 1, reason, input.actorUserId],
    );
    const updated = await tx.query<HeGradeRow>(
      `UPDATE he_grades SET score = $3, grade = $4, graded_at = now(), graded_by = $5, row_version = row_version + 1
        WHERE id = $1 AND row_version = $2
        RETURNING ${HE_GRADE_COLS}`,
      [existing.id, existing.row_version, input.score, grade, input.actorUserId],
    );
    const row = updated.rows[0];
    if (!row) throw conflict("The grade was changed by someone else");
    await recordSecurityEvent(tx, {
      eventType: "academics.he.grade.corrected",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { gradeId: row.id, revisionId: revision.rows[0]!.id, fromRowVersion: existing.row_version, toRowVersion: row.row_version },
      ip: input.ip,
    });
    return { grade: mapHeGrade(row), ref: { type: "he_grade_revision", id: revision.rows[0]!.id } };
  } catch (err) {
    const code = pgCode(err);
    if (code === "23505" || code === "FB409") throw conflict("The grade was changed by someone else");
    throw err;
  }
}

/** Current grade of an enrolment (null when none). */
export async function getHeGradeForEnrolment(tx: Tx, input: { tenantId: string; enrolmentId: string }): Promise<PublicHeGrade | null> {
  await assertHigherEd(tx, input.tenantId);
  const res = await tx.query<HeGradeRow>(`SELECT ${HE_GRADE_COLS} FROM he_grades WHERE tenant_id = $1 AND enrolment_id = $2`, [
    input.tenantId,
    input.enrolmentId,
  ]);
  return res.rows[0] ? mapHeGrade(res.rows[0]) : null;
}

/** Revision history of an enrolment's grade, oldest first. */
export async function listHeGradeRevisions(tx: Tx, input: { tenantId: string; enrolmentId: string; page: PageInput }) {
  await assertHigherEd(tx, input.tenantId);
  const res = await pageQuery<{
    id: string; tenant_id: string; grade_id: string; previous_score: string; previous_grade: string | null;
    new_score: string; new_grade: string | null; resulting_row_version: number; reason: string;
    revised_by: string; revised_at: Date | string;
  }>(
    tx,
    `SELECT v.id, v.tenant_id, v.grade_id, v.previous_score::text AS previous_score, v.previous_grade,
            v.new_score::text AS new_score, v.new_grade, v.resulting_row_version, v.reason, v.revised_by, v.revised_at
       FROM he_grade_revisions v
       JOIN he_grades g ON g.tenant_id = v.tenant_id AND g.id = v.grade_id
      WHERE v.tenant_id = $1 AND g.enrolment_id = $2`,
    [input.tenantId, input.enrolmentId],
    { name: "he_grade_revisions", expr: "q.resulting_row_version", type: "integer", dir: "asc" },
    input.page,
  );
  return {
    items: res.rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      grade_id: r.grade_id,
      previous_score: r.previous_score,
      previous_grade: r.previous_grade,
      new_score: r.new_score,
      new_grade: r.new_grade,
      resulting_row_version: r.resulting_row_version,
      reason: r.reason,
      revised_by: r.revised_by,
      revised_at: isoStamp(r.revised_at),
    })),
    page: res.page,
  };
}

/**
 * OD-5 idempotent replay: the grade exactly as the original request returned it, even if corrected
 * since. `he_grade` = version 1; `he_grade_revision` = the version that revision made.
 */
export async function getHeGradeVersion(
  tx: Tx,
  input: { tenantId: string; refType: string; refId: string },
): Promise<PublicHeGrade | null> {
  let gradeId: string;
  let version: number;
  if (input.refType === "he_grade_revision") {
    const rev = await tx.query<{ grade_id: string; resulting_row_version: number }>(
      `SELECT grade_id, resulting_row_version FROM he_grade_revisions WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.refId],
    );
    if (!rev.rows[0]) return null;
    gradeId = rev.rows[0].grade_id;
    version = rev.rows[0].resulting_row_version;
  } else {
    gradeId = input.refId;
    version = 1;
  }
  const cur = await tx.query<HeGradeRow>(`SELECT ${HE_GRADE_COLS} FROM he_grades WHERE tenant_id = $1 AND id = $2`, [input.tenantId, gradeId]);
  const row = cur.rows[0];
  if (!row) return null;
  if (row.row_version === version) return mapHeGrade(row);
  const made = await tx.query<{ new_score: string; new_grade: string | null; revised_at: Date | string; revised_by: string }>(
    `SELECT new_score::text AS new_score, new_grade, revised_at, revised_by
       FROM he_grade_revisions WHERE tenant_id = $1 AND grade_id = $2 AND resulting_row_version = $3`,
    [input.tenantId, gradeId, version],
  );
  if (made.rows[0]) {
    const m = made.rows[0];
    return { ...mapHeGrade(row), score: m.new_score, grade: m.new_grade, graded_at: isoStamp(m.revised_at)!, graded_by: m.revised_by, row_version: version };
  }
  const next = await tx.query<{ previous_score: string; previous_grade: string | null; previous_graded_at: Date | string; previous_graded_by: string | null }>(
    `SELECT previous_score::text AS previous_score, previous_grade, previous_graded_at, previous_graded_by
       FROM he_grade_revisions WHERE tenant_id = $1 AND grade_id = $2 AND resulting_row_version = $3`,
    [input.tenantId, gradeId, version + 1],
  );
  const n = next.rows[0];
  if (!n) return null;
  return {
    ...mapHeGrade(row),
    score: n.previous_score,
    grade: n.previous_grade,
    graded_at: isoStamp(n.previous_graded_at)!,
    graded_by: n.previous_graded_by,
    row_version: version,
  };
}

export interface OnlineExamQuestion {
  id: string;
  prompt: string;
  kind: "mcq" | "true_false";
  options?: string[];
  correct_answer: string;
  points: number;
}

export async function createOnlinePaper(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    class_id: string;
    subject_id: string;
    title: string;
    max_score: number;
    questions?: OnlineExamQuestion[] | null;
    ip?: string | null;
  },
) {
  await getClassById(tx, { tenantId: input.tenantId, classId: input.class_id });
  await getSubjectById(tx, { tenantId: input.tenantId, subjectId: input.subject_id });
  const title = trim(input.title, "title", 160);
  if (!(input.max_score > 0) || input.max_score > 10000) throw validationError("max_score must be greater than 0 and at most 10000");
  if (input.questions && input.questions.length > 0) {
    const ids = new Set<string>();
    for (const q of input.questions) {
      if (ids.has(q.id)) throw validationError("Duplicate question id");
      ids.add(q.id);
      if (!(q.points > 0)) throw validationError("Question points must be positive");
    }
  }
  const res = await tx.query<{
    id: string;
    tenant_id: string;
    class_id: string;
    subject_id: string;
    title: string;
    max_score: string;
    questions: OnlineExamQuestion[] | null;
    created_at: Date | string;
  }>(
    `INSERT INTO online_exam_papers (tenant_id, class_id, subject_id, title, max_score, questions, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     RETURNING id, tenant_id, class_id, subject_id, title, max_score::text AS max_score, questions, created_at`,
    [
      input.tenantId,
      input.class_id,
      input.subject_id,
      title,
      input.max_score,
      input.questions ? JSON.stringify(input.questions) : null,
      input.actorUserId,
    ],
  );
  const row = res.rows[0]!;
  await recordSecurityEvent(tx, {
    eventType: "academics.online_exam.created",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { paperId: row.id },
    ip: input.ip,
  });
  return {
    id: row.id,
    tenantId: row.tenant_id,
    class_id: row.class_id,
    subject_id: row.subject_id,
    title: row.title,
    max_score: row.max_score,
    questions: row.questions,
    created_at: isoStamp(row.created_at),
    published_at: null as string | null, // a new paper is unpublished until POST .../publish (migration 110)
  };
}

/**
 * `classIds`, when given, limits the list to those classes (the teacher reads, docs/TEACHER-READS.md: the classes the caller
 * teaches). It is a bound parameter, so it is part of the cursor fingerprint.
 */
export async function listOnlinePapers(tx: Tx, input: { tenantId: string; page: PageInput; id?: string; classIds?: readonly string[] }) {
  const params: unknown[] = [input.tenantId];
  let classClause = "";
  if (input.classIds) {
    params.push([...input.classIds]);
    classClause = ` AND class_id = ANY($${params.length}::uuid[])`;
  }
  const res = await pageQuery<{ id: string }>(
    tx,
    `SELECT id, tenant_id, class_id, subject_id, title, max_score::text AS max_score, created_at, published_at
       FROM online_exam_papers WHERE tenant_id = $1${classClause}`,
    params,
    { name: "online_exam_papers", expr: "q.created_at", type: "timestamptz", dir: "desc" },
    input.page,
    input.id,
  );
  const items = (res.rows as unknown as Array<{ id: string; tenant_id: string; class_id: string; subject_id: string; title: string; max_score: string; created_at: Date | string; published_at: Date | string | null }>).map((row) => ({
    id: row.id, tenantId: row.tenant_id, class_id: row.class_id, subject_id: row.subject_id, title: row.title, max_score: row.max_score, created_at: isoStamp(row.created_at),
    // migration 110: learners see a paper only once it is published (docs/STUDENT-ACCOUNTS.md)
    published_at: isoStamp(row.published_at),
  }));
  return { items, page: res.page };
}

/** A9-6: by-id lookup through the same query and scope as the list. */
export async function getOnlinePaperById(tx: Tx, input: { tenantId: string; id: string }) {
  return (await listOnlinePapers(tx, { ...input, page: ONE_ROW })).items[0] ?? null;
}

/**
 * Publish a paper to the learners of its class (migration 110, docs/STUDENT-ACCOUNTS.md). Until then no learner sees it.
 * Publishing again changes nothing (the first time stands). There is no unpublish: a paper learners may have started stays
 * visible to them.
 */
export async function publishOnlinePaper(tx: Tx, input: { tenantId: string; actorUserId: string; paperId: string; ip?: string | null }) {
  const res = await tx.query<{ published_now: boolean }>(
    `UPDATE online_exam_papers SET published_at = coalesce(published_at, now())
      WHERE tenant_id = $1 AND id = $2
      RETURNING (published_at = now()) AS published_now`,
    [input.tenantId, input.paperId],
  );
  if (res.rowCount === 0) throw notFound("Exam paper not found");
  if (res.rows[0]!.published_now) {
    await recordSecurityEvent(tx, {
      eventType: "academics.online_exam.published",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { paperId: input.paperId },
      ip: input.ip,
    });
  }
  return (await getOnlinePaperById(tx, { tenantId: input.tenantId, id: input.paperId }))!;
}

export async function startOnlineAttempt(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; paperId: string; learner_id: string; ip?: string | null },
) {
  const paper = await tx.query<{ class_id: string }>(
    `SELECT class_id FROM online_exam_papers WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.paperId],
  );
  if (paper.rowCount === 0) throw notFound("Exam paper not found");
  const learner = await tx.query(`SELECT id FROM learners WHERE tenant_id = $1 AND id = $2 AND active = true`, [input.tenantId, input.learner_id]);
  if (learner.rowCount === 0) throw validationError("learner_id must be an active learner in this school");
  // Review A9-4: only a learner of the paper's class may sit it; one in-progress attempt (migration 034).
  const member = await tx.query(
    `SELECT 1 FROM class_memberships WHERE tenant_id = $1 AND learner_id = $2 AND class_id = $3 LIMIT 1`,
    [input.tenantId, input.learner_id, paper.rows[0]!.class_id],
  );
  if (member.rowCount === 0) throw validationError("learner_id is not a member of the paper's class");
  let row: { id: string; tenant_id: string; paper_id: string; learner_id: string; status: string; created_at: Date | string };
  try {
    const res = await tx.query<typeof row>(
      `INSERT INTO online_exam_attempts (tenant_id, paper_id, learner_id, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, tenant_id, paper_id, learner_id, status, created_at`,
      [input.tenantId, input.paperId, input.learner_id, input.actorUserId],
    );
    row = res.rows[0]!;
  } catch (err) {
    if (pgCode(err) === "23505") throw conflict("This learner already has an attempt in progress on this paper");
    throw err;
  }
  await recordSecurityEvent(tx, {
    eventType: "academics.online_exam.attempt_started",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { attemptId: row.id, paperId: row.paper_id, learnerId: row.learner_id },
    ip: input.ip,
  });
  return { id: row.id, tenantId: row.tenant_id, paper_id: row.paper_id, learner_id: row.learner_id, status: row.status, submitted_at: null, created_at: isoStamp(row.created_at) };
}

/** Review A9-5: idempotent replay of start / submit re-reads the attempt by id (and its mark, once submitted). */
export async function getOnlineAttempt(tx: Tx, input: { tenantId: string; attemptId: string }) {
  const res = await tx.query<{
    id: string; tenant_id: string; paper_id: string; learner_id: string; status: string;
    submitted_at: Date | string | null; created_at: Date | string; mark_id: string | null; score: string | null;
  }>(
    `SELECT a.id, a.tenant_id, a.paper_id, a.learner_id, a.status, a.submitted_at, a.created_at,
            m.id AS mark_id, m.score::text AS score
       FROM online_exam_attempts a
       LEFT JOIN attempt_marks m ON m.tenant_id = a.tenant_id AND m.attempt_id = a.id
      WHERE a.tenant_id = $1 AND a.id = $2`,
    [input.tenantId, input.attemptId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    paper_id: row.paper_id,
    learner_id: row.learner_id,
    status: row.status,
    submitted_at: row.submitted_at === null ? null : isoStamp(row.submitted_at),
    created_at: isoStamp(row.created_at),
    mark: row.mark_id ? { id: row.mark_id, score: row.score! } : null,
  };
}


export async function submitOnlineAttempt(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    attemptId: string;
    score?: number;
    answers?: Record<string, string>;
    ip?: string | null;
    /** Who the mark row names (default: the actor). A learner's own submission is auto-marked by nobody: null. */
    markedBy?: string | null;
  },
) {
  const attempt = await tx.query<{
    paper_id: string;
    status: string;
    max_score: string;
    questions: OnlineExamQuestion[] | null;
  }>(
    `SELECT a.paper_id, a.status, p.max_score::text AS max_score, p.questions
       FROM online_exam_attempts a
       JOIN online_exam_papers p ON p.id = a.paper_id AND p.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1 AND a.id = $2
      FOR UPDATE OF a`,
    [input.tenantId, input.attemptId],
  );
  const row = attempt.rows[0];
  if (!row) throw notFound("Attempt not found");
  if (row.status !== "in_progress") throw conflict("This attempt is already submitted");

  let finalScore: number;
  let autoMarked = false;
  if (input.answers && row.questions && row.questions.length > 0) {
    let earned = 0;
    for (const q of row.questions) {
      const ans = input.answers[q.id];
      if (ans !== undefined && ans.trim().toLowerCase() === q.correct_answer.trim().toLowerCase()) {
        earned += q.points;
      }
    }
    finalScore = Math.min(earned, Number(row.max_score));
    autoMarked = true;
  } else if (input.score !== undefined) {
    finalScore = input.score;
  } else {
    throw validationError("Provide score, or answers for a paper with objective questions");
  }

  const ok = await tx.query<{ ok: boolean }>(`SELECT ($1::numeric >= 0 AND $1::numeric <= $2::numeric) AS ok`, [
    finalScore,
    row.max_score,
  ]);
  if (!ok.rows[0]?.ok) throw validationError("score must be between 0 and the paper max_score");
  const updated = await tx.query<{ id: string; status: string; submitted_at: Date | string; auto_marked: boolean }>(
    `UPDATE online_exam_attempts
        SET status = 'submitted', submitted_at = now(), answers = $2::jsonb, auto_marked = $3
      WHERE id = $1 AND status = 'in_progress'
      RETURNING id, status, submitted_at, auto_marked`,
    [input.attemptId, input.answers ? JSON.stringify(input.answers) : null, autoMarked],
  );
  if (updated.rowCount === 0) throw conflict("This attempt is already submitted");
  const mark = await tx.query<{ id: string; score: string }>(
    `INSERT INTO attempt_marks (tenant_id, attempt_id, score, marked_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, score::text AS score`,
    [input.tenantId, input.attemptId, finalScore, input.markedBy === undefined ? input.actorUserId : input.markedBy],
  );
  await recordSecurityEvent(tx, {
    eventType: "academics.online_exam.attempt_submitted",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { attemptId: input.attemptId, paperId: row.paper_id, autoMarked },
    ip: input.ip,
  });
  return {
    id: updated.rows[0]!.id,
    status: updated.rows[0]!.status,
    submitted_at: isoStamp(updated.rows[0]!.submitted_at),
    auto_marked: updated.rows[0]!.auto_marked,
    mark: { id: mark.rows[0]!.id, score: mark.rows[0]!.score },
  };
}
