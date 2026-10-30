import { canStartSitting, fetchLearnerExamStates, type LearnerExamState } from "./examExtensions";
import { fetchClassPapers, fetchPaperTotals, fetchReleasedAttempts, paperWindow, type AttemptRow, type ExamPaperRow } from "./examPapers";

/**
 * Exam papers as one learner sees them: what is on for their class, where
 * they stand on each, and what to offer next. The web's Exams screen and the
 * phone's use this, so the two can never disagree about whether a paper is open,
 * handed in or missed.
 */

/** One paper, with this learner's standing on it. */
export interface StudentPaper {
  paper: ExamPaperRow;
  /** This learner's own terms (extensions, resits) and where they stand: online papers only. */
  state: LearnerExamState | undefined;
  /** The sitting that counts, once the teacher has released results. */
  result: AttemptRow | undefined;
  /** Total marks, known once results are out. */
  total: number | undefined;
}

export type StandingTone = "ok" | "info" | "warn" | "muted";

/** Where a paper stands for this learner, in a word. `done` papers belong under "Done", the rest under "Coming up". */
export interface PaperStanding {
  label: string;
  tone: StandingTone;
  done: boolean;
}

/** The window this learner sits in: their own where their teacher gave them one, else the paper's. */
export function studentWindow(v: Pick<StudentPaper, "paper" | "state">): { opensAt: string; closesAt: string | null } {
  return v.state ? { opensAt: v.state.terms.opensAt, closesAt: v.state.terms.closesAt } : { opensAt: v.paper.opensAt, closesAt: v.paper.closesAt };
}

/** Whether this learner can start a sitting now: their first, or a resit. Never for a paper that is only read. */
export function canStartPaper(v: Pick<StudentPaper, "paper" | "state">, nowMs: number): boolean {
  const s = v.state;
  if (!s) return false;
  return canStartSitting({
    terms: { ...s.terms, durationMinutes: v.paper.durationMinutes },
    attemptsUsed: s.attemptsUsed,
    lastSubmitted: !!s.submittedAt,
    excused: s.status === "excused",
    nowMs,
  });
}

/** A resit granted and not started yet. */
export const paperResitWaiting = (v: Pick<StudentPaper, "state">): boolean =>
  !!v.state && v.state.attemptsUsed > 0 && !!v.state.submittedAt && v.state.attemptsUsed < v.state.terms.attemptsAllowed;

/** Where a paper stands for this learner. Missed and excused are never shown as a score. */
export function paperStanding(v: StudentPaper, nowMs: number): PaperStanding {
  const w = paperWindow(studentWindow(v), nowMs);
  if (v.paper.mode === "read") {
    if (v.result) return { label: "Results out", tone: "ok", done: true };
    return w === "upcoming"
      ? { label: "Coming up", tone: "info", done: false }
      : w === "open"
        ? { label: "Open", tone: "warn", done: false }
        : { label: "Closed", tone: "muted", done: true };
  }
  const status = v.state?.status;
  if (status === "in_progress") return { label: "In progress", tone: "warn", done: false };
  if (paperResitWaiting(v) && w !== "closed") {
    return canStartPaper(v, nowMs) ? { label: "Resit open", tone: "warn", done: false } : { label: "Resit coming up", tone: "info", done: false };
  }
  if (v.result) return { label: "Results out", tone: "ok", done: true };
  if (status === "excused") return { label: "Excused", tone: "muted", done: true };
  if (status === "submitted" || status === "marked") return { label: "Handed in", tone: "muted", done: true };
  if (status === "missed" || w === "closed") return { label: "Missed", tone: "muted", done: true };
  if (w === "upcoming") return { label: "Coming up", tone: "info", done: false };
  return { label: "Open now", tone: "warn", done: false };
}

export interface FamilyPaperGroups {
  /** Open or coming up, soonest first. */
  upcoming: StudentPaper[];
  /** Online papers the child missed or was excused from: no mark, and never shown as a 0. */
  notSat: StudentPaper[];
  /** Results released, with the score and the teacher's feedback. */
  released: StudentPaper[];
}

/**
 * What a parent is shown for a child: what is coming up, what was not sat, and
 * the released results. A parent sees the outcome, not the questions or the
 * answers (those stay with the learner), so a paper the child has handed in
 * and is waiting to be marked appears in none of the three.
 */
export function familyPaperGroups(papers: StudentPaper[], nowMs: number): FamilyPaperGroups {
  const status = (v: StudentPaper) => v.state?.status;
  const upcoming = papers
    .filter((v) => !v.result && paperWindow(studentWindow(v), nowMs) !== "closed"
      && status(v) !== "excused" && status(v) !== "submitted" && status(v) !== "marked")
    .sort((a, b) => a.paper.opensAt.localeCompare(b.paper.opensAt))
    .slice(0, 6);
  const notSat = papers.filter((v) => !v.result && (status(v) === "missed" || status(v) === "excused")).slice(0, 6);
  const released = papers.filter((v) => !!v.result).slice(0, 10);
  return { upcoming, notSat, released };
}

/** Every published paper for the learner's class, with their standing on each. */
export async function loadStudentPapers(classId: string, studentId: string): Promise<StudentPaper[]> {
  const [papers, states, results] = await Promise.all([fetchClassPapers(classId), fetchLearnerExamStates(studentId), fetchReleasedAttempts(studentId)]);
  const totals = await fetchPaperTotals(papers.filter((p) => results.has(p.id)).map((p) => p.id));
  return papers.map((paper): StudentPaper => ({ paper, state: states.get(paper.id), result: results.get(paper.id), total: totals.get(paper.id) }));
}
