import { supabase } from "./supabase";

/**
 * Exam papers and assessments (supabase/migrations/20261025030000_exam_papers.sql).
 * A teacher posts a paper for one class and subject; learners either read it
 * (a PDF or typed paper, written by hand in the exam room) or sit it online
 * (timed, choice questions marked automatically, written answers marked by
 * the teacher). "Assessment" covers CATs, quizzes and tests: the same engine.
 */

export type PaperKind = "exam" | "assessment";
export type PaperMode = "read" | "online";
export type QuestionKind = "choice" | "short" | "long";

export const PAPER_KIND_LABEL: Record<PaperKind, string> = { exam: "Exam", assessment: "Test / CAT" };
export const PAPER_MODE_LABEL: Record<PaperMode, string> = { read: "Read only", online: "Sat online" };
export const QUESTION_KIND_LABEL: Record<QuestionKind, string> = { choice: "Multiple choice", short: "Short answer", long: "Long answer" };

/** Answers as stored: an option index for a choice question, text for a written one. Keyed by question id. */
export type Answers = Record<string, number | string>;

const TITLE_MAX = 160;
const INSTRUCTIONS_MAX = 4000;
const BODY_MAX = 50000;
const PROMPT_MAX = 4000;
const OPTIONS_MIN = 2;
const OPTIONS_MAX = 8;
const POINTS_MAX = 100;
const DURATION_MAX = 600;
/** Mirrors the database: answers saved up to two minutes after time is up still count (a slow connection). */
export const SUBMIT_GRACE_MS = 2 * 60_000;

// ---------------------------------------------------------------- the paper
export interface PaperInput {
  kind: PaperKind;
  title: string;
  instructions: string;
  classId: string;
  subjectId: string;
  /** The term exam this counts towards, so its scores can go into the Gradebook. */
  examId: string | null;
  mode: PaperMode;
  /** A read-mode paper typed in rather than uploaded. */
  body: string;
  /** ISO timestamps. */
  opensAt: string;
  closesAt: string | null;
  /** Online only; null = no time limit beyond closesAt. */
  durationMinutes: number | null;
}

type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Checks the paper form. `hasFile` says whether a PDF is attached (or about
 * to be): a read-mode paper needs either that or typed text.
 */
export function validatePaper(input: PaperInput, { hasFile }: { hasFile: boolean }): Checked<PaperInput> {
  const title = input.title.trim().replace(/\s+/g, " ");
  const instructions = input.instructions.trim();
  const body = input.mode === "read" ? input.body.trim() : "";
  if (!input.classId) return { ok: false, message: "Pick the class." };
  if (!input.subjectId) return { ok: false, message: "Pick the subject." };
  if (!title) return { ok: false, message: "Give the paper a title, e.g. Mid-term Mathematics Paper 1." };
  if (title.length > TITLE_MAX) return { ok: false, message: `Keep the title to ${TITLE_MAX} characters or fewer.` };
  if (instructions.length > INSTRUCTIONS_MAX) return { ok: false, message: `Keep the instructions to ${INSTRUCTIONS_MAX} characters or fewer.` };
  if (body.length > BODY_MAX) return { ok: false, message: "The typed paper is too long. Upload it as a PDF instead." };
  if (input.mode === "read" && !body && !hasFile) return { ok: false, message: "Upload the paper as a PDF or type it in." };
  const opens = Date.parse(input.opensAt);
  if (Number.isNaN(opens)) return { ok: false, message: "Pick when the paper opens." };
  let closesAt: string | null = null;
  if (input.closesAt) {
    const closes = Date.parse(input.closesAt);
    if (Number.isNaN(closes)) return { ok: false, message: "That closing time isn't a real date." };
    if (closes <= opens) return { ok: false, message: "The paper has to close after it opens." };
    closesAt = input.closesAt;
  }
  let durationMinutes: number | null = null;
  if (input.mode === "online" && input.durationMinutes !== null) {
    const d = input.durationMinutes;
    if (!Number.isInteger(d) || d < 1 || d > DURATION_MAX) {
      return { ok: false, message: `The time allowed must be a whole number of minutes, 1 to ${DURATION_MAX}.` };
    }
    durationMinutes = d;
  }
  return { ok: true, value: { ...input, title, instructions, body, closesAt, durationMinutes } };
}

// ---------------------------------------------------------------- questions
export interface QuestionDraft {
  kind: QuestionKind;
  prompt: string;
  /** Choice only. */
  options: string[];
  points: number;
  /** Choice only: index into `options`. */
  correctOption: number | null;
  /** Written only, optional: what a good answer looks like, for whoever marks it. */
  modelAnswer: string;
}

export const blankQuestion = (kind: QuestionKind = "choice"): QuestionDraft => ({
  kind, prompt: "", options: kind === "choice" ? ["", ""] : [], points: 1, correctOption: null, modelAnswer: "",
});

/** Checks every question in the builder. Messages name the question by number. */
export function validateQuestions(questions: QuestionDraft[]): Checked<QuestionDraft[]> {
  const value: QuestionDraft[] = [];
  for (const [i, q] of questions.entries()) {
    const n = `Question ${i + 1}`;
    const prompt = q.prompt.trim();
    if (!prompt) return { ok: false, message: `${n} has no question written.` };
    if (prompt.length > PROMPT_MAX) return { ok: false, message: `${n} is too long. Keep it to ${PROMPT_MAX} characters.` };
    if (!Number.isInteger(q.points) || q.points < 1 || q.points > POINTS_MAX) {
      return { ok: false, message: `${n}: marks must be a whole number from 1 to ${POINTS_MAX}.` };
    }
    if (q.kind === "choice") {
      const options = q.options.map((o) => o.trim());
      if (options.length < OPTIONS_MIN || options.length > OPTIONS_MAX) {
        return { ok: false, message: `${n} needs ${OPTIONS_MIN} to ${OPTIONS_MAX} options.` };
      }
      if (options.some((o) => !o)) return { ok: false, message: `${n} has an empty option. Fill it in or remove it.` };
      if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return { ok: false, message: `${n} has the same option twice.` };
      if (q.correctOption === null || q.correctOption < 0 || q.correctOption >= options.length) {
        return { ok: false, message: `${n}: pick the correct option.` };
      }
      value.push({ ...q, prompt, options, correctOption: q.correctOption, modelAnswer: "" });
    } else {
      value.push({ ...q, prompt, options: [], correctOption: null, modelAnswer: q.modelAnswer.trim() });
    }
  }
  return { ok: true, value };
}

export const totalPoints = (questions: { points: number }[]): number => questions.reduce((sum, q) => sum + q.points, 0);

/** Why a paper can't be published yet, or null if it can. */
export function publishProblem(p: { mode: PaperMode; hasContent: boolean; questionCount: number }): string | null {
  if (p.mode === "online" && p.questionCount === 0) return "Add at least one question before publishing.";
  if (p.mode === "read" && !p.hasContent) return "Upload the paper or type it in before publishing.";
  return null;
}

// ---------------------------------------------------------------- marking
export interface MarkableQuestion {
  id: string;
  kind: QuestionKind;
  points: number;
  /** Null when the question has no key (written, or a choice the teacher marks by hand). */
  correctOption: number | null;
}

/**
 * The marks the system gives itself, the same way exam_auto_mark() does in
 * the database: a choice question with a key is right or wrong; a blank
 * written answer scores 0. Marks a teacher has already given (`given`) for
 * the rest are kept. `final` is null until every question has a mark.
 */
export function autoMark(questions: MarkableQuestion[], answers: Answers, given: Record<string, number> = {}) {
  const marks: Record<string, number> = { ...given };
  let auto = 0;
  let total = 0;
  let complete = true;
  for (const q of questions) {
    if (q.kind === "choice" && q.correctOption !== null) {
      marks[q.id] = answers[q.id] === q.correctOption ? q.points : 0;
      auto += marks[q.id]!;
    } else if (!(q.id in answers)) {
      marks[q.id] = 0;
    }
    const m = marks[q.id];
    if (m === undefined) complete = false;
    else total += m;
  }
  return { marks, auto, final: complete ? total : null };
}

/** Questions a teacher still has to mark by hand on a script. */
export function needsHandMarking(q: MarkableQuestion): boolean {
  return !(q.kind === "choice" && q.correctOption !== null);
}

/** "14 / 20 · 70%". */
export function scoreLabel(score: number | null, total: number): string {
  if (score === null) return "Not marked yet";
  if (total <= 0) return String(score);
  return `${score} / ${total} · ${Math.round((score / total) * 100)}%`;
}

/** A paper score scaled to a term exam's total, the same rounding send_exam_scores_to_gradebook() uses. */
export function scaleToExam(score: number, total: number, outOf: number): number {
  return total > 0 ? Math.round((score * outOf) / total) : 0;
}

// ---------------------------------------------------------------- the clock
/** When an attempt has to be in: the time limit or the closing time, whichever is first. Null = no limit. */
export function attemptDeadline(startedAt: string, durationMinutes: number | null, closesAt: string | null): Date | null {
  const byDuration = durationMinutes !== null ? Date.parse(startedAt) + durationMinutes * 60_000 : null;
  const byClose = closesAt ? Date.parse(closesAt) : null;
  if (byDuration === null && byClose === null) return null;
  if (byDuration === null) return new Date(byClose!);
  if (byClose === null) return new Date(byDuration);
  return new Date(Math.min(byDuration, byClose));
}

/** Milliseconds left, never negative. `skewMs` is server time minus this device's clock. */
export function timeLeftMs(deadline: Date | string, nowMs: number, skewMs = 0): number {
  const d = typeof deadline === "string" ? Date.parse(deadline) : deadline.getTime();
  return Math.max(0, d - (nowMs + skewMs));
}

/** "1:05:09", "12:04", "0:09". */
export function formatTimeLeft(ms: number): string {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export type PaperWindow = "upcoming" | "open" | "closed";

export function paperWindow(p: { opensAt: string; closesAt: string | null }, nowMs: number): PaperWindow {
  if (nowMs < Date.parse(p.opensAt)) return "upcoming";
  if (p.closesAt && nowMs >= Date.parse(p.closesAt)) return "closed";
  return "open";
}

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** "Opens Mon 3 Nov, 08:00 · closes Mon 3 Nov, 10:00". */
export function windowLabel(p: { opensAt: string; closesAt: string | null }, nowMs: number): string {
  const opens = nowMs < Date.parse(p.opensAt) ? `Opens ${fmtWhen(p.opensAt)}` : `Opened ${fmtWhen(p.opensAt)}`;
  if (!p.closesAt) return opens;
  return `${opens} · ${nowMs < Date.parse(p.closesAt) ? "closes" : "closed"} ${fmtWhen(p.closesAt)}`;
}

/** `<input type="datetime-local">` value for an ISO time, in this device's timezone. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** The ISO time for a `datetime-local` value (read in this device's timezone), or null if empty. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Where a paper's file lives in private-documents; families can read this prefix once the paper opens. */
export function examPaperFilePath(tenantId: string, paperId: string, fileName: string): string {
  return `${tenantId}/exam-papers/${paperId}/${Date.now()}-${fileName.replace(/[^\w.\- ]+/g, "_")}`;
}

// ---------------------------------------------------------------- data: staff
export interface ExamPaperRow {
  id: string;
  kind: PaperKind;
  title: string;
  instructions: string;
  classId: string;
  className: string;
  subjectId: string;
  subjectName: string;
  examId: string | null;
  examName: string | null;
  mode: PaperMode;
  filePath: string | null;
  fileName: string | null;
  opensAt: string;
  closesAt: string | null;
  durationMinutes: number | null;
  publishedAt: string | null;
  resultsReleasedAt: string | null;
  /** Staff only (families can't count questions before they start). */
  questionCount: number;
  /** Staff only: learners who have started or submitted. */
  attemptCount: number;
}

interface PaperDbRow {
  id: string; kind: PaperKind; title: string; instructions: string;
  class_id: string; subject_id: string; exam_id: string | null; mode: PaperMode;
  file_path: string | null; file_name: string | null;
  opens_at: string; closes_at: string | null; duration_minutes: number | null;
  published_at: string | null; results_released_at: string | null;
  classes: { name: string } | null; subjects: { name: string } | null; exams: { name: string } | null;
  exam_questions?: { count: number }[]; exam_attempts?: { count: number }[];
}

const PAPER_COLS = "id, kind, title, instructions, class_id, subject_id, exam_id, mode, file_path, file_name, opens_at, closes_at, duration_minutes, published_at, results_released_at, classes(name), subjects(name), exams(name)";

function toPaper(p: PaperDbRow): ExamPaperRow {
  return {
    id: p.id, kind: p.kind, title: p.title, instructions: p.instructions,
    classId: p.class_id, className: p.classes?.name ?? "—",
    subjectId: p.subject_id, subjectName: p.subjects?.name ?? "—",
    examId: p.exam_id, examName: p.exams?.name ?? null,
    mode: p.mode, filePath: p.file_path, fileName: p.file_name,
    opensAt: p.opens_at, closesAt: p.closes_at, durationMinutes: p.duration_minutes,
    publishedAt: p.published_at, resultsReleasedAt: p.results_released_at,
    questionCount: p.exam_questions?.[0]?.count ?? 0,
    attemptCount: p.exam_attempts?.[0]?.count ?? 0,
  };
}

/**
 * Every paper in the school, newest opening first. Staff can read them all;
 * a teacher's screen narrows this to the classes and subjects they teach
 * (fetchMyTeachingPairs).
 */
export async function fetchExamPapers(tenantId: string): Promise<ExamPaperRow[]> {
  const { data, error } = await supabase()
    .from("exam_papers")
    .select(`${PAPER_COLS}, exam_questions(count), exam_attempts(count)`)
    .eq("tenant_id", tenantId)
    .order("opens_at", { ascending: false })
    .returns<PaperDbRow[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map(toPaper);
}

/** "classId:subjectId" for every class and subject this teacher is assigned. */
export async function fetchMyTeachingPairs(teacherId: string): Promise<Set<string>> {
  const { data, error } = await supabase().from("teaching_assignments").select("class_id, subject_id").eq("teacher_id", teacherId);
  if (error) throw new Error(error.message);
  return new Set(((data ?? []) as { class_id: string; subject_id: string }[]).map((r) => `${r.class_id}:${r.subject_id}`));
}

/** This term's exams in the school, for "Counts towards". */
export async function fetchCurrentTermExams(tenantId: string): Promise<{ id: string; name: string; outOf: number }[]> {
  const { data: term, error: e1 } = await supabase().from("terms").select("id").eq("tenant_id", tenantId).eq("is_current", true).maybeSingle<{ id: string }>();
  if (e1) throw new Error(e1.message);
  if (!term) return [];
  const { data, error } = await supabase().from("exams").select("id, name, out_of").eq("term_id", term.id).order("name");
  if (error) throw new Error(error.message);
  return ((data ?? []) as { id: string; name: string; out_of: number }[]).map((e) => ({ id: e.id, name: e.name, outOf: e.out_of }));
}

export interface StaffQuestion extends QuestionDraft {
  id: string;
}

/** Everything the editor needs: the typed text, and the questions with their keys. */
export async function fetchPaperContent(paperId: string): Promise<{ body: string; questions: StaffQuestion[] }> {
  const [{ data: text, error: e1 }, { data: qs, error: e2 }] = await Promise.all([
    supabase().from("exam_paper_texts").select("body").eq("paper_id", paperId).maybeSingle<{ body: string }>(),
    supabase()
      .from("exam_questions")
      .select("id, position, kind, prompt, options, points, exam_question_keys(correct_option, model_answer)")
      .eq("paper_id", paperId)
      .order("position")
      .returns<{
        id: string; position: number; kind: QuestionKind; prompt: string; options: string[] | null; points: number;
        exam_question_keys: { correct_option: number | null; model_answer: string | null } | { correct_option: number | null; model_answer: string | null }[] | null;
      }[]>(),
  ]);
  if (e1) throw new Error(e1.message);
  if (e2) throw new Error(e2.message);
  return {
    body: text?.body ?? "",
    questions: (qs ?? []).map((q) => {
      const key = Array.isArray(q.exam_question_keys) ? q.exam_question_keys[0] : q.exam_question_keys;
      return {
        id: q.id, kind: q.kind, prompt: q.prompt, options: q.options ?? [], points: q.points,
        correctOption: key?.correct_option ?? null, modelAnswer: key?.model_answer ?? "",
      };
    }),
  };
}

function paperColumns(input: PaperInput) {
  return {
    kind: input.kind, title: input.title, instructions: input.instructions,
    class_id: input.classId, subject_id: input.subjectId, exam_id: input.examId, mode: input.mode,
    opens_at: input.opensAt, closes_at: input.closesAt,
    duration_minutes: input.mode === "online" ? input.durationMinutes : null,
  };
}

/** A change row-level security filters out is "0 rows", not an error; say so rather than report success. */
const NOT_YOURS = "You can only change papers for a class and subject you teach.";

export async function createExamPaper(tenantId: string, input: PaperInput): Promise<string> {
  const { data, error } = await supabase().from("exam_papers").insert({ tenant_id: tenantId, ...paperColumns(input) }).select("id").single<{ id: string }>();
  if (error) throw new Error(error.message);
  return data.id;
}

export async function updateExamPaper(id: string, input: PaperInput): Promise<void> {
  const { data, error } = await supabase().from("exam_papers").update(paperColumns(input)).eq("id", id).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(NOT_YOURS);
}

/** The typed read-mode paper; an empty body removes it. */
export async function savePaperBody(paperId: string, body: string): Promise<void> {
  const { error } = body
    ? await supabase().from("exam_paper_texts").upsert({ paper_id: paperId, body })
    : await supabase().from("exam_paper_texts").delete().eq("paper_id", paperId);
  if (error) throw new Error(error.message);
}

export async function setPaperFile(paperId: string, file: { path: string; name: string } | null): Promise<void> {
  const { error } = await supabase().from("exam_papers").update({ file_path: file?.path ?? null, file_name: file?.name ?? null }).eq("id", paperId);
  if (error) throw new Error(error.message);
}

/** Replaces all of an online paper's questions and keys at once. Refused once anyone has started. */
export async function saveExamQuestions(paperId: string, questions: QuestionDraft[]): Promise<void> {
  const { error } = await supabase().rpc("replace_exam_questions", {
    p_paper_id: paperId,
    p_questions: questions.map((q) => ({
      kind: q.kind, prompt: q.prompt, options: q.kind === "choice" ? q.options : null, points: q.points,
      correct_option: q.kind === "choice" ? q.correctOption : null, model_answer: q.modelAnswer || null,
    })),
  });
  if (error) throw new Error(error.message);
}

export async function setPaperPublished(paperId: string, published: boolean): Promise<void> {
  const { data, error } = await supabase().from("exam_papers").update({ published_at: published ? new Date().toISOString() : null }).eq("id", paperId).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(NOT_YOURS);
}

export async function deleteExamPaper(paperId: string): Promise<void> {
  const { data, error } = await supabase().from("exam_papers").delete().eq("id", paperId).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(NOT_YOURS);
}

export interface AttemptRow {
  id: string;
  studentId: string;
  /** 1 for the first sitting; a resit is 2, 3, ... (20261030100000_exam_extensions). */
  attemptNo: number;
  startedAt: string;
  submittedAt: string | null;
  answers: Answers;
  questionMarks: Record<string, number>;
  questionNotes: Record<string, string>;
  autoScore: number | null;
  finalScore: number | null;
  feedback: string | null;
}

interface AttemptDbRow {
  id: string; student_id: string; attempt_no: number; started_at: string; submitted_at: string | null; answers: Answers;
  question_marks: Record<string, number>; question_notes: Record<string, string>;
  auto_score: number | null; final_score: number | null; feedback: string | null;
}

const ATTEMPT_COLS = "id, student_id, attempt_no, started_at, submitted_at, answers, question_marks, question_notes, auto_score, final_score, feedback";

const toAttempt = (a: AttemptDbRow): AttemptRow => ({
  id: a.id, studentId: a.student_id, attemptNo: a.attempt_no ?? 1, startedAt: a.started_at, submittedAt: a.submitted_at, answers: a.answers ?? {},
  questionMarks: a.question_marks ?? {}, questionNotes: a.question_notes ?? {},
  autoScore: a.auto_score, finalScore: a.final_score, feedback: a.feedback,
});

/**
 * The class list against who has sat the paper. Attempts whose time ran out
 * without Submit are submitted first, so the list is complete.
 */
export async function fetchPaperScripts(paper: Pick<ExamPaperRow, "id" | "classId" | "mode">): Promise<{
  learners: { id: string; name: string; adm: string }[];
  attempts: AttemptRow[];
}> {
  if (paper.mode === "online") {
    const { error } = await supabase().rpc("close_overdue_exam_attempts", { p_paper_id: paper.id });
    if (error) throw new Error(error.message);
  }
  const [{ data: kids, error: e1 }, { data: rows, error: e2 }] = await Promise.all([
    supabase().from("students").select("id, full_name, admission_no").eq("class_id", paper.classId).eq("active", true).order("full_name"),
    supabase().from("exam_attempts").select(ATTEMPT_COLS).eq("paper_id", paper.id).returns<AttemptDbRow[]>(),
  ]);
  if (e1) throw new Error(e1.message);
  if (e2) throw new Error(e2.message);
  return {
    learners: ((kids ?? []) as { id: string; full_name: string; admission_no: string }[]).map((k) => ({ id: k.id, name: k.full_name, adm: k.admission_no })),
    attempts: (rows ?? []).map(toAttempt),
  };
}

export async function markExamAttempt(attemptId: string, marks: Record<string, number | null>, notes: Record<string, string>, feedback: string): Promise<void> {
  const { error } = await supabase().rpc("mark_exam_attempt", { p_attempt_id: attemptId, p_marks: marks, p_notes: notes, p_feedback: feedback });
  if (error) throw new Error(error.message);
}

export async function releaseExamResults(paperId: string, release: boolean): Promise<void> {
  const { error } = await supabase().rpc("release_exam_results", { p_paper_id: paperId, p_release: release });
  if (error) throw new Error(error.message);
}

/** Writes the marked scores into the linked term exam's marks; returns how many learners. */
export async function sendExamScoresToGradebook(paperId: string): Promise<number> {
  const { data, error } = await supabase().rpc("send_exam_scores_to_gradebook", { p_paper_id: paperId });
  if (error) throw new Error(error.message);
  return (data as number | null) ?? 0;
}

// ---------------------------------------------------------------- data: learners and families
/** Published papers for a class, as a learner or parent sees them. Question counts aren't visible to them. */
export async function fetchClassPapers(classId: string): Promise<ExamPaperRow[]> {
  const { data, error } = await supabase()
    .from("exam_papers")
    .select(PAPER_COLS)
    .eq("class_id", classId)
    .not("published_at", "is", null)
    .order("opens_at", { ascending: false })
    .returns<PaperDbRow[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map(toPaper);
}

export interface MyAttemptStatus {
  paperId: string;
  startedAt: string;
  submittedAt: string | null;
  deadline: string | null;
}

/** The signed-in learner's own attempts: started / submitted only, never the marks. */
export async function fetchMyAttemptStatuses(): Promise<Map<string, MyAttemptStatus>> {
  const { data, error } = await supabase().rpc("my_exam_attempts");
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { paper_id: string; started_at: string; submitted_at: string | null; deadline: string | null }[];
  return new Map(rows.map((r) => [r.paper_id, { paperId: r.paper_id, startedAt: r.started_at, submittedAt: r.submitted_at, deadline: r.deadline }]));
}

/**
 * Released results for one learner (row-level security hides anything not yet
 * released), by paper id: the sitting that counts (is_counting, a computed
 * column) where a resit means there is more than one.
 */
export async function fetchReleasedAttempts(studentId: string): Promise<Map<string, AttemptRow>> {
  const { data, error } = await supabase().from("exam_attempts").select(`paper_id, ${ATTEMPT_COLS}, is_counting`).eq("student_id", studentId)
    .order("attempt_no")
    .returns<(AttemptDbRow & { paper_id: string; is_counting: boolean })[]>();
  if (error) throw new Error(error.message);
  const out = new Map<string, AttemptRow>();
  for (const a of data ?? []) if (a.is_counting) out.set(a.paper_id, toAttempt(a));
  return out;
}

/** A read-mode paper's typed text, once it has opened. */
export async function fetchPaperText(paperId: string): Promise<string> {
  const { data, error } = await supabase().from("exam_paper_texts").select("body").eq("paper_id", paperId).maybeSingle<{ body: string }>();
  if (error) throw new Error(error.message);
  return data?.body ?? "";
}

/** Each paper's total marks, for papers whose questions the caller can read (a family: once results are out). */
export async function fetchPaperTotals(paperIds: string[]): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  if (!paperIds.length) return totals;
  const { data, error } = await supabase().from("exam_questions").select("paper_id, points").in("paper_id", paperIds);
  if (error) throw new Error(error.message);
  for (const q of (data ?? []) as { paper_id: string; points: number }[]) totals.set(q.paper_id, (totals.get(q.paper_id) ?? 0) + q.points);
  return totals;
}

export interface SittingQuestion {
  id: string;
  kind: QuestionKind;
  prompt: string;
  options: string[];
  points: number;
}

/** The questions, without keys: readable by a learner only once they've started. */
export async function fetchSittingQuestions(paperId: string): Promise<SittingQuestion[]> {
  const { data, error } = await supabase().from("exam_questions").select("id, kind, prompt, options, points").eq("paper_id", paperId).order("position");
  if (error) throw new Error(error.message);
  return ((data ?? []) as { id: string; kind: QuestionKind; prompt: string; options: string[] | null; points: number }[])
    .map((q) => ({ ...q, options: q.options ?? [] }));
}

export interface AttemptSession {
  id: string;
  paperId: string;
  attemptNo: number;
  startedAt: string;
  submittedAt: string | null;
  deadline: string | null;
  answers: Answers;
  /** Server time minus this device's clock, so the countdown matches the server's. */
  skewMs: number;
  /** Time was up before this save arrived: the last saved answers were submitted. */
  timedOut: boolean;
}

function toSession(raw: unknown): AttemptSession {
  const r = raw as { id: string; paper_id: string; attempt_no?: number; started_at: string; submitted_at: string | null; deadline: string | null; answers: Answers; server_now: string; timed_out?: boolean };
  return {
    id: r.id, paperId: r.paper_id, attemptNo: r.attempt_no ?? 1, startedAt: r.started_at, submittedAt: r.submitted_at, deadline: r.deadline,
    answers: r.answers ?? {}, skewMs: Date.parse(r.server_now) - Date.now(), timedOut: !!r.timed_out,
  };
}

/** Starts the clock, or picks up an attempt already under way. */
export async function startExamAttempt(paperId: string): Promise<AttemptSession> {
  const { data, error } = await supabase().rpc("start_exam_attempt", { p_paper_id: paperId });
  if (error) throw new Error(error.message);
  return toSession(data);
}

/** Autosave (submit = false) or hand in (submit = true). */
export async function saveExamAttempt(paperId: string, answers: Answers, submit: boolean): Promise<AttemptSession> {
  const { data, error } = await supabase().rpc("save_exam_attempt", { p_paper_id: paperId, p_answers: answers, p_submit: submit });
  if (error) throw new Error(error.message);
  return toSession(data);
}
