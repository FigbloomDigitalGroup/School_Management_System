import type { ClassLevel } from "./types";

/**
 * Which K-12 grading scale applies, registered by country + class level —
 * not hardcoded to Kenya. Kenya is the only entry today (KCSE for secondary,
 * CBC for primary/junior-secondary), but the shape supports adding another
 * country's system later without touching any call site.
 */

export type GradingSchemeId = "kcse" | "cbc";

export interface GradeBand { min: number; grade: string; points: number }

/** KCSE-style 12-point scale — Kenya's secondary-school scheme. */
export const KCSE_SCALE: GradeBand[] = [
  { min: 80, grade: "A", points: 12 },
  { min: 75, grade: "A-", points: 11 },
  { min: 70, grade: "B+", points: 10 },
  { min: 65, grade: "B", points: 9 },
  { min: 60, grade: "B-", points: 8 },
  { min: 55, grade: "C+", points: 7 },
  { min: 50, grade: "C", points: 6 },
  { min: 45, grade: "C-", points: 5 },
  { min: 40, grade: "D+", points: 4 },
  { min: 35, grade: "D", points: 3 },
  { min: 30, grade: "D-", points: 2 },
  { min: 0, grade: "E", points: 1 },
];

/** CBC rubric — Kenya's primary/junior-secondary scheme. A 4-band/8-point
 *  competency rubric, a genuinely different shape from KCSE's letter grades,
 *  not a relabeling of the same bands. */
export const CBC_SCALE: GradeBand[] = [
  { min: 90, grade: "EE1", points: 8 },
  { min: 75, grade: "EE2", points: 7 },
  { min: 58, grade: "ME1", points: 6 },
  { min: 41, grade: "ME2", points: 5 },
  { min: 31, grade: "AE1", points: 4 },
  { min: 21, grade: "AE2", points: 3 },
  { min: 11, grade: "BE1", points: 2 },
  { min: 1, grade: "BE2", points: 1 },
];

export const SCHEMES: Record<GradingSchemeId, GradeBand[]> = { kcse: KCSE_SCALE, cbc: CBC_SCALE };

const K12_SCHEME_REGISTRY: Record<string, Partial<Record<ClassLevel, GradingSchemeId>>> = {
  KE: { pre_primary: "cbc", primary: "cbc", junior_secondary: "cbc", senior_school: "cbc", secondary: "kcse" },
};

// ---------------------------------------------------------------- CBE rubric

/**
 * A judgement level on the CBE rubric — what a teacher records per learner
 * per strand (cbe_results.level_code). Not a band over a percentage: there is
 * no score behind it. Mirrors rubric_points() in
 * supabase/migrations/20260924060000_cbe_assessment.sql; keep them in step.
 */
export interface RubricLevel { code: string; label: string; points: number }

/** Four levels — pre-primary and primary. */
export const CBC_RUBRIC_4: RubricLevel[] = [
  { code: "EE", label: "Exceeding expectations", points: 4 },
  { code: "ME", label: "Meeting expectations", points: 3 },
  { code: "AE", label: "Approaching expectations", points: 2 },
  { code: "BE", label: "Below expectations", points: 1 },
];

/** Eight levels — junior and senior school. Each of the four split high/low. */
export const CBC_RUBRIC_8: RubricLevel[] = [
  { code: "EE1", label: "Exceeding expectations (high)", points: 8 },
  { code: "EE2", label: "Exceeding expectations", points: 7 },
  { code: "ME1", label: "Meeting expectations (high)", points: 6 },
  { code: "ME2", label: "Meeting expectations", points: 5 },
  { code: "AE1", label: "Approaching expectations (high)", points: 4 },
  { code: "AE2", label: "Approaching expectations", points: 3 },
  { code: "BE1", label: "Below expectations (high)", points: 2 },
  { code: "BE2", label: "Below expectations", points: 1 },
];

const RUBRIC_REGISTRY: Record<string, Partial<Record<ClassLevel, RubricLevel[]>>> = {
  KE: { pre_primary: CBC_RUBRIC_4, primary: CBC_RUBRIC_4, junior_secondary: CBC_RUBRIC_8, senior_school: CBC_RUBRIC_8 },
};

/** The rubric a class is judged on, or null where it's graded by exam marks instead (8-4-4 Forms). */
export function rubricFor(country: string, classLevel: ClassLevel): RubricLevel[] | null {
  return RUBRIC_REGISTRY[country]?.[classLevel] ?? null;
}

export interface StrandSummary {
  entered: number;
  total: number;
  meanPoints: number | null;
  /** The rubric level nearest the mean; null until at least one strand is judged. */
  overall: RubricLevel | null;
}

/** Overall level across a learner's strands: the mean of their points, read
 *  back onto the rubric. Never invented from nothing — no judgements, no level. */
export function summariseStrands(codes: (string | null | undefined)[], rubric: RubricLevel[]): StrandSummary {
  const points = codes
    .map((c) => rubric.find((l) => l.code === c)?.points)
    .filter((p): p is number => p !== undefined);
  if (!points.length) return { entered: 0, total: codes.length, meanPoints: null, overall: null };
  const mean = points.reduce((a, b) => a + b, 0) / points.length;
  const overall = rubric.reduce((best, l) => (Math.abs(l.points - mean) < Math.abs(best.points - mean) ? l : best));
  return { entered: points.length, total: codes.length, meanPoints: Math.round(mean * 10) / 10, overall };
}

/** Falls back to kcse for an unregistered country — matches the product's
 *  only real customers today (all Kenyan) rather than throwing, so onboarding
 *  a tenant with a not-yet-modeled country doesn't hard-fail. */
export function gradingSchemeFor(country: string, classLevel: ClassLevel): GradingSchemeId {
  return K12_SCHEME_REGISTRY[country]?.[classLevel] ?? "kcse";
}
