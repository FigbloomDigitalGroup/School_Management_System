import { supabase } from "./supabase";

export type HandIn = "paper" | "in_person" | "upload";

export const HAND_IN_OPTIONS: { value: HandIn; label: string; hint: string }[] = [
  { value: "paper", label: "Exercise book", hint: "Learners write it in their exercise book and hand it in." },
  { value: "in_person", label: "Show the teacher", hint: "Learners show or present it in class." },
  { value: "upload", label: "Upload a file or photo", hint: "Learners attach a photo or document in the app." },
];

export interface HomeworkInput {
  classId: string;
  subjectId: string;
  title: string;
  /** Instructions. May be empty: a title like "Exercise 4.2, page 61" is often all it takes. */
  body: string;
  /** YYYY-MM-DD. */
  dueOn: string;
  handIn: HandIn;
}

const TITLE_MAX = 120;
const BODY_MAX = 2000;

/**
 * Checks what a teacher typed for homework. `today` (YYYY-MM-DD) is passed in
 * so a due date can't be in the past when setting new work; editing existing
 * work may keep its date, so callers pass `allowPast` for that.
 */
export function validateHomework(
  input: HomeworkInput,
  today: string,
  { allowPast = false }: { allowPast?: boolean } = {},
): { ok: true; value: HomeworkInput } | { ok: false; message: string } {
  const title = input.title.trim().replace(/\s+/g, " ");
  const body = input.body.trim();
  if (!input.classId) return { ok: false, message: "Pick the class." };
  if (!input.subjectId) return { ok: false, message: "Pick the subject." };
  if (!title) return { ok: false, message: "Give the homework a title, e.g. Exercise 4.2, page 61." };
  if (title.length > TITLE_MAX) return { ok: false, message: `Keep the title to ${TITLE_MAX} characters or fewer.` };
  if (body.length > BODY_MAX) return { ok: false, message: `Keep the instructions to ${BODY_MAX} characters or fewer.` };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueOn) || Number.isNaN(Date.parse(input.dueOn))) {
    return { ok: false, message: "Pick a due date." };
  }
  if (!allowPast && input.dueOn < today) return { ok: false, message: "The due date can't be in the past." };
  if (!HAND_IN_OPTIONS.some((o) => o.value === input.handIn)) return { ok: false, message: "Pick how learners hand it in." };
  return { ok: true, value: { ...input, title, body } };
}

export interface HomeworkRow extends HomeworkInput {
  id: string;
  className: string;
  subjectName: string;
  /** Learners who have marked it handed in. */
  handedIn: number;
}

interface HomeworkDbRow {
  id: string;
  class_id: string;
  subject_id: string;
  title: string;
  body: string;
  due_on: string;
  hand_in: HandIn;
  classes: { name: string } | null;
  subjects: { name: string } | null;
  assignment_submissions: { count: number }[];
}

/** Homework this teacher has set, soonest due first. */
export async function fetchMyHomework(teacherId: string): Promise<HomeworkRow[]> {
  const { data, error } = await supabase()
    .from("assignments")
    .select("id, class_id, subject_id, title, body, due_on, hand_in, classes(name), subjects(name), assignment_submissions(count)")
    .eq("set_by", teacherId)
    .order("due_on", { ascending: false })
    .returns<HomeworkDbRow[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map((a) => ({
    id: a.id,
    classId: a.class_id,
    subjectId: a.subject_id,
    title: a.title,
    body: a.body,
    dueOn: a.due_on,
    handIn: a.hand_in,
    className: a.classes?.name ?? "—",
    subjectName: a.subjects?.name ?? "—",
    handedIn: a.assignment_submissions[0]?.count ?? 0,
  }));
}

/** Active learners per class, for "12 of 43 handed in". */
export async function fetchClassSizes(classIds: string[]): Promise<Record<string, number>> {
  if (!classIds.length) return {};
  const { data, error } = await supabase()
    .from("classes").select("id, students(count)").in("id", classIds)
    .returns<{ id: string; students: { count: number }[] }[]>();
  if (error) throw new Error(error.message);
  return Object.fromEntries((data ?? []).map((c) => [c.id, c.students[0]?.count ?? 0]));
}

export async function createHomework(tenantId: string, teacherId: string, input: HomeworkInput): Promise<void> {
  const { error } = await supabase().from("assignments").insert({
    tenant_id: tenantId, set_by: teacherId,
    class_id: input.classId, subject_id: input.subjectId,
    title: input.title, body: input.body, due_on: input.dueOn, hand_in: input.handIn,
  });
  if (error) throw new Error(error.message);
}

/** A change row-level security filters out is "0 rows", not an error; say so rather than report success. */
const NOT_YOURS = "You can only change homework you set.";

export async function updateHomework(id: string, input: HomeworkInput): Promise<void> {
  const { data, error } = await supabase().from("assignments").update({
    class_id: input.classId, subject_id: input.subjectId,
    title: input.title, body: input.body, due_on: input.dueOn, hand_in: input.handIn,
  }).eq("id", id).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(NOT_YOURS);
}

export async function deleteHomework(id: string): Promise<void> {
  const { data, error } = await supabase().from("assignments").delete().eq("id", id).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(NOT_YOURS);
}
