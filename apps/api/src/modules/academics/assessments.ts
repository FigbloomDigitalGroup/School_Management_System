import type { Tx } from "../../db/sql.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { getClassById, getSubjectById, getTermById } from "./structure.js";
import { pgCode } from "./pgError.js";
import { pageQuery, type Page, type PageInput } from "./pagination.js";

/**
 * Report-card figures (also enforced by report_card_publications.figures):
 * method `sum_and_mean_of_published_scores`.
 * For every published assessment of the class and term, each learner's
 * sum is SUM(score), count is how many of those scores exist, and average
 * is PostgreSQL ROUND(AVG(score), 2). assessment_ids are the source ids,
 * sorted, including published assessments that have no marks yet.
 * Grading schemes are not applied to this snapshot.
 */
export const REPORT_CARD_METHOD = "sum_and_mean_of_published_scores";

function isoStamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value : value.toISOString();
}

function isoDate(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  // node-pg parses a DATE as local midnight. UTC parts shift the calendar day west of UTC.
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function trim(value: string, field: string, max: number): string {
  const t = value.trim();
  if (t.length < 1 || t.length > max) throw validationError(`${field} must be 1–${max} characters`);
  return t;
}

export interface PublicAssessment {
  id: string;
  tenantId: string;
  class_id: string;
  subject_id: string;
  term_id: string;
  title: string;
  kind: "exam" | "homework" | "cbe" | "other";
  max_score: string;
  status: "draft" | "published" | "closed";
  published_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

type AssessmentRow = {
  id: string;
  tenant_id: string;
  class_id: string;
  subject_id: string;
  term_id: string;
  title: string;
  kind: PublicAssessment["kind"];
  max_score: string;
  status: PublicAssessment["status"];
  published_at: Date | string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
};

function mapAssessment(row: AssessmentRow): PublicAssessment {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    class_id: row.class_id,
    subject_id: row.subject_id,
    term_id: row.term_id,
    title: row.title,
    kind: row.kind,
    max_score: row.max_score,
    status: row.status,
    published_at: isoStamp(row.published_at),
    version: row.version,
    created_at: isoStamp(row.created_at)!,
    updated_at: isoStamp(row.updated_at)!,
  };
}

const ASSESSMENT_RETURNING = `id, tenant_id, class_id, subject_id, term_id, title, kind,
  max_score::text AS max_score, status, published_at, version, created_at, updated_at`;

export async function createAssessment(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    class_id: string;
    subject_id: string;
    term_id: string;
    title: string;
    kind: PublicAssessment["kind"];
    max_score: number;
    components?: Array<{ name: string; max_score: number; weight?: number | null; sort_order?: number }>;
    ip?: string | null;
  },
): Promise<PublicAssessment> {
  const title = trim(input.title, "title", 160);
  if (!(input.max_score > 0) || input.max_score > 10000) {
    throw validationError("max_score must be greater than 0 and at most 10000");
  }
  await getClassById(tx, { tenantId: input.tenantId, classId: input.class_id });
  await getSubjectById(tx, { tenantId: input.tenantId, subjectId: input.subject_id });
  await getTermById(tx, { tenantId: input.tenantId, termId: input.term_id });
  try {
    const res = await tx.query<AssessmentRow>(
      `INSERT INTO assessments
         (tenant_id, class_id, subject_id, term_id, title, kind, max_score, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${ASSESSMENT_RETURNING}`,
      [
        input.tenantId,
        input.class_id,
        input.subject_id,
        input.term_id,
        title,
        input.kind,
        input.max_score,
        input.actorUserId,
      ],
    );
    const row = res.rows[0]!;
    for (const [i, component] of (input.components ?? []).entries()) {
      const name = trim(component.name, "components.name", 80);
      // A9-11: the CHECK caps max_score at 10000; refuse before the database does.
      if (!(component.max_score > 0) || component.max_score > 10000) {
        throw validationError("component max_score must be greater than 0 and at most 10000");
      }
      await tx.query(
        `INSERT INTO assessment_components
           (tenant_id, assessment_id, name, max_score, weight, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.tenantId,
          row.id,
          name,
          component.max_score,
          component.weight ?? null,
          component.sort_order ?? i,
        ],
      );
    }
    await recordSecurityEvent(tx, {
      eventType: "academics.assessment.created",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { assessmentId: row.id, classId: row.class_id, subjectId: row.subject_id },
      ip: input.ip,
    });
    return mapAssessment(row);
  } catch (err) {
    if (pgCode(err) === "23503") throw validationError("Class, subject or term must belong to this school");
    throw err;
  }
}

export async function listAssessments(
  tx: Tx,
  input: {
    tenantId: string;
    classId?: string;
    termId?: string;
    /** OD-2: null = every class (academics readers); otherwise only these classes. */
    scopeClassIds: readonly string[] | null;
    page: PageInput;
  },
): Promise<Page<PublicAssessment>> {
  const clauses = ["tenant_id = $1"];
  const params: unknown[] = [input.tenantId];
  if (input.classId) {
    params.push(input.classId);
    clauses.push(`class_id = $${params.length}`);
  }
  if (input.termId) {
    params.push(input.termId);
    clauses.push(`term_id = $${params.length}`);
  }
  if (input.scopeClassIds) {
    params.push(input.scopeClassIds);
    clauses.push(`class_id = ANY($${params.length}::uuid[])`);
  }
  const out = await pageQuery<AssessmentRow>(
    tx,
    `SELECT ${ASSESSMENT_RETURNING} FROM assessments WHERE ${clauses.join(" AND ")}`,
    params,
    { name: "assessments", expr: "q.created_at", type: "timestamptz", dir: "desc" },
    input.page,
  );
  return { items: out.rows.map(mapAssessment), page: out.page };
}

export async function getAssessmentById(
  tx: Tx,
  input: { tenantId: string; assessmentId: string; lock?: boolean },
): Promise<PublicAssessment> {
  const res = input.lock
    ? await tx.query<AssessmentRow>(
        `SELECT ${ASSESSMENT_RETURNING} FROM assessments WHERE tenant_id = $1 AND id = $2 FOR SHARE`,
        [input.tenantId, input.assessmentId],
      )
    : await tx.query<AssessmentRow>(
        `SELECT ${ASSESSMENT_RETURNING} FROM assessments WHERE tenant_id = $1 AND id = $2`,
        [input.tenantId, input.assessmentId],
      );
  const row = res.rows[0];
  if (!row) throw notFound("Assessment not found");
  return mapAssessment(row);
}

/** OD-2 / A9-9: the assessment, or null when it does not exist or is outside `scopeClassIds`. */
export async function findAssessmentInScope(
  tx: Tx,
  input: { tenantId: string; assessmentId: string; scopeClassIds: readonly string[] | null },
): Promise<PublicAssessment | null> {
  const res = await tx.query<AssessmentRow>(
    `SELECT ${ASSESSMENT_RETURNING} FROM assessments
      WHERE tenant_id = $1 AND id = $2 AND ($3::uuid[] IS NULL OR class_id = ANY($3::uuid[]))`,
    [input.tenantId, input.assessmentId, input.scopeClassIds],
  );
  const row = res.rows[0];
  return row ? mapAssessment(row) : null;
}

export async function publishAssessment(
  tx: Tx,
  input: { tenantId: string; assessmentId: string; actorUserId: string; ip?: string | null },
): Promise<PublicAssessment> {
  const res = await tx.query<AssessmentRow>(
    `UPDATE assessments
        SET status = 'published', published_at = now(), version = version + 1, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'draft'
      RETURNING ${ASSESSMENT_RETURNING}`,
    [input.tenantId, input.assessmentId],
  );
  const row = res.rows[0];
  if (!row) {
    const existing = await tx.query(`SELECT status FROM assessments WHERE tenant_id = $1 AND id = $2`, [
      input.tenantId,
      input.assessmentId,
    ]);
    if (existing.rowCount === 0) throw notFound("Assessment not found");
    throw conflict("Only a draft assessment can be published");
  }
  await recordSecurityEvent(tx, {
    eventType: "academics.marks.published",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { assessmentId: row.id, version: row.version },
    ip: input.ip,
  });
  return mapAssessment(row);
}

export async function closeAssessment(
  tx: Tx,
  input: { tenantId: string; assessmentId: string; actorUserId: string; ip?: string | null },
): Promise<PublicAssessment> {
  const res = await tx.query<AssessmentRow>(
    `UPDATE assessments
        SET status = 'closed', version = version + 1, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'published'
      RETURNING ${ASSESSMENT_RETURNING}`,
    [input.tenantId, input.assessmentId],
  );
  const row = res.rows[0];
  if (!row) {
    const existing = await tx.query(`SELECT status FROM assessments WHERE tenant_id = $1 AND id = $2`, [
      input.tenantId,
      input.assessmentId,
    ]);
    if (existing.rowCount === 0) throw notFound("Assessment not found");
    throw conflict("Only a published assessment can be closed");
  }
  await recordSecurityEvent(tx, {
    eventType: "academics.assessment.closed",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { assessmentId: row.id, version: row.version },
    ip: input.ip,
  });
  return mapAssessment(row);
}

export interface PublicMark {
  id: string;
  tenantId: string;
  assessment_id: string;
  learner_id: string;
  score: string;
  grade: string | null;
  marked_at: string;
  marked_by: string | null;
  row_version: number;
}

function mapMark(row: {
  id: string;
  tenant_id: string;
  assessment_id: string;
  learner_id: string;
  score: string;
  grade: string | null;
  marked_at: Date | string;
  marked_by: string | null;
  row_version: number;
}): PublicMark {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    assessment_id: row.assessment_id,
    learner_id: row.learner_id,
    score: row.score,
    grade: row.grade,
    marked_at: isoStamp(row.marked_at)!,
    marked_by: row.marked_by,
    row_version: row.row_version,
  };
}

const MARK_RETURNING = `id, tenant_id, assessment_id, learner_id, score::text AS score, grade,
  marked_at, marked_by, row_version`;

export async function upsertMark(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    assessmentId: string;
    learner_id: string;
    score: number;
    grade?: string | null;
    /** Required when a row already exists. 0 or omitted creates. */
    rowVersion: number | null;
    ip?: string | null;
  },
): Promise<PublicMark> {
  // OD-1: hold the assessment row (FOR SHARE) so a concurrent publish waits for this write, then
  // refuse ordinary writes once it is published. Published marks change only through correctMark.
  const assessment = await getAssessmentById(tx, {
    tenantId: input.tenantId,
    assessmentId: input.assessmentId,
    lock: true,
  });
  if (assessment.status !== "draft") {
    throw conflict("Marks of a published assessment are locked. Record a correction instead.");
  }
  const grade =
    input.grade === undefined || input.grade === null || input.grade.trim() === ""
      ? null
      : trim(input.grade, "grade", 16);
  const scoreOk = await tx.query<{ ok: boolean }>(
    `SELECT ($1::numeric >= 0 AND $1::numeric <= $2::numeric) AS ok`,
    [input.score, assessment.max_score],
  );
  if (!scoreOk.rows[0]?.ok) throw validationError("score must be between 0 and the assessment max_score");

  const learner = await tx.query(
    `SELECT id FROM learners WHERE tenant_id = $1 AND id = $2 AND active = true`,
    [input.tenantId, input.learner_id],
  );
  if (learner.rowCount === 0) throw validationError("learner_id must be an active learner in this school");
  // Review A9-1: the write is authorised against the assessment's class, so the learner must be
  // a member of that class (an archived membership still counts for a mid-year move).
  const member = await tx.query(
    `SELECT 1 FROM class_memberships WHERE tenant_id = $1 AND learner_id = $2 AND class_id = $3 LIMIT 1`,
    [input.tenantId, input.learner_id, assessment.class_id],
  );
  if (member.rowCount === 0) throw validationError("learner_id is not a member of the assessment's class");

  const existing = await tx.query<{ id: string; row_version: number }>(
    `SELECT id, row_version FROM mark_entries
      WHERE tenant_id = $1 AND assessment_id = $2 AND learner_id = $3
      FOR UPDATE`,
    [input.tenantId, input.assessmentId, input.learner_id],
  );
  const current = existing.rows[0];
  try {
    if (!current) {
      if (input.rowVersion !== null && input.rowVersion !== 0) {
        throw conflict("The mark was updated by someone else");
      }
      const inserted = await tx.query(
        `INSERT INTO mark_entries
           (tenant_id, assessment_id, learner_id, score, grade, marked_by, row_version)
         VALUES ($1, $2, $3, $4, $5, $6, 1)
         RETURNING ${MARK_RETURNING}`,
        [input.tenantId, input.assessmentId, input.learner_id, input.score, grade, input.actorUserId],
      );
      const row = inserted.rows[0] as Parameters<typeof mapMark>[0];
      await recordSecurityEvent(tx, {
        eventType: "academics.mark.upserted",
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        detail: { markId: row.id, assessmentId: row.assessment_id, learnerId: row.learner_id, rowVersion: row.row_version },
        ip: input.ip,
      });
      return mapMark(row);
    }
    if (input.rowVersion === null || input.rowVersion !== current.row_version) {
      throw conflict("The mark was updated by someone else");
    }
    const updated = await tx.query(
      `UPDATE mark_entries
          SET score = $3, grade = $4, marked_at = now(), marked_by = $5, row_version = row_version + 1
        WHERE id = $1 AND row_version = $2
        RETURNING ${MARK_RETURNING}`,
      [current.id, input.rowVersion, input.score, grade, input.actorUserId],
    );
    const row = updated.rows[0] as Parameters<typeof mapMark>[0] | undefined;
    if (!row) throw conflict("The mark was updated by someone else");
    await recordSecurityEvent(tx, {
      eventType: "academics.mark.upserted",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { markId: row.id, assessmentId: row.assessment_id, learnerId: row.learner_id, rowVersion: row.row_version },
      ip: input.ip,
    });
    return mapMark(row);
  } catch (err) {
    if (pgCode(err) === "23505") throw conflict("A mark for this learner already exists");
    if (pgCode(err) === "23503") throw validationError("Learner or assessment must belong to this school");
    // OD-1 lock trigger (migration 035): the assessment was published concurrently.
    if (pgCode(err) === "23514") throw conflict("Marks of a published assessment are locked. Record a correction instead.");
    throw err;
  }
}

/** Marks of one assessment. The caller has already resolved the assessment within its scope. */
export async function listMarks(
  tx: Tx,
  input: { tenantId: string; assessmentId: string; page: PageInput },
): Promise<Page<PublicMark>> {
  const out = await pageQuery<Parameters<typeof mapMark>[0]>(
    tx,
    `SELECT ${MARK_RETURNING} FROM mark_entries WHERE tenant_id = $1 AND assessment_id = $2`,
    [input.tenantId, input.assessmentId],
    { name: "marks", expr: "q.learner_id::text", type: "text", dir: "asc" },
    input.page,
  );
  return { items: out.rows.map(mapMark), page: out.page };
}

export async function getMarkById(tx: Tx, input: { tenantId: string; markId: string }): Promise<PublicMark | null> {
  const res = await tx.query(`SELECT ${MARK_RETURNING} FROM mark_entries WHERE tenant_id = $1 AND id = $2`, [
    input.tenantId,
    input.markId,
  ]);
  const row = res.rows[0] as Parameters<typeof mapMark>[0] | undefined;
  return row ? mapMark(row) : null;
}

export interface PublicMarkCorrection {
  id: string;
  tenantId: string;
  assessment_id: string;
  learner_id: string;
  previous_score: string | null;
  previous_grade: string | null;
  new_score: string;
  new_grade: string | null;
  resulting_row_version: number;
  reason: string;
  corrected_by: string;
  corrected_at: string;
}

type CorrectionRow = {
  id: string;
  tenant_id: string;
  assessment_id: string;
  learner_id: string;
  previous_score: string | null;
  previous_grade: string | null;
  new_score: string;
  new_grade: string | null;
  resulting_row_version: number;
  reason: string;
  corrected_by: string;
  corrected_at: Date | string;
};

const CORRECTION_COLS = `id, tenant_id, assessment_id, learner_id, previous_score::text AS previous_score,
  previous_grade, new_score::text AS new_score, new_grade, resulting_row_version, reason, corrected_by, corrected_at`;

function mapCorrection(row: CorrectionRow): PublicMarkCorrection {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    assessment_id: row.assessment_id,
    learner_id: row.learner_id,
    previous_score: row.previous_score,
    previous_grade: row.previous_grade,
    new_score: row.new_score,
    new_grade: row.new_grade,
    resulting_row_version: row.resulting_row_version,
    reason: row.reason,
    corrected_by: row.corrected_by,
    corrected_at: isoStamp(row.corrected_at)!,
  };
}

/**
 * OD-1 correction of a mark on a published assessment. Only for non-draft assessments (a draft is
 * edited directly), only by academics writers (the route enforces resource.academics.write; class
 * assessors cannot correct), with a reason, against the current row_version (0 when the learner has
 * no mark yet). The original value stays in mark_corrections; the database refuses any change to a
 * published mark that has no matching correction row (migration 035).
 */
export async function correctMark(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    assessmentId: string;
    learner_id: string;
    score: number;
    grade?: string | null;
    reason: string;
    rowVersion: number;
    ip?: string | null;
  },
): Promise<{ correction: PublicMarkCorrection; mark: PublicMark }> {
  const assessment = await getAssessmentById(tx, {
    tenantId: input.tenantId,
    assessmentId: input.assessmentId,
    lock: true,
  });
  if (assessment.status === "draft") {
    throw conflict("This assessment is not published yet. Edit the mark directly.");
  }
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500) throw validationError("reason must be 5–500 characters");
  const grade =
    input.grade === undefined || input.grade === null || input.grade.trim() === ""
      ? null
      : trim(input.grade, "grade", 16);
  const scoreOk = await tx.query<{ ok: boolean }>(
    `SELECT ($1::numeric >= 0 AND $1::numeric <= $2::numeric) AS ok`,
    [input.score, assessment.max_score],
  );
  if (!scoreOk.rows[0]?.ok) throw validationError("score must be between 0 and the assessment max_score");
  const member = await tx.query(
    `SELECT 1 FROM class_memberships WHERE tenant_id = $1 AND learner_id = $2 AND class_id = $3 LIMIT 1`,
    [input.tenantId, input.learner_id, assessment.class_id],
  );
  if (member.rowCount === 0) throw validationError("learner_id is not a member of the assessment's class");

  const current = await tx.query<{ id: string; score: string; grade: string | null; row_version: number }>(
    `SELECT id, score::text AS score, grade, row_version FROM mark_entries
      WHERE tenant_id = $1 AND assessment_id = $2 AND learner_id = $3
      FOR UPDATE`,
    [input.tenantId, input.assessmentId, input.learner_id],
  );
  const existing = current.rows[0];
  const currentVersion = existing ? existing.row_version : 0;
  if (input.rowVersion !== currentVersion) throw conflict("The mark was updated by someone else");
  if (existing) {
    const same = await tx.query<{ same: boolean }>(`SELECT ($1::numeric = $2::numeric) AS same`, [
      existing.score,
      input.score,
    ]);
    if (same.rows[0]?.same && existing.grade === grade) {
      throw validationError("The correction does not change the mark");
    }
  }
  try {
    const correction = await tx.query<CorrectionRow>(
      `INSERT INTO mark_corrections
         (tenant_id, assessment_id, learner_id, previous_score, previous_grade, new_score, new_grade,
          resulting_row_version, reason, corrected_by)
       VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, $8, $9, $10)
       RETURNING ${CORRECTION_COLS}`,
      [
        input.tenantId,
        input.assessmentId,
        input.learner_id,
        existing ? existing.score : null,
        existing ? existing.grade : null,
        input.score,
        grade,
        currentVersion + 1,
        reason,
        input.actorUserId,
      ],
    );
    const markRes = existing
      ? await tx.query(
          `UPDATE mark_entries
              SET score = $3, grade = $4, marked_at = now(), marked_by = $5, row_version = row_version + 1
            WHERE id = $1 AND row_version = $2
            RETURNING ${MARK_RETURNING}`,
          [existing.id, currentVersion, input.score, grade, input.actorUserId],
        )
      : await tx.query(
          `INSERT INTO mark_entries (tenant_id, assessment_id, learner_id, score, grade, marked_by, row_version)
           VALUES ($1, $2, $3, $4, $5, $6, 1)
           RETURNING ${MARK_RETURNING}`,
          [input.tenantId, input.assessmentId, input.learner_id, input.score, grade, input.actorUserId],
        );
    const markRow = markRes.rows[0] as Parameters<typeof mapMark>[0] | undefined;
    if (!markRow) throw conflict("The mark was updated by someone else");
    const row = correction.rows[0]!;
    // Audit: ids and versions only. Scores and the free-text reason live in mark_corrections.
    await recordSecurityEvent(tx, {
      eventType: "academics.mark.corrected",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: {
        correctionId: row.id,
        markId: markRow.id,
        assessmentId: input.assessmentId,
        learnerId: input.learner_id,
        fromRowVersion: currentVersion,
        toRowVersion: row.resulting_row_version,
      },
      ip: input.ip,
    });
    return { correction: mapCorrection(row), mark: mapMark(markRow) };
  } catch (err) {
    const code = pgCode(err);
    if (code === "23505" || code === "FB409") throw conflict("The mark was updated by someone else");
    if (code === "23503") throw validationError("Learner or assessment must belong to this school");
    throw err;
  }
}

export async function listMarkCorrections(
  tx: Tx,
  input: { tenantId: string; assessmentId: string; page: PageInput },
): Promise<Page<PublicMarkCorrection>> {
  const out = await pageQuery<CorrectionRow>(
    tx,
    `SELECT ${CORRECTION_COLS} FROM mark_corrections WHERE tenant_id = $1 AND assessment_id = $2`,
    [input.tenantId, input.assessmentId],
    { name: "mark_corrections", expr: "q.corrected_at", type: "timestamptz", dir: "asc" },
    input.page,
  );
  return { items: out.rows.map(mapCorrection), page: out.page };
}

export async function getMarkCorrectionById(
  tx: Tx,
  input: { tenantId: string; correctionId: string },
): Promise<{ correction: PublicMarkCorrection; mark: PublicMark } | null> {
  const res = await tx.query<CorrectionRow>(
    `SELECT ${CORRECTION_COLS} FROM mark_corrections WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.correctionId],
  );
  const row = res.rows[0];
  if (!row) return null;
  const mark = await tx.query<{ id: string }>(
    `SELECT id FROM mark_entries WHERE tenant_id = $1 AND assessment_id = $2 AND learner_id = $3`,
    [input.tenantId, row.assessment_id, row.learner_id],
  );
  const markId = mark.rows[0]?.id;
  if (!markId) return null;
  // Replay returns the mark exactly as this correction left it (same transaction: marked_at equals
  // corrected_at, marked_by equals corrected_by), not a later state.
  const correction = mapCorrection(row);
  return {
    correction,
    mark: {
      id: markId,
      tenantId: row.tenant_id,
      assessment_id: row.assessment_id,
      learner_id: row.learner_id,
      score: row.new_score,
      grade: row.new_grade,
      marked_at: correction.corrected_at,
      marked_by: row.corrected_by,
      row_version: row.resulting_row_version,
    },
  };
}

/** How learners hand a piece of homework in. The same three values as the live app (packages/shared/src/homework.ts, HandIn). */
export const HOMEWORK_HAND_IN = ["paper", "in_person", "upload"] as const;
export type HomeworkHandIn = (typeof HOMEWORK_HAND_IN)[number];

/**
 * The "For parents" guide of a homework item, written for a parent (docs/HOMEWORK.md). The same shape as the live
 * `assignments.parent_guide`: every key is optional, a key that says nothing is left out, and an item with no guide has none.
 */
export interface HomeworkParentGuide {
  about?: string;
  needs?: string[];
  help?: string;
  avoid?: string;
  minutes?: number;
}

/** What a client may send for a guide (blank strings and a null `minutes` are tidied away, as the live `cleanGuide` does). */
export interface HomeworkParentGuideInput {
  about?: string;
  needs?: string[];
  help?: string;
  avoid?: string;
  minutes?: number | null;
}

const GUIDE_NEED_MAX = 80;
const GUIDE_MAX_NEEDS = 20;

/** Tidies a guide for saving, as the live `cleanGuide` does: trimmed, needs de-duplicated (any case) and capped, minutes 1 to 600; a guide that says nothing is null. */
export function tidyParentGuide(input: HomeworkParentGuideInput | null | undefined): HomeworkParentGuide | null {
  if (!input) return null;
  const out: HomeworkParentGuide = {};
  const about = input.about?.trim();
  if (about) out.about = about;
  const needs: string[] = [];
  for (const raw of input.needs ?? []) {
    const need = raw.trim().slice(0, GUIDE_NEED_MAX);
    if (need && !needs.some((n) => n.toLowerCase() === need.toLowerCase())) needs.push(need);
  }
  if (needs.length) out.needs = needs.slice(0, GUIDE_MAX_NEEDS);
  const help = input.help?.trim();
  if (help) out.help = help;
  const avoid = input.avoid?.trim();
  if (avoid) out.avoid = avoid;
  if (input.minutes !== null && input.minutes !== undefined) {
    if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 600) {
      throw validationError("minutes must be a whole number from 1 to 600");
    }
    out.minutes = input.minutes;
  }
  if (Object.keys(out).length === 0) return null;
  return out;
}

/** Reads a stored guide defensively: only the five known keys, with their types, and null when nothing is left. */
export function readParentGuide(raw: unknown): HomeworkParentGuide | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: HomeworkParentGuide = {};
  for (const key of ["about", "help", "avoid"] as const) {
    const v = r[key];
    if (typeof v === "string" && v.trim()) out[key] = v.trim();
  }
  if (Array.isArray(r.needs)) {
    const needs = r.needs.filter((n): n is string => typeof n === "string" && n.trim() !== "").map((n) => n.trim());
    if (needs.length) out.needs = needs;
  }
  if (typeof r.minutes === "number" && Number.isInteger(r.minutes) && r.minutes >= 1 && r.minutes <= 600) out.minutes = r.minutes;
  return Object.keys(out).length ? out : null;
}

/**
 * What a LEARNER is shown of a guide: what to bring and how long it takes. The other three parts ("how you can help", "please
 * avoid", what it is about) are written to a parent, and the learner's screens never show them (docs/HOMEWORK.md).
 */
export function learnerParentGuide(guide: HomeworkParentGuide | null): HomeworkParentGuide | null {
  if (!guide) return null;
  const out: HomeworkParentGuide = {};
  if (guide.needs?.length) out.needs = guide.needs;
  if (guide.minutes !== undefined) out.minutes = guide.minutes;
  return Object.keys(out).length ? out : null;
}

/**
 * The name of whoever set a homework item: their staff record in this school (a current one first), else the name on their own
 * account. A name only: no id, e-mail, phone or title. NULL for an item whose creator account is gone. `h` is the item's alias.
 */
export const HOMEWORK_TEACHER_NAME_SQL = `COALESCE(
  (SELECT sm.full_name FROM staff_members sm
    WHERE sm.tenant_id = h.tenant_id AND sm.user_id = h.created_by
    ORDER BY (sm.archived_at IS NOT NULL), sm.created_at LIMIT 1),
  (SELECT NULLIF(btrim(u.full_name), '') FROM users u WHERE u.id = h.created_by))`;

export interface PublicHomework {
  id: string;
  tenantId: string;
  class_id: string;
  subject_id: string;
  term_id: string;
  title: string;
  due_on: string;
  /** The instructions. May be empty. */
  body: string;
  hand_in: HomeworkHandIn;
  parent_guide: HomeworkParentGuide | null;
  /** Who set it (a name only), or null. */
  teacher_name: string | null;
  created_at: string;
  /** Null on every listed item: an archived item leaves the lists, and only the archive call itself returns one with a date. */
  archived_at: string | null;
}

export async function createHomework(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    class_id: string;
    subject_id: string;
    term_id: string;
    title: string;
    due_on: string;
    body: string;
    hand_in?: HomeworkHandIn;
    parent_guide?: HomeworkParentGuideInput | null;
    ip?: string | null;
  },
): Promise<PublicHomework> {
  const title = trim(input.title, "title", 160);
  const body = input.body;
  if (body.length > 8000) throw validationError("body must be at most 8000 characters");
  const guide = tidyParentGuide(input.parent_guide);
  await getClassById(tx, { tenantId: input.tenantId, classId: input.class_id });
  await getSubjectById(tx, { tenantId: input.tenantId, subjectId: input.subject_id });
  await getTermById(tx, { tenantId: input.tenantId, termId: input.term_id });
  let id: string;
  try {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO homework_items
         (tenant_id, class_id, subject_id, term_id, title, due_on, body, hand_in, parent_guide, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9::jsonb, $10)
       RETURNING id`,
      [
        input.tenantId,
        input.class_id,
        input.subject_id,
        input.term_id,
        title,
        input.due_on,
        body,
        input.hand_in ?? "paper",
        guide === null ? null : JSON.stringify(guide),
        input.actorUserId,
      ],
    );
    id = res.rows[0]!.id;
  } catch (err) {
    // The database repeats the guide/body/hand-in checks; never forward raw constraint text.
    if (pgCode(err) === "23514") throw validationError("The homework does not fit the allowed sizes and values");
    throw err;
  }
  await recordSecurityEvent(tx, {
    eventType: "academics.homework.created",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { homeworkId: id, classId: input.class_id },
    ip: input.ip,
  });
  return (await getHomeworkById(tx, { tenantId: input.tenantId, homeworkId: id }))!;
}

type HomeworkRow = {
  id: string;
  tenant_id: string;
  class_id: string;
  subject_id: string;
  term_id: string;
  title: string;
  due_on: Date | string;
  body: string;
  hand_in: HomeworkHandIn;
  parent_guide: unknown;
  teacher_name: string | null;
  created_at: Date | string;
  archived_at: Date | string | null;
};

const HOMEWORK_SELECT = `SELECT h.id, h.tenant_id, h.class_id, h.subject_id, h.term_id, h.title, h.due_on, h.body, h.hand_in,
       h.parent_guide, ${HOMEWORK_TEACHER_NAME_SQL} AS teacher_name, h.created_at, h.archived_at
  FROM homework_items h`;

function mapHomework(row: HomeworkRow): PublicHomework {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    class_id: row.class_id,
    subject_id: row.subject_id,
    term_id: row.term_id,
    title: row.title,
    due_on: isoDate(row.due_on),
    body: row.body,
    hand_in: row.hand_in,
    parent_guide: readParentGuide(row.parent_guide),
    teacher_name: row.teacher_name,
    created_at: isoStamp(row.created_at)!,
    archived_at: isoStamp(row.archived_at),
  };
}

/**
 * `classIds`, when given, limits the list to those classes (the teacher reads, docs/TEACHER-READS.md: the classes the caller
 * teaches). It is bound as a parameter, so it is part of the cursor fingerprint: a cursor cannot be replayed under another scope.
 */
export async function listHomework(
  tx: Tx,
  input: { tenantId: string; classId?: string; classIds?: readonly string[]; page: PageInput },
): Promise<Page<PublicHomework>> {
  const params: unknown[] = [input.tenantId];
  // An archived item is in no list (docs/HOMEWORK.md).
  let classClause = " AND h.archived_at IS NULL";
  if (input.classId) {
    params.push(input.classId);
    classClause += ` AND h.class_id = $${params.length}`;
  }
  if (input.classIds) {
    params.push([...input.classIds]);
    classClause += ` AND h.class_id = ANY($${params.length}::uuid[])`;
  }
  const out = await pageQuery<HomeworkRow>(
    tx,
    `${HOMEWORK_SELECT} WHERE h.tenant_id = $1${classClause}`,
    params,
    { name: "homework", expr: "q.due_on", type: "date", dir: "asc" },
    input.page,
  );
  return { items: out.rows.map(mapHomework), page: out.page };
}

/**
 * A9-6: replays read the row by id. An ARCHIVED item is returned too (with its `archived_at`): a repeat of an archive call with the
 * same Idempotency-Key must find what the first call did. Lists and the family read never return one.
 */
export async function getHomeworkById(tx: Tx, input: { tenantId: string; homeworkId: string }): Promise<PublicHomework | null> {
  const res = await tx.query<HomeworkRow>(`${HOMEWORK_SELECT} WHERE h.tenant_id = $1 AND h.id = $2`, [input.tenantId, input.homeworkId]);
  return res.rows[0] ? mapHomework(res.rows[0]) : null;
}

type HomeworkPatchInput = {
  class_id?: string;
  subject_id?: string;
  title?: string;
  due_on?: string;
  body?: string;
  hand_in?: HomeworkHandIn;
  /** A guide replaces the stored one; null (or one that says nothing) clears it; left out keeps it. */
  parent_guide?: HomeworkParentGuideInput | null;
};

/**
 * Partial update of a homework item (docs/HOMEWORK.md): a field left out keeps its value, `parent_guide: null` clears the guide.
 * The row is locked first (the same pattern as updateClass). Changing the class or subject checks the new one exists in this
 * school. The term cannot change. An archived item cannot be changed (409). Changing nothing writes nothing and no audit event.
 */
export async function updateHomework(
  tx: Tx,
  input: HomeworkPatchInput & { tenantId: string; homeworkId: string; actorUserId: string; ip?: string | null },
): Promise<PublicHomework> {
  const found = await tx.query<{
    class_id: string;
    subject_id: string;
    title: string;
    due_on: string;
    body: string;
    hand_in: HomeworkHandIn;
    parent_guide: unknown;
    archived_at: Date | string | null;
  }>(
    `SELECT class_id, subject_id, title, due_on::text AS due_on, body, hand_in, parent_guide, archived_at
       FROM homework_items WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.homeworkId],
  );
  const current = found.rows[0];
  if (!current) throw notFound("Homework not found");
  if (current.archived_at !== null) throw conflict("Archived homework cannot be changed");

  const currentGuide = readParentGuide(current.parent_guide);
  const next = {
    class_id: input.class_id ?? current.class_id,
    subject_id: input.subject_id ?? current.subject_id,
    title: input.title !== undefined ? trim(input.title, "title", 160) : current.title,
    due_on: input.due_on ?? current.due_on,
    body: input.body ?? current.body,
    hand_in: input.hand_in ?? current.hand_in,
    parent_guide: input.parent_guide !== undefined ? tidyParentGuide(input.parent_guide) : currentGuide,
  };
  if (next.body.length > 8000) throw validationError("body must be at most 8000 characters");
  if (next.class_id !== current.class_id) await getClassById(tx, { tenantId: input.tenantId, classId: next.class_id });
  if (next.subject_id !== current.subject_id) await getSubjectById(tx, { tenantId: input.tenantId, subjectId: next.subject_id });

  const changed: string[] = [];
  if (next.class_id !== current.class_id) changed.push("class_id");
  if (next.subject_id !== current.subject_id) changed.push("subject_id");
  if (next.title !== current.title) changed.push("title");
  if (next.due_on !== current.due_on) changed.push("due_on");
  if (next.body !== current.body) changed.push("body");
  if (next.hand_in !== current.hand_in) changed.push("hand_in");
  if (JSON.stringify(next.parent_guide) !== JSON.stringify(currentGuide)) changed.push("parent_guide");
  if (changed.length === 0) return (await getHomeworkById(tx, input))!;

  try {
    await tx.query(
      `UPDATE homework_items
          SET class_id = $3, subject_id = $4, title = $5, due_on = $6::date, body = $7, hand_in = $8, parent_guide = $9::jsonb,
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL`,
      [
        input.tenantId,
        input.homeworkId,
        next.class_id,
        next.subject_id,
        next.title,
        next.due_on,
        next.body,
        next.hand_in,
        next.parent_guide === null ? null : JSON.stringify(next.parent_guide),
      ],
    );
  } catch (err) {
    // The CHECKs repeat the checks above; never forward a raw constraint text.
    if (pgCode(err) === "23514") throw validationError("The homework does not fit the allowed sizes and values");
    throw err;
  }
  await recordSecurityEvent(tx, {
    eventType: "academics.homework.updated",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    // Field names only, never their values: a title or a guide is the school's own words.
    detail: { homeworkId: input.homeworkId, fields: changed },
    ip: input.ip,
  });
  return (await getHomeworkById(tx, input))!;
}

/**
 * Archive a homework item: "delete" on the API (decision N10). It leaves the teacher lists and the family and learner reads,
 * nothing is removed, and there is no restore. Archiving an archived item is refused (409) and changes nothing.
 */
export async function archiveHomework(
  tx: Tx,
  input: { tenantId: string; homeworkId: string; actorUserId: string; ip?: string | null },
): Promise<PublicHomework> {
  const found = await tx.query<{ class_id: string; archived_at: Date | string | null }>(
    `SELECT class_id, archived_at FROM homework_items WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.homeworkId],
  );
  const current = found.rows[0];
  if (!current) throw notFound("Homework not found");
  if (current.archived_at !== null) throw conflict("Homework is already archived");
  await tx.query(
    `UPDATE homework_items SET archived_at = now(), archived_by = $3, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL`,
    [input.tenantId, input.homeworkId, input.actorUserId],
  );
  await recordSecurityEvent(tx, {
    eventType: "academics.homework.archived",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { homeworkId: input.homeworkId, classId: current.class_id },
    ip: input.ip,
  });
  return (await getHomeworkById(tx, input))!;
}

export interface PublicMaterial {
  id: string;
  tenantId: string;
  title: string;
  description: string | null;
  class_id: string | null;
  subject_id: string | null;
  url: string | null;
  storage_status: "metadata_only";
  published_at: string | null;
  archived_at: string | null;
  created_at: string;
}

function materialUrl(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  const url = value.trim();
  if (url.length > 2000) throw validationError("url must be at most 2000 characters");
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) throw new Error("invalid");
  } catch {
    throw validationError("url must be a valid HTTPS link");
  }
  return url;
}

export async function registerLearningMaterial(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    title: string;
    description?: string | null;
    class_id?: string | null;
    subject_id?: string | null;
    url?: string | null;
    ip?: string | null;
  },
): Promise<PublicMaterial> {
  const title = trim(input.title, "title", 160);
  const description =
    input.description === undefined || input.description === null || input.description.trim() === ""
      ? null
      : input.description;
  if (description && description.length > 4000) throw validationError("description must be at most 4000 characters");
  const url = materialUrl(input.url);
  if (input.class_id) await getClassById(tx, { tenantId: input.tenantId, classId: input.class_id });
  if (input.subject_id) await getSubjectById(tx, { tenantId: input.tenantId, subjectId: input.subject_id });
  const res = await tx.query<{
    id: string;
    tenant_id: string;
    title: string;
    description: string | null;
    class_id: string | null;
    subject_id: string | null;
    url: string | null;
    storage_status: "metadata_only";
    published_at: Date | string | null;
    archived_at: Date | string | null;
    created_at: Date | string;
  }>(
    `INSERT INTO learning_materials
       (tenant_id, title, description, class_id, subject_id, url, storage_key, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
     RETURNING id, tenant_id, title, description, class_id, subject_id, url, storage_status, published_at, archived_at, created_at`,
    [input.tenantId, title, description, input.class_id ?? null, input.subject_id ?? null, url, input.actorUserId],
  );
  const row = res.rows[0]!;
  await recordSecurityEvent(tx, {
    eventType: "academics.material.registered",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { materialId: row.id },
    ip: input.ip,
  });
  return {
    id: row.id,
    tenantId: row.tenant_id,
    title: row.title,
    description: row.description,
    class_id: row.class_id,
    subject_id: row.subject_id,
    url: row.url,
    storage_status: "metadata_only",
    published_at: isoStamp(row.published_at),
    archived_at: isoStamp(row.archived_at),
    created_at: isoStamp(row.created_at)!,
  };
}

type MaterialRow = {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  class_id: string | null;
  subject_id: string | null;
  url: string | null;
  storage_status: "metadata_only";
  published_at: Date | string | null;
  archived_at: Date | string | null;
  created_at: Date | string;
};

const MATERIAL_COLS = `id, tenant_id, title, description, class_id, subject_id, url, storage_status, published_at, archived_at, created_at`;

function mapMaterial(row: MaterialRow): PublicMaterial {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    title: row.title,
    description: row.description,
    class_id: row.class_id,
    subject_id: row.subject_id,
    url: row.url,
    storage_status: "metadata_only",
    published_at: isoStamp(row.published_at),
    archived_at: isoStamp(row.archived_at),
    created_at: isoStamp(row.created_at)!,
  };
}

/**
 * `classIds`, when given, limits the list to those classes (the teacher reads, docs/TEACHER-READS.md); `includeSchoolWide`
 * also lists the materials that name no class (shared with every class). Both are bound parameters, so they are part of
 * the cursor fingerprint.
 */
export async function listLearningMaterials(
  tx: Tx,
  input: { tenantId: string; classId?: string; classIds?: readonly string[]; includeSchoolWide?: boolean; page: PageInput },
): Promise<Page<PublicMaterial>> {
  const params: unknown[] = [input.tenantId];
  let classClause = " AND archived_at IS NULL";
  if (input.classId) {
    params.push(input.classId);
    classClause += ` AND class_id = $${params.length}`;
  }
  if (input.classIds) {
    params.push([...input.classIds]);
    classClause += input.includeSchoolWide
      ? ` AND (class_id = ANY($${params.length}::uuid[]) OR class_id IS NULL)`
      : ` AND class_id = ANY($${params.length}::uuid[])`;
  }
  const out = await pageQuery<MaterialRow>(
    tx,
    `SELECT ${MATERIAL_COLS} FROM learning_materials WHERE tenant_id = $1${classClause}`,
    params,
    { name: "materials", expr: "q.created_at", type: "timestamptz", dir: "desc" },
    input.page,
  );
  return { items: out.rows.map(mapMaterial), page: out.page };
}

export async function getLearningMaterialById(
  tx: Tx,
  input: { tenantId: string; materialId: string },
): Promise<PublicMaterial | null> {
  const res = await tx.query<MaterialRow>(`SELECT ${MATERIAL_COLS} FROM learning_materials WHERE tenant_id = $1 AND id = $2`, [
    input.tenantId,
    input.materialId,
  ]);
  return res.rows[0] ? mapMaterial(res.rows[0]) : null;
}

export async function updateLearningMaterial(
  tx: Tx,
  input: {
    tenantId: string;
    materialId: string;
    actorUserId: string;
    title?: string;
    description?: string | null;
    class_id?: string | null;
    subject_id?: string | null;
    url?: string | null;
    ip?: string | null;
  },
): Promise<PublicMaterial> {
  const fields: string[] = [];
  const values: unknown[] = [input.tenantId, input.materialId];
  const set = (column: string, value: unknown) => {
    values.push(value);
    fields.push(`${column} = $${values.length}`);
  };
  if (input.title !== undefined) set("title", trim(input.title, "title", 160));
  if (input.description !== undefined) {
    const description = input.description?.trim() || null;
    if (description && description.length > 4000) throw validationError("description must be at most 4000 characters");
    set("description", description);
  }
  if (input.class_id !== undefined) {
    if (input.class_id) await getClassById(tx, { tenantId: input.tenantId, classId: input.class_id });
    set("class_id", input.class_id);
  }
  if (input.subject_id !== undefined) {
    if (input.subject_id) await getSubjectById(tx, { tenantId: input.tenantId, subjectId: input.subject_id });
    set("subject_id", input.subject_id);
  }
  if (input.url !== undefined) set("url", materialUrl(input.url));
  const current = await tx.query<{ archived_at: Date | string | null }>(
    `SELECT archived_at FROM learning_materials WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.materialId],
  );
  if (!current.rows[0]) throw notFound("Learning material not found");
  if (current.rows[0].archived_at !== null) throw conflict("Archived learning material cannot be changed");
  if (fields.length === 0) return (await getLearningMaterialById(tx, input))!;
  const out = await tx.query(
    `UPDATE learning_materials SET ${fields.join(", ")} WHERE tenant_id = $1 AND id = $2 RETURNING id`,
    values,
  );
  if (!out.rows[0]) throw notFound("Learning material not found");
  await recordSecurityEvent(tx, {
    eventType: "academics.material.updated",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { materialId: input.materialId, fields: fields.map((field) => field.split(" = ")[0]) },
    ip: input.ip,
  });
  return (await getLearningMaterialById(tx, input))!;
}

export async function archiveLearningMaterial(
  tx: Tx,
  input: { tenantId: string; materialId: string; actorUserId: string; ip?: string | null },
): Promise<PublicMaterial> {
  const found = await tx.query<{ archived_at: Date | string | null }>(
    `SELECT archived_at FROM learning_materials WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.materialId],
  );
  const current = found.rows[0];
  if (!current) throw notFound("Learning material not found");
  if (current.archived_at !== null) return (await getLearningMaterialById(tx, input))!;
  await tx.query(`UPDATE learning_materials SET archived_at = now() WHERE tenant_id = $1 AND id = $2`, [input.tenantId, input.materialId]);
  await recordSecurityEvent(tx, {
    eventType: "academics.material.archived",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { materialId: input.materialId },
    ip: input.ip,
  });
  return (await getLearningMaterialById(tx, input))!;
}

export async function setLearningMaterialPublished(
  tx: Tx,
  input: { tenantId: string; materialId: string; actorUserId: string; published: boolean; ip?: string | null },
): Promise<PublicMaterial> {
  const current = await tx.query<{ published_at: Date | string | null; archived_at: Date | string | null }>(
    `SELECT published_at, archived_at FROM learning_materials WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.materialId],
  );
  const row = current.rows[0];
  if (!row) throw notFound("Learning material not found");
  if (row.archived_at !== null) throw conflict("Archived learning material cannot be published");
  if ((row.published_at !== null) === input.published) return (await getLearningMaterialById(tx, input))!;
  await tx.query(
    `UPDATE learning_materials SET published_at = ${input.published ? "now()" : "NULL"} WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.materialId],
  );
  await recordSecurityEvent(tx, {
    eventType: input.published ? "academics.material.published" : "academics.material.unpublished",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { materialId: input.materialId },
    ip: input.ip,
  });
  return (await getLearningMaterialById(tx, input))!;
}

export interface GradeBand {
  min: number;
  max: number;
  grade: string;
}

/** Bands cover 0–100 without gaps or overlaps. min is inclusive, max is exclusive except the last band. */
export function parseGradingRules(rules: unknown): { bands: GradeBand[] } {
  if (!rules || typeof rules !== "object" || !Array.isArray((rules as { bands?: unknown }).bands)) {
    throw validationError("rules.bands must be a non-empty array of {min, max, grade}");
  }
  const raw = (rules as { bands: unknown[] }).bands;
  if (raw.length < 1) throw validationError("rules.bands must be a non-empty array of {min, max, grade}");
  const bands: GradeBand[] = raw.map((item) => {
    if (!item || typeof item !== "object") throw validationError("each band needs min, max and grade");
    const band = item as { min?: unknown; max?: unknown; grade?: unknown };
    if (typeof band.min !== "number" || typeof band.max !== "number" || typeof band.grade !== "string") {
      throw validationError("each band needs numeric min, numeric max and a grade");
    }
    const grade = band.grade.trim();
    if (grade.length < 1 || grade.length > 16) throw validationError("grade must be 1–16 characters");
    if (!(band.min < band.max)) throw validationError("each band max must be greater than min");
    return { min: band.min, max: band.max, grade };
  });
  const ordered = [...bands].sort((a, b) => a.min - b.min);
  if (ordered[0]!.min !== 0 || ordered[ordered.length - 1]!.max !== 100) {
    throw validationError("bands must start at 0 and end at 100");
  }
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i]!.min !== ordered[i - 1]!.max) {
      throw validationError("bands must meet without gaps or overlaps");
    }
  }
  return { bands: ordered };
}

export interface PublicGradingScheme {
  id: string;
  tenantId: string;
  name: string;
  version: number;
  rules: { bands: GradeBand[] };
  created_at: string;
}

export async function createGradingScheme(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    name: string;
    version?: number;
    rules: unknown;
    ip?: string | null;
  },
): Promise<PublicGradingScheme> {
  const name = trim(input.name, "name", 80);
  const version = input.version ?? 1;
  if (!Number.isInteger(version) || version < 1) throw validationError("version must be an integer >= 1");
  const rules = parseGradingRules(input.rules);
  try {
    const res = await tx.query<{
      id: string;
      tenant_id: string;
      name: string;
      version: number;
      rules: { bands: GradeBand[] };
      created_at: Date | string;
    }>(
      `INSERT INTO grading_schemes (tenant_id, name, version, rules, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id, tenant_id, name, version, rules, created_at`,
      [input.tenantId, name, version, JSON.stringify(rules), input.actorUserId],
    );
    const row = res.rows[0]!;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      version: row.version,
      rules: row.rules,
      created_at: isoStamp(row.created_at)!,
    };
  } catch (err) {
    if (pgCode(err) === "23505") throw conflict("A grading scheme with this name and version already exists");
    throw err;
  }
}

type SchemeRow = {
  id: string;
  tenant_id: string;
  name: string;
  version: number;
  rules: { bands: GradeBand[] };
  created_at: Date | string;
};

function mapScheme(row: SchemeRow): PublicGradingScheme {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    version: row.version,
    rules: row.rules,
    created_at: isoStamp(row.created_at)!,
  };
}

export async function listGradingSchemes(
  tx: Tx,
  input: { tenantId: string; page: PageInput },
): Promise<Page<PublicGradingScheme>> {
  const out = await pageQuery<SchemeRow>(
    tx,
    `SELECT id, tenant_id, name, version, rules, created_at FROM grading_schemes WHERE tenant_id = $1`,
    [input.tenantId],
    { name: "grading_schemes", expr: "q.created_at", type: "timestamptz", dir: "asc" },
    input.page,
  );
  return { items: out.rows.map(mapScheme), page: out.page };
}

export async function getGradingSchemeById(
  tx: Tx,
  input: { tenantId: string; schemeId: string },
): Promise<PublicGradingScheme | null> {
  const res = await tx.query<SchemeRow>(
    `SELECT id, tenant_id, name, version, rules, created_at FROM grading_schemes WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.schemeId],
  );
  return res.rows[0] ? mapScheme(res.rows[0]) : null;
}

export interface PublicReportCard {
  id: string;
  tenantId: string;
  term_id: string;
  class_id: string;
  published_at: string;
  published_by: string | null;
  figures: {
    method: typeof REPORT_CARD_METHOD;
    assessment_ids: string[];
    grading_scheme_id?: string | null;
    grading_scheme_name?: string | null;
    learners: Array<{
      learner_id: string;
      sum: string;
      count: number;
      average: string | null;
      grade?: string | null;
      assessment_ids: string[];
    }>;
    /** Published CBE snapshot (not reduced to a single average). */
    cbe: {
      assessment_ids: string[];
      learners: Array<{
        learner_id: string;
        results: Array<{
          cbe_assessment_id: string;
          title: string;
          instrument_type: string;
          strand_id: string | null;
          learning_outcome_id: string | null;
          level_code: string;
          points: string;
          observation: string | null;
          teacher_feedback: string | null;
          completion_status: string;
          curriculum_version_label: string | null;
        }>;
      }>;
    };
    /** Term competency/value ratings for class members at publish time. */
    competencies: {
      learners: Array<{
        learner_id: string;
        ratings: Array<{ kind: string; item: string; level_code: string }>;
      }>;
    };
  };
}

export async function publishReportCard(
  tx: Tx,
  input: {
    tenantId: string;
    termId: string;
    classId: string;
    gradingSchemeId?: string | null;
    actorUserId: string;
    ip?: string | null;
  },
): Promise<PublicReportCard> {
  await getClassById(tx, { tenantId: input.tenantId, classId: input.classId });
  await getTermById(tx, { tenantId: input.tenantId, termId: input.termId });
  let scheme: PublicGradingScheme | null = null;
  if (input.gradingSchemeId) {
    scheme = await getGradingSchemeById(tx, { tenantId: input.tenantId, schemeId: input.gradingSchemeId });
    if (!scheme) throw notFound("Grading scheme not found");
  }
  const sources = await tx.query<{ id: string }>(
    `SELECT id FROM assessments
      WHERE tenant_id = $1 AND class_id = $2 AND term_id = $3 AND status = 'published'
      ORDER BY id`,
    [input.tenantId, input.classId, input.termId],
  );
  const perLearner = await tx.query<{
    learner_id: string;
    sum: string;
    count: number;
    average: string | null;
    assessment_ids: string[];
  }>(
    `SELECT m.learner_id,
            SUM(m.score)::text AS sum,
            COUNT(*)::int AS count,
            ROUND(AVG(m.score), 2)::text AS average,
            ARRAY_AGG(a.id ORDER BY a.id) AS assessment_ids
       FROM assessments a
       JOIN mark_entries m ON m.assessment_id = a.id AND m.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1 AND a.class_id = $2 AND a.term_id = $3 AND a.status = 'published'
      GROUP BY m.learner_id
      ORDER BY m.learner_id`,
    [input.tenantId, input.classId, input.termId],
  );
  const cbeAssessments = await tx.query<{ id: string }>(
    `SELECT id FROM cbe_assessments
      WHERE tenant_id = $1 AND class_id = $2 AND term_id = $3 AND status IN ('published', 'closed')
      ORDER BY id`,
    [input.tenantId, input.classId, input.termId],
  );
  const cbeRows = await tx.query<{
    learner_id: string;
    cbe_assessment_id: string;
    title: string;
    instrument_type: string;
    strand_id: string | null;
    learning_outcome_id: string | null;
    level_code: string;
    points: string;
    observation: string | null;
    teacher_feedback: string | null;
    completion_status: string;
    curriculum_version_label: string | null;
  }>(
    `SELECT r.learner_id, r.cbe_assessment_id, a.title, a.instrument_type, r.strand_id, r.learning_outcome_id,
            r.level_code, r.points::text AS points, r.observation, r.teacher_feedback, r.completion_status,
            a.curriculum_version_label
       FROM cbe_results r
       JOIN cbe_assessments a ON a.tenant_id = r.tenant_id AND a.id = r.cbe_assessment_id
      WHERE a.tenant_id = $1 AND a.class_id = $2 AND a.term_id = $3 AND a.status IN ('published', 'closed')
      ORDER BY r.learner_id, r.cbe_assessment_id, r.learning_outcome_id NULLS LAST`,
    [input.tenantId, input.classId, input.termId],
  );
  const cbeByLearner = new Map<string, PublicReportCard["figures"]["cbe"]["learners"][number]["results"]>();
  for (const row of cbeRows.rows) {
    const list = cbeByLearner.get(row.learner_id) ?? [];
    list.push({
      cbe_assessment_id: row.cbe_assessment_id,
      title: row.title,
      instrument_type: row.instrument_type,
      strand_id: row.strand_id,
      learning_outcome_id: row.learning_outcome_id,
      level_code: row.level_code,
      points: row.points,
      observation: row.observation,
      teacher_feedback: row.teacher_feedback,
      completion_status: row.completion_status,
      curriculum_version_label: row.curriculum_version_label,
    });
    cbeByLearner.set(row.learner_id, list);
  }
  const competencyRows = await tx.query<{
    learner_id: string;
    kind: string;
    item: string;
    level_code: string;
  }>(
    `SELECT r.learner_id, r.kind, r.item, r.level_code
       FROM learner_competency_ratings r
       JOIN class_memberships cm
         ON cm.tenant_id = r.tenant_id AND cm.learner_id = r.learner_id AND cm.active = true
      WHERE r.tenant_id = $1 AND r.term_id = $2 AND cm.class_id = $3
      ORDER BY r.learner_id, r.kind, r.item`,
    [input.tenantId, input.termId, input.classId],
  );
  const competencyByLearner = new Map<string, Array<{ kind: string; item: string; level_code: string }>>();
  for (const row of competencyRows.rows) {
    const list = competencyByLearner.get(row.learner_id) ?? [];
    list.push({ kind: row.kind, item: row.item, level_code: row.level_code });
    competencyByLearner.set(row.learner_id, list);
  }
  const gradeForAverage = (avg: string | null): string | null => {
    if (!scheme || avg === null) return null;
    const n = Number(avg);
    if (!Number.isFinite(n)) return null;
    const band = scheme.rules.bands.find((b) => n >= b.min && n <= b.max);
    return band ? band.grade : null;
  };
  const figures: PublicReportCard["figures"] = {
    method: REPORT_CARD_METHOD,
    assessment_ids: sources.rows.map((r) => r.id),
    ...(scheme ? { grading_scheme_id: scheme.id, grading_scheme_name: scheme.name } : {}),
    learners: perLearner.rows.map((row) => ({
      learner_id: row.learner_id,
      sum: row.sum,
      count: row.count,
      average: row.average,
      ...(scheme ? { grade: gradeForAverage(row.average) } : {}),
      assessment_ids: row.assessment_ids,
    })),
    cbe: {
      assessment_ids: cbeAssessments.rows.map((r) => r.id),
      learners: [...cbeByLearner.entries()].map(([learner_id, results]) => ({ learner_id, results })),
    },
    competencies: {
      learners: [...competencyByLearner.entries()].map(([learner_id, ratings]) => ({ learner_id, ratings })),
    },
  };
  const res = await tx.query<{
    id: string;
    tenant_id: string;
    term_id: string;
    class_id: string;
    published_at: Date | string;
    published_by: string | null;
    figures: PublicReportCard["figures"];
  }>(
    `INSERT INTO report_card_publications
       (tenant_id, term_id, class_id, published_by, figures)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id, tenant_id, term_id, class_id, published_at, published_by, figures`,
    [input.tenantId, input.termId, input.classId, input.actorUserId, JSON.stringify(figures)],
  );
  const row = res.rows[0]!;
  await recordSecurityEvent(tx, {
    eventType: "academics.report_card.published",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: {
      reportCardId: row.id,
      classId: row.class_id,
      termId: row.term_id,
      assessmentIds: figures.assessment_ids,
    },
    ip: input.ip,
  });
  return {
    id: row.id,
    tenantId: row.tenant_id,
    term_id: row.term_id,
    class_id: row.class_id,
    published_at: isoStamp(row.published_at)!,
    published_by: row.published_by,
    figures: row.figures,
  };
}

type ReportCardRow = {
  id: string;
  tenant_id: string;
  term_id: string;
  class_id: string;
  published_at: Date | string;
  published_by: string | null;
  figures: PublicReportCard["figures"];
};

function mapReportCard(row: ReportCardRow): PublicReportCard {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    term_id: row.term_id,
    class_id: row.class_id,
    published_at: isoStamp(row.published_at)!,
    published_by: row.published_by,
    figures: row.figures,
  };
}

export async function getReportCardById(
  tx: Tx,
  input: { tenantId: string; reportCardId: string },
): Promise<PublicReportCard> {
  const res = await tx.query<ReportCardRow>(
    `SELECT id, tenant_id, term_id, class_id, published_at, published_by, figures
       FROM report_card_publications WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.reportCardId],
  );
  const row = res.rows[0];
  if (!row) throw notFound("Report card not found");
  return mapReportCard(row);
}

/**
 * List published report-card snapshots. Optional class/term filters.
 * When `scopeClassIds` is set (OD-2 teacher scope), only those classes are returned.
 */
export async function listReportCards(
  tx: Tx,
  input: {
    tenantId: string;
    page: PageInput;
    classId?: string;
    termId?: string;
    scopeClassIds?: string[] | null;
    id?: string;
  },
): Promise<Page<PublicReportCard>> {
  // OD-2 / A9-9: scope before existence probes so out-of-scope and missing classId look the same.
  if (input.scopeClassIds !== undefined && input.scopeClassIds !== null) {
    if (input.scopeClassIds.length === 0) {
      return { items: [], page: { next_cursor: null, limit: input.page.limit } };
    }
    if (input.classId && !input.scopeClassIds.includes(input.classId)) {
      return { items: [], page: { next_cursor: null, limit: input.page.limit } };
    }
  }
  if (input.classId) await getClassById(tx, { tenantId: input.tenantId, classId: input.classId });
  if (input.termId) await getTermById(tx, { tenantId: input.tenantId, termId: input.termId });
  const params: unknown[] = [input.tenantId];
  const filters: string[] = ["tenant_id = $1"];
  if (input.classId) {
    params.push(input.classId);
    filters.push(`class_id = $${params.length}`);
  }
  if (input.termId) {
    params.push(input.termId);
    filters.push(`term_id = $${params.length}`);
  }
  if (input.scopeClassIds != null) {
    params.push(input.scopeClassIds);
    filters.push(`class_id = ANY($${params.length}::uuid[])`);
  }
  const res = await pageQuery<{ id: string }>(
    tx,
    `SELECT id, tenant_id, term_id, class_id, published_at, published_by, figures
       FROM report_card_publications WHERE ${filters.join(" AND ")}`,
    params,
    { name: "report_card_publications", expr: "q.published_at", type: "timestamptz", dir: "desc" },
    input.page,
    input.id,
  );
  const items = (res.rows as unknown as ReportCardRow[]).map(mapReportCard);
  return { items, page: res.page };
}
