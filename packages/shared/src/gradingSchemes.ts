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

/** Falls back to kcse for an unregistered country — matches the product's
 *  only real customers today (all Kenyan) rather than throwing, so onboarding
 *  a tenant with a not-yet-modeled country doesn't hard-fail. */
export function gradingSchemeFor(country: string, classLevel: ClassLevel): GradingSchemeId {
  return K12_SCHEME_REGISTRY[country]?.[classLevel] ?? "kcse";
}
