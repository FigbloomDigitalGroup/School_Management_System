import type { Tx } from "../../db/sql.js";
import { conflict, forbidden, notFound, validationError } from "../../http/errors.js";
import { startOnlineAttempt, submitOnlineAttempt, type OnlineExamQuestion } from "../academics/higherEd.js";

/**
 * A learner's online exams (docs/STUDENT-ACCOUNTS.md, owner decision 4): the PUBLISHED papers of their own current-year
 * classes, and their OWN attempts only. The caller's learner has already been proven by the route (`student_my_learner()`);
 * every statement here is still filtered by school and by that learner.
 *
 * What a learner never sees: a teacher's answer key (`correct_answer` is never selected into a learner's answer), another
 * learner's attempt, an unpublished paper, a paper of another class, and their own score (the API has no "results
 * released" state yet, finding student-4; the teacher reads marks as before).
 */
export const PAPER_NOT_FOUND = "Exam paper not found";
export const ATTEMPT_NOT_FOUND = "Attempt not found";
const MAX_ANSWER_LENGTH = 1000;

export interface LearnerQuestion {
  id: string;
  prompt: string;
  kind: "mcq" | "true_false";
  options: string[] | null;
  points: number;
}

/** The question as a learner may see it: an allowlist of fields, so the answer key can never ride along. */
function forLearner(q: OnlineExamQuestion): LearnerQuestion {
  return { id: q.id, prompt: q.prompt, kind: q.kind, options: q.options ?? null, points: q.points };
}

interface PaperRow {
  id: string;
  title: string;
  max_score: string;
  class_id: string;
  class_name: string;
  subject_id: string;
  subject_name: string;
  published_at: Date;
  questions: OnlineExamQuestion[] | null;
}

/** Published papers of the learner's active memberships of active classes in the current academic year. */
const PAPERS_SQL = `
  SELECT p.id, p.title, p.max_score::text AS max_score, p.class_id, c.name AS class_name, p.subject_id, s.name AS subject_name,
         p.published_at, p.questions
    FROM online_exam_papers p
    JOIN classes c ON c.tenant_id = p.tenant_id AND c.id = p.class_id AND c.active = true AND c.archived_at IS NULL
    JOIN subjects s ON s.tenant_id = p.tenant_id AND s.id = p.subject_id
   WHERE p.tenant_id = $1 AND p.published_at IS NOT NULL AND p.archived_at IS NULL
     AND EXISTS (
       SELECT 1 FROM class_memberships cm
         JOIN academic_years y ON y.tenant_id = cm.tenant_id AND y.id = cm.academic_year_id AND y.is_current = true
        WHERE cm.tenant_id = p.tenant_id AND cm.class_id = p.class_id AND cm.learner_id = $2
          AND cm.active = true AND cm.archived_at IS NULL)`;

async function myPaper(tx: Tx, input: { tenantId: string; learnerId: string; paperId: string; allowArchived?: boolean }): Promise<PaperRow | null> {
  const sql = input.allowArchived ? PAPERS_SQL.replace(" AND p.archived_at IS NULL", "") : PAPERS_SQL;
  const res = await tx.query<PaperRow>(`${sql} AND p.id = $3`, [input.tenantId, input.learnerId, input.paperId]);
  return res.rows[0] ?? null;
}

export interface MyAttemptSummary {
  id: string;
  status: "in_progress" | "submitted";
  started_at: string;
  submitted_at: string | null;
}

export interface MyOnlineExam {
  id: string;
  title: string;
  max_score: string;
  class: { id: string; name: string };
  subject: { id: string; name: string };
  published_at: string;
  question_count: number;
  /** The learner's own attempts at this paper (oldest first). A learner may start one attempt. */
  attempts: MyAttemptSummary[];
}

const iso = (v: Date | string): string => new Date(v).toISOString();

export async function listMyOnlineExams(tx: Tx, input: { tenantId: string; learnerId: string }): Promise<MyOnlineExam[]> {
  const papers = await tx.query<PaperRow>(`${PAPERS_SQL} ORDER BY p.published_at DESC, p.id LIMIT 200`, [input.tenantId, input.learnerId]);
  if (papers.rows.length === 0) return [];
  const attempts = await tx.query<{ id: string; paper_id: string; status: MyAttemptSummary["status"]; created_at: Date; submitted_at: Date | null }>(
    `SELECT id, paper_id, status, created_at, submitted_at FROM online_exam_attempts
      WHERE tenant_id = $1 AND learner_id = $2 AND paper_id = ANY($3::uuid[])
      ORDER BY created_at, id`,
    [input.tenantId, input.learnerId, papers.rows.map((p) => p.id)],
  );
  return papers.rows.map((p) => ({
    id: p.id,
    title: p.title,
    max_score: p.max_score,
    class: { id: p.class_id, name: p.class_name },
    subject: { id: p.subject_id, name: p.subject_name },
    published_at: iso(p.published_at),
    question_count: p.questions?.length ?? 0,
    attempts: attempts.rows
      .filter((a) => a.paper_id === p.id)
      .map((a) => ({ id: a.id, status: a.status, started_at: iso(a.created_at), submitted_at: a.submitted_at ? iso(a.submitted_at) : null })),
  }));
}

export interface MyAttempt {
  id: string;
  status: "in_progress" | "submitted";
  started_at: string;
  submitted_at: string | null;
  /** The answers saved so far (or submitted): question id to the chosen answer. */
  answers: Record<string, string>;
  paper: { id: string; title: string; max_score: string; subject: { id: string; name: string }; questions: LearnerQuestion[] };
}

async function loadMyAttempt(tx: Tx, input: { tenantId: string; learnerId: string; attemptId: string; lock?: boolean }) {
  const res = await tx.query<{ id: string; paper_id: string; status: MyAttempt["status"]; created_at: Date; submitted_at: Date | null; answers: Record<string, string> | null }>(
    `SELECT id, paper_id, status, created_at, submitted_at, answers FROM online_exam_attempts
      WHERE tenant_id = $1 AND id = $2 AND learner_id = $3${input.lock ? " FOR UPDATE" : ""}`,
    [input.tenantId, input.attemptId, input.learnerId],
  );
  const attempt = res.rows[0];
  if (!attempt) throw notFound(ATTEMPT_NOT_FOUND);
  // The paper must still be one of the learner's published papers (a class change takes it away).
  const paper = await myPaper(tx, { tenantId: input.tenantId, learnerId: input.learnerId, paperId: attempt.paper_id, allowArchived: true });
  if (!paper) throw notFound(ATTEMPT_NOT_FOUND);
  return { attempt, paper };
}

function view(attempt: { id: string; status: MyAttempt["status"]; created_at: Date; submitted_at: Date | null; answers: Record<string, string> | null }, paper: PaperRow): MyAttempt {
  return {
    id: attempt.id,
    status: attempt.status,
    started_at: iso(attempt.created_at),
    submitted_at: attempt.submitted_at ? iso(attempt.submitted_at) : null,
    answers: attempt.answers ?? {},
    paper: {
      id: paper.id,
      title: paper.title,
      max_score: paper.max_score,
      subject: { id: paper.subject_id, name: paper.subject_name },
      questions: (paper.questions ?? []).map(forLearner),
    },
  };
}

export async function getMyAttempt(tx: Tx, input: { tenantId: string; learnerId: string; attemptId: string }): Promise<MyAttempt> {
  const { attempt, paper } = await loadMyAttempt(tx, input);
  return view(attempt, paper);
}

/** Only answers to this paper's questions, each a short string. */
function checkAnswers(paper: PaperRow, answers: Record<string, string>): void {
  const ids = new Set((paper.questions ?? []).map((q) => q.id));
  for (const [key, value] of Object.entries(answers)) {
    if (!ids.has(key)) throw validationError("answers may only name this paper's questions");
    if (typeof value !== "string" || value.length > MAX_ANSWER_LENGTH) throw validationError(`each answer must be at most ${MAX_ANSWER_LENGTH} characters`);
  }
}

/** Start the learner's attempt at a published paper of their own class. One attempt per paper. */
export async function startMyAttempt(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; learnerId: string; paperId: string; ip: string | null },
): Promise<MyAttempt> {
  const paper = await myPaper(tx, input);
  if (!paper) throw notFound(PAPER_NOT_FOUND);
  if (!paper.questions || paper.questions.length === 0) throw conflict("This paper has no questions to answer online");
  const earlier = await tx.query<{ status: string }>(
    `SELECT status FROM online_exam_attempts WHERE tenant_id = $1 AND paper_id = $2 AND learner_id = $3 LIMIT 1`,
    [input.tenantId, input.paperId, input.learnerId],
  );
  if (earlier.rows[0]) {
    throw conflict(earlier.rows[0].status === "in_progress" ? "This paper is already started: open the attempt to carry on" : "This paper has already been submitted");
  }
  const started = await startOnlineAttempt(tx, {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    paperId: input.paperId,
    learner_id: input.learnerId,
    ip: input.ip,
  });
  return getMyAttempt(tx, { tenantId: input.tenantId, learnerId: input.learnerId, attemptId: started.id });
}

/** Save answers while the attempt is in progress (the sitting page saves as it goes). Replaces the saved set. */
export async function saveMyAnswers(
  tx: Tx,
  input: { tenantId: string; learnerId: string; attemptId: string; answers: Record<string, string> },
): Promise<MyAttempt> {
  const { attempt, paper } = await loadMyAttempt(tx, { ...input, lock: true });
  if (attempt.status !== "in_progress") throw conflict("This attempt is already submitted");
  checkAnswers(paper, input.answers);
  await tx.query(`UPDATE online_exam_attempts SET answers = $3::jsonb WHERE tenant_id = $1 AND id = $2 AND status = 'in_progress'`, [
    input.tenantId,
    input.attemptId,
    JSON.stringify(input.answers),
  ]);
  return getMyAttempt(tx, input);
}

/**
 * Submit the learner's own attempt with their answers. It is marked automatically against the paper's questions (the
 * learner is not told the score). A learner never sends a score: that is a teacher's act, refused with 403.
 */
export async function submitMyAttempt(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; learnerId: string; attemptId: string; answers?: Record<string, string>; score?: number; ip: string | null },
): Promise<{ id: string; status: "submitted"; submitted_at: string }> {
  if (input.score !== undefined) throw forbidden("A learner submits answers, not a score");
  const { attempt, paper } = await loadMyAttempt(tx, { ...input, lock: true });
  if (attempt.status !== "in_progress") throw conflict("This attempt is already submitted");
  const answers = input.answers ?? attempt.answers ?? {};
  checkAnswers(paper, answers);
  const done = await submitOnlineAttempt(tx, {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    attemptId: input.attemptId,
    answers,
    ip: input.ip,
    markedBy: null,
  });
  return { id: done.id, status: "submitted", submitted_at: done.submitted_at! };
}
