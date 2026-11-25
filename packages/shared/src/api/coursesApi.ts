import { NotOnApiError } from "../capabilities";
import type { ActiveLearnerOption } from "../learners";
import type { CourseSectionRow, EnrolledStudentRow, InstructorSectionRow } from "../courses";
import type { Course, CourseSection, Semester } from "../types";
import { apiClient } from "./client";
import { userMessage } from "./errors";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import { settlePool } from "./pool";
import type { components } from "./schema";
import { permissionCodes } from "./sessionApi";
import { listAcademicTerms, listAcademicYears, listTeachers, termFromApi, yearNumberOf } from "./setupApi";
import { apiMyStaffId, apiStaffNames } from "./teachingLookups";

/**
 * Higher-education courses on apps/api (FIG-327 on Supabase): the API side of courses.ts, for the admin Courses screen and the
 * lecturer's "My sections".
 *
 * The API's model is smaller than Supabase's, and the differences are handled here, not in the screens:
 *  - A semester IS an academic term (of an academic year). "Add semester" finds or makes the calendar year, then the term.
 *  - A course is a code, a title and credit hours. It has no department.
 *  - A section is a course in a term with a label, and an instructor: a STAFF record of the school (so every instructor id on an
 *    API build is a staff id, as every teacher id is). It has no room, capacity or schedule.
 *  - An enrolment is a learner in a section, "enrolled" or "withdrawn". It can be made; nothing changes it but a grade call.
 *  - Every higher-education call is refused (400) unless the school's profile says it is a higher-education school.
 * What the API cannot do throws NotOnApiError, and the screen does not offer it (capabilities.ts).
 */

type HeCourse = components["schemas"]["HeCourse"];
type HeSection = components["schemas"]["HeSection"];
type HeEnrolment = components["schemas"]["HeEnrolment"];

function tenantIdOrThrow(tenantId?: string): string {
  const id = tenantId ?? apiClient().activeTenant();
  if (!id) throw new Error("No active school selected.");
  return id;
}

// ---------------------------------------------------------------- reading the lists

function listCourses(tenantId: string): Promise<HeCourse[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/he-courses", { path: { tenantId }, query: { limit: API_PAGE_LIMIT, cursor }, tenantId });
    return { items: r.courses, page: r.page };
  });
}

function listSections(tenantId: string): Promise<HeSection[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/he-sections", { path: { tenantId }, query: { limit: API_PAGE_LIMIT, cursor }, tenantId });
    return { items: r.sections, page: r.page };
  });
}

/** The enrolments of the school, or of one section (`sectionId`), withdrawn ones included. */
function listEnrolments(tenantId: string, sectionId?: string): Promise<HeEnrolment[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/he-enrolments", { path: { tenantId }, query: { sectionId, limit: API_PAGE_LIMIT, cursor }, tenantId });
    return { items: r.enrolments, page: r.page };
  });
}

// ---------------------------------------------------------------- semesters (academic terms)

/** Newest first: the later year, then the later term of it. */
export async function apiFetchSemesters(tenantId?: string): Promise<Semester[]> {
  const tid = tenantIdOrThrow(tenantId);
  const [years, terms] = await Promise.all([listAcademicYears(tid), listAcademicTerms(tid)]);
  const yearById = new Map(years.map((y) => [y.id, y]));
  return terms
    .map((t): Semester => termFromApi(t, yearById.get(t.academic_year_id), tid))
    .sort((a, b) => b.year - a.year || b.index - a.index);
}

/** Makes the semester as a term of the calendar year it is in (the year is made, 1 January to 31 December, if the school has none yet). */
export async function apiCreateSemester(input: Omit<Semester, "id">): Promise<Semester> {
  const tid = tenantIdOrThrow(input.tenant_id);
  const c = apiClient();
  const years = await listAcademicYears(tid);
  let year = years.find((y) => yearNumberOf(y) === input.year);
  if (!year) {
    year = (await c.post("/v1/tenants/{tenantId}/academic-years", {
      path: { tenantId: tid }, tenantId: tid,
      body: { label: String(input.year), starts_on: `${input.year}-01-01`, ends_on: `${input.year}-12-31` },
    })).academic_year;
  }
  const made = await c.post("/v1/tenants/{tenantId}/academic-terms", {
    path: { tenantId: tid }, tenantId: tid,
    body: { academic_year_id: year.id, index: input.index, label: input.name, starts_on: input.starts_on, ends_on: input.ends_on },
  });
  return termFromApi(made.term, year, tid);
}

/** Makes the semester (and its year) the current one. Only one is current at a time: the API clears the old one. */
export async function apiSetCurrentSemester(tenantId: string, semesterId: string): Promise<void> {
  const c = apiClient();
  const term = (await listAcademicTerms(tenantId)).find((t) => t.id === semesterId);
  if (!term) throw new Error("That semester was not found.");
  const year = (await listAcademicYears(tenantId)).find((y) => y.id === term.academic_year_id);
  if (year && !year.is_current) {
    await c.post("/v1/tenants/{tenantId}/academic-years/{academicYearId}/set-current", { path: { tenantId, academicYearId: year.id }, tenantId });
  }
  await c.post("/v1/tenants/{tenantId}/academic-terms/{termId}/set-current", { path: { tenantId, termId: semesterId }, tenantId });
}

// ---------------------------------------------------------------- courses

function courseFromApi(c: HeCourse): Course {
  return { id: c.id, tenant_id: c.tenantId, code: c.code, name: c.title, credits: Number(c.credit_hours), department: null };
}

export async function apiFetchCourses(tenantId?: string): Promise<Course[]> {
  const tid = tenantIdOrThrow(tenantId);
  return (await listCourses(tid)).map(courseFromApi).sort((a, b) => a.code.localeCompare(b.code));
}

export async function apiCreateCourse(input: Omit<Course, "id">): Promise<Course> {
  if (input.department) throw new NotOnApiError("A course's department");
  const tid = tenantIdOrThrow(input.tenant_id);
  const made = await apiClient().post("/v1/tenants/{tenantId}/he-courses", {
    path: { tenantId: tid }, tenantId: tid, body: { code: input.code, title: input.name, credit_hours: input.credits },
  });
  return courseFromApi(made.course);
}

// ---------------------------------------------------------------- sections

function sectionFromApi(s: HeSection, tenantId: string): CourseSection {
  return { id: s.id, tenant_id: tenantId, course_id: s.course_id, semester_id: s.term_id, section_label: s.label, instructor_id: s.instructor_staff_id, room: null, capacity: null };
}

/**
 * The sections of one semester, with their course, instructor and how many learners are enrolled. The instructor's name comes from
 * the staff list; a person who may not read it (a teacher holding only the Academics area) gets `null` names, and the screen still
 * shows who the instructor is by id.
 */
export async function apiFetchCourseSections(tenantId: string, semesterId: string): Promise<CourseSectionRow[]> {
  const [sections, courses, enrolments, staffNames] = await Promise.all([listSections(tenantId), listCourses(tenantId), listEnrolments(tenantId), apiStaffNames(tenantId)]);
  const courseById = new Map(courses.map((c) => [c.id, c]));
  const enrolled = new Map<string, number>();
  for (const e of enrolments) if (e.status === "enrolled") enrolled.set(e.section_id, (enrolled.get(e.section_id) ?? 0) + 1);
  return sections
    .filter((s) => s.term_id === semesterId)
    .map((s) => ({
      ...sectionFromApi(s, tenantId),
      course_code: courseById.get(s.course_id)?.code ?? "",
      course_name: courseById.get(s.course_id)?.title ?? "",
      instructor_name: (s.instructor_staff_id && staffNames.get(s.instructor_staff_id)) || null,
      enrolled_count: enrolled.get(s.id) ?? 0,
    }))
    .sort((a, b) => a.section_label.localeCompare(b.section_label) || a.course_code.localeCompare(b.course_code));
}

/**
 * The sections the signed-in person instructs, across semesters, with course, semester and how many learners are enrolled now
 * (`GET /me/teaching/he-sections`: the API decides "mine" from the person's own staff record). The API answers for the signed-in
 * person only, so asking for someone else's sections is not on the API. A section's room and capacity do not exist there.
 */
export async function apiFetchInstructorSections(tenantId: string, instructorUserId: string): Promise<InstructorSectionRow[]> {
  const me = apiClient().store.get()?.userId;
  if (me && instructorUserId !== me) throw new NotOnApiError("Another person's sections");
  const [rows, staffId] = await Promise.all([
    listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/me/teaching/he-sections", { path: { tenantId }, query: { limit: API_PAGE_LIMIT, cursor }, tenantId });
      return { items: r.sections, page: r.page };
    }),
    apiMyStaffId(tenantId),
  ]);
  return rows.map((s) => ({
    id: s.id, tenant_id: tenantId, course_id: s.course_id, semester_id: s.term_id, section_label: s.label,
    instructor_id: staffId, room: null, capacity: null,
    course_code: s.course_code, course_name: s.course_title, semester_name: s.term_label, enrolled_count: s.enrolled_count,
  }));
}

export async function apiCreateCourseSection(input: Omit<CourseSection, "id">): Promise<CourseSection> {
  if (input.room) throw new NotOnApiError("A section's room");
  if (input.capacity != null) throw new NotOnApiError("A section's capacity");
  const tid = tenantIdOrThrow(input.tenant_id);
  const made = await apiClient().post("/v1/tenants/{tenantId}/he-sections", {
    path: { tenantId: tid }, tenantId: tid,
    body: { course_id: input.course_id, term_id: input.semester_id, label: input.section_label, ...(input.instructor_id ? { instructor_staff_id: input.instructor_id } : {}) },
  });
  return sectionFromApi(made.section, tid);
}

/** Names the instructor of a section (a staff id), or takes the instructor off (`null`). */
export async function apiAssignSectionInstructor(sectionId: string, instructorStaffId: string | null, tenantId?: string): Promise<void> {
  const tid = tenantIdOrThrow(tenantId);
  await apiClient().patch("/v1/tenants/{tenantId}/he-sections/{sectionId}", {
    path: { tenantId: tid, sectionId }, tenantId: tid, body: { instructor_staff_id: instructorStaffId },
  });
}

/** The school's teachers as instructor choices (id = staff id), by name. Empty for a person who may not read the staff list. */
export function apiFetchSchoolTeacherOptions(tenantId: string): Promise<{ id: string; full_name: string }[]> {
  return listTeachers(tenantId);
}

// ---------------------------------------------------------------- enrolments

/**
 * A section's roster, for two kinds of reader. A person who may read the school's enrolments (the Academics area, an administrator)
 * gets everyone ever enrolled, oldest first, named from the learner list ("withdrawn" is the screens' "dropped"). Anyone else (a
 * lecturer) gets the learners enrolled now in a section they instruct, by name, from `/me/teaching`: that read says "not found" for
 * any other section. The choice is made from the person's permissions, so a lecturer's page never makes a request that is refused.
 */
export async function apiFetchEnrollmentsForSection(sectionId: string, tenantId?: string): Promise<EnrolledStudentRow[]> {
  const tid = tenantIdOrThrow(tenantId);
  if (!(await permissionCodes(tid)).includes("resource.academics.read")) return instructorRoster(tid, sectionId);
  const [enrolments, learners] = await Promise.all([
    listEnrolments(tid, sectionId),
    listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/learners", { path: { tenantId: tid }, query: { limit: API_PAGE_LIMIT, cursor }, tenantId: tid });
      return { items: r.learners, page: r.page };
    }),
  ]);
  const learnerById = new Map(learners.map((l) => [l.id, l]));
  return [...enrolments]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((e) => ({
      enrollment_id: e.id,
      student_id: e.learner_id,
      full_name: learnerById.get(e.learner_id)?.full_name ?? "Unknown learner",
      admission_no: learnerById.get(e.learner_id)?.admission_no ?? "",
      status: e.status === "enrolled" ? "enrolled" : "dropped",
    }));
}

/** The learners enrolled now in a section the signed-in person instructs (name and admission number only). */
async function instructorRoster(tenantId: string, sectionId: string): Promise<EnrolledStudentRow[]> {
  const rows = await listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/me/teaching/he-sections/{sectionId}/enrolments", { path: { tenantId, sectionId }, query: { limit: API_PAGE_LIMIT, cursor }, tenantId });
    return { items: r.enrolments, page: r.page };
  });
  return rows.map((e) => ({ enrollment_id: e.id, student_id: e.learner_id, full_name: e.full_name, admission_no: e.admission_no, status: "enrolled" as const }));
}

/**
 * The API has no batch, so the learners go in one at a time, four at once. A learner the API refuses (already in the section, no
 * longer active) does not stop the rest; if any were refused the error says how many went in and why the first was refused.
 */
export async function apiEnrollStudents(tenantId: string, sectionId: string, studentIds: string[]): Promise<void> {
  if (!studentIds.length) return;
  const settled = await settlePool(studentIds, 4, async (learnerId) => {
    await apiClient().post("/v1/tenants/{tenantId}/he-enrolments", {
      path: { tenantId }, tenantId, body: { section_id: sectionId, learner_id: learnerId },
    });
  });
  const failed = settled.filter((s): s is { ok: false; error: unknown } => !s.ok);
  if (!failed.length) return;
  const done = studentIds.length - failed.length;
  throw new Error(`${done} of ${studentIds.length} learner${studentIds.length === 1 ? " was" : "s were"} enrolled. The rest were refused: ${userMessage(failed[0]!.error)}`);
}

/** Active learners (id, name, admission number) by name, for the roster's "Add students" list. */
export async function apiFetchActiveLearnerOptions(tenantId: string): Promise<ActiveLearnerOption[]> {
  const learners = await listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/learners", { path: { tenantId }, query: { active: true, limit: API_PAGE_LIMIT, cursor }, tenantId });
    return { items: r.learners, page: r.page };
  });
  return learners.map((l) => ({ id: l.id, full_name: l.full_name, admission_no: l.admission_no })).sort((a, b) => a.full_name.localeCompare(b.full_name));
}
