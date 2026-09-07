/**
 * KCSE-style 12-point scale. ONE source of truth — the same score must never
 * render as two different grades anywhere in the product.
 */

export const GRADE_SCALE = [
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
] as const;

export type Grade = (typeof GRADE_SCALE)[number]["grade"];

export function gradeFor(score: number): Grade {
  return (GRADE_SCALE.find((g) => score >= g.min) ?? GRADE_SCALE[GRADE_SCALE.length - 1]!).grade;
}

export function pointsFor(score: number): number {
  return (GRADE_SCALE.find((g) => score >= g.min) ?? GRADE_SCALE[GRADE_SCALE.length - 1]!).points;
}

export const GRADE_INK: Record<string, string> = {
  A: "#1B4D2E", "A-": "#1B4D2E", "B+": "#2E7D4F", B: "#2E7D4F",
  "B-": "#8A6D08", "C+": "#8A3D08", C: "#8A3D08", "C-": "#8A3D08",
  "D+": "#B8460A", D: "#B8460A", "D-": "#B8460A", E: "#B8460A",
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
export function summarise(results: SubjectResult[]): Summary {
  const scored = results.filter((r) => r.score !== null) as { subject: string; score: number }[];
  if (!scored.length) {
    return { entered: 0, total: results.length, meanScore: null, meanGrade: null, totalPoints: 0 };
  }
  const meanScore = Math.round(scored.reduce((a, r) => a + r.score, 0) / scored.length);
  return {
    entered: scored.length,
    total: results.length,
    meanScore,
    meanGrade: gradeFor(meanScore),
    totalPoints: scored.reduce((a, r) => a + pointsFor(r.score), 0),
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
