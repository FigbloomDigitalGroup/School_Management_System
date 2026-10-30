import { supabase } from "./supabase";
import { attemptDeadline, SUBMIT_GRACE_MS, type ExamPaperRow, type PaperMode } from "./examPapers";
import type { Audience } from "./types";

/**
 * Per-learner extensions, resits, and "missed" / "excused" on online papers
 * (supabase/migrations/20261030100000_exam_extensions.sql).
 *
 * A teacher can give a learner extra minutes, a window of their own, or a
 * resit (one more sitting once the last is handed in). Extra minutes go on
 * the time limit and on the closing time, so a learner always gets them.
 * With more than one sitting, the teacher picks which counts: the latest
 * handed in, or the best. The original sitting stays on the record.
 *
 * The pure functions here mirror the database (exam_learner_terms,
 * exam_learner_deadline, exam_counting_attempt, exam_learner_state): change
 * one, change the other. Missed and excused are never a score, so nothing
 * here or downstream turns them into a 0.
 */

export type CountingRule = "latest" | "best";
export const COUNTING_LABEL: Record<CountingRule, string> = { latest: "The latest sitting counts", best: "The best sitting counts" };

export type LearnerPaperStatus = "not_started" | "in_progress" | "submitted" | "marked" | "missed" | "excused";
export const LEARNER_STATUS_LABEL: Record<LearnerPaperStatus, string> = {
  not_started: "Not started", in_progress: "Sitting now", submitted: "To mark", marked: "Marked", missed: "Missed", excused: "Excused",
};

/** Why a mark has no score (marks.absence). */
export type MarkAbsence = "missed" | "excused";
export const ABSENCE_LABEL: Record<MarkAbsence, string> = { missed: "Missed", excused: "Excused" };

const REASON_MAX = 500;
const EXTRA_MAX = 600;

export interface ExamOverride {
  studentId: string;
  /** This learner's own window; null = the paper's. ISO timestamps. */
  opensAt: string | null;
  closesAt: string | null;
  extraMinutes: number;
  /** 1 = the usual single sitting; each resit adds one. */
  attemptsAllowed: number;
  counting: CountingRule;
  /** Staff only. */
  reason: string;
  updatedAt: string;
}

export interface ExamExcusal {
  studentId: string;
  reason: string;
  createdAt: string;
}

// ---------------------------------------------------------------- a learner's terms
export interface LearnerTerms {
  opensAt: string;
  closesAt: string | null;
  durationMinutes: number | null;
  extraMinutes: number;
  attemptsAllowed: number;
  counting: CountingRule;
}

/** The paper's window and time, with this learner's override (if any) on top. */
export function learnerTerms(
  paper: Pick<ExamPaperRow, "opensAt" | "closesAt" | "durationMinutes">,
  o?: Pick<ExamOverride, "opensAt" | "closesAt" | "extraMinutes" | "attemptsAllowed" | "counting"> | null,
): LearnerTerms {
  return {
    opensAt: o?.opensAt ?? paper.opensAt,
    closesAt: o?.closesAt ?? paper.closesAt,
    durationMinutes: paper.durationMinutes,
    extraMinutes: o?.extraMinutes ?? 0,
    attemptsAllowed: o?.attemptsAllowed ?? 1,
    counting: o?.counting ?? "latest",
  };
}

/** The time this learner is allowed, extra minutes included. Null = no limit. */
export const allowedMinutes = (t: LearnerTerms): number | null => (t.durationMinutes === null ? null : t.durationMinutes + t.extraMinutes);

/**
 * When a sitting started at `startedAt` has to be in: the time limit or the
 * closing time, whichever is first, each with the learner's extra minutes.
 */
export function learnerDeadline(startedAt: string, t: LearnerTerms): Date | null {
  const closes = t.closesAt ? new Date(Date.parse(t.closesAt) + t.extraMinutes * 60_000).toISOString() : null;
  return attemptDeadline(startedAt, allowedMinutes(t), closes);
}

// ---------------------------------------------------------------- sittings
export interface Sitting {
  attemptNo: number;
  submittedAt: string | null;
  finalScore: number | null;
}

/**
 * The sitting that goes on the record. Only handed-in sittings count, so the
 * original stands until a resit is in. "latest": the most recent; "best": the
 * highest final score (unmarked counts lowest), the later one on a tie.
 */
export function countingAttempt<T extends Sitting>(attempts: T[], rule: CountingRule): T | undefined {
  let pick: T | undefined;
  for (const a of attempts) {
    if (!a.submittedAt) continue;
    if (!pick) { pick = a; continue; }
    if (rule === "best") {
      const s = a.finalScore ?? -1;
      const best = pick.finalScore ?? -1;
      if (s > best || (s === best && a.attemptNo > pick.attemptNo)) pick = a;
    } else if (a.attemptNo > pick.attemptNo) {
      pick = a;
    }
  }
  return pick;
}

/**
 * Where a learner stands on a paper right now, the same way
 * exam_learner_state() decides it. Null for a read-mode paper: nothing is
 * sat online, so nothing can be missed.
 */
export function learnerPaperStatus(input: {
  mode: PaperMode;
  terms: LearnerTerms;
  attempts: Sitting[];
  excused: boolean;
  nowMs: number;
}): LearnerPaperStatus | null {
  if (input.mode !== "online") return null;
  if (input.excused) return "excused";
  if (input.attempts.some((a) => !a.submittedAt)) return "in_progress";
  const counted = countingAttempt(input.attempts, input.terms.counting);
  if (counted) return counted.finalScore === null ? "submitted" : "marked";
  if (input.terms.closesAt && input.nowMs >= Date.parse(input.terms.closesAt)) return "missed";
  return "not_started";
}

/** Whether a sitting can be started now: a first one, or a resit granted after the last was handed in. */
export function canStartSitting(input: { terms: LearnerTerms; attemptsUsed: number; lastSubmitted: boolean; excused: boolean; nowMs: number }): boolean {
  const { terms, nowMs } = input;
  if (input.excused) return false;
  if (input.attemptsUsed > 0 && !input.lastSubmitted) return false;
  if (input.attemptsUsed >= terms.attemptsAllowed) return false;
  if (nowMs < Date.parse(terms.opensAt)) return false;
  return !terms.closesAt || nowMs < Date.parse(terms.closesAt);
}

/** True while a sitting with this deadline can still take answers (two minutes' grace for a slow connection). */
export const stillOnTheClock = (deadline: Date | string | null, nowMs: number): boolean =>
  deadline === null || nowMs <= (typeof deadline === "string" ? Date.parse(deadline) : deadline.getTime()) + SUBMIT_GRACE_MS;

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** What a learner has been given, for staff: "+15 min · own window Tue 4 Nov, 08:00 to 10:00 · resit (2 sittings, best counts)". */
export function overrideSummary(o: Pick<ExamOverride, "opensAt" | "closesAt" | "extraMinutes" | "attemptsAllowed" | "counting">): string {
  const parts: string[] = [];
  if (o.extraMinutes > 0) parts.push(`+${o.extraMinutes} min`);
  if (o.opensAt || o.closesAt) {
    parts.push(`own window${o.opensAt ? ` from ${fmtWhen(o.opensAt)}` : ""}${o.closesAt ? ` to ${fmtWhen(o.closesAt)}` : ""}`);
  }
  if (o.attemptsAllowed > 1) parts.push(`resit (${o.attemptsAllowed} sittings, ${o.counting} counts)`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------- the form
export interface OverrideInput {
  /** ISO timestamps, or null to keep the paper's. */
  opensAt: string | null;
  closesAt: string | null;
  extraMinutes: number;
  resit: boolean;
  counting: CountingRule;
  reason: string;
}

type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Checks the extension form. `paper` supplies whichever end of the window the
 * learner doesn't get their own of. `hasResitAlready`: editing terms that
 * already allow a resit, so nothing new is needed.
 */
export function validateOverride(
  input: OverrideInput,
  paper: Pick<ExamPaperRow, "opensAt" | "closesAt">,
  { hasResitAlready = false }: { hasResitAlready?: boolean } = {},
): Checked<OverrideInput> {
  const reason = input.reason.trim().replace(/\s+/g, " ");
  if (!reason) return { ok: false, message: "Say why in a line, e.g. \"Sick on the day\"." };
  if (reason.length > REASON_MAX) return { ok: false, message: `Keep the reason to ${REASON_MAX} characters or fewer.` };
  const extra = input.extraMinutes;
  if (!Number.isInteger(extra) || extra < 0 || extra > EXTRA_MAX) {
    return { ok: false, message: `Extra time must be a whole number of minutes, 0 to ${EXTRA_MAX}.` };
  }
  for (const t of [input.opensAt, input.closesAt]) {
    if (t !== null && Number.isNaN(Date.parse(t))) return { ok: false, message: "That isn't a real date." };
  }
  const opens = Date.parse(input.opensAt ?? paper.opensAt);
  const closes = input.closesAt ?? paper.closesAt;
  if (closes && Date.parse(closes) <= opens) return { ok: false, message: "The window has to close after it opens." };
  if (!input.resit && extra === 0 && !input.opensAt && !input.closesAt && !hasResitAlready) {
    return { ok: false, message: "Give extra time, a window of their own, or a resit." };
  }
  return { ok: true, value: { ...input, reason } };
}

/** The in-app notice a learner gets when given an extension or a resit. */
export function grantNotice(p: { title: string; subjectName: string }, input: Pick<OverrideInput, "opensAt" | "closesAt" | "extraMinutes" | "resit">): { subject: string; body: string } {
  const lines: string[] = [];
  if (input.resit) lines.push(`You can sit "${p.title}" (${p.subjectName}) again.`);
  else lines.push(`Your teacher has changed your terms for "${p.title}" (${p.subjectName}).`);
  if (input.opensAt || input.closesAt) {
    lines.push(`Your own window: ${input.opensAt ? `opens ${fmtWhen(input.opensAt)}` : "opens as planned"}${input.closesAt ? `, closes ${fmtWhen(input.closesAt)}` : ""}.`);
  }
  if (input.extraMinutes > 0) lines.push(`You have ${input.extraMinutes} extra minutes.`);
  lines.push("Open Exams & tests to see it.");
  return { subject: input.resit ? `Resit: ${p.title}` : `Extra time: ${p.title}`, body: lines.join(" ") };
}

// ---------------------------------------------------------------- data: staff
interface OverrideDbRow {
  student_id: string; opens_at: string | null; closes_at: string | null; extra_minutes: number;
  attempts_allowed: number; counting: CountingRule; reason: string; updated_at: string;
}

/** Every learner's own terms and excusal on one paper (staff who may set it only). */
export async function fetchPaperOverrides(paperId: string): Promise<{ overrides: Map<string, ExamOverride>; excusals: Map<string, ExamExcusal> }> {
  const [{ data: o, error: e1 }, { data: x, error: e2 }] = await Promise.all([
    supabase().from("exam_paper_overrides")
      .select("student_id, opens_at, closes_at, extra_minutes, attempts_allowed, counting, reason, updated_at")
      .eq("paper_id", paperId).returns<OverrideDbRow[]>(),
    supabase().from("exam_paper_excusals").select("student_id, reason, created_at").eq("paper_id", paperId)
      .returns<{ student_id: string; reason: string; created_at: string }[]>(),
  ]);
  if (e1) throw new Error(e1.message);
  if (e2) throw new Error(e2.message);
  return {
    overrides: new Map((o ?? []).map((r) => [r.student_id, {
      studentId: r.student_id, opensAt: r.opens_at, closesAt: r.closes_at, extraMinutes: r.extra_minutes,
      attemptsAllowed: r.attempts_allowed, counting: r.counting, reason: r.reason, updatedAt: r.updated_at,
    }])),
    excusals: new Map((x ?? []).map((r) => [r.student_id, { studentId: r.student_id, reason: r.reason, createdAt: r.created_at }])),
  };
}

/** Gives these learners their own terms. Returns the logins of those who have one, to tell them. */
export async function setExamOverride(paperId: string, studentIds: string[], input: OverrideInput): Promise<string[]> {
  const { data, error } = await supabase().rpc("set_exam_override", {
    p_paper_id: paperId, p_student_ids: studentIds, p_opens_at: input.opensAt, p_closes_at: input.closesAt,
    p_extra_minutes: input.extraMinutes, p_resit: input.resit, p_counting: input.counting, p_reason: input.reason,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as string[];
}

export async function clearExamOverride(paperId: string, studentId: string): Promise<void> {
  const { error } = await supabase().rpc("clear_exam_override", { p_paper_id: paperId, p_student_id: studentId });
  if (error) throw new Error(error.message);
}

export async function setExamExcusal(paperId: string, studentId: string, excused: boolean, reason: string): Promise<void> {
  const { error } = await supabase().rpc("set_exam_excusal", { p_paper_id: paperId, p_student_id: studentId, p_excused: excused, p_reason: reason });
  if (error) throw new Error(error.message);
}

/**
 * Tells learners about an extension or a resit: an in-app notice to exactly
 * them, then a push. A push failure comes back for the caller to show; the
 * notice is already there.
 */
export async function notifyExamGrant(input: {
  tenantId: string; authorId: string; profileIds: string[];
  paper: Pick<ExamPaperRow, "title" | "subjectName">; grant: OverrideInput;
}): Promise<{ pushError: string | null }> {
  if (!input.profileIds.length) return { pushError: null };
  const sb = supabase();
  const notice = grantNotice(input.paper, input.grant);
  const { data: created, error } = await sb.from("announcements").insert({
    tenant_id: input.tenantId,
    author_id: input.authorId,
    subject: notice.subject,
    body: notice.body,
    audience: { kind: "people", profile_ids: input.profileIds } satisfies Audience,
    channels: ["in_app", "push"],
    published_at: new Date().toISOString(),
  }).select("id").single<{ id: string }>();
  if (error) throw new Error(error.message);
  const { error: pushErr } = await sb.functions.invoke("send-push", { body: { announcement_id: created.id } });
  return { pushError: pushErr ? pushErr.message : null };
}

/** Missed / excused marks for one exam and subject, keyed by learner, for the Gradebook. */
export async function fetchMarkAbsences(examId: string, subjectId: string, studentIds: string[]): Promise<Record<string, MarkAbsence>> {
  if (!studentIds.length) return {};
  const { data, error } = await supabase().from("marks").select("student_id, absence")
    .eq("exam_id", examId).eq("subject_id", subjectId).in("student_id", studentIds).not("absence", "is", null);
  if (error) throw new Error(error.message);
  return Object.fromEntries(((data ?? []) as { student_id: string; absence: MarkAbsence }[]).map((r) => [r.student_id, r.absence]));
}

// ---------------------------------------------------------------- data: learners and families
export interface LearnerExamState {
  paperId: string;
  terms: Omit<LearnerTerms, "durationMinutes">;
  attemptsUsed: number;
  /** The latest sitting. */
  startedAt: string | null;
  submittedAt: string | null;
  deadline: string | null;
  status: LearnerPaperStatus;
}

/** One learner's standing on every published online paper for their class (learner_exam_states), by paper id. */
export async function fetchLearnerExamStates(studentId: string): Promise<Map<string, LearnerExamState>> {
  const { data, error } = await supabase().rpc("learner_exam_states", { p_student_id: studentId });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as {
    paper_id: string; opens_at: string; closes_at: string | null; extra_minutes: number; attempts_allowed: number;
    attempts_used: number; counting: CountingRule; started_at: string | null; submitted_at: string | null;
    deadline: string | null; state: LearnerPaperStatus;
  }[];
  return new Map(rows.map((r) => [r.paper_id, {
    paperId: r.paper_id,
    terms: { opensAt: r.opens_at, closesAt: r.closes_at, extraMinutes: r.extra_minutes, attemptsAllowed: r.attempts_allowed, counting: r.counting },
    attemptsUsed: r.attempts_used, startedAt: r.started_at, submittedAt: r.submitted_at, deadline: r.deadline, status: r.state,
  }]));
}

/** Subjects of one exam this learner has no score in because they missed the paper or were excused (published only). */
export async function fetchExamAbsences(studentId: string, examId: string): Promise<{ name: string; absence: MarkAbsence }[]> {
  const { data, error } = await supabase().from("marks").select("absence, subjects(name)")
    .eq("exam_id", examId).eq("student_id", studentId).not("absence", "is", null)
    .returns<{ absence: MarkAbsence; subjects: { name: string } | null }[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({ name: r.subjects?.name ?? "Subject", absence: r.absence })).sort((a, b) => a.name.localeCompare(b.name));
}
