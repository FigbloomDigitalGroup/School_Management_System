import type { LetterGrade } from "./types";

/**
 * Credit/GPA scale for higher-ed — deliberately separate from grading.ts's
 * fixed 12-point KCSE scale. grading.ts's own docstring is explicit: "the
 * same score must never render as two different grades anywhere in the
 * product." A weighted-composite, 4.0-scale GPA is a different algorithm,
 * not a parameterization of that scale, so it gets its own module, its own
 * tables (course_assessments/course_marks/course_grades), and never imports
 * from or writes into grading.ts's world.
 */

// Cutoffs follow Kenyan university convention (e.g. Kenyatta University: A =
// 70-100%), not the ~90%=A scale common in the US — a Kenyan institution
// using the American cutoffs unmodified would under-grade nearly every
// student, so these are the actual default rather than a placeholder.
export const GPA_SCALE: { min: number; grade: LetterGrade; points: number }[] = [
  { min: 70, grade: "A", points: 4.0 },
  { min: 65, grade: "A-", points: 3.7 },
  { min: 60, grade: "B+", points: 3.3 },
  { min: 55, grade: "B", points: 3.0 },
  { min: 50, grade: "B-", points: 2.7 },
  { min: 45, grade: "C+", points: 2.3 },
  { min: 40, grade: "C", points: 2.0 },
  { min: 35, grade: "C-", points: 1.7 },
  { min: 30, grade: "D+", points: 1.3 },
  { min: 25, grade: "D", points: 1.0 },
  { min: 20, grade: "D-", points: 0.7 },
  { min: 0, grade: "F", points: 0.0 },
];

export function letterAndPoints(weightedScorePct: number): { grade: LetterGrade; points: number } {
  const row = GPA_SCALE.find((g) => weightedScorePct >= g.min) ?? GPA_SCALE[GPA_SCALE.length - 1]!;
  return { grade: row.grade, points: row.points };
}

export interface AssessmentMark { score: number | null; weight_pct: number; out_of: number }

/**
 * The weighted-average percentage across whatever assessments are graded so
 * far, re-normalized to the weight actually entered — same "never invent a
 * mean from a partial roster" spirit as grading.ts's summarise(), just
 * weighted instead of a plain average. Null once nothing is graded yet.
 */
export function weightedScore(marks: AssessmentMark[]): number | null {
  const graded = marks.filter((m) => m.score !== null) as { score: number; weight_pct: number; out_of: number }[];
  if (!graded.length) return null;
  const totalWeight = graded.reduce((a, m) => a + m.weight_pct, 0);
  if (totalWeight <= 0) return null;
  const weightedSum = graded.reduce((a, m) => a + (m.score / m.out_of) * 100 * m.weight_pct, 0);
  return Math.round((weightedSum / totalWeight) * 100) / 100;
}

export interface CourseGpaInput { grade_points: number; credits: number }

/** Credit-weighted GPA across several finalized course grades: Σ(points×credits) / Σ(credits). */
export function creditWeightedGpa(courses: CourseGpaInput[]): number | null {
  if (!courses.length) return null;
  const totalCredits = courses.reduce((a, c) => a + c.credits, 0);
  if (totalCredits <= 0) return null;
  const totalPoints = courses.reduce((a, c) => a + c.grade_points * c.credits, 0);
  return Math.round((totalPoints / totalCredits) * 100) / 100;
}
