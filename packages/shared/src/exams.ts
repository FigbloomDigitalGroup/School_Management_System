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
}

/**
 * Exams are out of 100. The paper total is a column (exams.out_of) and the
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

export async function createExam(tenantId: string, termId: string, name: string): Promise<void> {
  const { error } = await supabase().from("exams").insert({ tenant_id: tenantId, term_id: termId, name, out_of: EXAM_OUT_OF });
  if (error) throw new Error(error.code === "23505" ? `This term already has an exam called "${name}".` : error.message);
}

/** Only a school admin may change an exam; for anyone else row-level security filters it to "0 rows", not an error. */
const ADMIN_ONLY = "Only the school admin can change exams.";

export async function renameExam(examId: string, name: string): Promise<void> {
  const { data, error } = await supabase().from("exams").update({ name }).eq("id", examId).select("id");
  if (error) throw new Error(error.code === "23505" ? `This term already has an exam called "${name}".` : error.message);
  if (!data?.length) throw new Error(ADMIN_ONLY);
}

/** Refused by the database once any mark has been entered for the exam. */
export async function deleteExam(examId: string): Promise<void> {
  const { data, error } = await supabase().from("exams").delete().eq("id", examId).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(ADMIN_ONLY);
}
