import type { ClassLevel, Tenant } from "./types";

/**
 * Class levels and the years inside them — the one place that knows PP1 comes
 * before Grade 1, that Grade 6 moves up into junior school, and that Form 4
 * leaves. Mirrors level_year_valid() in
 * supabase/migrations/20260924030000_cbe_level_keys.sql; keep the two in step.
 *
 * A class's year is (level, form_level), never form_level alone: Grade 1,
 * Form 1 and PP1 are all form_level 1.
 */

export type Track = "cbe" | "844";
export type Pathway = "stem" | "social_sciences" | "arts_sports";

export interface LevelInfo {
  /** Section heading, e.g. "Junior school". */
  label: string;
  /** What a single year is called: "PP1", "Grade 7", "Form 3". */
  prefix: "PP" | "Grade" | "Form";
  min: number;
  max: number;
  track: Track;
}

export const LEVELS: Record<ClassLevel, LevelInfo> = {
  pre_primary: { label: "Pre-primary", prefix: "PP", min: 1, max: 2, track: "cbe" },
  primary: { label: "Primary", prefix: "Grade", min: 1, max: 6, track: "cbe" },
  junior_secondary: { label: "Junior school", prefix: "Grade", min: 7, max: 9, track: "cbe" },
  senior_school: { label: "Senior school", prefix: "Grade", min: 10, max: 12, track: "cbe" },
  secondary: { label: "Secondary (8-4-4)", prefix: "Form", min: 1, max: 4, track: "844" },
};

/** Youngest to oldest, CBE first, then the 8-4-4 track. */
export const LEVEL_ORDER: ClassLevel[] = ["pre_primary", "primary", "junior_secondary", "senior_school", "secondary"];

export const PATHWAY_LABEL: Record<Pathway, string> = {
  stem: "STEM",
  social_sciences: "Social Sciences",
  arts_sports: "Arts & Sports Science",
};

/** "PP1", "Grade 7", "Form 3". */
export function yearLabel(level: ClassLevel, year: number): string {
  const { prefix } = LEVELS[level];
  return prefix === "PP" ? `PP${year}` : `${prefix} ${year}`;
}

export function yearsFor(level: ClassLevel): number[] {
  const { min, max } = LEVELS[level];
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

export function isValidYear(level: ClassLevel, year: number): boolean {
  const { min, max } = LEVELS[level];
  return Number.isInteger(year) && year >= min && year <= max;
}

/** The levels a school of this kind can create classes at. A secondary school
 *  runs junior and senior CBE alongside its last 8-4-4 Forms. */
export function levelsForTenant(tenantLevel: Tenant["level"]): ClassLevel[] {
  if (tenantLevel === "primary") return ["pre_primary", "primary", "junior_secondary"];
  if (tenantLevel === "secondary") return ["junior_secondary", "senior_school", "secondary"];
  return LEVEL_ORDER;
}

/** The school-kind choice at onboarding, spelled out in the years each one covers (levelsForTenant). */
export const SCHOOL_LEVEL_OPTIONS: { value: Tenant["level"]; label: string }[] = [
  { value: "secondary", label: "Secondary — junior & senior school (CBE) and 8-4-4 Forms" },
  { value: "primary", label: "Primary — PP1 to Grade 9 (CBE)" },
  { value: "combined", label: "Combined — every level" },
];

/** Pre-selected level when adding a class — unchanged from before CBE levels existed. */
export function defaultLevelForTenant(tenantLevel: Tenant["level"]): ClassLevel {
  return tenantLevel === "primary" ? "primary" : "secondary";
}

// CBE years on one line: PP1 = -1, PP2 = 0, Grade n = n.
function cbeIndex(level: ClassLevel, year: number): number {
  return level === "pre_primary" ? year - 2 : year;
}

function fromCbeIndex(i: number): { level: ClassLevel; year: number } | null {
  if (i <= 0) return i >= -1 ? { level: "pre_primary", year: i + 2 } : null;
  if (i <= 6) return { level: "primary", year: i };
  if (i <= 9) return { level: "junior_secondary", year: i };
  if (i <= 12) return { level: "senior_school", year: i };
  return null;
}

/** The year a class moves up into, or null when its learners leave the school
 *  system (Grade 12, Form 4). Crosses levels: PP2 → Grade 1, Grade 6 → Grade 7,
 *  Grade 9 → Grade 10. */
export function nextYear(level: ClassLevel, year: number): { level: ClassLevel; year: number } | null {
  if (LEVELS[level].track === "844") return year < LEVELS.secondary.max ? { level, year: year + 1 } : null;
  return fromCbeIndex(cbeIndex(level, year) + 1);
}

/** Orders classes youngest first: PP1 … Grade 12, then Form 1 … Form 4. */
export function yearSortKey(level: ClassLevel, year: number): number {
  return LEVELS[level].track === "844" ? 100 + year : cbeIndex(level, year);
}

export interface YearGroup { key: string; level: ClassLevel; year: number }

export const yearGroupKey = (level: ClassLevel, year: number) => `${level}:${year}`;

/** The distinct year groups a set of classes covers, youngest first. */
export function yearGroupsOf(classes: { level: ClassLevel; form_level: number }[]): YearGroup[] {
  const byKey = new Map<string, YearGroup>();
  for (const c of classes) byKey.set(yearGroupKey(c.level, c.form_level), { key: yearGroupKey(c.level, c.form_level), level: c.level, year: c.form_level });
  return [...byKey.values()].sort((a, b) => yearSortKey(a.level, a.year) - yearSortKey(b.level, b.year));
}

/** Label for a row aimed at a year whose level may be unknown (written before levels were recorded). */
export function targetYearLabel(level: ClassLevel | null | undefined, year: number): string {
  return level ? yearLabel(level, year) : `Form ${year}`;
}

/** Whether a class offers a subject: its level (when the subject names one)
 *  and its min/max year bounds, read within that level. */
export function subjectOffered(
  subject: { level?: ClassLevel | null; min_form_level: number | null; max_form_level: number | null },
  cls: { level: ClassLevel; year: number },
): boolean {
  if (subject.level && subject.level !== cls.level) return false;
  return (subject.min_form_level == null || subject.min_form_level <= cls.year)
    && (subject.max_form_level == null || subject.max_form_level >= cls.year);
}

/**
 * Whether something aimed at a year (a fee item, a form-wide announcement, a
 * subject's range) applies to a class. A null target level is a row written
 * before levels were recorded; it keeps its old meaning — any class with that
 * form_level.
 */
export function yearMatches(
  target: { level: ClassLevel | null | undefined; year: number },
  cls: { level: ClassLevel | null | undefined; year: number },
): boolean {
  if (target.year !== cls.year) return false;
  return !target.level || !cls.level || target.level === cls.level;
}
