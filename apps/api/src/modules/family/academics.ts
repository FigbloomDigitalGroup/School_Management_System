import type { Tx } from "../../db/sql.js";
import { validationError } from "../../http/errors.js";
import {
  HOMEWORK_TEACHER_NAME_SQL,
  learnerParentGuide,
  readParentGuide,
  type HomeworkHandIn,
  type HomeworkParentGuide,
} from "../academics/assessments.js";
import { schoolToday } from "../tenancy/schoolClock.js";
import { currentClasses } from "./children.js";

/**
 * Family reads of one child's school record (docs/FAMILY-READS.md). Every function here takes a learner id that the
 * route has ALREADY proven to be the caller's child (assertMyChild); each statement is still filtered by school and
 * learner, and runs under the forced tenant policy. Nothing returns another learner's row: class figures are reduced to
 * the child's own slice, and a class mean is shown only when at least three learners have a mark.
 */

const MAX_DAYS = 366;
/** A class mean is shown only when at least this many learners have a mark, so it cannot reveal one other child's score. */
export const CLASS_MEAN_MIN_MARKS = 3;

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// ------------------------------------------------------------------------------------------------- attendance

export interface ChildAttendance {
  from: string;
  to: string;
  marks: Array<{ date: string; session: "morning" | "afternoon"; mark: "present" | "absent" | "late" | "excused" }>;
  counts: { morning: Record<string, number>; afternoon: Record<string, number> };
  early_sign_outs: Array<{
    id: string;
    date: string;
    signed_out_at: string;
    reason: string;
    collected_by_name: string;
    collected_by_relationship: string;
  }>;
}

/**
 * Register marks (morning and afternoon) and early sign-outs that were not voided, in [from, to]. Default window: the
 * current term up to today, or the last 90 days when no term is current. At most 366 days.
 */
export async function childAttendance(
  tx: Tx,
  input: { tenantId: string; learnerId: string; from?: string; to?: string },
): Promise<ChildAttendance> {
  const today = await schoolToday(tx, input.tenantId);
  let from = input.from;
  let to = input.to;
  if (!from || !to) {
    const term = await tx.query<{ starts_on: string; ends_on: string }>(
      `SELECT starts_on::text AS starts_on, ends_on::text AS ends_on FROM academic_terms WHERE tenant_id = $1 AND is_current = true LIMIT 1`,
      [input.tenantId],
    );
    const t = term.rows[0];
    to ??= t ? (t.ends_on < today ? t.ends_on : today) : today;
    from ??= t && t.starts_on <= to ? t.starts_on : addDays(to, -90);
  }
  if (from > to) throw validationError("from must not be after to");
  if (daysBetween(from, to) > MAX_DAYS) throw validationError(`the window is at most ${MAX_DAYS} days`);

  const marks = await tx.query<{ date: string; session: "morning" | "afternoon"; mark: ChildAttendance["marks"][number]["mark"] }>(
    `SELECT taken_on::text AS date, 'morning' AS session, mark FROM attendance
      WHERE tenant_id = $1 AND learner_id = $2 AND taken_on BETWEEN $3::date AND $4::date
     UNION ALL
     SELECT taken_on::text AS date, 'afternoon' AS session, mark FROM attendance_afternoon
      WHERE tenant_id = $1 AND learner_id = $2 AND taken_on BETWEEN $3::date AND $4::date
     ORDER BY date, session DESC`,
    [input.tenantId, input.learnerId, from, to],
  );
  const counts: ChildAttendance["counts"] = { morning: {}, afternoon: {} };
  for (const m of marks.rows) counts[m.session][m.mark] = (counts[m.session][m.mark] ?? 0) + 1;

  const signOuts = await tx.query<{
    id: string;
    date: string;
    signed_out_at: Date;
    reason: string;
    collected_by_name: string;
    collected_by_relationship: string;
  }>(
    `SELECT id, taken_on::text AS date, signed_out_at, reason, collected_by_name, collected_by_relationship
       FROM early_sign_outs
      WHERE tenant_id = $1 AND learner_id = $2 AND voided_at IS NULL AND taken_on BETWEEN $3::date AND $4::date
      ORDER BY signed_out_at, id`,
    [input.tenantId, input.learnerId, from, to],
  );
  return {
    from,
    to,
    marks: marks.rows,
    counts,
    early_sign_outs: signOuts.rows.map((s) => ({ ...s, signed_out_at: s.signed_out_at.toISOString() })),
  };
}

// ------------------------------------------------------------------------------------------------- results

export interface ChildResults {
  marks: Array<{
    assessment_id: string;
    title: string;
    kind: string;
    status: "published" | "closed";
    published_at: string | null;
    max_score: string;
    score: string;
    grade: string | null;
    class_mean: string | null;
    subject: { id: string; name: string };
    term: { id: string; label: string };
  }>;
  cbe_results: Array<{
    cbe_assessment_id: string;
    title: string;
    status: "published" | "closed";
    published_at: string | null;
    assessment_date: string | null;
    learning_area: { id: string; name: string };
    strand: { id: string; name: string } | null;
    level_code: string;
    points: string;
    teacher_feedback: string | null;
    term: { id: string; label: string };
  }>;
}

/** The child's own marks on published or closed assessments (never a draft), and CBE results likewise. */
export async function childResults(tx: Tx, input: { tenantId: string; learnerId: string; termId?: string }): Promise<ChildResults> {
  const marks = await tx.query<{
    assessment_id: string;
    title: string;
    kind: string;
    status: "published" | "closed";
    published_at: Date | null;
    max_score: string;
    score: string;
    grade: string | null;
    class_mean: string | null;
    subject_id: string;
    subject_name: string;
    term_id: string;
    term_label: string;
  }>(
    `SELECT a.id AS assessment_id, a.title, a.kind, a.status, a.published_at, a.max_score::text AS max_score,
            m.score::text AS score, m.grade,
            (SELECT CASE WHEN count(*) >= $4 THEN round(avg(x.score), 2)::text END
               FROM mark_entries x WHERE x.tenant_id = a.tenant_id AND x.assessment_id = a.id) AS class_mean,
            s.id AS subject_id, s.name AS subject_name, t.id AS term_id, t.label AS term_label
       FROM mark_entries m
       JOIN assessments a ON a.tenant_id = m.tenant_id AND a.id = m.assessment_id AND a.status IN ('published', 'closed')
       JOIN subjects s ON s.tenant_id = a.tenant_id AND s.id = a.subject_id
       JOIN academic_terms t ON t.tenant_id = a.tenant_id AND t.id = a.term_id
      WHERE m.tenant_id = $1 AND m.learner_id = $2 AND ($3::uuid IS NULL OR a.term_id = $3::uuid)
      ORDER BY a.published_at DESC NULLS LAST, a.id
      LIMIT 500`,
    [input.tenantId, input.learnerId, input.termId ?? null, CLASS_MEAN_MIN_MARKS],
  );
  const cbe = await tx.query<{
    cbe_assessment_id: string;
    title: string;
    status: "published" | "closed";
    published_at: Date | null;
    assessment_date: string | null;
    learning_area_id: string;
    learning_area_name: string;
    strand_id: string | null;
    strand_name: string | null;
    level_code: string;
    points: string;
    teacher_feedback: string | null;
    term_id: string;
    term_label: string;
  }>(
    `SELECT a.id AS cbe_assessment_id, a.title, a.status, a.published_at, a.assessment_date::text AS assessment_date,
            la.id AS learning_area_id, la.name AS learning_area_name, st.id AS strand_id, st.name AS strand_name,
            r.level_code, r.points::text AS points, r.teacher_feedback, t.id AS term_id, t.label AS term_label
       FROM cbe_results r
       JOIN cbe_assessments a ON a.tenant_id = r.tenant_id AND a.id = r.cbe_assessment_id AND a.status IN ('published', 'closed')
       JOIN learning_areas la ON la.tenant_id = a.tenant_id AND la.id = a.learning_area_id
       LEFT JOIN strands st ON st.tenant_id = r.tenant_id AND st.id = r.strand_id
       JOIN academic_terms t ON t.tenant_id = a.tenant_id AND t.id = a.term_id
      WHERE r.tenant_id = $1 AND r.learner_id = $2 AND ($3::uuid IS NULL OR a.term_id = $3::uuid)
      ORDER BY a.published_at DESC NULLS LAST, a.id, st.name NULLS FIRST, r.id
      LIMIT 500`,
    [input.tenantId, input.learnerId, input.termId ?? null],
  );
  return {
    marks: marks.rows.map((r) => ({
      assessment_id: r.assessment_id,
      title: r.title,
      kind: r.kind,
      status: r.status,
      published_at: r.published_at ? r.published_at.toISOString() : null,
      max_score: r.max_score,
      score: r.score,
      grade: r.grade,
      class_mean: r.class_mean,
      subject: { id: r.subject_id, name: r.subject_name },
      term: { id: r.term_id, label: r.term_label },
    })),
    cbe_results: cbe.rows.map((r) => ({
      cbe_assessment_id: r.cbe_assessment_id,
      title: r.title,
      status: r.status,
      published_at: r.published_at ? r.published_at.toISOString() : null,
      assessment_date: r.assessment_date,
      learning_area: { id: r.learning_area_id, name: r.learning_area_name },
      strand: r.strand_id ? { id: r.strand_id, name: r.strand_name ?? "" } : null,
      level_code: r.level_code,
      points: r.points,
      teacher_feedback: r.teacher_feedback,
      term: { id: r.term_id, label: r.term_label },
    })),
  };
}

// ------------------------------------------------------------------------------------------------- report cards

type Figures = {
  method?: string;
  grading_scheme_name?: string;
  learners?: Array<{ learner_id: string; sum: string; count: number; average: string | null; grade?: string | null }>;
  cbe?: { learners?: Array<{ learner_id: string; results: Array<Record<string, unknown>> }> };
  competencies?: { learners?: Array<{ learner_id: string; ratings: Array<{ kind: string; item: string; level_code: string }> }> };
};

export interface ChildReportCard {
  id: string;
  published_at: string;
  term: { id: string; label: string };
  class: { id: string; name: string };
  method: string | null;
  grading_scheme_name: string | null;
  summary: { sum: string; count: number; average: string | null; grade: string | null } | null;
  cbe_results: Array<{
    cbe_assessment_id: string;
    title: string;
    level_code: string;
    points: string;
    teacher_feedback: string | null;
  }>;
  competencies: Array<{ kind: string; item: string; level_code: string }>;
}

/**
 * The newest published report card per term and class the child belongs to (or appears in), reduced to the child's own
 * slice of the class snapshot. The snapshot's other learners never leave this function.
 */
export async function childReportCards(tx: Tx, input: { tenantId: string; learnerId: string }): Promise<ChildReportCard[]> {
  const res = await tx.query<{
    id: string;
    published_at: Date;
    figures: Figures;
    term_id: string;
    term_label: string;
    class_id: string;
    class_name: string;
  }>(
    `SELECT DISTINCT ON (r.term_id, r.class_id) r.id, r.published_at, r.figures, t.id AS term_id, t.label AS term_label,
            c.id AS class_id, c.name AS class_name
       FROM report_card_publications r
       JOIN academic_terms t ON t.tenant_id = r.tenant_id AND t.id = r.term_id
       JOIN classes c ON c.tenant_id = r.tenant_id AND c.id = r.class_id
      WHERE r.tenant_id = $1
        AND (EXISTS (SELECT 1 FROM class_memberships cm
                      WHERE cm.tenant_id = r.tenant_id AND cm.class_id = r.class_id AND cm.learner_id = $2)
             OR r.figures->'learners' @> jsonb_build_array(jsonb_build_object('learner_id', $2::text)))
      ORDER BY r.term_id, r.class_id, r.published_at DESC, r.id DESC`,
    [input.tenantId, input.learnerId],
  );
  const out = res.rows.map((row): ChildReportCard => {
    const f = row.figures ?? {};
    const mine = (f.learners ?? []).find((l) => l.learner_id === input.learnerId);
    const cbe = (f.cbe?.learners ?? []).find((l) => l.learner_id === input.learnerId);
    const comp = (f.competencies?.learners ?? []).find((l) => l.learner_id === input.learnerId);
    return {
      id: row.id,
      published_at: row.published_at.toISOString(),
      term: { id: row.term_id, label: row.term_label },
      class: { id: row.class_id, name: row.class_name },
      method: typeof f.method === "string" ? f.method : null,
      grading_scheme_name: typeof f.grading_scheme_name === "string" ? f.grading_scheme_name : null,
      summary: mine ? { sum: mine.sum, count: mine.count, average: mine.average, grade: mine.grade ?? null } : null,
      cbe_results: (cbe?.results ?? []).map((r) => ({
        cbe_assessment_id: String(r.cbe_assessment_id),
        title: String(r.title),
        level_code: String(r.level_code),
        points: String(r.points),
        teacher_feedback: typeof r.teacher_feedback === "string" ? r.teacher_feedback : null,
      })),
      competencies: (comp?.ratings ?? []).map((r) => ({ kind: r.kind, item: r.item, level_code: r.level_code })),
    };
  });
  out.sort((a, b) => b.published_at.localeCompare(a.published_at) || a.id.localeCompare(b.id));
  return out;
}

// ------------------------------------------------------------------------------------------------- homework, materials, timetable

export interface ChildHomework {
  id: string;
  title: string;
  /** The instructions. May be empty. */
  body: string;
  due_on: string;
  term_id: string;
  subject: { id: string; name: string };
  /** How learners hand it in. */
  hand_in: HomeworkHandIn;
  /** The guide written for parents. A learner is sent only what to bring and how long it takes (docs/HOMEWORK.md). */
  parent_guide: HomeworkParentGuide | null;
  /** The name of whoever set it, or null. A name only. */
  teacher_name: string | null;
  created_at: string;
}

/**
 * Homework of the child's current-year class, due on or after `from` (default 21 days before today). Archived homework is never
 * returned. `reader` is who is asking: a parent gets the whole "For parents" guide, a learner reading their own work only the
 * parts meant for them (what to bring, how long it takes).
 */
export async function childHomework(
  tx: Tx,
  input: { tenantId: string; learnerId: string; reader: "family" | "student"; from?: string },
): Promise<{ from: string; homework: ChildHomework[] }> {
  const from = input.from ?? addDays(await schoolToday(tx, input.tenantId), -21);
  const klass = (await currentClasses(tx, input.tenantId, [input.learnerId])).get(input.learnerId);
  if (!klass) return { from, homework: [] };
  const res = await tx.query<{
    id: string;
    title: string;
    body: string;
    due_on: string;
    term_id: string;
    hand_in: HomeworkHandIn;
    parent_guide: unknown;
    teacher_name: string | null;
    subject_id: string;
    subject_name: string;
    created_at: Date;
  }>(
    `SELECT h.id, h.title, h.body, h.due_on::text AS due_on, h.term_id, h.hand_in, h.parent_guide,
            ${HOMEWORK_TEACHER_NAME_SQL} AS teacher_name, s.id AS subject_id, s.name AS subject_name, h.created_at
       FROM homework_items h
       JOIN subjects s ON s.tenant_id = h.tenant_id AND s.id = h.subject_id
      WHERE h.tenant_id = $1 AND h.class_id = $2 AND h.due_on >= $3::date AND h.archived_at IS NULL
      ORDER BY h.due_on, h.id
      LIMIT 200`,
    [input.tenantId, klass.id, from],
  );
  return {
    from,
    homework: res.rows.map((r) => {
      const guide = readParentGuide(r.parent_guide);
      return {
        id: r.id,
        title: r.title,
        body: r.body,
        due_on: r.due_on,
        term_id: r.term_id,
        subject: { id: r.subject_id, name: r.subject_name },
        hand_in: r.hand_in,
        parent_guide: input.reader === "student" ? learnerParentGuide(guide) : guide,
        teacher_name: r.teacher_name,
        created_at: r.created_at.toISOString(),
      };
    }),
  };
}

export interface ChildMaterial {
  id: string;
  title: string;
  description: string | null;
  subject: { id: string; name: string } | null;
  url: string | null;
  storage_status: string;
  published_at: string;
  created_at: string;
}

/** Published, non-archived learning materials for the child's current-year class (newest first). Files are metadata only (A5). */
export async function childMaterials(tx: Tx, input: { tenantId: string; learnerId: string }): Promise<ChildMaterial[]> {
  const klass = (await currentClasses(tx, input.tenantId, [input.learnerId])).get(input.learnerId);
  if (!klass) return [];
  const res = await tx.query<{ id: string; title: string; description: string | null; subject_id: string | null; subject_name: string | null; url: string | null; storage_status: string; published_at: Date; created_at: Date }>(
    `SELECT m.id, m.title, m.description, s.id AS subject_id, s.name AS subject_name, m.url, m.storage_status, m.published_at, m.created_at
       FROM learning_materials m
       LEFT JOIN subjects s ON s.tenant_id = m.tenant_id AND s.id = m.subject_id
      WHERE m.tenant_id = $1 AND m.class_id = $2 AND m.published_at IS NOT NULL AND m.archived_at IS NULL
      ORDER BY m.created_at DESC, m.id
      LIMIT 200`,
    [input.tenantId, klass.id],
  );
  return res.rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    subject: r.subject_id ? { id: r.subject_id, name: r.subject_name ?? "" } : null,
    url: r.url,
    storage_status: r.storage_status,
    published_at: r.published_at.toISOString(),
    created_at: r.created_at.toISOString(),
  }));
}

export interface ChildTimetable {
  publication_id: string;
  version: number;
  published_at: string;
  term_id: string | null;
  class: { id: string; name: string };
  slots: Array<{
    day_of_week: number;
    starts_at: string;
    ends_at: string;
    room: string | null;
    subject: { id: string; name: string | null };
    teacher_name: string | null;
  }>;
}

type SnapshotSlot = { subject_id?: unknown; teaching_assignment_id?: unknown; day_of_week?: unknown; starts_at?: unknown; ends_at?: unknown; room?: unknown };

/** The newest PUBLISHED timetable of the child's current-year class, or null. Drafts never appear. */
export async function childTimetable(tx: Tx, input: { tenantId: string; learnerId: string }): Promise<ChildTimetable | null> {
  const klass = (await currentClasses(tx, input.tenantId, [input.learnerId])).get(input.learnerId);
  if (!klass) return null;
  const pub = await tx.query<{ id: string; version: number; published_at: Date; term_id: string | null; slots_snapshot: SnapshotSlot[] }>(
    `SELECT id, version, published_at, term_id, slots_snapshot FROM timetable_publications
      WHERE tenant_id = $1 AND class_id = $2 AND status = 'published'
      ORDER BY published_at DESC, version DESC, id DESC
      LIMIT 1`,
    [input.tenantId, klass.id],
  );
  const p = pub.rows[0];
  if (!p) return null;
  const subjects = await tx.query<{ id: string; name: string }>(
    `SELECT id, name FROM subjects WHERE tenant_id = $1 AND id IN (
       SELECT (e->>'subject_id')::uuid FROM timetable_publications tp, jsonb_array_elements(tp.slots_snapshot) e
        WHERE tp.tenant_id = $1 AND tp.id = $2)`,
    [input.tenantId, p.id],
  );
  // teacher: the slot's teaching assignment, or else the class's active assignment for that subject
  const teachers = await tx.query<{ id: string; subject_id: string; active: boolean; full_name: string }>(
    `SELECT ta.id, ta.subject_id, ta.active, sm.full_name
       FROM teaching_assignments ta
       JOIN staff_members sm ON sm.tenant_id = ta.tenant_id AND sm.id = ta.staff_member_id
      WHERE ta.tenant_id = $1 AND ta.class_id = $2`,
    [input.tenantId, klass.id],
  );
  const subjectName = new Map(subjects.rows.map((s) => [s.id, s.name]));
  const byAssignment = new Map(teachers.rows.map((t) => [t.id, t.full_name]));
  const bySubject = new Map(teachers.rows.filter((t) => t.active).map((t) => [t.subject_id, t.full_name]));
  const slots = (Array.isArray(p.slots_snapshot) ? p.slots_snapshot : []).map((s) => {
    const subjectId = String(s.subject_id ?? "");
    const ta = typeof s.teaching_assignment_id === "string" ? s.teaching_assignment_id : null;
    return {
      day_of_week: Number(s.day_of_week),
      starts_at: String(s.starts_at ?? "").slice(0, 5),
      ends_at: String(s.ends_at ?? "").slice(0, 5),
      room: typeof s.room === "string" ? s.room : null,
      subject: { id: subjectId, name: subjectName.get(subjectId) ?? null },
      teacher_name: (ta ? byAssignment.get(ta) : undefined) ?? bySubject.get(subjectId) ?? null,
    };
  });
  slots.sort((a, b) => a.day_of_week - b.day_of_week || a.starts_at.localeCompare(b.starts_at));
  return {
    publication_id: p.id,
    version: p.version,
    published_at: p.published_at.toISOString(),
    term_id: p.term_id,
    class: { id: klass.id, name: klass.name },
    slots,
  };
}
