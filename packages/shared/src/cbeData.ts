import type { Strand } from "./curriculum";
import { rubricFor, summariseStrands, type RubricLevel } from "./gradingSchemes";
import { supabase } from "./supabase";
import type { ClassLevel } from "./types";

/**
 * CBE assessment data (supabase/migrations/20260924060000_cbe_assessment.sql):
 * one assessment per class x subject, a rubric level per learner per strand,
 * and one teacher comment per learner. Shared by the web and mobile teacher
 * gradebooks and the parent/student results screens.
 */

export interface CbeAssessment {
  id: string;
  tenant_id: string;
  term_id: string;
  class_id: string;
  subject_id: string;
  title: string;
  kind: "formative" | "summative";
  assessed_on: string;
  published_at: string | null;
  created_by: string | null;
  created_at: string;
}

export interface StrandNode extends Strand { subStrands: Strand[] }

/** What a teacher has recorded for one learner on one assessment. */
export interface CbeEntry { levels: Record<string, string>; comment: string }

export async function fetchCbeAssessments(classId: string, subjectId: string, termId: string): Promise<CbeAssessment[]> {
  const { data, error } = await supabase().from("cbe_assessments").select("*")
    .eq("class_id", classId).eq("subject_id", subjectId).eq("term_id", termId)
    .order("assessed_on", { ascending: false }).order("created_at", { ascending: false })
    .returns<CbeAssessment[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function createCbeAssessment(input: {
  tenantId: string; termId: string; classId: string; subjectId: string; title: string; kind: CbeAssessment["kind"]; createdBy: string;
}): Promise<CbeAssessment> {
  const { data, error } = await supabase().from("cbe_assessments").insert({
    tenant_id: input.tenantId, term_id: input.termId, class_id: input.classId, subject_id: input.subjectId,
    title: input.title, kind: input.kind, created_by: input.createdBy,
  }).select("*").single<CbeAssessment>();
  if (error) throw new Error(error.message);
  return data;
}

/** Strands for one learning area and grade — KICD's official ones plus the
 *  school's own (RLS returns both) — with sub-strands nested under each. */
export async function fetchStrandsForGrade(learningAreaId: string, grade: number): Promise<StrandNode[]> {
  const { data, error } = await supabase().from("strands").select("*")
    .eq("learning_area_id", learningAreaId).eq("grade", grade)
    .order("sort_order").order("name").returns<Strand[]>();
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  // Official strands first, then the school's own additions.
  const tops = rows.filter((s) => !s.parent_id).sort((a, b) => Number(a.tenant_id !== null) - Number(b.tenant_id !== null));
  return tops.map((t) => ({ ...t, subStrands: rows.filter((s) => s.parent_id === t.id) }));
}

export async function addSchoolStrand(tenantId: string, learningAreaId: string, grade: number, name: string): Promise<Strand> {
  const { data, error } = await supabase().from("strands").insert({
    tenant_id: tenantId, learning_area_id: learningAreaId, grade, name, sort_order: 1000,
  }).select("*").single<Strand>();
  if (error) throw new Error(error.message);
  return data;
}

export async function fetchCbeEntries(assessmentId: string): Promise<Record<string, CbeEntry>> {
  const [{ data: results, error: e1 }, { data: comments, error: e2 }] = await Promise.all([
    supabase().from("cbe_results").select("student_id, strand_id, level_code").eq("assessment_id", assessmentId)
      .returns<{ student_id: string; strand_id: string; level_code: string }[]>(),
    supabase().from("cbe_assessment_comments").select("student_id, comment").eq("assessment_id", assessmentId)
      .returns<{ student_id: string; comment: string }[]>(),
  ]);
  if (e1) throw new Error(e1.message);
  if (e2) throw new Error(e2.message);
  const out: Record<string, CbeEntry> = {};
  const entry = (id: string) => (out[id] ??= { levels: {}, comment: "" });
  for (const r of results ?? []) entry(r.student_id).levels[r.strand_id] = r.level_code;
  for (const c of comments ?? []) entry(c.student_id).comment = c.comment;
  return out;
}

/**
 * Writes a teacher's grid: upserts every judged cell (points are computed by
 * the database from the code), deletes cells cleared back to blank, and
 * keeps one comment per learner (a blank comment removes it).
 */
export async function saveCbeEntries(input: {
  tenantId: string; assessmentId: string; enteredBy: string;
  results: { studentId: string; strandId: string; code: string }[];
  cleared: { studentId: string; strandId: string }[];
  comments: { studentId: string; comment: string }[];
}): Promise<void> {
  const sb = supabase();
  if (input.results.length) {
    const { error } = await sb.from("cbe_results").upsert(
      input.results.map((r) => ({
        tenant_id: input.tenantId, assessment_id: input.assessmentId, student_id: r.studentId,
        strand_id: r.strandId, level_code: r.code, entered_by: input.enteredBy,
      })),
      { onConflict: "assessment_id,student_id,strand_id" },
    );
    if (error) throw new Error(error.message);
  }
  for (const c of input.cleared) {
    const { error } = await sb.from("cbe_results").delete()
      .eq("assessment_id", input.assessmentId).eq("student_id", c.studentId).eq("strand_id", c.strandId);
    if (error) throw new Error(error.message);
  }
  const keep = input.comments.filter((c) => c.comment.trim());
  const drop = input.comments.filter((c) => !c.comment.trim());
  if (keep.length) {
    const { error } = await sb.from("cbe_assessment_comments").upsert(
      keep.map((c) => ({ tenant_id: input.tenantId, assessment_id: input.assessmentId, student_id: c.studentId, comment: c.comment.trim() })),
      { onConflict: "assessment_id,student_id" },
    );
    if (error) throw new Error(error.message);
  }
  if (drop.length) {
    const { error } = await sb.from("cbe_assessment_comments").delete()
      .eq("assessment_id", input.assessmentId).in("student_id", drop.map((c) => c.studentId));
    if (error) throw new Error(error.message);
  }
}

export async function publishCbeAssessment(assessmentId: string): Promise<void> {
  const { data, error } = await supabase().from("cbe_assessments").update({ published_at: new Date().toISOString() })
    .eq("id", assessmentId).select("id");
  if (error) throw new Error(error.message);
  // RLS filters an update it doesn't allow down to zero rows instead of erroring.
  if (!data?.length) throw new Error("You can only publish assessments for a class and subject you teach.");
}

// ---------------------------------------------------------------- results

export interface CbeStrandResult { strandId: string; name: string; code: string; label: string }

/** A learner's latest published assessment in one learning area. */
export interface CbeLearningAreaResult {
  subjectId: string;
  subjectName: string;
  assessmentTitle: string;
  assessedOn: string;
  kind: CbeAssessment["kind"];
  overall: RubricLevel | null;
  strands: CbeStrandResult[];
  comment: string | null;
}

interface PublishedResultRow {
  student_id: string;
  strand_id: string;
  level_code: string;
  strands: { name: string; sort_order: number } | null;
  cbe_assessments: {
    id: string; title: string; kind: CbeAssessment["kind"]; assessed_on: string; published_at: string;
    subject_id: string; subjects: { name: string } | null; classes: { level: ClassLevel } | null;
  };
}

/**
 * Published CBE results for these learners, keyed by student id — per
 * learning area, the most recent published assessment (by date assessed).
 * RLS limits a parent or student to their own learners' published rows.
 */
export async function loadPublishedCbeResults(studentIds: string[], country: string): Promise<Map<string, CbeLearningAreaResult[]>> {
  const out = new Map<string, CbeLearningAreaResult[]>();
  if (!studentIds.length) return out;
  const sb = supabase();
  const [{ data: rows, error: e1 }, { data: comments, error: e2 }] = await Promise.all([
    sb.from("cbe_results")
      .select("student_id, strand_id, level_code, strands(name, sort_order), cbe_assessments!inner(id, title, kind, assessed_on, published_at, subject_id, subjects(name), classes(level))")
      .in("student_id", studentIds)
      .not("cbe_assessments.published_at", "is", null)
      .returns<PublishedResultRow[]>(),
    sb.from("cbe_assessment_comments").select("assessment_id, student_id, comment").in("student_id", studentIds)
      .returns<{ assessment_id: string; student_id: string; comment: string }[]>(),
  ]);
  if (e1) throw new Error(e1.message);
  if (e2) throw new Error(e2.message);
  const commentFor = new Map((comments ?? []).map((c) => [`${c.assessment_id}:${c.student_id}`, c.comment]));

  // student -> subject -> latest assessment id
  const latest = new Map<string, { id: string; on: string; published: string }>();
  for (const r of rows ?? []) {
    const k = `${r.student_id}:${r.cbe_assessments.subject_id}`;
    const cur = latest.get(k);
    const a = r.cbe_assessments;
    if (!cur || a.assessed_on > cur.on || (a.assessed_on === cur.on && a.published_at > cur.published)) {
      latest.set(k, { id: a.id, on: a.assessed_on, published: a.published_at });
    }
  }

  const grouped = new Map<string, { a: PublishedResultRow["cbe_assessments"]; studentId: string; items: { strandId: string; name: string; order: number; code: string }[] }>();
  for (const r of rows ?? []) {
    const k = `${r.student_id}:${r.cbe_assessments.subject_id}`;
    if (latest.get(k)?.id !== r.cbe_assessments.id) continue;
    const g = grouped.get(k) ?? { a: r.cbe_assessments, studentId: r.student_id, items: [] };
    g.items.push({ strandId: r.strand_id, name: r.strands?.name ?? "Strand", order: r.strands?.sort_order ?? 0, code: r.level_code });
    grouped.set(k, g);
  }

  for (const g of grouped.values()) {
    const rubric = rubricFor(country, g.a.classes?.level ?? "primary") ?? [];
    const items = g.items.sort((x, y) => x.order - y.order || x.name.localeCompare(y.name));
    const result: CbeLearningAreaResult = {
      subjectId: g.a.subject_id,
      subjectName: g.a.subjects?.name ?? "Learning area",
      assessmentTitle: g.a.title,
      assessedOn: g.a.assessed_on,
      kind: g.a.kind,
      overall: summariseStrands(items.map((i) => i.code), rubric).overall,
      strands: items.map((i) => ({ strandId: i.strandId, name: i.name, code: i.code, label: rubric.find((l) => l.code === i.code)?.label ?? i.code })),
      comment: commentFor.get(`${g.a.id}:${g.studentId}`) ?? null,
    };
    out.set(g.studentId, [...(out.get(g.studentId) ?? []), result]);
  }
  for (const list of out.values()) list.sort((a, b) => a.subjectName.localeCompare(b.subjectName));
  return out;
}
