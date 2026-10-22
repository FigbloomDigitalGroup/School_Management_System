import { letterAndPoints, weightedScore } from "./gpa";
import { supabase } from "./supabase";
import type { CourseAssessment, CourseGrade, LetterGrade } from "./types";

/**
 * Data access for the higher-ed GPA gradebook (FIG-330) — course_assessments/
 * course_marks/course_grades, parallel to exams/marks and never touching
 * them (grading.ts's fixed KCSE scale is a different, separately-owned
 * source of truth; see gpa.ts's header).
 */

export async function fetchAssessments(sectionId: string): Promise<CourseAssessment[]> {
  const { data, error } = await supabase()
    .from("course_assessments").select("*").eq("course_section_id", sectionId)
    .order("name").returns<CourseAssessment[]>();
  if (error) throw error;
  return data ?? [];
}

export async function createAssessment(input: Omit<CourseAssessment, "id" | "published_at">): Promise<CourseAssessment> {
  const { data, error } = await supabase().from("course_assessments").insert(input).select("*").single<CourseAssessment>();
  if (error) throw error;
  return data;
}

/** Publishing gates student/parent visibility — same shape as exams.published_at. */
export async function publishAssessment(assessmentId: string): Promise<void> {
  const { error } = await supabase().from("course_assessments").update({ published_at: new Date().toISOString() }).eq("id", assessmentId);
  if (error) throw error;
}

export async function fetchMarksForAssessment(assessmentId: string): Promise<Record<string, number | null>> {
  const { data, error } = await supabase().from("course_marks").select("student_id, score").eq("assessment_id", assessmentId)
    .returns<{ student_id: string; score: number | null }[]>();
  if (error) throw error;
  const out: Record<string, number | null> = {};
  for (const row of data ?? []) out[row.student_id] = row.score;
  return out;
}

export interface MarkInput { student_id: string; score: number | null }

export async function saveMarks(tenantId: string, assessmentId: string, enteredBy: string, rows: MarkInput[]): Promise<void> {
  if (!rows.length) return;
  const { error } = await supabase().from("course_marks").upsert(
    rows.map((r) => ({ tenant_id: tenantId, assessment_id: assessmentId, student_id: r.student_id, score: r.score, entered_by: enteredBy })),
    { onConflict: "assessment_id,student_id" },
  );
  if (error) throw error;
}

/**
 * Closes out a section: computes each enrolled student's weighted score
 * across every PUBLISHED assessment (unpublished ones are still a draft, so
 * they don't count toward the transcript any more than an unpublished exam
 * counts toward a K-12 report card) and stores the result — a snapshot, not
 * a live view, so a later mark correction doesn't silently reflow a
 * student's transcript (same reasoning as fee_invoices.paid_cents being
 * trigger-maintained rather than summed on read).
 */
export async function finalizeSectionGrades(tenantId: string, sectionId: string): Promise<{ studentsGraded: number }> {
  const [{ data: assessments, error: aErr }, { data: enrollments, error: eErr }] = await Promise.all([
    supabase().from("course_assessments").select("id, weight_pct, out_of").eq("course_section_id", sectionId).not("published_at", "is", null)
      .returns<{ id: string; weight_pct: number; out_of: number }[]>(),
    supabase().from("enrollments").select("student_id").eq("course_section_id", sectionId).eq("status", "enrolled")
      .returns<{ student_id: string }[]>(),
  ]);
  if (aErr) throw aErr;
  if (eErr) throw eErr;
  if (!assessments?.length || !enrollments?.length) return { studentsGraded: 0 };

  const { data: markRows, error: mErr } = await supabase()
    .from("course_marks").select("student_id, assessment_id, score")
    .in("assessment_id", assessments.map((a) => a.id))
    .returns<{ student_id: string; assessment_id: string; score: number | null }[]>();
  if (mErr) throw mErr;

  const marksByStudent = new Map<string, { student_id: string; assessment_id: string; score: number | null }[]>();
  for (const m of markRows ?? []) marksByStudent.set(m.student_id, [...(marksByStudent.get(m.student_id) ?? []), m]);
  const assessmentById = new Map(assessments.map((a) => [a.id, a]));

  const rows: Omit<CourseGrade, "id" | "finalized_at">[] = [];
  for (const e of enrollments) {
    const marks = marksByStudent.get(e.student_id) ?? [];
    const composite = weightedScore(marks.map((m) => {
      const a = assessmentById.get(m.assessment_id)!;
      return { score: m.score, weight_pct: a.weight_pct, out_of: a.out_of };
    }));
    if (composite === null) continue; // nothing graded for this student yet — skip, don't invent a grade
    const { grade, points } = letterAndPoints(composite);
    rows.push({ tenant_id: tenantId, student_id: e.student_id, course_section_id: sectionId, weighted_score: composite, letter_grade: grade, grade_points: points });
  }
  if (!rows.length) return { studentsGraded: 0 };

  const { error } = await supabase().from("course_grades").upsert(
    rows.map((r) => ({ ...r, finalized_at: new Date().toISOString() })),
    { onConflict: "student_id,course_section_id" },
  );
  if (error) throw error;
  return { studentsGraded: rows.length };
}

export interface StudentCourseResult {
  courseSectionId: string;
  courseCode: string;
  courseName: string;
  sectionLabel: string;
  semesterName: string;
  credits: number;
  assessments: { name: string; score: number | null; outOf: number; weightPct: number }[];
  grade: { letter: LetterGrade; points: number; weightedScore: number } | null;
}

/** Everything a student's "My results" screen needs: one row per enrolled section, with published marks and (once closed out) the finalized grade. */
export async function fetchStudentCourseResults(studentId: string): Promise<StudentCourseResult[]> {
  const { data: enrollments, error } = await supabase()
    .from("enrollments")
    .select("course_section_id, course_sections(section_label, courses(code, name, credits), semesters(name))")
    .eq("student_id", studentId)
    .eq("status", "enrolled")
    .returns<{ course_section_id: string; course_sections: { section_label: string; courses: { code: string; name: string; credits: number } | null; semesters: { name: string } | null } | null }[]>();
  if (error) throw error;
  if (!enrollments?.length) return [];

  const sectionIds = enrollments.map((e) => e.course_section_id);
  const [{ data: assessmentRows }, { data: gradeRows }] = await Promise.all([
    supabase().from("course_assessments").select("id, course_section_id, name, weight_pct, out_of").in("course_section_id", sectionIds).not("published_at", "is", null)
      .returns<{ id: string; course_section_id: string; name: string; weight_pct: number; out_of: number }[]>(),
    supabase().from("course_grades").select("course_section_id, weighted_score, letter_grade, grade_points").eq("student_id", studentId).in("course_section_id", sectionIds)
      .returns<{ course_section_id: string; weighted_score: number; letter_grade: LetterGrade; grade_points: number }[]>(),
  ]);

  const assessmentIds = (assessmentRows ?? []).map((a) => a.id);
  const { data: markRows } = assessmentIds.length
    ? await supabase().from("course_marks").select("assessment_id, score").eq("student_id", studentId).in("assessment_id", assessmentIds).returns<{ assessment_id: string; score: number | null }[]>()
    : { data: [] as { assessment_id: string; score: number | null }[] };

  const scoreByAssessment = new Map((markRows ?? []).map((m) => [m.assessment_id, m.score]));
  const gradeBySection = new Map((gradeRows ?? []).map((g) => [g.course_section_id, g]));

  return enrollments
    .filter((e) => e.course_sections)
    .map((e) => {
      const cs = e.course_sections!;
      const assessments = (assessmentRows ?? [])
        .filter((a) => a.course_section_id === e.course_section_id)
        .map((a) => ({ name: a.name, score: scoreByAssessment.get(a.id) ?? null, outOf: a.out_of, weightPct: a.weight_pct }));
      const g = gradeBySection.get(e.course_section_id);
      return {
        courseSectionId: e.course_section_id,
        courseCode: cs.courses?.code ?? "",
        courseName: cs.courses?.name ?? "",
        sectionLabel: cs.section_label,
        semesterName: cs.semesters?.name ?? "",
        credits: cs.courses?.credits ?? 0,
        assessments,
        grade: g ? { letter: g.letter_grade, points: g.grade_points, weightedScore: g.weighted_score } : null,
      };
    });
}
