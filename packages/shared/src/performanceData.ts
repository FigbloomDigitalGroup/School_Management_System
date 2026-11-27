import {
  apiFetchCbeBandReport, apiFetchCbeLevels, apiFetchClassLearnerMeans, apiFetchClassLearnerNames, apiFetchClassOptions, apiFetchClassPerformance, apiFetchLearnerTrend,
} from "./api/performanceApi";
import { onApi } from "./backend";
import { rubricFor, summariseStrands } from "./gradingSchemes";
import { yearSortKey } from "./levels";
import { fetchAllPages } from "./paging";
import {
  learnerTrend, semesterGpaTrend,
  type CbeLevelRow, type ClassPerformanceRow, type LearnerHistoryRow, type LearnerMeanRow, type LearnerTrend, type SemesterGpa,
} from "./performance";
import { supabase } from "./supabase";
import type { ClassGroup, ClassLevel } from "./types";

/**
 * Loads what the performance charts plot. The trends themselves are computed
 * in performance.ts; see 20261027090000_performance_analytics.sql for the
 * RPCs, which only ever return published marks.
 */

/** One learner's published marks across every exam, as series. Families and staff alike. */
export async function fetchLearnerTrend(studentId: string): Promise<LearnerTrend> {
  if (onApi()) return apiFetchLearnerTrend(studentId);
  const { data, error } = await supabase().rpc("learner_results_history", { p_student_id: studentId });
  if (error) throw new Error(error.message);
  return learnerTrend((data ?? []) as LearnerHistoryRow[]);
}

/** Per exam x class x subject for one class, or the whole school when classId is null. Staff only. */
export async function fetchClassPerformance(tenantId: string, classId: string | null): Promise<ClassPerformanceRow[]> {
  if (onApi()) return apiFetchClassPerformance(tenantId, classId);
  return fetchAllPages<ClassPerformanceRow>((from, to) =>
    supabase()
      .rpc("class_exam_performance", { p_tenant_id: tenantId, p_class_id: classId })
      .order("exam_id").order("class_id").order("subject_id")
      .range(from, to),
  );
}

/** Each learner's mean per exam in one class. Staff only. */
export async function fetchClassLearnerMeans(classId: string): Promise<LearnerMeanRow[]> {
  if (onApi()) return apiFetchClassLearnerMeans(classId);
  return fetchAllPages<LearnerMeanRow>((from, to) =>
    supabase()
      .rpc("class_learner_exam_means", { p_class_id: classId })
      .order("exam_id").order("student_id")
      .range(from, to),
  );
}

/**
 * Published CBE strand judgements, for one learner or one class (or the
 * school). RLS already hides unpublished ones from families; the filter here
 * holds staff to the same line.
 */
export async function fetchCbeLevels(scope: { studentId: string } | { classId: string } | { tenantId: string }): Promise<CbeLevelRow[]> {
  if (onApi()) return apiFetchCbeLevels(scope);
  const rows = await fetchAllPages<{ level_code: string; cbe_assessments: { assessed_on: string } | null }>((from, to) => {
    let q = supabase()
      .from("cbe_results")
      .select("level_code, cbe_assessments!inner(assessed_on, class_id, published_at)")
      .not("cbe_assessments.published_at", "is", null);
    if ("studentId" in scope) q = q.eq("student_id", scope.studentId);
    else if ("classId" in scope) q = q.eq("cbe_assessments.class_id", scope.classId);
    else q = q.eq("tenant_id", scope.tenantId);
    return q.order("id").range(from, to)
      .returns<{ level_code: string; cbe_assessments: { assessed_on: string } | null }[]>();
  });
  return rows.flatMap((r) => (r.cbe_assessments ? [{ assessedOn: r.cbe_assessments.assessed_on, levelCode: r.level_code }] : []));
}

/** A higher-ed learner's GPA per semester, from finalized course grades. */
export async function fetchSemesterGpas(studentId: string): Promise<SemesterGpa[]> {
  type Row = {
    grade_points: number;
    course_sections: { courses: { credits: number } | null; semesters: { id: string; name: string; starts_on: string } | null } | null;
  };
  const { data, error } = await supabase()
    .from("course_grades")
    .select("grade_points, course_sections(courses(credits), semesters(id, name, starts_on))")
    .eq("student_id", studentId)
    .returns<Row[]>();
  if (error) throw new Error(error.message);
  return semesterGpaTrend((data ?? []).flatMap((r) => {
    const s = r.course_sections?.semesters;
    return s ? [{ semesterId: s.id, semesterName: s.name, startsOn: s.starts_on, credits: r.course_sections?.courses?.credits ?? 0, gradePoints: Number(r.grade_points) }] : [];
  }));
}

// ---------------------------------------------------------------- what the admin's Performance and Reports screens pick from (FIG-1899)

export type ClassOption = Pick<ClassGroup, "id" | "name" | "level" | "form_level">;

/** Every class in the school, youngest year first, then by name. Throws the database's message. */
export async function fetchClassOptions(tenantId: string): Promise<ClassOption[]> {
  if (onApi()) return apiFetchClassOptions(tenantId);
  const { data, error } = await supabase().from("classes").select("id, name, level, form_level")
    .eq("tenant_id", tenantId).order("form_level").order("name").returns<ClassOption[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** The active learners of one class, by name. Throws the database's message. */
export async function fetchClassLearnerNames(classId: string): Promise<{ id: string; full_name: string }[]> {
  if (onApi()) return apiFetchClassLearnerNames(classId);
  const { data, error } = await supabase().from("students").select("id, full_name")
    .eq("class_id", classId).eq("active", true).order("full_name").returns<{ id: string; full_name: string }[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

export const CBE_BANDS = ["EE", "ME", "AE", "BE"] as const;
export type CbeBand = (typeof CBE_BANDS)[number];

/** Per class x learning area, the latest published assessment this term: how many learners sit at each rubric band overall. */
export interface CbeBandRow {
  key: string;
  className: string;
  learningAreaName: string;
  assessmentTitle: string;
  counts: Record<CbeBand, number>;
  learners: number;
  sort: number;
}

interface CbeReportRow {
  student_id: string;
  level_code: string;
  cbe_assessments: {
    id: string; title: string; assessed_on: string; class_id: string; subject_id: string;
    subjects: { name: string } | null; classes: { name: string; level: ClassLevel; form_level: number } | null;
  };
}

/**
 * Per class x learning area, the latest published assessment of the term: how many learners sit at each rubric band overall. 8-level results fold
 * into their band (EE1 and EE2 are both EE) so every class reads the same way. Youngest year first, then by class and learning area.
 * Throws the database's message.
 */
export async function fetchCbeBandReport(tenantId: string, termId: string, country: string): Promise<CbeBandRow[]> {
  if (onApi()) return apiFetchCbeBandReport(tenantId, termId, country);
  const { data, error } = await supabase().from("cbe_results")
    .select("student_id, level_code, cbe_assessments!inner(id, title, assessed_on, published_at, term_id, class_id, subject_id, subjects(name), classes(name, level, form_level))")
    .eq("tenant_id", tenantId)
    .eq("cbe_assessments.term_id", termId)
    .not("cbe_assessments.published_at", "is", null)
    .returns<CbeReportRow[]>();
  if (error) throw new Error(error.message);

  const latest = new Map<string, { id: string; on: string }>();
  for (const r of data ?? []) {
    const k = `${r.cbe_assessments.class_id}:${r.cbe_assessments.subject_id}`;
    const cur = latest.get(k);
    if (!cur || r.cbe_assessments.assessed_on > cur.on) latest.set(k, { id: r.cbe_assessments.id, on: r.cbe_assessments.assessed_on });
  }

  const byAssessment = new Map<string, { a: CbeReportRow["cbe_assessments"]; codes: Map<string, string[]> }>();
  for (const r of data ?? []) {
    const k = `${r.cbe_assessments.class_id}:${r.cbe_assessments.subject_id}`;
    if (latest.get(k)?.id !== r.cbe_assessments.id) continue;
    const g = byAssessment.get(k) ?? { a: r.cbe_assessments, codes: new Map() };
    g.codes.set(r.student_id, [...(g.codes.get(r.student_id) ?? []), r.level_code]);
    byAssessment.set(k, g);
  }

  const rows: CbeBandRow[] = [];
  for (const [key, g] of byAssessment) {
    const level = g.a.classes?.level ?? "primary";
    const rubric = rubricFor(country, level) ?? [];
    const counts: Record<CbeBand, number> = { EE: 0, ME: 0, AE: 0, BE: 0 };
    for (const codes of g.codes.values()) {
      const overall = summariseStrands(codes, rubric).overall;
      if (overall) counts[overall.code.slice(0, 2) as CbeBand] += 1;
    }
    rows.push({
      key, className: g.a.classes?.name ?? "Class", learningAreaName: g.a.subjects?.name ?? "Learning area", assessmentTitle: g.a.title,
      counts, learners: g.codes.size, sort: yearSortKey(level, g.a.classes?.form_level ?? 0),
    });
  }
  return rows.sort((a, b) => a.sort - b.sort || a.className.localeCompare(b.className) || a.learningAreaName.localeCompare(b.learningAreaName));
}
