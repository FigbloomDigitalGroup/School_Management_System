import { gradeFor } from "./grading";
import type { GradingSchemeId } from "./gradingSchemes";

/**
 * Performance over time, as pure functions over what the analytics RPCs
 * return (supabase/migrations/20261027090000_performance_analytics.sql). The
 * fetching lives in performanceData.ts; everything here is plain data in,
 * plain data out, so the web and mobile charts compute trends the same way.
 *
 * Every series is "one value per exam, oldest first", with null where there
 * is nothing to plot (a learner who missed an exam, a subject not sat). A
 * chart draws a gap there; it never invents a zero.
 */

/** An exam placed in time. Exams have no date, so their term and publication date order them. */
export interface ExamRef {
  id: string;
  name: string;
  termId: string;
  termName: string;
  termStartsOn: string;
  publishedAt: string | null;
}

/** Oldest first: by term, then by when it went out (not yet out sorts last), then by name. */
export function compareExams(a: ExamRef, b: ExamRef): number {
  return a.termStartsOn.localeCompare(b.termStartsOn)
    || (a.publishedAt ?? "￿").localeCompare(b.publishedAt ?? "￿")
    || a.name.localeCompare(b.name);
}

interface ExamColumns {
  exam_id: string;
  exam_name: string;
  term_id: string;
  term_name: string;
  term_starts_on: string;
  published_at: string | null;
}

function examRefOf(r: ExamColumns): ExamRef {
  return { id: r.exam_id, name: r.exam_name, termId: r.term_id, termName: r.term_name, termStartsOn: r.term_starts_on, publishedAt: r.published_at };
}

/** Each exam in the rows once, oldest first. */
export function examsOf(rows: ExamColumns[]): ExamRef[] {
  const byId = new Map<string, ExamRef>();
  for (const r of rows) if (!byId.has(r.exam_id)) byId.set(r.exam_id, examRefOf(r));
  return [...byId.values()].sort(compareExams);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function mean(values: number[]): number | null {
  return values.length ? round1(values.reduce((a, v) => a + v, 0) / values.length) : null;
}

/** The first and last values that exist, and the change between them. Null with fewer than two. */
export function changeOver(values: (number | null)[]): { from: number; to: number; fromIndex: number; toIndex: number; change: number } | null {
  const present = values.flatMap((v, i) => (v === null ? [] : [{ v, i }]));
  if (present.length < 2) return null;
  const first = present[0]!;
  const last = present[present.length - 1]!;
  return { from: first.v, to: last.v, fromIndex: first.i, toIndex: last.i, change: round1(last.v - first.v) };
}

// ---------------------------------------------------------------- one learner

/** A row of learner_results_history(). */
export interface LearnerHistoryRow extends ExamColumns {
  subject_id: string;
  subject_name: string;
  score: number;
  class_mean: number | null;
}

export interface SubjectSeries {
  id: string;
  name: string;
  scores: (number | null)[];
  classMeans: (number | null)[];
}

export interface LearnerTrend {
  exams: ExamRef[];
  /** The learner's mean over the subjects they sat in each exam. */
  overall: (number | null)[];
  /** The class means of those same subjects, averaged: what "the class" scored on the papers this learner sat. */
  classOverall: (number | null)[];
  /** Alphabetical. */
  subjects: SubjectSeries[];
}

export function learnerTrend(rows: LearnerHistoryRow[]): LearnerTrend {
  const exams = examsOf(rows);
  const col = new Map(exams.map((e, i) => [e.id, i]));
  const subjects = new Map<string, SubjectSeries>();
  for (const r of rows) {
    const s = subjects.get(r.subject_id) ?? {
      id: r.subject_id, name: r.subject_name,
      scores: exams.map(() => null), classMeans: exams.map(() => null),
    };
    const i = col.get(r.exam_id)!;
    s.scores[i] = r.score;
    s.classMeans[i] = r.class_mean === null ? null : Number(r.class_mean);
    subjects.set(r.subject_id, s);
  }
  const list = [...subjects.values()].sort((a, b) => a.name.localeCompare(b.name));
  const overall = exams.map((_, i) => mean(list.flatMap((s) => (s.scores[i] === null ? [] : [s.scores[i]!]))));
  const classOverall = exams.map((_, i) =>
    mean(list.flatMap((s) => (s.scores[i] === null || s.classMeans[i] === null ? [] : [s.classMeans[i]!]))));
  return { exams, overall, classOverall, subjects: list };
}

export interface SubjectStanding {
  id: string;
  name: string;
  /** Mean of every exam the subject was sat in. */
  average: number;
  latest: number | null;
  /** First sitting to latest; null with only one. */
  change: number | null;
  /** How far above (+) or below (-) the class mean, on average. Null without class means. */
  vsClass: number | null;
  sittings: number;
}

/** Strongest first, by average. */
export function subjectStandings(trend: LearnerTrend): SubjectStanding[] {
  return trend.subjects
    .map((s) => {
      const sat = s.scores.filter((v): v is number => v !== null);
      const gaps = s.scores.flatMap((v, i) => (v === null || s.classMeans[i] === null ? [] : [v - s.classMeans[i]!]));
      return {
        id: s.id,
        name: s.name,
        average: mean(sat) ?? 0,
        latest: [...s.scores].reverse().find((v) => v !== null) ?? null,
        change: changeOver(s.scores)?.change ?? null,
        vsClass: mean(gaps),
        sittings: sat.length,
      };
    })
    .filter((s) => s.sittings > 0)
    .sort((a, b) => b.average - a.average || a.name.localeCompare(b.name));
}

/** "Up 6 marks since Opener · Term 1" and the like; null when there is nothing to compare. */
export function describeChange(values: (number | null)[], exams: ExamRef[], unit = "marks"): string | null {
  const c = changeOver(values);
  if (!c) return null;
  const since = exams[c.fromIndex];
  const where = since ? ` since ${since.name} (${since.termName})` : "";
  if (Math.abs(c.change) < 0.5) return `Steady${where}`;
  const amount = Number.isInteger(c.change) ? Math.abs(c.change) : Math.abs(c.change).toFixed(1);
  return `${c.change > 0 ? "Up" : "Down"} ${amount} ${unit}${where}`;
}

// ---------------------------------------------------------------- a class, or the whole school

/** A row of class_exam_performance(): one exam x class x subject. */
export interface ClassPerformanceRow extends ExamColumns {
  class_id: string;
  class_name: string;
  subject_id: string;
  subject_name: string;
  teacher_id: string | null;
  teacher_name: string | null;
  learners: number;
  mean_score: number;
  scores: number[];
}

/** Mean of every mark in each exam, so a subject sat by 40 counts more than one sat by 4. */
export function overallMeans(rows: ClassPerformanceRow[], exams: ExamRef[]): (number | null)[] {
  return exams.map((e) => {
    const these = rows.filter((r) => r.exam_id === e.id);
    const n = these.reduce((a, r) => a + r.learners, 0);
    return n ? round1(these.reduce((a, r) => a + Number(r.mean_score) * r.learners, 0) / n) : null;
  });
}

/** One series per subject, alphabetical; across classes a subject's mean is weighted the same way. */
export function subjectMeans(rows: ClassPerformanceRow[], exams: ExamRef[]): { id: string; name: string; means: (number | null)[] }[] {
  const ids = new Map<string, string>();
  for (const r of rows) ids.set(r.subject_id, r.subject_name);
  return [...ids.entries()]
    .map(([id, name]) => ({ id, name, means: overallMeans(rows.filter((r) => r.subject_id === id), exams) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Each subject's mean in one exam, highest first. */
export function subjectComparison(rows: ClassPerformanceRow[], examId: string): { id: string; name: string; mean: number; learners: number }[] {
  const exam = rows.filter((r) => r.exam_id === examId);
  return subjectMeans(exam, exam.length ? [examRefOf(exam[0]!)] : [])
    .flatMap((s) => {
      const m = s.means[0];
      return m === null || m === undefined ? [] : [{ id: s.id, name: s.name, mean: m, learners: exam.filter((r) => r.subject_id === s.id).reduce((a, r) => a + r.learners, 0) }];
    })
    .sort((a, b) => b.mean - a.mean || a.name.localeCompare(b.name));
}

/**
 * Grade bands for a distribution, best first. KCSE's twelve grades fold into
 * their letter (A- and A are both "A"), CBC's eight into their level (EE1 and
 * EE2 are both "EE"): twelve slivers per bar can't be read.
 */
export const GRADE_BANDS: Record<GradingSchemeId, string[]> = {
  kcse: ["A", "B", "C", "D", "E"],
  cbc: ["EE", "ME", "AE", "BE"],
};

export function gradeBand(score: number, scheme: GradingSchemeId): string {
  const grade = gradeFor(score, scheme);
  return scheme === "cbc" ? grade.slice(0, 2) : grade.slice(0, 1);
}

export interface Distribution {
  key: string;
  label: string;
  sublabel: string;
  /** Learners per band, in GRADE_BANDS order. */
  counts: number[];
  total: number;
}

/** How many marks fell in each grade band, per exam. A subject's marks count separately: this is marks, not learners. */
export function gradeDistributions(rows: ClassPerformanceRow[], exams: ExamRef[], scheme: GradingSchemeId): Distribution[] {
  const bands = GRADE_BANDS[scheme];
  return exams.map((e) => {
    const counts = bands.map(() => 0);
    for (const r of rows) {
      if (r.exam_id !== e.id) continue;
      for (const s of r.scores) counts[bands.indexOf(gradeBand(s, scheme))]! += 1;
    }
    return { key: e.id, label: e.name, sublabel: e.termName, counts, total: counts.reduce((a, c) => a + c, 0) };
  }).filter((d) => d.total > 0);
}

/** A row of class_learner_exam_means(). */
export interface LearnerMeanRow {
  exam_id: string;
  student_id: string;
  full_name: string;
  mean_score: number;
  subjects: number;
}

export interface Mover {
  studentId: string;
  name: string;
  from: number;
  to: number;
  change: number;
}

/** Biggest rises and falls between two exams, among learners who sat both. */
export function movers(rows: LearnerMeanRow[], fromExamId: string, toExamId: string, limit = 5): { improved: Mover[]; dropped: Mover[] } {
  const before = new Map(rows.filter((r) => r.exam_id === fromExamId).map((r) => [r.student_id, Number(r.mean_score)]));
  const all: Mover[] = rows
    .filter((r) => r.exam_id === toExamId && before.has(r.student_id))
    .map((r) => {
      const from = before.get(r.student_id)!;
      const to = Number(r.mean_score);
      return { studentId: r.student_id, name: r.full_name, from, to, change: round1(to - from) };
    });
  const byName = (a: Mover, b: Mover) => a.name.localeCompare(b.name);
  return {
    improved: all.filter((m) => m.change > 0).sort((a, b) => b.change - a.change || byName(a, b)).slice(0, limit),
    dropped: all.filter((m) => m.change < 0).sort((a, b) => a.change - b.change || byName(a, b)).slice(0, limit),
  };
}

export interface TeachingResult {
  key: string;
  classId: string;
  className: string;
  subjectName: string;
  teacherName: string | null;
  learners: number;
  latestExam: ExamRef;
  latest: number;
  /** Against the exam before it in this class and subject; null when it's the first. */
  change: number | null;
}

/**
 * Each class and subject's latest published mean, with who teaches it now and
 * how it moved since the exam before. "Now": teaching_assignments has no
 * history, so a subject that changed hands is credited to today's teacher.
 */
export function teachingResults(rows: ClassPerformanceRow[]): TeachingResult[] {
  const groups = new Map<string, ClassPerformanceRow[]>();
  for (const r of rows) {
    const key = `${r.class_id}:${r.subject_id}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()]
    .map(([key, list]) => {
      const sorted = [...list].sort((a, b) => compareExams(examRefOf(a), examRefOf(b)));
      const last = sorted[sorted.length - 1]!;
      const prev = sorted[sorted.length - 2];
      return {
        key,
        classId: last.class_id,
        className: last.class_name,
        subjectName: last.subject_name,
        teacherName: last.teacher_name,
        learners: last.learners,
        latestExam: examRefOf(last),
        latest: Number(last.mean_score),
        change: prev ? round1(Number(last.mean_score) - Number(prev.mean_score)) : null,
      };
    })
    .sort((a, b) => a.className.localeCompare(b.className) || a.subjectName.localeCompare(b.subjectName));
}

// ---------------------------------------------------------------- CBE rubric levels

/** CBE judgements have no score, so trends are level counts. EE1/EE2 fold into EE, as in GRADE_BANDS.cbc. */
export const RUBRIC_BANDS = GRADE_BANDS.cbc;

export function rubricBand(code: string): string {
  return code.slice(0, 2).toUpperCase();
}

export interface CbeLevelRow {
  /** cbe_assessments.assessed_on, YYYY-MM-DD */
  assessedOn: string;
  levelCode: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Strand judgements per month, oldest first: assessments are dated, and a month keeps a busy term readable. */
export function cbeLevelTrend(rows: CbeLevelRow[]): Distribution[] {
  const byMonth = new Map<string, number[]>();
  for (const r of rows) {
    const band = RUBRIC_BANDS.indexOf(rubricBand(r.levelCode));
    if (band < 0) continue;
    const month = r.assessedOn.slice(0, 7);
    const counts = byMonth.get(month) ?? RUBRIC_BANDS.map(() => 0);
    counts[band]! += 1;
    byMonth.set(month, counts);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, counts]) => ({
      key: month,
      label: MONTHS[Number(month.slice(5, 7)) - 1] ?? month,
      sublabel: month.slice(0, 4),
      counts,
      total: counts.reduce((a, c) => a + c, 0),
    }));
}

// ---------------------------------------------------------------- higher-ed GPA

export interface SemesterGradeRow {
  semesterId: string;
  semesterName: string;
  startsOn: string;
  credits: number;
  gradePoints: number;
}

export interface SemesterGpa {
  semesterId: string;
  name: string;
  gpa: number;
  /** Every finalized course up to and including this semester. */
  cumulative: number;
  credits: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Credit-weighted, like creditWeightedGpa(); a semester with no credits yet is left out. */
export function semesterGpaTrend(rows: SemesterGradeRow[]): SemesterGpa[] {
  const bySemester = new Map<string, { name: string; startsOn: string; credits: number; points: number }>();
  for (const r of rows) {
    if (r.credits <= 0) continue;
    const s = bySemester.get(r.semesterId) ?? { name: r.semesterName, startsOn: r.startsOn, credits: 0, points: 0 };
    s.credits += r.credits;
    s.points += r.credits * r.gradePoints;
    bySemester.set(r.semesterId, s);
  }
  let credits = 0;
  let points = 0;
  return [...bySemester.entries()]
    .sort(([, a], [, b]) => a.startsOn.localeCompare(b.startsOn))
    .map(([semesterId, s]) => {
      credits += s.credits;
      points += s.points;
      return { semesterId, name: s.name, gpa: round2(s.points / s.credits), cumulative: round2(points / credits), credits: s.credits };
    });
}
