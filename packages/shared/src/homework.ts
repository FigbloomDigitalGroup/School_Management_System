import { supabase } from "./supabase";
import { formatShortDate } from "./parentData";
import { sendClassMessage } from "./teacherData";
import { removeAttachmentFilesFor } from "./materials";
import type { ClassLevel } from "./types";

/**
 * Homework parents can actually help with. A teacher sets a piece of work for
 * one class + subject and, next to the learner's instructions, leaves a short
 * guide written for the parent: what it's about, what the child needs, how to
 * help, what not to do, and how long it should take.
 *
 * One module for the teacher's form, the parent's card and the student's
 * "done" tick — web, the parent/student app and the teacher app all call it,
 * so the wording a parent sees is the wording the teacher previewed.
 *
 * Storage: assignments.parent_guide (jsonb), see
 * supabase/migrations/20261025000000_homework_parent_guide.sql.
 */

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
  /**
   * The "For parents" section. Left out (undefined), a save doesn't touch
   * what's stored; null or an empty guide clears it.
   */
  guide?: ParentGuide | null;
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
  if (input.guide && input.guide.minutes !== null && cleanMinutes(input.guide.minutes) === null) {
    return { ok: false, message: `Give the time in whole minutes, from 1 to ${MAX_MINUTES}.` };
  }
  return { ok: true, value: { ...input, title, body } };
}

export interface HomeworkRow extends HomeworkInput {
  id: string;
  className: string;
  subjectName: string;
  /** Learners who have marked it handed in. */
  handedIn: number;
  guide: ParentGuide | null;
}

interface HomeworkDbRow {
  id: string;
  class_id: string;
  subject_id: string;
  title: string;
  body: string;
  due_on: string;
  hand_in: HandIn;
  parent_guide: unknown;
  classes: { name: string } | null;
  subjects: { name: string } | null;
  assignment_submissions: { count: number }[];
}

/** Homework this teacher has set, soonest due first. */
export async function fetchMyHomework(teacherId: string): Promise<HomeworkRow[]> {
  const { data, error } = await supabase()
    .from("assignments")
    .select("id, class_id, subject_id, title, body, due_on, hand_in, parent_guide, classes(name), subjects(name), assignment_submissions(count)")
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
    guide: normaliseGuide(a.parent_guide),
  }));
}

/** Active learners per class, for "12 of 43 handed in". A learner who has left is archived and not counted. */
export async function fetchClassSizes(classIds: string[]): Promise<Record<string, number>> {
  if (!classIds.length) return {};
  const { data, error } = await supabase()
    .from("classes").select("id, students(count)").in("id", classIds).eq("students.active", true)
    .returns<{ id: string; students: { count: number }[] }[]>();
  if (error) throw new Error(error.message);
  return Object.fromEntries((data ?? []).map((c) => [c.id, c.students[0]?.count ?? 0]));
}

/**
 * "12 of 43". A learner who handed in and was archived afterwards is no longer
 * in the 43, so the count never runs past the class ("44 of 43").
 */
export function handedInLabel(handedIn: number, classSize: number | undefined): string {
  return classSize === undefined ? `${handedIn} of ?` : `${Math.min(handedIn, classSize)} of ${classSize}`;
}

/** The columns a save writes. parent_guide only when the caller sent one, so an older form can't wipe it. */
function homeworkColumns(input: HomeworkInput) {
  return {
    class_id: input.classId, subject_id: input.subjectId,
    title: input.title, body: input.body, due_on: input.dueOn, hand_in: input.handIn,
    ...(input.guide !== undefined ? { parent_guide: input.guide ? cleanGuide(input.guide) : null } : {}),
  };
}

/** Sets new homework. Returns its id. */
export async function createHomework(tenantId: string, teacherId: string, input: HomeworkInput): Promise<string> {
  const { data, error } = await supabase()
    .from("assignments")
    .insert({ tenant_id: tenantId, set_by: teacherId, ...homeworkColumns(input) })
    .select("id")
    .single<{ id: string }>();
  if (error) throw new Error(error.message);
  return data.id;
}

/** A change row-level security filters out is "0 rows", not an error; say so rather than report success. */
const NOT_YOURS = "You can only change homework you set.";

export async function updateHomework(id: string, input: HomeworkInput): Promise<void> {
  const { data, error } = await supabase().from("assignments").update(homeworkColumns(input)).eq("id", id).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(NOT_YOURS);
}

export async function deleteHomework(id: string): Promise<void> {
  // Its attachments' rows go with it; their files in storage don't, so they go first.
  await removeAttachmentFilesFor("homework", id);
  const { data, error } = await supabase().from("assignments").delete().eq("id", id).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(NOT_YOURS);
}

// ------------------------------------------------------------------ parent guide

/** How a parent would say it — the student app has its own shorter labels (HAND_IN_LABEL). */
export const HAND_IN_PARENT_LABEL: Record<HandIn, string> = {
  paper: "Done in the exercise book",
  in_person: "Handed to the teacher in class",
  upload: "Sent through the app",
};

export interface ParentGuide {
  /** What it's about, in plain words. */
  about: string;
  /** Things the child needs: materials, printing, internet, a signature… */
  needs: string[];
  /** How a parent can help. */
  help: string;
  /** What not to do, e.g. don't do it for them. */
  avoid: string;
  /** Expected time in minutes; null when the teacher didn't say. */
  minutes: number | null;
}

/** Quick-add chips on the teacher's form — the needs that come up week after week. */
export const NEED_CHIPS = [
  "Exercise book",
  "Printing",
  "Internet access",
  "Parent signature",
  "Materials from home",
  "Calculator",
] as const;

export const EMPTY_GUIDE: ParentGuide = { about: "", needs: [], help: "", avoid: "", minutes: null };

const MAX_NEEDS = 20;
const MAX_NEED_LENGTH = 80;
const MAX_MINUTES = 600;

// ------------------------------------------------------------------ grade tone

/** PP1–PP2 and Grade 1–3. Mirrors is_young_class() in the migration: these
 *  are the learners a parent sits with, and the ones whose parent may tick
 *  "done" for them (a young child often has no login of their own). */
export function isYoungLearner(level: ClassLevel | null | undefined, year: number): boolean {
  return level === "pre_primary" || (level === "primary" && year <= 3);
}

/** A parent of a young child marks homework done; older learners mark their own. */
export const parentMayMarkDone = isYoungLearner;

export type GuideTone = "sit_with" | "light_touch";

export function guideToneFor(level: ClassLevel | null | undefined, year: number): GuideTone {
  return isYoungLearner(level, year) ? "sit_with" : "light_touch";
}

const TONE_DEFAULTS: Record<GuideTone, Pick<ParentGuide, "help" | "avoid" | "minutes">> = {
  sit_with: {
    help: "Sit with your child while they work. Read the instructions out loud together, then let them try each question before you help.",
    avoid: "Please don't write the answers for them. If they get stuck, write a short note in the book so I know what to go over again.",
    minutes: 15,
  },
  light_touch: {
    help: "Check they have a quiet place and the time to do it. You don't need to know the subject — asking them to explain one answer to you is enough.",
    avoid: "Please don't do it for them. A wrong answer in their own words helps me more than a right one in yours.",
    minutes: 40,
  },
};

/** What the teacher's "For parents" section starts with for a class of this age. */
export function defaultGuide(level: ClassLevel | null | undefined, year: number): ParentGuide {
  return { ...EMPTY_GUIDE, needs: [], ...TONE_DEFAULTS[guideToneFor(level, year)] };
}

/** Placeholder text for the teacher's guided fields — examples, not defaults. */
export const GUIDE_PLACEHOLDERS: Record<GuideTone, Record<"about" | "help" | "avoid", string>> = {
  sit_with: {
    about: "e.g. Counting in twos up to 20, using things you have at home like bottle tops or beans.",
    help: "e.g. Count the beans together first, then let them try on their own.",
    avoid: "e.g. Please don't count for them — let them use their fingers.",
  },
  light_touch: {
    about: "e.g. Practice on speed-time graphs before Friday's test. It builds on Tuesday's lesson.",
    help: "e.g. Ask them to explain what the slope of the graph means.",
    avoid: "e.g. Please don't look up the answers online for them.",
  },
};

/**
 * When the teacher switches class, re-tone the help/avoid/time fields — but
 * only the ones still holding the old class's defaults. Anything the teacher
 * has typed is theirs and is never overwritten.
 */
export function retoneGuide(guide: ParentGuide, from: GuideTone, to: GuideTone): ParentGuide {
  if (from === to) return guide;
  const old = TONE_DEFAULTS[from];
  const next = TONE_DEFAULTS[to];
  return {
    ...guide,
    help: guide.help === old.help || !guide.help.trim() ? next.help : guide.help,
    avoid: guide.avoid === old.avoid || !guide.avoid.trim() ? next.avoid : guide.avoid,
    minutes: guide.minutes === old.minutes || guide.minutes === null ? next.minutes : guide.minutes,
  };
}

// ------------------------------------------------------------------ reading/writing the jsonb

/** Adds a need unless it is already there (case-insensitive). */
export function addNeed(needs: string[], need: string): string[] {
  const n = need.trim().slice(0, MAX_NEED_LENGTH);
  if (!n || needs.some((x) => x.toLowerCase() === n.toLowerCase())) return needs;
  return [...needs, n].slice(0, MAX_NEEDS);
}

export function removeNeed(needs: string[], need: string): string[] {
  return needs.filter((x) => x.toLowerCase() !== need.toLowerCase());
}

function cleanMinutes(m: unknown): number | null {
  const n = typeof m === "string" ? Number(m) : m;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r >= 1 && r <= MAX_MINUTES ? r : null;
}

/** Whether a guide says anything at all. */
export function isGuideEmpty(g: ParentGuide | null | undefined): boolean {
  return !g || (!g.about.trim() && g.needs.length === 0 && !g.help.trim() && !g.avoid.trim() && g.minutes === null);
}

/**
 * Tidies a guide for saving: trimmed, needs de-duplicated and capped, minutes
 * in range. Only the keys that say something are kept, and a guide that says
 * nothing is stored as null — the check constraint accepts exactly this shape.
 */
export function cleanGuide(g: ParentGuide): Partial<ParentGuide> | null {
  const needs = g.needs.reduce<string[]>((acc, n) => addNeed(acc, n), []);
  const out: Partial<ParentGuide> = {};
  if (g.about.trim()) out.about = g.about.trim();
  if (needs.length) out.needs = needs;
  if (g.help.trim()) out.help = g.help.trim();
  if (g.avoid.trim()) out.avoid = g.avoid.trim();
  const minutes = cleanMinutes(g.minutes);
  if (minutes !== null) out.minutes = minutes;
  return Object.keys(out).length ? out : null;
}

/** Reads assignments.parent_guide defensively — null when there is nothing to show. */
export function normaliseGuide(raw: unknown): ParentGuide | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const guide: ParentGuide = {
    about: str(r.about),
    needs: Array.isArray(r.needs) ? r.needs.filter((n): n is string => typeof n === "string").reduce<string[]>((acc, n) => addNeed(acc, n), []) : [],
    help: str(r.help),
    avoid: str(r.avoid),
    minutes: cleanMinutes(r.minutes),
  };
  return isGuideEmpty(guide) ? null : guide;
}

// ------------------------------------------------------------------ plain-words dates and times

/** Whole days from today (local time) to a YYYY-MM-DD date: 0 today, 1 tomorrow, -1 yesterday. */
export function daysFromToday(dateOnly: string, now: Date = new Date()): number {
  const d = new Date(`${dateOnly}T00:00:00`);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

/** "Due today", "Due tomorrow", "Due on Friday", "Due on 14 Oct", "Was due yesterday", "Was due 3 days ago". */
export function dueWords(dueOn: string, now: Date = new Date()): string {
  const diff = daysFromToday(dueOn, now);
  if (diff === 0) return "Due today";
  if (diff === 1) return "Due tomorrow";
  if (diff > 1 && diff < 7) return `Due on ${new Date(`${dueOn}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long" })}`;
  if (diff >= 7) return `Due on ${formatShortDate(dueOn)}`;
  if (diff === -1) return "Was due yesterday";
  if (diff > -7) return `Was due ${-diff} days ago`;
  return `Was due on ${formatShortDate(dueOn)}`;
}

/** "About 15 minutes", "About 1 hour", "About 1 hour 30 minutes"; "" when unknown. */
export function minutesWords(minutes: number | null | undefined): string {
  if (minutes == null || minutes <= 0) return "";
  if (minutes < 60) return `About ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `About ${h} hour${h === 1 ? "" : "s"}${m ? ` ${m} minutes` : ""}`;
}

// ------------------------------------------------------------------ ordering

export interface Dated { dueOn: string; done: boolean }

/** A parent's list for one child: overdue first (oldest first), then what's
 *  coming (soonest first), then what's done (most recent first). */
export function splitHomework<T extends Dated>(items: T[], now: Date = new Date()): { overdue: T[]; upcoming: T[]; done: T[] } {
  const overdue: T[] = [];
  const upcoming: T[] = [];
  const done: T[] = [];
  for (const it of items) {
    if (it.done) done.push(it);
    else if (daysFromToday(it.dueOn, now) < 0) overdue.push(it);
    else upcoming.push(it);
  }
  overdue.sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  upcoming.sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  done.sort((a, b) => b.dueOn.localeCompare(a.dueOn));
  return { overdue, upcoming, done };
}

// ------------------------------------------------------------------ telling parents

/** The in-app note a class's parents get when homework is set. */
export function homeworkNotice(
  hw: Pick<HomeworkInput, "title" | "dueOn" | "guide">,
  subjectName: string,
  className: string,
  now: Date = new Date(),
): { subject: string; body: string } {
  const g = hw.guide ?? EMPTY_GUIDE;
  const lines = [`New ${subjectName} homework for ${className}. ${dueWords(hw.dueOn, now)}.`];
  if (g.about.trim()) lines.push(`What it's about: ${g.about.trim()}`);
  if (g.needs.length) lines.push(`Your child will need: ${g.needs.join(", ")}.`);
  if (g.help.trim()) lines.push(`How you can help: ${g.help.trim()}`);
  if (g.avoid.trim()) lines.push(`Please avoid: ${g.avoid.trim()}`);
  const time = minutesWords(g.minutes);
  if (time) lines.push(`${time}.`);
  lines.push("You can see this any time under Homework.");
  return { subject: `Homework: ${hw.title.trim()}`, body: lines.join("\n\n") };
}

/** Tells a class's parents about new homework: an in-app class message to guardians only. */
export async function notifyHomeworkParents(
  tenantId: string, teacherId: string, hw: HomeworkInput, subjectName: string, className: string,
): Promise<void> {
  const notice = homeworkNotice(hw, subjectName, className);
  await sendClassMessage(tenantId, teacherId, hw.classId, "guardians", notice.subject, notice.body);
}

// ------------------------------------------------------------------ parent

export interface HomeworkItem {
  id: string;
  title: string;
  body: string;
  subject: string;
  teacher: string;
  dueOn: string;
  handIn: HandIn;
  guide: ParentGuide | null;
  done: boolean;
  /** Who ticked it, from the parent's point of view. */
  doneBy: "you" | "child" | "school" | null;
  /** A file was uploaded with it — undoing "done" would lose the record of it, so it can't be undone here. */
  hasFile: boolean;
}

export interface ChildHomework {
  studentId: string;
  /** PP1–Grade 3: the parent may tick "done" for them. */
  parentMarksDone: boolean;
  items: HomeworkItem[];
}

/** How far back a parent's list reaches — older work is between the child and the teacher by now. */
const PARENT_LOOKBACK_DAYS = 21;

/**
 * Homework for each of a parent's children, keyed by student id. Separate
 * from loadParentData() so the Home card and Homework screen can load it on
 * their own without slowing fees/results.
 */
export async function loadParentHomework(profileId: string, studentIds: string[], now: Date = new Date()): Promise<Record<string, ChildHomework>> {
  if (!studentIds.length) return {};
  const { data: kids, error: kErr } = await supabase()
    .from("students")
    .select("id, class_id, profile_id, classes(level, form_level)")
    .in("id", studentIds);
  if (kErr) throw new Error(kErr.message);

  const students = (kids ?? []) as unknown as { id: string; class_id: string | null; profile_id: string | null; classes: { level: ClassLevel; form_level: number } | null }[];
  const classIds = [...new Set(students.map((s) => s.class_id).filter((c): c is string => !!c))];

  const since = new Date(now);
  since.setDate(since.getDate() - PARENT_LOOKBACK_DAYS);
  const pad = (n: number) => String(n).padStart(2, "0");
  const sinceIso = `${since.getFullYear()}-${pad(since.getMonth() + 1)}-${pad(since.getDate())}`;

  const [{ data: rows, error: aErr }, { data: subs, error: sErr }] = await Promise.all([
    classIds.length
      ? supabase()
          .from("assignments")
          .select("id, class_id, set_by, title, body, due_on, hand_in, parent_guide, subjects(name)")
          .in("class_id", classIds)
          .gte("due_on", sinceIso)
          .order("due_on", { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    supabase().from("assignment_submissions").select("assignment_id, student_id, marked_by, file_path").in("student_id", studentIds),
  ]);
  if (aErr) throw new Error(aErr.message);
  if (sErr) throw new Error(sErr.message);

  const assignments = (rows ?? []) as unknown as {
    id: string; class_id: string; set_by: string; title: string; body: string; due_on: string; hand_in: HandIn;
    parent_guide: unknown; subjects: { name: string } | null;
  }[];

  // A parent can't read a teacher's profile row; teacher_names() returns just the name.
  const teacherIds = [...new Set(assignments.map((a) => a.set_by))];
  const { data: names } = teacherIds.length
    ? await supabase().rpc("teacher_names", { teacher_ids: teacherIds })
    : { data: [] };
  const teacherName = new Map(((names ?? []) as { id: string; full_name: string }[]).map((t) => [t.id, t.full_name]));

  const subByKey = new Map(((subs ?? []) as { assignment_id: string; student_id: string; marked_by: string | null; file_path: string | null }[])
    .map((s) => [`${s.assignment_id}:${s.student_id}`, s]));

  const out: Record<string, ChildHomework> = {};
  for (const s of students) {
    out[s.id] = {
      studentId: s.id,
      parentMarksDone: parentMayMarkDone(s.classes?.level, s.classes?.form_level ?? 0),
      items: assignments.filter((a) => a.class_id === s.class_id).map((a) => {
        const sub = subByKey.get(`${a.id}:${s.id}`);
        return {
          id: a.id,
          title: a.title,
          body: a.body,
          subject: a.subjects?.name ?? "Subject",
          teacher: teacherName.get(a.set_by) ?? "The class teacher",
          dueOn: a.due_on,
          handIn: a.hand_in,
          guide: normaliseGuide(a.parent_guide),
          done: !!sub,
          doneBy: !sub ? null : sub.marked_by === profileId ? "you" : sub.marked_by && sub.marked_by === s.profile_id ? "child" : "school",
          hasFile: !!sub?.file_path,
        };
      }),
    };
  }
  return out;
}

/** "Done — marked by you", for the parent's card. */
export function doneByWords(doneBy: HomeworkItem["doneBy"], childFirst: string): string {
  if (doneBy === "you") return "Done. You marked it done.";
  if (doneBy === "child") return `Done. ${childFirst} marked it done.`;
  return "Done.";
}

// ------------------------------------------------------------------ marking done (student, or parent of a young child)

/**
 * Marks one piece of homework done (or undoes it) for one learner. RLS
 * (may_mark_submission) decides who may: the learner, staff, or a parent of
 * a PP1–Grade 3 learner. Undo never removes a row with an uploaded file —
 * that row is the only record of the file.
 */
export async function setHomeworkDone(assignmentId: string, studentId: string, done: boolean): Promise<void> {
  if (done) {
    const { error } = await supabase()
      .from("assignment_submissions")
      .upsert({ assignment_id: assignmentId, student_id: studentId }, { onConflict: "assignment_id,student_id", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    return;
  }
  const { error } = await supabase()
    .from("assignment_submissions")
    .delete()
    .eq("assignment_id", assignmentId)
    .eq("student_id", studentId)
    .is("file_path", null);
  if (error) throw new Error(error.message);
}
