/**
 * Behaviour points (docs/BEHAVIOUR.md, "Points"): the period a points total counts, and what a balance is in each mode. The same
 * rules as `behaviourPeriod` and `pointsBalance` in packages/shared/src/behaviour.ts (the live Supabase feature), kept as pure
 * functions so they can be tested without a database. The API cannot import the shared package, so the rule is written here too;
 * `test/behaviour.points.unit.test.ts` pins the cases both sides must agree on.
 */
export type BehaviourMode = "merits_only" | "demerits_only" | "both";
export type BehaviourReset = "term" | "year" | "never";

export interface TermStart {
  academic_year_id: string;
  /** YYYY-MM-DD */
  starts_on: string;
}

export interface Period {
  /** YYYY-MM-DD, or null for "from the beginning" */
  start: string | null;
  /** YYYY-MM-DD inclusive, or null for open-ended */
  end: string | null;
}

const dayBefore = (d: string): string => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/**
 * The points period holding `on` (YYYY-MM-DD).
 *   never  no start, no end.
 *   term   from the start of the latest term that began on or before `on`, to the day before the next term starts (the holiday
 *          after a term belongs to it). Before any term: from 1 January of that year.
 *   year   the academic year of that term: from its first term's start to the day before the first term of a later year starts.
 *          Before any term, as `term`.
 * A null end means open-ended (no later term, or no later year, is set up yet).
 */
export function behaviourPeriod(reset: BehaviourReset, terms: readonly TermStart[], on: string): Period {
  if (reset === "never") return { start: null, end: null };
  const sorted = [...terms].sort((a, b) => a.starts_on.localeCompare(b.starts_on));
  const cur = [...sorted].reverse().find((t) => t.starts_on <= on) ?? null;
  if (reset === "term" || cur === null) {
    const next = sorted.find((t) => t.starts_on > on) ?? null;
    return { start: cur?.starts_on ?? `${on.slice(0, 4)}-01-01`, end: next ? dayBefore(next.starts_on) : null };
  }
  const yearStart = sorted.find((t) => t.academic_year_id === cur.academic_year_id)!.starts_on;
  const nextYear = sorted.find((t) => t.academic_year_id !== cur.academic_year_id && t.starts_on > on) ?? null;
  return { start: yearStart, end: nextYear ? dayBefore(nextYear.starts_on) : null };
}

export interface PointsSettings {
  points_enabled: boolean;
  mode: BehaviourMode;
  starting_points: number;
}

export interface PointsResult {
  merit_points: number;
  demerit_points: number;
  /** null when the school has points turned off. */
  balance: number | null;
}

/**
 * The balance as the school's mode counts it: merits_only: the merits; demerits_only: the starting balance plus the demerits
 * (0 or less); both: merits plus demerits. null when points are off. The sums count every entry that is not voided, whatever
 * families may be shown of them: a total that hid demerits would be wrong.
 */
export function pointsFromSums(merits: number, demerits: number, s: PointsSettings): PointsResult {
  const balance = !s.points_enabled
    ? null
    : s.mode === "merits_only"
      ? merits
      : s.mode === "demerits_only"
        ? s.starting_points + demerits
        : merits + demerits;
  return { merit_points: merits, demerit_points: demerits, balance };
}
