import { fetchAllPages } from "./paging";
import {
  learnerTrend, semesterGpaTrend,
  type CbeLevelRow, type ClassPerformanceRow, type LearnerHistoryRow, type LearnerMeanRow, type LearnerTrend, type SemesterGpa,
} from "./performance";
import { supabase } from "./supabase";

/**
 * Loads what the performance charts plot. The trends themselves are computed
 * in performance.ts; see 20261027090000_performance_analytics.sql for the
 * RPCs, which only ever return published marks.
 */

/** One learner's published marks across every exam, as series. Families and staff alike. */
export async function fetchLearnerTrend(studentId: string): Promise<LearnerTrend> {
  const { data, error } = await supabase().rpc("learner_results_history", { p_student_id: studentId });
  if (error) throw new Error(error.message);
  return learnerTrend((data ?? []) as LearnerHistoryRow[]);
}

/** Per exam x class x subject for one class, or the whole school when classId is null. Staff only. */
export async function fetchClassPerformance(tenantId: string, classId: string | null): Promise<ClassPerformanceRow[]> {
  return fetchAllPages<ClassPerformanceRow>((from, to) =>
    supabase()
      .rpc("class_exam_performance", { p_tenant_id: tenantId, p_class_id: classId })
      .order("exam_id").order("class_id").order("subject_id")
      .range(from, to),
  );
}

/** Each learner's mean per exam in one class. Staff only. */
export async function fetchClassLearnerMeans(classId: string): Promise<LearnerMeanRow[]> {
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
