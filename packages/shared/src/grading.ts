/**
 * Grade/points computation against whichever scheme applies (see
 * gradingSchemes.ts) — KCSE and CBC today. ONE source of truth per scheme —
 * the same score must never render as two different grades anywhere in the
 * product, so every call site passes the scheme explicitly rather than
 * relying on a silent default.
 */

import { CBC_SCALE, KCSE_SCALE, SCHEMES, type GradingSchemeId } from "./gradingSchemes";

export type Grade = (typeof KCSE_SCALE)[number]["grade"] | (typeof CBC_SCALE)[number]["grade"];

export function gradeFor(score: number, scheme: GradingSchemeId): Grade {
  const bands = SCHEMES[scheme];
  return (bands.find((g) => score >= g.min) ?? bands[bands.length - 1]!).grade as Grade;
}

export function pointsFor(score: number, scheme: GradingSchemeId): number {
  const bands = SCHEMES[scheme];
  return (bands.find((g) => score >= g.min) ?? bands[bands.length - 1]!).points;
}

// One merged map covering both label sets — KCSE's A/A-/… and CBC's
// EE1/EE2/… never collide, so a single Record needs no scheme-namespacing.
export const GRADE_INK: Record<string, string> = {
  A: "#1B4D2E", "A-": "#1B4D2E", "B+": "#2E7D4F", B: "#2E7D4F",
  "B-": "#8A6D08", "C+": "#8A3D08", C: "#8A3D08", "C-": "#8A3D08",
  "D+": "#B8460A", D: "#B8460A", "D-": "#B8460A", E: "#B8460A",
  EE1: "#1B4D2E", EE2: "#2E7D4F", ME1: "#2E7D4F", ME2: "#8A6D08",
  AE1: "#8A3D08", AE2: "#8A3D08", BE1: "#B8460A", BE2: "#B8460A",
};

export interface SubjectResult { subject: string; score: number | null }

export interface Summary {
  entered: number;
  total: number;
  meanScore: number | null;
  meanGrade: Grade | null;
  totalPoints: number;
}

/** Never invent a mean from a partial roster — say how many are missing instead. */
export function summarise(results: SubjectResult[], scheme: GradingSchemeId): Summary {
  const scored = results.filter((r) => r.score !== null) as { subject: string; score: number }[];
  if (!scored.length) {
    return { entered: 0, total: results.length, meanScore: null, meanGrade: null, totalPoints: 0 };
  }
  const meanScore = Math.round(scored.reduce((a, r) => a + r.score, 0) / scored.length);
  return {
    entered: scored.length,
    total: results.length,
    meanScore,
    meanGrade: gradeFor(meanScore, scheme),
    totalPoints: scored.reduce((a, r) => a + pointsFor(r.score, scheme), 0),
  };
}

/** Shown to students instead of a class rank. */
export function againstMean(score: number, classMean: number): string {
  const d = score - classMean;
  if (d === 0) return `Exactly the class mean of ${classMean}`;
  return `${Math.abs(d)} ${d > 0 ? "above" : "below"} the class mean of ${classMean}`;
}

/** Bulk entry: accepts "72", "72 ", "abs", "-" and rejects anything out of range. */
export function parseScoreInput(raw: string, outOf = 100): { ok: true; score: number | null } | { ok: false; message: string } {
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "-") return { ok: true, score: null };
  if (v === "abs" || v === "absent") return { ok: true, score: null };
  if (!/^\d{1,3}$/.test(v)) return { ok: false, message: "Numbers only, or 'abs' if they missed it." };
  const n = Number(v);
  if (n > outOf) return { ok: false, message: `This paper is out of ${outOf}.` };
  return { ok: true, score: n };
}
