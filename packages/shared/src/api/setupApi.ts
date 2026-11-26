import { LEVELS, subjectOffered, yearSortKey } from "../levels";
import type { ClassGroup, ClassLevel, Subject, Term } from "../types";
import { NotOnApiError } from "../capabilities";
import { apiClient } from "./client";
import { isApiError, userMessage } from "./errors";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import type { components } from "./schema";

/**
 * Setting a school up on the API (FIG-1890): the API side of schoolSetup.ts. The screens call the same functions; on an API
 * build they land here. The API's model is not Supabase's, and the differences are handled here, not in the screens:
 *
 *  - A class belongs to an academic year, and a term to a year. Supabase had neither link. "The classes" here means the
 *    classes of the current year; making a class needs a current year (School settings -> Start a term makes one).
 *  - A teacher is a staff record, not a login. Every teacher id on this side is a staff id, kept opaque by the screens.
 *  - A subject is a code, a name, a level, a year range and a core flag. It has no link to a KICD learning area.
 *  - A class and a subject can be changed (migration 101: `PATCH`), and a class's teacher, room and subjects' teachers can be set and
 *    cleared. A class is ARCHIVED, not deleted: the API refuses while an active learner is in it, and has no restore. A teaching
 *    assignment keeps its id when its teacher changes, and is archived to clear it.
 *  - What the API cannot do throws NotOnApiError, and the screen does not offer it (capabilities.ts).
 *  - A write that names no school (a class's teacher, a subject's code) goes to the school the tab is in.
 */

type SchoolClass = components["schemas"]["SchoolClass"];
type AcademicYear = components["schemas"]["AcademicYear"];
type AcademicTerm = components["schemas"]["AcademicTerm"];
type ApiSubject = components["schemas"]["Subject"];
type StaffMember = components["schemas"]["StaffMember"];

export interface TeacherOption { id: string; full_name: string }

/** The school a write is for when it was not told one (the shared functions that change a class or a subject take only its id). */
function activeTenantId(): string {
  const id = apiClient().activeTenant();
  if (!id) throw new Error("No active school selected.");
  return id;
}

// ---------------------------------------------------------------- reading the lists (every page)

export function listAcademicYears(tenantId: string): Promise<AcademicYear[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/academic-years", { path: { tenantId }, query: { limit: API_PAGE_LIMIT, cursor }, tenantId });
    return { items: r.academic_years, page: r.page };
  });
}

export function listAcademicTerms(tenantId: string, academicYearId?: string): Promise<AcademicTerm[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/academic-terms", { path: { tenantId }, query: { academicYearId, limit: API_PAGE_LIMIT, cursor }, tenantId });
    return { items: r.terms, page: r.page };
  });
}

export async function listClasses(tenantId: string, academicYearId?: string): Promise<SchoolClass[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/classes", { path: { tenantId }, query: { academicYearId, active: true, limit: API_PAGE_LIMIT, cursor }, tenantId });
    return { items: r.classes, page: r.page };
  });
}

export async function listApiSubjects(tenantId: string): Promise<ApiSubject[]> {
  const all = await listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/subjects", { path: { tenantId }, query: { limit: API_PAGE_LIMIT, cursor }, tenantId });
    return { items: r.subjects, page: r.page };
  });
  return all.filter((s) => s.active);
}

/** The school's teachers, by name. A person who may not read the staff list (a teacher holding only Academics) gets an empty list, not an error: the screens then show every teacher as unassigned. */
export async function listTeachers(tenantId: string): Promise<TeacherOption[]> {
  try {
    const staff: StaffMember[] = await listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/staff", { path: { tenantId }, query: { active: true, limit: API_PAGE_LIMIT, cursor }, tenantId });
      return { items: r.staff, page: r.page };
    });
    return staff.filter((s) => s.classification === "teacher").map((s) => ({ id: s.id, full_name: s.full_name })).sort((a, b) => a.full_name.localeCompare(b.full_name));
  } catch (err) {
    if (isApiError(err) && err.code === "forbidden") return [];
    throw err;
  }
}

/**
 * The ids of the school's active learners, or null when the person may not read learners. Archiving a learner does NOT end their
 * class membership in the API (it stays active, and restoring them needs nothing done), so a class's headcount must count only the
 * memberships of learners who are active.
 */
export async function listActiveLearnerIds(tenantId: string): Promise<Set<string> | null> {
  try {
    const rows = await listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/learners", { path: { tenantId }, query: { active: true, limit: API_PAGE_LIMIT, cursor }, tenantId });
      return { items: r.learners, page: r.page };
    });
    return new Set(rows.map((l) => l.id));
  } catch (err) {
    // A teacher holding only Academics reads classes but not learners: the count then includes archived learners, never fails.
    if (isApiError(err) && err.code === "forbidden") return null;
    throw err;
  }
}

async function countByClass(tenantId: string): Promise<Map<string, number>> {
  const [rows, active] = await Promise.all([
    listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/class-memberships", { path: { tenantId }, query: { active: true, limit: API_PAGE_LIMIT, cursor }, tenantId });
      return { items: r.memberships, page: r.page };
    }),
    listActiveLearnerIds(tenantId),
  ]);
  const counts = new Map<string, number>();
  for (const m of rows) {
    if (active && !active.has(m.learner_id)) continue;
    counts.set(m.class_id, (counts.get(m.class_id) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------- shaping what the screens expect

/** The year a year row stands for as a number: the calendar year it starts in. */
export function yearNumberOf(y: Pick<AcademicYear, "starts_on" | "label">): number {
  const fromDate = Number(y.starts_on.slice(0, 4));
  if (Number.isInteger(fromDate) && fromDate > 1900) return fromDate;
  const fromLabel = Number(/\d{4}/.exec(y.label)?.[0]);
  return Number.isInteger(fromLabel) ? fromLabel : new Date().getFullYear();
}

export function classGroupFromApi(c: SchoolClass, tenantId: string): ClassGroup {
  const level: ClassLevel = c.education_level ?? "secondary";
  return {
    id: c.id, tenant_id: tenantId, name: c.name, level,
    // A class that never said its year is read as the first of its level: sorted and labelled, never a made-up 0.
    form_level: c.form_level ?? LEVELS[level].min,
    pathway: c.pathway, stream: c.stream, class_teacher_id: c.class_teacher_staff_id, room: c.room ?? null,
  };
}

export function termFromApi(t: AcademicTerm, year: AcademicYear | undefined, tenantId: string): Term {
  const n = Math.min(Math.max(t.index, 1), 3) as 1 | 2 | 3;
  return {
    id: t.id, tenant_id: tenantId, name: t.label, year: year ? yearNumberOf(year) : Number(t.starts_on.slice(0, 4)),
    index: n, starts_on: t.starts_on, ends_on: t.ends_on, is_current: t.is_current,
  };
}

export function subjectFromApi(s: ApiSubject, tenantId: string): Subject {
  return {
    id: s.id, tenant_id: tenantId, name: s.name, code: s.code, is_core: s.is_core ?? true,
    level: s.education_level ?? null, min_form_level: s.min_form_level ?? null, max_form_level: s.max_form_level ?? null,
    // The API's subject has no link to a KICD learning area.
    learning_area_id: null,
  };
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/** Youngest year first (PP1 ... Grade 12, then Form 1 ... 4), then by name: the order the screens always showed. */
export const byYear = (a: ClassGroup, b: ClassGroup) => yearSortKey(a.level, a.form_level) - yearSortKey(b.level, b.form_level) || a.name.localeCompare(b.name);

// ---------------------------------------------------------------- classes

export async function currentAcademicYear(tenantId: string): Promise<AcademicYear | null> {
  return (await listAcademicYears(tenantId)).find((y) => y.is_current) ?? null;
}

export interface ApiClassesOverview {
  classes: ClassGroup[];
  teachers: TeacherOption[];
  subjects: { id: string; name: string }[];
  studentCountByClass: Map<string, number>;
}

/** The current year's classes (every active class when no year is current yet), the teachers, the subjects, and each class's learner count. */
export async function apiFetchClassesOverview(tenantId: string): Promise<ApiClassesOverview> {
  const year = await currentAcademicYear(tenantId);
  const [classes, teachers, subjects, counts] = await Promise.all([
    listClasses(tenantId, year?.id), listTeachers(tenantId), listApiSubjects(tenantId), countByClass(tenantId),
  ]);
  const shown = new Set(classes.map((c) => c.id));
  const studentCountByClass = new Map([...counts].filter(([id]) => shown.has(id)));
  return {
    classes: classes.map((c) => classGroupFromApi(c, tenantId)).sort(byYear),
    teachers,
    subjects: subjects.map((s) => ({ id: s.id, name: s.name })).sort(byName),
    studentCountByClass,
  };
}

export interface ApiNewClass {
  name: string; level: ClassLevel; formLevel: number; pathway: ClassGroup["pathway"]; stream: string | null; room: string | null; classTeacherId: string | null;
}

async function requireCurrentYear(tenantId: string): Promise<AcademicYear> {
  const year = await currentAcademicYear(tenantId);
  if (!year) throw new Error("The school has no current academic year yet. Start a term under School settings first.");
  return year;
}

function classBody(yearId: string, c: ApiNewClass) {
  return {
    academic_year_id: yearId, name: c.name, form_level: c.formLevel, education_level: c.level,
    pathway: c.pathway ?? null, stream: c.stream, room: blankToNull(c.room), class_teacher_staff_id: c.classTeacherId,
  };
}

export async function apiCreateClass(tenantId: string, c: ApiNewClass): Promise<void> {
  const year = await requireCurrentYear(tenantId);
  await apiClient().post("/v1/tenants/{tenantId}/classes", { path: { tenantId }, body: classBody(year.id, c), tenantId });
}

/**
 * The API has no batch, so these go one at a time and stop at the first the API refuses. Supabase did all or none; here
 * the classes before the refused one exist, and the message says how many (running it again with the rest is safe: a name
 * already used is refused, not duplicated).
 */
export async function apiCreateClasses(tenantId: string, classes: ApiNewClass[]): Promise<void> {
  const year = await requireCurrentYear(tenantId);
  let made = 0;
  for (const c of classes) {
    try {
      await apiClient().post("/v1/tenants/{tenantId}/classes", { path: { tenantId }, body: classBody(year.id, c), tenantId });
      made++;
    } catch (err) {
      throw partialFailure("classes", made, classes.length, c.name, err);
    }
  }
}

/** Gives a class another teacher, or takes the teacher off with null. The new teacher must be an active member of staff of the school (400 otherwise). */
export async function apiSetClassTeacher(classId: string, teacherId: string | null): Promise<void> {
  const tenantId = activeTenantId();
  await apiClient().patch("/v1/tenants/{tenantId}/classes/{classId}", { path: { tenantId, classId }, body: { class_teacher_staff_id: teacherId }, tenantId });
}

/** Sets a class's room, or clears it when blank or null. */
export async function apiSetClassRoom(classId: string, room: string | null): Promise<void> {
  const tenantId = activeTenantId();
  await apiClient().patch("/v1/tenants/{tenantId}/classes/{classId}", { path: { tenantId, classId }, body: { room: blankToNull(room) }, tenantId });
}

/**
 * Archives a class (what the screens call deleting one). The API refuses with 409 while an active learner is in it, ends the class's
 * teaching assignments, and keeps its timetable and history. There is no restore. The ApiError's message is the API's own sentence,
 * written for the person ("The class still has 2 learners. Move them to another class first.").
 */
export async function apiArchiveClass(classId: string): Promise<void> {
  const tenantId = activeTenantId();
  await apiClient().post("/v1/tenants/{tenantId}/classes/{classId}/archive", { path: { tenantId, classId }, tenantId });
}

/** The error for a batch that stopped part-way. Nothing made yet: the API's own error, untouched. Otherwise a message saying how far it got. */
function partialFailure(nouns: string, made: number, total: number, which: string, err: unknown): Error {
  if (made === 0) return err instanceof Error ? err : new Error(userMessage(err));
  return new Error(`${made} of ${total} ${nouns} were added. "${which}" was not: ${userMessage(err)}`);
}

// ---------------------------------------------------------------- the term and the school's details

export interface ApiTermSetup {
  term: Term | null;
  classes: Pick<ClassGroup, "id" | "name" | "level" | "form_level" | "class_teacher_id">[];
  subjectsCount: number;
  teacherOptions: TeacherOption[];
  activeStudents: number;
}

export async function apiFetchTermSetup(tenantId: string): Promise<ApiTermSetup> {
  const [years, terms, classes, subjects, teachers, counts] = await Promise.all([
    listAcademicYears(tenantId), listAcademicTerms(tenantId), listClasses(tenantId), listApiSubjects(tenantId), listTeachers(tenantId), countByClass(tenantId),
  ]);
  const current = terms.find((t) => t.is_current);
  const currentYear = years.find((y) => y.is_current);
  // The checklist counts the current year's classes and the learners placed in them.
  const yearClasses = currentYear ? classes.filter((c) => c.academic_year_id === currentYear.id) : classes;
  const ids = new Set(yearClasses.map((c) => c.id));
  let activeStudents = 0;
  for (const [id, n] of counts) if (ids.has(id)) activeStudents += n;
  return {
    term: current ? termFromApi(current, years.find((y) => y.id === current.academic_year_id), tenantId) : null,
    classes: yearClasses.map((c) => classGroupFromApi(c, tenantId)).sort(byYear),
    subjectsCount: subjects.length,
    teacherOptions: teachers,
    activeStudents,
  };
}

/**
 * Starts a term and makes it the current one, with its year. The API has no "start a term" call, so this finds or makes the
 * year (the calendar year, 1 January to 31 December), makes the term, and sets both current. A step the API refuses stops it
 * there; what was made stays (a year with no term is harmless, and starting again reuses it).
 */
export async function apiStartTerm(input: { tenantId: string; year: number; index: 1 | 2 | 3; startsOn: string; endsOn: string }): Promise<void> {
  const { tenantId } = input;
  const c = apiClient();
  const years = await listAcademicYears(tenantId);
  let year = years.find((y) => yearNumberOf(y) === input.year);
  if (!year) {
    const made = await c.post("/v1/tenants/{tenantId}/academic-years", {
      path: { tenantId }, tenantId,
      body: { label: String(input.year), starts_on: `${input.year}-01-01`, ends_on: `${input.year}-12-31` },
    });
    year = made.academic_year;
  }
  if (!year.is_current) await c.post("/v1/tenants/{tenantId}/academic-years/{academicYearId}/set-current", { path: { tenantId, academicYearId: year.id }, tenantId });

  const existing = (await listAcademicTerms(tenantId, year.id)).find((t) => t.index === input.index);
  const term = existing ?? (await c.post("/v1/tenants/{tenantId}/academic-terms", {
    path: { tenantId }, tenantId,
    body: { academic_year_id: year.id, index: input.index, label: `Term ${input.index}, ${input.year}`, starts_on: input.startsOn, ends_on: input.endsOn },
  })).term;
  if (!term.is_current) await c.post("/v1/tenants/{tenantId}/academic-terms/{termId}/set-current", { path: { tenantId, termId: term.id }, tenantId });
}

const blankToNull = (s: string | null): string | null => (s === null || s.trim() === "" ? null : s.trim());

export async function apiSaveSchoolDetails(tenantId: string, d: { name: string; county: string; moeRegistration: string }): Promise<void> {
  await apiClient().patch("/v1/tenants/{tenantId}/school-profile", {
    path: { tenantId }, tenantId, body: { name: d.name.trim(), county: blankToNull(d.county), moe_registration: blankToNull(d.moeRegistration) },
  });
}

export async function apiSaveSchoolAccent(tenantId: string, accent: string): Promise<void> {
  await apiClient().patch("/v1/tenants/{tenantId}/school-profile", { path: { tenantId }, tenantId, body: { accent } });
}

// ---------------------------------------------------------------- subjects, and who teaches them

export async function apiFetchSubjects(tenantId: string): Promise<Subject[]> {
  return (await listApiSubjects(tenantId)).map((s) => subjectFromApi(s, tenantId)).sort(byName);
}

/** A subject to make. `level` is left out of the request when it is undefined, so the API's own default applies; null means any level. */
export interface ApiNewSubject {
  name: string; code: string; isCore: boolean; level?: ClassLevel | null; minFormLevel: number | null; maxFormLevel: number | null;
  /** The KICD learning area it was added from: the API's subject has no such link, so a call that gives one is refused. */
  learningAreaId?: string;
}

function subjectBody(s: ApiNewSubject) {
  if (s.learningAreaId !== undefined) throw new NotOnApiError("Adding a subject from the KICD catalogue");
  return {
    code: s.code, name: s.name, is_core: s.isCore,
    ...(s.level !== undefined ? { education_level: s.level } : {}),
    min_form_level: s.minFormLevel, max_form_level: s.maxFormLevel,
  };
}

export async function apiCreateSubject(tenantId: string, s: ApiNewSubject): Promise<void> {
  await apiClient().post("/v1/tenants/{tenantId}/subjects", { path: { tenantId }, tenantId, body: subjectBody(s) });
}

/** One at a time (the API has no batch): see apiCreateClasses for what a refusal part-way leaves. */
export async function apiCreateSubjects(tenantId: string, subjects: ApiNewSubject[]): Promise<void> {
  const bodies = subjects.map(subjectBody);
  let made = 0;
  for (const [i, s] of subjects.entries()) {
    try {
      await apiClient().post("/v1/tenants/{tenantId}/subjects", { path: { tenantId }, tenantId, body: bodies[i]! });
      made++;
    } catch (err) {
      throw partialFailure("subjects", made, subjects.length, s.name, err);
    }
  }
}

/**
 * Changes a subject. The years and the name and code are always sent (a null year clears it); the level and the core flag only when given.
 * The API refuses a code another subject has (409), years outside the level (400), and a subject that was archived (400): its own
 * sentences reach the person.
 */
export async function apiUpdateSubject(
  subjectId: string,
  f: { name: string; code: string; minFormLevel: number | null; maxFormLevel: number | null; level?: ClassLevel | null; isCore?: boolean },
): Promise<void> {
  const tenantId = activeTenantId();
  await apiClient().patch("/v1/tenants/{tenantId}/subjects/{subjectId}", {
    path: { tenantId, subjectId }, tenantId,
    body: {
      name: f.name, code: f.code, min_form_level: f.minFormLevel, max_form_level: f.maxFormLevel,
      ...(f.level !== undefined ? { education_level: f.level } : {}),
      ...(f.isCore !== undefined ? { is_core: f.isCore } : {}),
    },
  });
}

export interface ApiClassSubjects {
  rows: { subject: Subject; teacherId: string | null }[];
  qualifiedTeacherIdsBySubject: Map<string, Set<string>>;
}

async function listAssignments(tenantId: string, classId: string) {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/teaching-assignments", { path: { tenantId }, query: { classId, active: true, limit: API_PAGE_LIMIT, cursor }, tenantId });
    return { items: r.assignments, page: r.page };
  });
}

/**
 * The subjects a class takes, with who teaches each in this class. A subject whose level or years leave this class out is not listed
 * (Subjects > "which forms offer it"), as on Supabase, unless it already has a teacher here: that one stays so the teacher can be changed
 * or cleared. The API keeps no list of which teacher "teaches" which subject, so none is marked qualified.
 */
export async function apiFetchClassSubjects(tenantId: string, classId: string, classLevel: ClassLevel, formLevel: number): Promise<ApiClassSubjects> {
  const [subjects, assignments] = await Promise.all([listApiSubjects(tenantId), listAssignments(tenantId, classId)]);
  const teacherBySubject = new Map(assignments.map((a) => [a.subject_id, a.staff_member_id]));
  const rows = subjects
    .map((s) => ({ subject: subjectFromApi(s, tenantId), teacherId: teacherBySubject.get(s.id) ?? null }))
    .filter((r) => r.teacherId !== null || subjectOffered(r.subject, { level: classLevel, year: formLevel }))
    .sort((a, b) => byName(a.subject, b.subject));
  return { rows, qualifiedTeacherIdsBySubject: new Map() };
}

/**
 * Names, changes or clears a subject's teacher in a class. A subject with none gets a new assignment. One that has a teacher keeps its
 * assignment (the same id, so its timetable slots keep their link) and is given the new one; clearing archives it. The new teacher must
 * be an active member of staff of the school (400 otherwise).
 */
export async function apiSetClassSubjectTeacher(input: { tenantId: string; classId: string; subjectId: string; teacherId: string | null }): Promise<void> {
  const { tenantId, classId, subjectId, teacherId } = input;
  const existing = (await listAssignments(tenantId, classId)).find((a) => a.subject_id === subjectId);
  if (!teacherId) {
    if (!existing) return;
    await apiClient().post("/v1/tenants/{tenantId}/teaching-assignments/{assignmentId}/archive", { path: { tenantId, assignmentId: existing.id }, tenantId });
    return;
  }
  if (existing) {
    if (existing.staff_member_id === teacherId) return;
    await apiClient().patch("/v1/tenants/{tenantId}/teaching-assignments/{assignmentId}", { path: { tenantId, assignmentId: existing.id }, body: { staff_member_id: teacherId }, tenantId });
    return;
  }
  await apiClient().post("/v1/tenants/{tenantId}/teaching-assignments", { path: { tenantId }, tenantId, body: { staff_member_id: teacherId, class_id: classId, subject_id: subjectId } });
}
