import {
  apiCreateClass, apiCreateClasses, apiCreateSubject, apiCreateSubjects, apiFetchClassSubjects, apiFetchClassesOverview, apiFetchSubjects,
  apiFetchTermSetup, apiSaveSchoolAccent, apiSaveSchoolDetails, apiSetClassSubjectTeacher, apiStartTerm,
} from "./api/setupApi";
import { onApi } from "./backend";
import { NotOnApiError } from "./capabilities";
import { subjectOffered, yearSortKey, type Pathway } from "./levels";
import { supabase } from "./supabase";
import type { ClassGroup, ClassLevel, Profile, Subject, Term } from "./types";

/**
 * Setting a school up (FIG-1897): its classes, its term and details, promoting a class at the year's end, its subjects
 * and who teaches them. The admin's setup screens used to query the database themselves; they call these instead, so
 * moving the apps to the new API (FIG-1890) changes this module and not the screens.
 *
 * Nothing here changes what the apps do. Each function is the call a screen made before, with the same filters, the same
 * order and the same errors: a call that threw the database's own error still does, and one that threw
 * `new Error(message)` still does.
 *
 * On an API build (`onApi()`) each function answers from apps/api (api/setupApi.ts). What the API cannot do yet throws
 * NotOnApiError, and the screen does not offer it (capabilities.ts `setupCapabilities`).
 */

interface TeacherOption { id: string; full_name: string }

// ---------------------------------------------------------------- classes

export interface ClassesOverview {
  /** Youngest year first (PP1 … Grade 12, then Form 1 … 4), then by name. */
  classes: ClassGroup[];
  teachers: TeacherOption[];
  subjects: { id: string; name: string }[];
  /** Active learners on each class's roll, by class id. */
  studentCountByClass: Map<string, number>;
}

/** Everything the Classes screen shows: the classes, the school's teachers and subjects, and how many learners each class has. */
export async function fetchClassesOverview(tenantId: string): Promise<ClassesOverview> {
  if (onApi()) return apiFetchClassesOverview(tenantId);
  const sb = supabase();
  const [{ data: classRows, error: e1 }, { data: teacherRows, error: e2 }, { data: studentRows, error: e3 }, { data: subjectRows, error: e4 }] = await Promise.all([
    sb.from("classes").select("*").eq("tenant_id", tenantId).order("form_level").order("name").returns<ClassGroup[]>(),
    sb.from("profiles").select("id,full_name").eq("tenant_id", tenantId).eq("role", "teacher").order("full_name").returns<TeacherOption[]>(),
    sb.from("students").select("id,class_id").eq("tenant_id", tenantId).eq("active", true).returns<{ id: string; class_id: string }[]>(),
    sb.from("subjects").select("id,name").eq("tenant_id", tenantId).order("name").returns<{ id: string; name: string }[]>(),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  if (e3) throw e3;
  if (e4) throw e4;

  const studentCountByClass = new Map<string, number>();
  for (const s of studentRows ?? []) studentCountByClass.set(s.class_id, (studentCountByClass.get(s.class_id) ?? 0) + 1);

  // Youngest first: PP1 … Grade 12, then Form 1 … 4. form_level alone cannot order a school that runs more than one
  // level (Grade 1 and Form 1 are both 1).
  const classes = [...(classRows ?? [])].sort((a, b) =>
    yearSortKey(a.level, a.form_level) - yearSortKey(b.level, b.form_level) || a.name.localeCompare(b.name));
  return { classes, teachers: teacherRows ?? [], subjects: subjectRows ?? [], studentCountByClass };
}

/** A class to create. */
export interface NewClass {
  name: string;
  level: ClassLevel;
  formLevel: number;
  /** Senior school only. */
  pathway: Pathway | null;
  stream: string | null;
  room: string | null;
  classTeacherId: string | null;
}

function classRow(tenantId: string, c: NewClass) {
  return {
    tenant_id: tenantId,
    name: c.name,
    level: c.level,
    form_level: c.formLevel,
    pathway: c.pathway,
    stream: c.stream,
    room: c.room,
    class_teacher_id: c.classTeacherId,
  };
}

/** Adds one class. Throws the database's answer when it refuses. */
export async function createClass(tenantId: string, c: NewClass): Promise<void> {
  if (onApi()) return apiCreateClass(tenantId, c);
  const { error } = await supabase().from("classes").insert(classRow(tenantId, c));
  if (error) throw error;
}

/** Adds several classes in one request: all of them or none. */
export async function createClasses(tenantId: string, classes: NewClass[]): Promise<void> {
  if (onApi()) return apiCreateClasses(tenantId, classes);
  const { error } = await supabase().from("classes").insert(classes.map((c) => classRow(tenantId, c)));
  if (error) throw error;
}

/** Gives a class its class teacher, or takes the teacher off with null. */
export async function setClassTeacher(classId: string, teacherId: string | null): Promise<void> {
  if (onApi()) throw new NotOnApiError("Changing a class's teacher");
  const { error } = await supabase().from("classes").update({ class_teacher_id: teacherId }).eq("id", classId);
  if (error) throw error;
}

export async function deleteClass(classId: string): Promise<void> {
  if (onApi()) throw new NotOnApiError("Deleting a class");
  const { error } = await supabase().from("classes").delete().eq("id", classId);
  if (error) throw error;
}

// ---------------------------------------------------------------- the term and the school's details

export type SetupClassRow = Pick<ClassGroup, "id" | "name" | "level" | "form_level" | "class_teacher_id">;

/** What the setup checklist counts. */
export interface TermSetupData {
  term: Term | null;
  classes: SetupClassRow[];
  subjectsCount: number;
  feeItemsCount: number;
  teacherOptions: Pick<Profile, "id" | "full_name">[];
  activeStudents: number;
}

/**
 * The setup checklist's figures. A part that cannot be read counts as nothing (no error is raised), as the screen
 * always did.
 */
export async function fetchTermSetup(tenantId: string): Promise<TermSetupData> {
  if (onApi()) return { ...(await apiFetchTermSetup(tenantId)), feeItemsCount: 0 };
  const sb = supabase();
  const { data: term } = await sb.from("terms").select("*").eq("tenant_id", tenantId).eq("is_current", true).maybeSingle<Term>();
  const termId = term?.id ?? null;

  const [{ data: classRows }, { count: subjectsCount }, feeItemsRes, { data: teacherRows }, { count: studentsCount }] = await Promise.all([
    sb.from("classes").select("id,name,level,form_level,class_teacher_id").eq("tenant_id", tenantId).order("form_level").order("name").returns<SetupClassRow[]>(),
    sb.from("subjects").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
    termId
      ? sb.from("fee_items").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("term_id", termId)
      : Promise.resolve({ count: 0 }),
    sb.from("profiles").select("id,full_name").eq("tenant_id", tenantId).eq("role", "teacher").order("full_name").returns<Pick<Profile, "id" | "full_name">[]>(),
    sb.from("students").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("active", true),
  ]);

  return {
    term: term ?? null,
    classes: classRows ?? [],
    subjectsCount: subjectsCount ?? 0,
    feeItemsCount: feeItemsRes.count ?? 0,
    teacherOptions: teacherRows ?? [],
    activeStudents: studentsCount ?? 0,
  };
}

/**
 * Starts a term and makes it the current one. One database call: it switches the current term off and starts this one
 * together, so a term the database refuses leaves the school with the term it had (FIG-1427).
 */
export async function startTerm(input: { tenantId: string; year: number; index: 1 | 2 | 3; startsOn: string; endsOn: string }): Promise<void> {
  if (onApi()) return apiStartTerm(input);
  const { error } = await supabase().rpc("start_term", {
    p_tenant_id: input.tenantId, p_year: input.year, p_index: input.index, p_starts_on: input.startsOn, p_ends_on: input.endsOn,
  });
  if (error) throw error;
}

export async function saveSchoolDetails(tenantId: string, details: { name: string; county: string; moeRegistration: string }): Promise<void> {
  if (onApi()) return apiSaveSchoolDetails(tenantId, details);
  const { error } = await supabase().rpc("set_school_details", {
    p_tenant_id: tenantId,
    p_name: details.name,
    p_county: details.county,
    p_moe_registration: details.moeRegistration,
  });
  if (error) throw error;
}

export async function saveSchoolPaymentMethods(
  tenantId: string,
  methods: { paybill: string; till: string; bankDetails: string; notes: string },
): Promise<void> {
  if (onApi()) throw new NotOnApiError("Payment methods");
  const { error } = await supabase().rpc("set_school_payment_methods", {
    p_tenant_id: tenantId,
    p_paybill: methods.paybill,
    p_till: methods.till,
    p_bank_details: methods.bankDetails,
    p_notes: methods.notes,
  });
  if (error) throw error;
}

export async function saveSchoolLogo(tenantId: string, logoUrl: string): Promise<void> {
  if (onApi()) throw new NotOnApiError("The school crest");
  const { error } = await supabase().rpc("set_school_logo", { p_tenant_id: tenantId, p_logo_url: logoUrl });
  if (error) throw error;
}

export async function saveSchoolAccent(tenantId: string, accent: string): Promise<void> {
  if (onApi()) return apiSaveSchoolAccent(tenantId, accent);
  const { error } = await supabase().rpc("set_school_accent", { p_tenant_id: tenantId, p_accent: accent });
  if (error) throw error;
}

// ---------------------------------------------------------------- promoting a class

export interface PromotionRosterRow { id: string; full_name: string; admission_no: string; profile_id: string | null }

/** The class's active learners, by name. */
export async function fetchPromotionRoster(classId: string): Promise<PromotionRosterRow[]> {
  if (onApi()) throw new NotOnApiError("Promoting a class");
  const { data, error } = await supabase()
    .from("students").select("id, full_name, admission_no, profile_id").eq("class_id", classId).eq("active", true).order("full_name")
    .returns<PromotionRosterRow[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Each learner's mean across every subject of the most recently published exam: what "promote if passing" judges
 * against. A learner with no marks on record has no entry, so the bulk action leaves them untouched rather than guessing.
 */
export async function fetchLatestExamMeans(tenantId: string, studentIds: string[]): Promise<Map<string, number>> {
  if (onApi()) throw new NotOnApiError("Promoting a class");
  const out = new Map<string, number>();
  if (!studentIds.length) return out;
  const { data: examRows, error: e1 } = await supabase()
    .from("exams").select("id").eq("tenant_id", tenantId).not("published_at", "is", null).order("published_at", { ascending: false }).limit(1)
    .returns<{ id: string }[]>();
  if (e1) throw new Error(e1.message);
  const examId = examRows?.[0]?.id;
  if (!examId) return out;

  const { data: markRows, error: e2 } = await supabase()
    .from("marks").select("student_id, score").eq("exam_id", examId).in("student_id", studentIds)
    .returns<{ student_id: string; score: number | null }[]>();
  if (e2) throw new Error(e2.message);

  const scoresByStudent = new Map<string, number[]>();
  for (const m of markRows ?? []) {
    if (m.score === null) continue;
    const arr = scoresByStudent.get(m.student_id) ?? [];
    arr.push(m.score);
    scoresByStudent.set(m.student_id, arr);
  }
  for (const [sid, scores] of scoresByStudent) out.set(sid, Math.round(scores.reduce((a, b) => a + b, 0) / scores.length));
  return out;
}

/** Takes learners off the roll (graduated, or withdrawn). A plain update: no archive stamp, as before (FIG-1420). */
export async function markLearnersLeft(studentIds: string[]): Promise<void> {
  if (onApi()) throw new NotOnApiError("Promoting a class");
  const { error } = await supabase().from("students").update({ active: false }).in("id", studentIds);
  if (error) throw error;
}

/** Moves learners to another class. */
export async function moveLearnersToClass(classId: string, studentIds: string[]): Promise<void> {
  if (onApi()) throw new NotOnApiError("Promoting a class");
  const { error } = await supabase().from("students").update({ class_id: classId }).in("id", studentIds);
  if (error) throw error;
}

/** Every guardian's profile id, by learner. */
export async function fetchGuardianProfileIds(studentIds: string[]): Promise<Map<string, string[]>> {
  if (onApi()) throw new NotOnApiError("Promoting a class");
  const { data, error } = await supabase()
    .from("guardians").select("student_id, profile_id")
    .in("student_id", studentIds)
    .returns<{ student_id: string; profile_id: string }[]>();
  if (error) throw error;

  const byStudent = new Map<string, string[]>();
  for (const g of data ?? []) {
    const ids = byStudent.get(g.student_id) ?? [];
    ids.push(g.profile_id);
    byStudent.set(g.student_id, ids);
  }
  return byStudent;
}

/** One in-app notice to one person. */
export interface InAppNotice { userId: string; subject: string; body: string }

/** Sends each person their notice in the app (no SMS or email), published now. Sends nothing for an empty list. */
export async function sendInAppNotices(input: { tenantId: string; authorId: string; notices: InAppNotice[] }): Promise<void> {
  if (input.notices.length === 0) return;
  if (onApi()) throw new NotOnApiError("Sending notices");
  const now = new Date().toISOString();
  const { error } = await supabase().from("announcements").insert(input.notices.map((n) => ({
    tenant_id: input.tenantId, author_id: input.authorId, subject: n.subject, body: n.body,
    audience: { kind: "user" as const, user_id: n.userId },
    channels: ["in_app"], published_at: now,
  })));
  if (error) throw error;
}

// ---------------------------------------------------------------- subjects, and who teaches them

/** The school's subjects, by name. */
export async function fetchSubjects(tenantId: string): Promise<Subject[]> {
  if (onApi()) return apiFetchSubjects(tenantId);
  const { data, error } = await supabase().from("subjects").select("*").eq("tenant_id", tenantId).order("name").returns<Subject[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** A subject to add. `level` and `learningAreaId` are only sent when given. */
export interface NewSubject {
  name: string;
  code: string;
  isCore: boolean;
  /** The level the year bounds are read within; null = any level. Left out, the database's own default applies. */
  level?: ClassLevel | null;
  minFormLevel: number | null;
  maxFormLevel: number | null;
  /** The KICD learning area it was added from. */
  learningAreaId?: string;
}

function subjectRow(tenantId: string, s: NewSubject) {
  return {
    tenant_id: tenantId, name: s.name, code: s.code, is_core: s.isCore,
    ...(s.level !== undefined ? { level: s.level } : {}),
    min_form_level: s.minFormLevel, max_form_level: s.maxFormLevel,
    ...(s.learningAreaId !== undefined ? { learning_area_id: s.learningAreaId } : {}),
  };
}

export async function createSubject(tenantId: string, subject: NewSubject): Promise<void> {
  if (onApi()) return apiCreateSubject(tenantId, subject);
  const { error } = await supabase().from("subjects").insert(subjectRow(tenantId, subject));
  if (error) throw error;
}

/** Adds several subjects in one request: all of them or none. */
export async function createSubjects(tenantId: string, subjects: NewSubject[]): Promise<void> {
  if (onApi()) return apiCreateSubjects(tenantId, subjects);
  const { error } = await supabase().from("subjects").insert(subjects.map((s) => subjectRow(tenantId, s)));
  if (error) throw error;
}

export async function updateSubject(
  subjectId: string,
  fields: { name: string; code: string; minFormLevel: number | null; maxFormLevel: number | null },
): Promise<void> {
  if (onApi()) throw new NotOnApiError("Editing a subject");
  const { error } = await supabase().from("subjects").update({
    name: fields.name, code: fields.code,
    min_form_level: fields.minFormLevel, max_form_level: fields.maxFormLevel,
  }).eq("id", subjectId);
  if (error) throw error;
}

export interface ClassSubjectsData {
  rows: { subject: Subject; teacherId: string | null }[];
  /** The teachers who say they teach each subject (a teacher's own subject list), by subject id. */
  qualifiedTeacherIdsBySubject: Map<string, Set<string>>;
}

/** The subjects a class takes and who teaches each, with which teachers are qualified for which subject. */
export async function fetchClassSubjects(tenantId: string, classId: string, classLevel: ClassLevel, formLevel: number): Promise<ClassSubjectsData> {
  if (onApi()) return apiFetchClassSubjects(tenantId, classId);
  const sb = supabase();
  const [{ data: subjects, error: e1 }, { data: assignments, error: e2 }, { data: specializations, error: e3 }] = await Promise.all([
    sb.from("subjects").select("*").eq("tenant_id", tenantId).order("name").returns<Subject[]>(),
    sb.from("teaching_assignments").select("subject_id, teacher_id").eq("class_id", classId)
      .returns<{ subject_id: string; teacher_id: string }[]>(),
    sb.from("teacher_subjects").select("subject_id, teacher_id").eq("tenant_id", tenantId).returns<{ subject_id: string; teacher_id: string }[]>(),
  ]);
  if (e1) throw new Error(e1.message);
  if (e2) throw new Error(e2.message);
  if (e3) throw new Error(e3.message);

  // A subject applies here unless it is explicitly bounded to a form/grade range that excludes this class: "Computer
  // Studies" set to Form 1-2 only does not show up for a Form 3 class at all.
  const offered = (subjects ?? []).filter((s) => subjectOffered(s, { level: classLevel, year: formLevel }));

  const teacherBySubject = new Map((assignments ?? []).map((a) => [a.subject_id, a.teacher_id]));
  const rows = offered.map((s) => ({ subject: s, teacherId: teacherBySubject.get(s.id) ?? null }));

  const qualifiedTeacherIdsBySubject = new Map<string, Set<string>>();
  for (const row of specializations ?? []) {
    const ids = qualifiedTeacherIdsBySubject.get(row.subject_id) ?? new Set<string>();
    ids.add(row.teacher_id);
    qualifiedTeacherIdsBySubject.set(row.subject_id, ids);
  }

  return { rows, qualifiedTeacherIdsBySubject };
}

/** Names the teacher of one subject in one class, or clears it with null. This is the only place teaching assignments are made. */
export async function setClassSubjectTeacher(input: { tenantId: string; classId: string; subjectId: string; teacherId: string | null }): Promise<void> {
  if (onApi()) return apiSetClassSubjectTeacher(input);
  if (!input.teacherId) {
    const { error } = await supabase().from("teaching_assignments")
      .delete().eq("class_id", input.classId).eq("subject_id", input.subjectId);
    if (error) throw error;
    return;
  }
  const { error } = await supabase().from("teaching_assignments").upsert(
    { tenant_id: input.tenantId, class_id: input.classId, subject_id: input.subjectId, teacher_id: input.teacherId },
    { onConflict: "class_id,subject_id" },
  );
  if (error) throw error;
}
