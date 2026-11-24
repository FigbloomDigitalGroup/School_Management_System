import {
  apiCountPaperMarks, apiDeleteExam, apiFetchExamPapers, apiFetchExamSummaries, apiPaperAction, apiRenameExam, apiSetUpExam, apiTopUpExam,
  type ExamSetPaper, type PaperActionResult, type SetUpResult,
} from "./api/gradesApi";
import { onApi } from "./backend";
import { NotOnApiError } from "./capabilities";
import { supabase } from "./supabase";

/** An exam as the admin's Exams screen lists it. */
export interface ExamSummary {
  id: string;
  name: string;
  outOf: number;
  /** Marks entered so far, across every class and subject. */
  marksEntered: number;
  /** How many class-and-subject results are out to families. */
  resultsOut: number;
  /** API only: how many papers (one per class and subject) the exam is made of. */
  papers?: number;
}

export type { ExamSetPaper, PaperActionResult, SetUpResult };

/**
 * Exams are out of 100 on Supabase. The paper total is a column (exams.out_of) and the
 * database checks every mark against it, but the Gradebook and every family
 * result screen read a mark as a percentage, so a paper out of 30 would show
 * as 21/100 and be graded as a fail. Supporting other totals means those
 * screens converting to a percentage first; until then nothing creates one.
 */
export const EXAM_OUT_OF = 100;

const NAME_MAX = 60;

/**
 * Checks the name a person typed for an exam. Names are unique within a term,
 * ignoring case and surrounding spaces; pass the names already in the term,
 * minus the one being renamed.
 */
export function validateExamName(raw: string, otherNames: string[]): { ok: true; name: string } | { ok: false; message: string } {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, message: "Give the exam a name, e.g. Mock 1 or End of Term 3." };
  if (name.length > NAME_MAX) return { ok: false, message: `Keep the name to ${NAME_MAX} characters or fewer.` };
  if (otherNames.some((n) => n.trim().toLowerCase() === name.toLowerCase())) {
    return { ok: false, message: `This term already has an exam called "${name}".` };
  }
  return { ok: true, name };
}

interface ExamRow {
  id: string;
  name: string;
  out_of: number;
  marks: { count: number }[];
  mark_publications: { count: number }[];
}

/** This term's exams, oldest name first, with how far along each is. */
export async function fetchExamSummaries(termId: string): Promise<ExamSummary[]> {
  if (onApi()) return apiFetchExamSummaries(termId);
  const { data, error } = await supabase()
    .from("exams")
    .select("id, name, out_of, marks(count), mark_publications(count)")
    .eq("term_id", termId)
    .order("name")
    .returns<ExamRow[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map((e) => ({
    id: e.id,
    name: e.name,
    outOf: e.out_of,
    marksEntered: e.marks[0]?.count ?? 0,
    resultsOut: e.mark_publications[0]?.count ?? 0,
  }));
}

/** Checks what a person typed for the paper's total (API only: the API's `max_score`). A whole or decimal number above 0, up to 10,000. */
export function validateExamOutOf(raw: string): { ok: true; outOf: number } | { ok: false; message: string } {
  const text = raw.trim();
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(text)) return { ok: false, message: "Type the total as a number, for example 100 or 50." };
  const outOf = Number(text);
  if (!(outOf > 0) || outOf > 10000) return { ok: false, message: "The total must be more than 0 and at most 10,000." };
  return { ok: true, outOf };
}

/**
 * Makes an exam. On the API the exam is one paper for each class and subject that has a teacher, out of `outOf`; the answer says how many
 * were made. On Supabase the exam is one row, always out of 100.
 */
export async function createExam(tenantId: string, termId: string, name: string, outOf: number = EXAM_OUT_OF): Promise<SetUpResult | void> {
  if (onApi()) return apiSetUpExam(termId, name, outOf, tenantId);
  const { error } = await supabase().from("exams").insert({ tenant_id: tenantId, term_id: termId, name, out_of: EXAM_OUT_OF });
  if (error) throw new Error(error.code === "23505" ? `This term already has an exam called "${name}".` : error.message);
}

/** Only a school admin may change an exam; for anyone else row-level security filters it to "0 rows", not an error. */
const ADMIN_ONLY = "Only the school admin can change exams.";

export async function renameExam(examId: string, name: string): Promise<void> {
  if (onApi()) return apiRenameExam();
  const { data, error } = await supabase().from("exams").update({ name }).eq("id", examId).select("id");
  if (error) throw new Error(error.code === "23505" ? `This term already has an exam called "${name}".` : error.message);
  if (!data?.length) throw new Error(ADMIN_ONLY);
}

/** Refused by the database once any mark has been entered for the exam. */
export async function deleteExam(examId: string): Promise<void> {
  if (onApi()) return apiDeleteExam();
  const { data, error } = await supabase().from("exams").delete().eq("id", examId).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(ADMIN_ONLY);
}

// ---------------------------------------------------------------- API only: an exam's papers (one per class and subject)

function apiOnly(what: string): never {
  throw new NotOnApiError(what);
}

/** Makes the papers an exam is missing (a subject given a teacher after the exam was made). */
export async function topUpExam(examId: string, outOf: number): Promise<SetUpResult> {
  return onApi() ? apiTopUpExam(examId, outOf) : apiOnly("Adding papers to an exam");
}

/** The exam's papers with their status. */
export async function fetchExamSetPapers(examId: string): Promise<ExamSetPaper[]> {
  return onApi() ? apiFetchExamPapers(examId) : apiOnly("An exam's papers");
}

/** How many marks each paper has. */
export async function countPaperMarks(paperIds: readonly string[]): Promise<Map<string, number>> {
  return onApi() ? apiCountPaperMarks(paperIds) : apiOnly("A paper's mark count");
}

/** Publishes or closes papers, a few at once; says how many were done. */
export async function actOnPapers(action: "publish" | "close", paperIds: readonly string[]): Promise<PaperActionResult> {
  return onApi() ? apiPaperAction(action, paperIds) : apiOnly("Publishing a paper");
}
