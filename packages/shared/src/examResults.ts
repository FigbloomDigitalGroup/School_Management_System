import { supabase } from "./supabase";
import { fetchAllPages } from "./paging";

/**
 * What a parent or learner can see of an exam, one learner at a time.
 *
 * Teachers publish a class and subject at a time (mark_publications), so an
 * exam can be half out: Chemistry published, the other eight subjects not yet.
 * Which exams a learner has results for is therefore decided by the marks they
 * can actually read, which RLS already limits to what has been published for
 * their class. Looking at exams.published_at instead would count an exam that
 * only another class's teachers have published.
 */

export interface PublishedExam {
  id: string;
  name: string;
  /** How many subjects have a mark out for this learner. */
  subjectCount: number;
}

export interface ExamSubject {
  name: string;
  score: number;
  classMean: number | null;
}

interface VisibleMark {
  student_id: string;
  exam_id: string;
  score: number | null;
  exams: { name: string; published_at: string | null } | null;
}

/**
 * Groups marks into each learner's exams, newest first (by when the exam first
 * went out). A missed paper has no score and is not a subject to show, so an
 * exam where a learner has nothing but those is left out.
 */
export function groupPublishedExams(rows: VisibleMark[]): Map<string, PublishedExam[]> {
  const byStudent = new Map<string, Map<string, { name: string; publishedAt: string; subjectCount: number }>>();
  for (const row of rows) {
    if (row.score === null || !row.exams) continue;
    const exams = byStudent.get(row.student_id) ?? new Map();
    const seen = exams.get(row.exam_id) ?? { name: row.exams.name, publishedAt: row.exams.published_at ?? "", subjectCount: 0 };
    seen.subjectCount += 1;
    exams.set(row.exam_id, seen);
    byStudent.set(row.student_id, exams);
  }

  const result = new Map<string, PublishedExam[]>();
  for (const [studentId, exams] of byStudent) {
    result.set(
      studentId,
      [...exams.entries()]
        .sort(([, a], [, b]) => b.publishedAt.localeCompare(a.publishedAt) || a.name.localeCompare(b.name))
        .map(([id, e]) => ({ id, name: e.name, subjectCount: e.subjectCount })),
    );
  }
  return result;
}

/** " · 1 subject" for the newest exam, so a headline mean over a half-published exam says what it covers. Empty when there is none. */
export function newestExamNote(exams: PublishedExam[]): string {
  const newest = exams[0];
  return newest ? ` · ${newest.subjectCount} subject${newest.subjectCount === 1 ? "" : "s"}` : "";
}

/** Every exam each of these learners has results out for, newest first. A learner with none has no entry. */
export async function fetchPublishedExams(studentIds: string[]): Promise<Map<string, PublishedExam[]>> {
  if (studentIds.length === 0) return new Map();
  const rows = await fetchAllPages<VisibleMark>((from, to) =>
    supabase()
      .from("marks")
      .select("student_id, exam_id, score, exams(name, published_at)")
      .in("student_id", studentIds)
      .order("exam_id")
      .order("student_id")
      .order("subject_id")
      .range(from, to)
      .returns<VisibleMark[]>(),
  );
  return groupPublishedExams(rows);
}

/** The real class-wide mean for every subject of one exam, computed server
 *  side (class_means_for_exam) — RLS only lets a parent/student read their
 *  own child's marks rows, so this can never be derived from a client-side
 *  SELECT without exposing other students' individual scores. */
export async function fetchClassMeans(examId: string, classId: string): Promise<Map<string, number>> {
  const { data, error } = await supabase().rpc("class_means_for_exam", { p_exam_id: examId, p_class_id: classId });
  if (error) throw error;
  return new Map((data as { subject_id: string; mean_score: number }[] ?? []).map((r) => [r.subject_id, r.mean_score]));
}

/**
 * One learner's marks for one exam, each with its class mean (null when there
 * isn't one). A higher-ed learner has no class, so no means.
 */
export async function fetchExamSubjects(studentId: string, classId: string | null | undefined, examId: string): Promise<ExamSubject[]> {
  const [{ data, error }, means] = await Promise.all([
    supabase().from("marks").select("score, subject_id, subjects(name)").eq("exam_id", examId).eq("student_id", studentId)
      .returns<{ score: number | null; subject_id: string; subjects: { name: string } | null }[]>(),
    classId ? fetchClassMeans(examId, classId) : Promise.resolve(new Map<string, number>()),
  ]);
  if (error) throw new Error(error.message);
  return (data ?? [])
    .filter((m) => m.score !== null)
    .map((m) => ({ name: m.subjects?.name ?? "Subject", score: m.score as number, classMean: means.get(m.subject_id) ?? null }));
}
