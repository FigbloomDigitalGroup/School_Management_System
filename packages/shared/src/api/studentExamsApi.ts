import type { LearnerExamState } from "../examExtensions";
import type { Answers, AttemptSession, ExamPaperRow, SittingQuestion } from "../examPapers";
import type { StudentPaper } from "../studentExams";
import { apiClient } from "./client";
import { isApiError } from "./errors";
import { apiFetchOwnLearner } from "./ownLearner";
import { familyTenantId } from "./parentApi";
import type { components } from "./schema";

/**
 * A learner's online exams on apps/api: the API side of studentExams.ts and the sitting functions of examPapers.ts, for the Exams & tests
 * pages (docs/web-on-api/student-pages.md; apps/api/docs/STUDENT-ACCOUNTS.md, "Online exams").
 *
 * The API's exam is smaller than Supabase's, and the differences are handled here, not in the screens:
 *  - A paper is the PUBLISHED online paper of the learner's own class: a title, subject, total marks and objective questions (multiple choice
 *    and true or false). There is no kind, window, time limit, instructions, file or typed text: a paper is open from the moment it is
 *    published, has no clock and no deadline, and never closes (so there is no "missed").
 *  - A learner has ONE attempt per paper (no resits). Starting it twice is a 409, so a paper already started is carried on from its attempt.
 *  - The answer to a question is the text of the chosen option (the server compares it with the key, ignoring case and spaces); the screens
 *    keep the option's number, which is turned into its text on the way out and back on the way in. A true or false question has no
 *    options of its own: "True" and "False" are offered.
 *  - The learner is never told a score: the server marks the attempt and sends back no mark, so there is no "your score" and no review
 *    (studentCapabilities().examScores). A paper with no questions cannot be sat online (409) and is left out of the list.
 */

type StudentExam = components["schemas"]["StudentOnlineExam"];
type StudentAttempt = components["schemas"]["StudentOnlineExamAttempt"];
type StudentQuestion = components["schemas"]["StudentOnlineExamQuestion"];

export function paperFromStudentExam(p: StudentExam): ExamPaperRow {
  const max = Number(p.max_score);
  return {
    id: p.id, kind: "exam", title: p.title, instructions: "",
    classId: p.class.id, className: p.class.name, subjectId: p.subject.id, subjectName: p.subject.name,
    examId: null, examName: null, mode: "online", filePath: null, fileName: null,
    opensAt: p.published_at, closesAt: null, durationMinutes: null, publishedAt: p.published_at, resultsReleasedAt: null,
    questionCount: p.question_count, attemptCount: p.attempts.length,
    maxScore: Number.isFinite(max) && max > 0 ? max : null,
  };
}

/** Where the learner stands: no attempt, one under way, or one handed in. One attempt is all there is, and there is never an extension or an excusal. */
export function stateFromStudentExam(p: StudentExam): LearnerExamState {
  const a = p.attempts[p.attempts.length - 1];
  return {
    paperId: p.id,
    terms: { opensAt: p.published_at, closesAt: null, extraMinutes: 0, attemptsAllowed: 1, counting: "latest" },
    attemptsUsed: p.attempts.length,
    startedAt: a?.started_at ?? null,
    submittedAt: a?.submitted_at ?? null,
    deadline: null,
    status: !a ? "not_started" : a.status === "in_progress" ? "in_progress" : "submitted",
  };
}

async function listMine(): Promise<StudentExam[]> {
  const tenantId = familyTenantId();
  return (await apiClient().get("/v1/tenants/{tenantId}/me/learner/online-exams", { path: { tenantId }, tenantId })).papers;
}

/** The online papers published for the learner's class, with their own standing on each. */
export async function apiLoadStudentPapers(): Promise<StudentPaper[]> {
  const papers = await listMine();
  return papers
    .filter((p) => p.question_count > 0)
    .map((p) => ({ paper: paperFromStudentExam(p), state: stateFromStudentExam(p), result: undefined, total: undefined }));
}

// ---------------------------------------------------------------- one sitting

/** What a sitting remembers between its calls: the attempt and the paper's questions, so a save needs no read. */
interface Sitting {
  attemptId: string;
  startedAt: string;
  questions: StudentQuestion[];
}

const sittings = new Map<string, Sitting>();
const starting = new Map<string, Promise<AttemptSession>>();

/** Kept per signed-in person, so a sitting is never carried over to whoever signs in next on the same page. */
const keyOf = (paperId: string): string => `${apiClient().session()?.userId ?? ""}|${paperId}`;

/** The options a question offers: its own, or True and False for a true or false question that lists none. */
export function optionsOf(q: Pick<StudentQuestion, "kind" | "options">): string[] {
  return q.options && q.options.length ? q.options : q.kind === "true_false" ? ["True", "False"] : [];
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The saved answers (option text) as the screen keeps them (option numbers); one that matches no option is kept as text. */
export function answersToScreen(questions: readonly StudentQuestion[], saved: Record<string, string>): Answers {
  const out: Answers = {};
  for (const q of questions) {
    const text = saved[q.id];
    if (text === undefined) continue;
    const k = optionsOf(q).findIndex((o) => same(o, text));
    out[q.id] = k >= 0 ? k : text;
  }
  return out;
}

/** The screen's answers (option numbers) as the server takes them (option text), for this paper's questions only; a number with no such option is left out. */
export function answersToServer(questions: readonly StudentQuestion[], answers: Answers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of questions) {
    const a = answers[q.id];
    if (a === undefined) continue;
    const text = typeof a === "number" ? optionsOf(q)[a] : a;
    if (text !== undefined) out[q.id] = text;
  }
  return out;
}

function isStudentAttempt(a: unknown): a is StudentAttempt {
  const o = a as { id?: unknown; paper?: { questions?: unknown } } | null;
  return !!o && typeof o.id === "string" && Array.isArray(o.paper?.questions);
}

function sessionOf(paperId: string, a: StudentAttempt): AttemptSession {
  return {
    id: a.id, paperId, attemptNo: 1, startedAt: a.started_at, submittedAt: a.submitted_at, deadline: null,
    answers: answersToScreen(a.paper.questions, a.answers), skewMs: 0, timedOut: false,
  };
}

async function readAttempt(attemptId: string): Promise<StudentAttempt> {
  const tenantId = familyTenantId();
  return (await apiClient().get("/v1/tenants/{tenantId}/me/learner/online-exam-attempts/{attemptId}", { path: { tenantId, attemptId }, tenantId })).attempt;
}

async function begin(paperId: string): Promise<AttemptSession> {
  const tenantId = familyTenantId();
  const paper = async () => (await listMine()).find((p) => p.id === paperId);
  const mine = async () => (await paper())?.attempts.at(-1);
  const listed = await paper();
  if (!listed) throw new Error("That paper is not open to you.");
  let existing = listed.attempts.at(-1);
  let attempt: StudentAttempt;
  if (existing) {
    attempt = await readAttempt(existing.id);
  } else {
    const learner = await apiFetchOwnLearner();
    try {
      const made = (await apiClient().post("/v1/tenants/{tenantId}/online-exam-papers/{paperId}/attempts", {
        path: { tenantId, paperId }, body: { learner_id: learner.learner_id }, tenantId,
      })).attempt;
      if (!isStudentAttempt(made)) throw new Error("The server's answer about that paper was not understood.");
      attempt = made;
    } catch (err) {
      // Another start of the same paper got there first (the page opened twice): carry on with that attempt.
      if (!(isApiError(err) && err.code === "conflict")) throw err;
      existing = await mine();
      if (!existing) throw err;
      attempt = await readAttempt(existing.id);
    }
  }
  sittings.set(keyOf(paperId), { attemptId: attempt.id, startedAt: attempt.started_at, questions: attempt.paper.questions });
  return sessionOf(paperId, attempt);
}

/** Starts the learner's attempt at a paper, or picks up the one under way. Asked twice at once (a page that renders twice), it is one start. */
export function apiStartExamAttempt(paperId: string): Promise<AttemptSession> {
  const key = keyOf(paperId);
  const running = starting.get(key);
  if (running) return running;
  const p = begin(paperId).finally(() => { starting.delete(key); });
  starting.set(key, p);
  return p;
}

async function sittingOf(paperId: string): Promise<Sitting> {
  const known = sittings.get(keyOf(paperId));
  if (known) return known;
  await apiStartExamAttempt(paperId);
  const s = sittings.get(keyOf(paperId));
  if (!s) throw new Error("That paper is not open to you.");
  return s;
}

/** The paper's questions (without the key), as the sitting screen reads them: every question is a choice. */
export async function apiFetchSittingQuestions(paperId: string): Promise<SittingQuestion[]> {
  const s = await sittingOf(paperId);
  return s.questions.map((q) => ({ id: q.id, kind: "choice", prompt: q.prompt, options: optionsOf(q), points: q.points }));
}

/**
 * Saves the answers (`submit` false: the server replaces the saved set) or hands them in (`submit` true: the answers go with the hand-in and
 * the server marks them; it sends back no score).
 */
export async function apiSaveExamAttempt(paperId: string, answers: Answers, submit: boolean): Promise<AttemptSession> {
  const tenantId = familyTenantId();
  const s = await sittingOf(paperId);
  const body = { answers: answersToServer(s.questions, answers) };
  if (submit) {
    const done = (await apiClient().post("/v1/tenants/{tenantId}/online-exam-attempts/{attemptId}/submit", { path: { tenantId, attemptId: s.attemptId }, body, tenantId })) as { submitted_at?: string };
    sittings.delete(keyOf(paperId));
    return {
      id: s.attemptId, paperId, attemptNo: 1, startedAt: s.startedAt, submittedAt: done.submitted_at ?? new Date().toISOString(), deadline: null,
      answers, skewMs: 0, timedOut: false,
    };
  }
  const saved = (await apiClient().put("/v1/tenants/{tenantId}/me/learner/online-exam-attempts/{attemptId}/answers", { path: { tenantId, attemptId: s.attemptId }, body, tenantId })).attempt;
  return sessionOf(paperId, saved);
}

/** Forgets what a sitting kept (sign-out, tests). */
export function forgetSittings(): void {
  sittings.clear();
  starting.clear();
}
