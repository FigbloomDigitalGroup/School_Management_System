import { supabase } from "./supabase";
import { invokeEdge } from "./edge";
import type { QuestionDraft } from "./examPapers";
import type { ParentGuide } from "./homework";
import type { ReportCardData } from "./reportCards";

/**
 * AI drafting for staff and the study helper for learners, through the
 * ai-assist edge function (supabase/functions/ai-assist). Every result here
 * is a draft: the screens put it in front of a person to edit, and nothing
 * is saved or sent until they do.
 */

/** Drafting a class's comments or a question paper can take a while. */
const AI_TIMEOUT_MS = 120_000;

async function ask<T>(task: string, payload: unknown): Promise<T> {
  const { result } = await invokeEdge<{ result: T }>("ai-assist", { task, payload }, { timeoutMs: AI_TIMEOUT_MS });
  return result;
}

// ------------------------------------------------------------------ report card comments

/** What the model is told about one learner: a first name and the results, nothing else. */
export interface AiLearner {
  ref: string;
  firstName: string;
  className: string;
  curriculum: "844" | "cbc";
  mean: number | null;
  grade: string | null;
  subjects: { name: string; average: number | null; grade: string | null }[];
  areas: { name: string; level: string | null; strands: { name: string; level: string }[] }[];
  competencies: { label: string; level: string }[];
  attendancePct: number | null;
  existing?: string;
}

/**
 * A stored report card cut down to what comment drafting needs. Deliberately
 * leaves out the surname, admission number, fees, position and anything about
 * other learners: none of it makes a better comment.
 */
export function learnerForAi(ref: string, d: ReportCardData, existing?: string | null): AiLearner {
  return {
    ref,
    firstName: d.learner.name.trim().split(/\s+/)[0] ?? "",
    className: d.learner.className,
    curriculum: d.scheme === "cbc" ? "cbc" : "844",
    mean: d.summary.mean,
    grade: d.summary.grade,
    subjects: d.subjects.map((s) => ({ name: s.name, average: s.average, grade: s.grade })),
    areas: d.cbe.map((a) => ({ name: a.area, level: a.level, strands: (a.strands ?? []).map((st) => ({ name: st.name, level: st.level })) })),
    competencies: (d.competencies ?? []).map((c) => ({ label: c.label, level: c.level })),
    attendancePct: d.attendance && d.attendance.days > 0 ? Math.round((d.attendance.present / d.attendance.days) * 100) : null,
    ...(existing?.trim() ? { existing: existing.trim() } : {}),
  };
}

export const AI_COMMENT_BATCH = 15;

/** Draft comments for up to AI_COMMENT_BATCH learners; split a class with chunk(). */
export async function draftReportComments(
  who: "teacher" | "principal" | "both", learners: AiLearner[],
): Promise<{ ref: string; teacher: string; principal: string }[]> {
  const { comments } = await ask<{ comments: { ref: string; teacher: string; principal: string }[] }>("report_comment", { who, learners });
  return comments;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ------------------------------------------------------------------ questions

export interface QuestionRequest {
  subject: string;
  topic: string;
  classLabel: string;
  curriculum: "844" | "cbc";
  kind: "exam" | "assessment";
  choice: number;
  short: number;
  long: number;
  difficulty: "easy" | "mixed" | "hard";
  notes?: string;
}

interface AiQuestion { kind: "choice" | "short" | "long"; prompt: string; options: string[]; correct_option: number; model_answer: string; points: number }

/** Turns the model's questions into the builder's drafts, dropping any that wouldn't be valid there. */
export function questionDraftsFromAi(questions: AiQuestion[]): QuestionDraft[] {
  return questions.flatMap((q): QuestionDraft[] => {
    const prompt = q.prompt?.trim();
    if (!prompt) return [];
    const points = Math.min(Math.max(Math.round(q.points || 1), 1), 100);
    if (q.kind === "choice") {
      const options = (q.options ?? []).map((o) => o.trim()).filter(Boolean).slice(0, 6);
      if (options.length < 2) return [];
      const correct = Number.isInteger(q.correct_option) && q.correct_option >= 0 && q.correct_option < options.length ? q.correct_option : null;
      return [{ kind: "choice", prompt, options, points, correctOption: correct, modelAnswer: q.model_answer?.trim() ?? "" }];
    }
    return [{ kind: q.kind === "long" ? "long" : "short", prompt, options: [], points, correctOption: null, modelAnswer: q.model_answer?.trim() ?? "" }];
  });
}

export async function draftQuestions(req: QuestionRequest): Promise<QuestionDraft[]> {
  const { questions } = await ask<{ questions: AiQuestion[] }>("questions", req);
  return questionDraftsFromAi(questions);
}

// ------------------------------------------------------------------ homework

export interface HomeworkDraftRequest {
  subject: string;
  topic: string;
  classLabel: string;
  curriculum: "844" | "cbc";
  youngLearner: boolean;
  notes?: string;
}

export async function draftHomework(req: HomeworkDraftRequest): Promise<{ title: string; body: string; guide: ParentGuide }> {
  const r = await ask<{ title: string; body: string; guide: { about: string; needs: string[]; help: string; avoid: string; minutes: number } }>("homework", req);
  const minutes = Number.isInteger(r.guide?.minutes) && r.guide.minutes >= 1 && r.guide.minutes <= 600 ? r.guide.minutes : null;
  return {
    title: (r.title ?? "").trim().slice(0, 120),
    body: (r.body ?? "").trim(),
    guide: {
      about: r.guide?.about?.trim() ?? "",
      needs: (r.guide?.needs ?? []).map((n) => n.trim()).filter(Boolean).slice(0, 10),
      help: r.guide?.help?.trim() ?? "",
      avoid: r.guide?.avoid?.trim() ?? "",
      minutes,
    },
  };
}

// ------------------------------------------------------------------ messages

export type MessageTone = "warm" | "formal" | "brief";
export type MessageLanguage = "en" | "sw" | "both";

export async function draftMessage(input: {
  notes: string; audience: string; tone: MessageTone; language: MessageLanguage; schoolName?: string;
}): Promise<{ subject: string; body: string }> {
  return ask("message", input);
}

export async function translateMessage(subject: string, body: string, to: "sw" | "en"): Promise<{ subject: string; body: string }> {
  return ask("translate", { subject, body, to });
}

// ------------------------------------------------------------------ study helper

export interface TutorTurn { role: "user" | "assistant"; content: string }

/** The helper's next reply. Throws an EdgeError with status 423 while an exam is open. */
export async function askTutor(messages: TutorTurn[]): Promise<string> {
  const { text } = await ask<{ text: string }>("tutor", { messages });
  return text;
}

// ------------------------------------------------------------------ settings

export interface AiStatus { aiEnabled: boolean; tutorEnabled: boolean; monthlyTokens: number; usedTokens: number }

export async function fetchAiStatus(tenantId: string): Promise<AiStatus | null> {
  const { data, error } = await supabase().rpc("ai_status", { p_tenant_id: tenantId });
  if (error) throw new Error(error.message);
  const row = (data as { ai_enabled: boolean; ai_tutor_enabled: boolean; monthly_tokens: number; used_tokens: number }[] | null)?.[0];
  return row ? { aiEnabled: row.ai_enabled, tutorEnabled: row.ai_tutor_enabled, monthlyTokens: row.monthly_tokens, usedTokens: Number(row.used_tokens) } : null;
}

export async function saveAiSettings(tenantId: string, enabled: boolean, tutorEnabled: boolean): Promise<void> {
  const { error } = await supabase().rpc("set_ai_settings", { p_tenant_id: tenantId, p_enabled: enabled, p_tutor_enabled: tutorEnabled });
  if (error) throw new Error(error.message);
}
