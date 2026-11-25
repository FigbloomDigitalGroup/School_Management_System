import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSchoolTeacherOptions } from "../adminAreas";
import { initBackend } from "../backend";
import { coursesCapabilities, isNotOnApiError } from "../capabilities";
import {
  assignSectionInstructor, createCourse, createCourseSection, createSemester, enrollStudents, fetchCourseSections, fetchCourses,
  fetchEnrollmentsForSection, fetchInstructorSections, fetchSectionTimetableSlots, fetchSemesters, saveSectionTimetable, setCurrentSemester,
  setEnrollmentStatus,
} from "../courses";
import { fetchActiveLearnerOptions } from "../learners";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { isApiError } from "./errors";
import { clearTeachingLookups } from "./teachingLookups";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const P = `/v1/tenants/${T}`;
const Y25 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const Y26 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const TERM1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const TERM2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const TERM3 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
const CS201 = "c5c5c5c5-c5c5-4c5c-8c5c-c5c5c5c5c5c1";
const CS101 = "c5c5c5c5-c5c5-4c5c-8c5c-c5c5c5c5c5c2";
const SEC_A = "e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e1";
const SEC_B = "e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e2";
const SEC_OLD = "e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e3";
const L1 = "10000001-1111-4111-8111-111111111111";
const L2 = "10000002-1111-4111-8111-111111111111";
const L3 = "10000003-1111-4111-8111-111111111111";
const ST1 = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a51";
const ST2 = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a52";
const stamp = { created_at: "2026-05-01T08:00:00Z", updated_at: "2026-05-01T08:00:00Z" };

const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const list = (key: string, items: unknown[]): FakeReply => ({ body: { [key]: items, page: page() } });
const refused = (code: string, status: number, message = "no"): FakeReply => ({ status, body: { error: { code, message } } });
const year = (id: string, label: string, isCurrent = false) => ({ id, tenantId: T, label, starts_on: `${label}-01-01`, ends_on: `${label}-12-31`, is_current: isCurrent, ...stamp });
const term = (id: string, yearId: string, index: number, label: string, isCurrent = false) => ({
  id, tenantId: T, academic_year_id: yearId, index, label, starts_on: "2026-01-05", ends_on: "2026-04-03", is_current: isCurrent, ...stamp,
});
const course = (id: string, code: string, title: string, hours = "3") => ({ id, tenantId: T, code, title, credit_hours: hours, created_at: stamp.created_at });
const section = (id: string, courseId: string, termId: string, label: string, instructor: string | null = null) => ({
  id, tenantId: T, course_id: courseId, term_id: termId, label, instructor_staff_id: instructor, created_at: stamp.created_at,
});
const staffRecord = (id: string, name: string, classification = "teacher") => ({ id, tenantId: T, full_name: name, classification, active: true, user_id: null, ...stamp });
/** One of the lecturer's own sections, as `GET /me/teaching/he-sections` returns it. */
const mine = (id: string, courseId: string, code: string, title: string, termId: string, termLabel: string, label: string, enrolled: number) => ({
  id, course_id: courseId, course_code: code, course_title: title, term_id: termId, term_label: termLabel, label, enrolled_count: enrolled,
});
/** What `GET /v1/rbac/permissions` answers. */
const permissions = (...codes: string[]): FakeReply => ({ body: { items: codes, page: page() } });
const ADMIN_CODES = ["resource.academics.read", "resource.academics.write", "resource.teaching.read"];
const LECTURER_CODES = ["resource.teaching.read", "rbac.permissions.read"];
const enrolment = (id: string, sectionId: string, learnerId: string, status: "enrolled" | "withdrawn", at: string) => ({
  id, tenantId: T, section_id: sectionId, learner_id: learnerId, status, created_at: at,
});
const learner = (id: string, name: string, adm: string, active = true) => ({
  id, tenantId: T, admission_no: adm, full_name: name, gender: "female", boarding: false, date_of_birth: "2001-01-01", active, archived_at: null, ...stamp,
});

let api: FakeApi;
function boot(routes: Record<string, FakeRoute>) {
  clearTeachingLookups(); // the staff list and the person's own staff id are kept for a few seconds
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: "u1" }));
  setApiActiveTenant(T);
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

describe("semesters are academic terms", () => {
  const years = list("academic_years", [year(Y25, "2025"), year(Y26, "2026", true)]);

  it("lists the terms as semesters, newest first (later year, then later term)", async () => {
    boot({
      [`GET ${P}/academic-years`]: years,
      [`GET ${P}/academic-terms`]: list("terms", [term(TERM1, Y25, 3, "Term 3, 2025"), term(TERM2, Y26, 1, "Semester 1, 2026", true), term(TERM3, Y26, 2, "Semester 2, 2026")]),
    });
    const sems = await fetchSemesters(T);

    expect(sems.map((s) => [s.name, s.year, s.index, s.is_current])).toEqual([
      ["Semester 2, 2026", 2026, 2, false], ["Semester 1, 2026", 2026, 1, true], ["Term 3, 2025", 2025, 3, false],
    ]);
  });

  it("makes a semester in the year that exists, without making another year", async () => {
    boot({
      [`GET ${P}/academic-years`]: years,
      [`POST ${P}/academic-terms`]: { status: 201, body: { term: term(TERM3, Y26, 2, "Semester 2, 2026") } },
    });
    const made = await createSemester({ tenant_id: T, name: "Semester 2, 2026", year: 2026, index: 2, starts_on: "2026-05-04", ends_on: "2026-08-28", is_current: false });

    expect(api.callsTo(`POST ${P}/academic-years`)).toHaveLength(0);
    expect(api.callsTo(`POST ${P}/academic-terms`)[0]?.body).toEqual({ academic_year_id: Y26, index: 2, label: "Semester 2, 2026", starts_on: "2026-05-04", ends_on: "2026-08-28" });
    expect(made).toMatchObject({ id: TERM3, name: "Semester 2, 2026", year: 2026, index: 2 });
  });

  it("makes the calendar year first when the school has none for it", async () => {
    boot({
      [`GET ${P}/academic-years`]: years,
      [`POST ${P}/academic-years`]: { status: 201, body: { academic_year: year("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7", "2027") } },
      [`POST ${P}/academic-terms`]: { status: 201, body: { term: term(TERM3, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7", 1, "Semester 1, 2027") } },
    });
    await createSemester({ tenant_id: T, name: "Semester 1, 2027", year: 2027, index: 1, starts_on: "2027-01-04", ends_on: "2027-04-30", is_current: false });

    expect(api.callsTo(`POST ${P}/academic-years`)[0]?.body).toEqual({ label: "2027", starts_on: "2027-01-01", ends_on: "2027-12-31" });
    expect((api.callsTo(`POST ${P}/academic-terms`)[0]?.body as { academic_year_id: string }).academic_year_id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7");
  });

  it("makes a semester current together with its year, and only calls the year when it is not current already", async () => {
    boot({
      [`GET ${P}/academic-years`]: years,
      [`GET ${P}/academic-terms`]: list("terms", [term(TERM1, Y25, 3, "Term 3, 2025"), term(TERM2, Y26, 1, "Semester 1, 2026", true)]),
      [`POST ${P}/academic-years/${Y25}/set-current`]: { body: { academic_year: year(Y25, "2025", true) } },
      [`POST ${P}/academic-terms/${TERM1}/set-current`]: { body: { term: term(TERM1, Y25, 3, "Term 3, 2025", true) } },
      [`POST ${P}/academic-terms/${TERM2}/set-current`]: { body: { term: term(TERM2, Y26, 1, "Semester 1, 2026", true) } },
    });
    await setCurrentSemester(T, TERM1);
    expect(api.callsTo(`POST ${P}/academic-years/${Y25}/set-current`)).toHaveLength(1);
    expect(api.callsTo(`POST ${P}/academic-terms/${TERM1}/set-current`)).toHaveLength(1);

    await setCurrentSemester(T, TERM2);
    expect(api.callsTo(`POST ${P}/academic-years/${Y26}/set-current`)).toHaveLength(0);
    expect(api.callsTo(`POST ${P}/academic-terms/${TERM2}/set-current`)).toHaveLength(1);
  });

  it("says so when the semester is not in the school", async () => {
    boot({ [`GET ${P}/academic-years`]: years, [`GET ${P}/academic-terms`]: list("terms", []) });
    await expect(setCurrentSemester(T, TERM1)).rejects.toThrow(/not found/);
  });
});

describe("courses", () => {
  it("lists courses by code with the API's title as the name and credit hours as a number; no department", async () => {
    boot({ [`GET ${P}/he-courses`]: list("courses", [course(CS201, "CS201", "Data Structures", "4.5"), course(CS101, "CS101", "Programming")]) });
    expect(await fetchCourses(T)).toEqual([
      { id: CS101, tenant_id: T, code: "CS101", name: "Programming", credits: 3, department: null },
      { id: CS201, tenant_id: T, code: "CS201", name: "Data Structures", credits: 4.5, department: null },
    ]);
  });

  it("makes a course from a code, a name and credits", async () => {
    boot({ [`POST ${P}/he-courses`]: { status: 201, body: { course: course(CS201, "CS201", "Data Structures", "4") } } });
    const made = await createCourse({ tenant_id: T, code: "CS201", name: "Data Structures", credits: 4, department: null });

    expect(api.callsTo(`POST ${P}/he-courses`)[0]?.body).toEqual({ code: "CS201", title: "Data Structures", credit_hours: 4 });
    expect(made).toMatchObject({ id: CS201, name: "Data Structures", credits: 4 });
  });

  it("refuses a department (the API's course has none) before calling anything", async () => {
    boot({});
    const err = await createCourse({ tenant_id: T, code: "CS201", name: "Data Structures", credits: 4, department: "Computer Science" }).catch((e) => e);
    expect(isNotOnApiError(err)).toBe(true);
    expect(api.calls).toHaveLength(0);
  });

  it("passes on a refusal because the school is not a higher-education school", async () => {
    boot({ [`GET ${P}/he-courses`]: refused("validation_error", 400, "Higher-education records require school profile institution_type higher_ed") });
    const err = await fetchCourses(T).catch((e) => e);
    expect(isApiError(err) && err.status === 400).toBe(true);
  });
});

describe("sections", () => {
  const routes = (): Record<string, FakeRoute> => ({
    [`GET ${P}/he-sections`]: list("sections", [section(SEC_B, CS101, TERM2, "B"), section(SEC_A, CS201, TERM2, "A", ST1), section(SEC_OLD, CS201, TERM1, "A")]),
    [`GET ${P}/he-courses`]: list("courses", [course(CS201, "CS201", "Data Structures"), course(CS101, "CS101", "Programming")]),
    [`GET ${P}/staff`]: list("staff", [staffRecord(ST1, "Dr Okello"), staffRecord(ST2, "Dr Wanjiru")]),
    [`GET ${P}/he-enrolments`]: list("enrolments", [
      enrolment("n1", SEC_A, L1, "enrolled", "2026-05-02T08:00:00Z"), enrolment("n2", SEC_A, L2, "enrolled", "2026-05-03T08:00:00Z"),
      enrolment("n3", SEC_A, L3, "withdrawn", "2026-05-04T08:00:00Z"), enrolment("n4", SEC_OLD, L1, "enrolled", "2026-01-04T08:00:00Z"),
    ]),
  });

  it("lists one semester's sections with their course and the learners ENROLLED (a withdrawn learner is not counted)", async () => {
    boot(routes());
    const rows = await fetchCourseSections(T, TERM2);

    expect(rows.map((r) => [r.section_label, r.course_code, r.course_name, r.enrolled_count, r.semester_id])).toEqual([
      ["A", "CS201", "Data Structures", 2, TERM2], ["B", "CS101", "Programming", 0, TERM2],
    ]);
    // The instructor is a staff record, named from the staff list; a section with none says so. Room and capacity do not exist on the API.
    expect(rows[0]).toMatchObject({ instructor_id: ST1, instructor_name: "Dr Okello", room: null, capacity: null });
    expect(rows[1]).toMatchObject({ instructor_id: null, instructor_name: null, room: null, capacity: null });
  });

  it("still lists the sections, with the instructor's id but no name, for a reader who may not read the staff list", async () => {
    boot({ ...routes(), [`GET ${P}/staff`]: refused("forbidden", 403) });
    const rows = await fetchCourseSections(T, TERM2);
    expect(rows[0]).toMatchObject({ section_label: "A", instructor_id: ST1, instructor_name: null });
  });

  it("makes a section of a course in a semester, with no instructor unless one is chosen", async () => {
    boot({ [`POST ${P}/he-sections`]: { status: 201, body: { section: section(SEC_A, CS201, TERM2, "A") } } });
    const made = await createCourseSection({ tenant_id: T, semester_id: TERM2, course_id: CS201, section_label: "A", instructor_id: null, room: null, capacity: null });

    expect(api.callsTo(`POST ${P}/he-sections`)[0]?.body).toEqual({ course_id: CS201, term_id: TERM2, label: "A" });
    expect(made).toMatchObject({ id: SEC_A, section_label: "A", semester_id: TERM2, instructor_id: null });
  });

  it("makes a section with its instructor (a staff id) in the same call", async () => {
    boot({ [`POST ${P}/he-sections`]: { status: 201, body: { section: section(SEC_A, CS201, TERM2, "A", ST1) } } });
    const made = await createCourseSection({ tenant_id: T, semester_id: TERM2, course_id: CS201, section_label: "A", instructor_id: ST1, room: null, capacity: null });

    expect(api.callsTo(`POST ${P}/he-sections`)[0]?.body).toEqual({ course_id: CS201, term_id: TERM2, label: "A", instructor_staff_id: ST1 });
    expect(made.instructor_id).toBe(ST1);
  });

  it("refuses a room or a capacity (the API's section has none) before calling anything", async () => {
    boot({});
    const base = { tenant_id: T, semester_id: TERM2, course_id: CS201, section_label: "A", instructor_id: null, room: null, capacity: null };
    for (const extra of [{ room: "LH 3" }, { capacity: 40 }]) {
      expect(isNotOnApiError(await createCourseSection({ ...base, ...extra }).catch((e) => e))).toBe(true);
    }
    expect(api.calls).toHaveLength(0);
  });

  it("names, changes and clears a section's instructor with one PATCH each, and passes a refusal on", async () => {
    boot({ [`PATCH ${P}/he-sections/${SEC_A}`]: (call) => ((call.body as { instructor_staff_id: string | null }).instructor_staff_id === "bad"
      ? refused("validation_error", 400, "instructor_staff_id must be an active staff member in this school")
      : { body: { section: section(SEC_A, CS201, TERM2, "A") } }) });
    await assignSectionInstructor(SEC_A, ST1);
    await assignSectionInstructor(SEC_A, null);
    expect(api.callsTo(`PATCH ${P}/he-sections/${SEC_A}`).map((c) => c.body)).toEqual([{ instructor_staff_id: ST1 }, { instructor_staff_id: null }]);

    const err = await assignSectionInstructor(SEC_A, "bad").catch((e) => e);
    expect(isApiError(err) && err.status === 400).toBe(true);
  });

  it("lists the school's teachers as instructor choices: active staff classed as teachers, by name, with their STAFF id", async () => {
    boot({ [`GET ${P}/staff`]: list("staff", [staffRecord(ST2, "Dr Wanjiru"), staffRecord("5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a53", "Mr Librarian", "non_teaching"), staffRecord(ST1, "Dr Okello")]) });
    expect(await fetchSchoolTeacherOptions(T)).toEqual([{ id: ST1, full_name: "Dr Okello" }, { id: ST2, full_name: "Dr Wanjiru" }]);
    expect(api.callsTo(`GET ${P}/staff`)[0]?.query.get("active")).toBe("true");
  });

  it("gives no choices, rather than failing, to a reader who may not read the staff list", async () => {
    boot({ [`GET ${P}/staff`]: refused("forbidden", 403) });
    expect(await fetchSchoolTeacherOptions(T)).toEqual([]);
  });
});

describe("My sections (a lecturer's own)", () => {
  const myRoutes = (): Record<string, FakeRoute> => ({
    [`GET ${P}/me/teaching/he-sections`]: list("sections", [
      mine(SEC_A, CS201, "CS201", "Data Structures", TERM2, "Semester 2, 2026", "A", 2),
      mine(SEC_OLD, CS201, "CS201", "Data Structures", TERM1, "Semester 1, 2026", "A", 31),
    ]),
    [`GET ${P}/staff/me`]: { body: { staff: staffRecord(ST1, "Dr Okello") } },
  });

  it("reads the sections the API says are the person's, with course, semester and the learners enrolled now; no room or capacity", async () => {
    boot(myRoutes());
    const rows = await fetchInstructorSections(T, "u1");

    expect(rows).toEqual([
      { id: SEC_A, tenant_id: T, course_id: CS201, semester_id: TERM2, section_label: "A", instructor_id: ST1, room: null, capacity: null,
        course_code: "CS201", course_name: "Data Structures", semester_name: "Semester 2, 2026", enrolled_count: 2 },
      { id: SEC_OLD, tenant_id: T, course_id: CS201, semester_id: TERM1, section_label: "A", instructor_id: ST1, room: null, capacity: null,
        course_code: "CS201", course_name: "Data Structures", semester_name: "Semester 1, 2026", enrolled_count: 31 },
    ]);
    // "mine" is decided by the server: nothing school-wide is read.
    expect(api.calls.map((c) => c.path).sort()).toEqual([`${P}/me/teaching/he-sections`, `${P}/staff/me`]);
  });

  it("follows the pages of the list", async () => {
    boot({
      ...myRoutes(),
      [`GET ${P}/me/teaching/he-sections`]: (call) => (call.query.get("cursor") === "c2"
        ? list("sections", [mine(SEC_OLD, CS201, "CS201", "Data Structures", TERM1, "Semester 1, 2026", "A", 31)])
        : { body: { sections: [mine(SEC_A, CS201, "CS201", "Data Structures", TERM2, "Semester 2, 2026", "A", 2)], page: page("c2") } }),
    });
    expect((await fetchInstructorSections(T, "u1")).map((r) => r.id)).toEqual([SEC_A, SEC_OLD]);
  });

  it("is an empty list for a person who instructs nothing or has no staff record (not an error)", async () => {
    boot({ [`GET ${P}/me/teaching/he-sections`]: list("sections", []), [`GET ${P}/staff/me`]: refused("not_found", 404, "No staff record is linked to this account in this school") });
    expect(await fetchInstructorSections(T, "u1")).toEqual([]);
  });

  it("cannot answer for another person: the API reads only the signed-in person's sections", async () => {
    boot(myRoutes());
    const err = await fetchInstructorSections(T, "someone-else").catch((e) => e);
    expect(isNotOnApiError(err)).toBe(true);
    expect(api.calls).toHaveLength(0);
  });

  it("passes on a refusal because the school is not a higher-education school", async () => {
    boot({ ...myRoutes(), [`GET ${P}/me/teaching/he-sections`]: refused("validation_error", 400, "Higher-education records require school profile institution_type higher_ed") });
    const err = await fetchInstructorSections(T, "u1").catch((e) => e);
    expect(isApiError(err) && err.status === 400).toBe(true);
  });

  it("the API build offers the instructor controls and My sections, and still hides room, capacity, schedule, dropping and a department", () => {
    initBackend({ kind: "api", apiUrl: BASE });
    expect(coursesCapabilities()).toEqual({
      courseDepartment: false, sectionInstructor: true, sectionRoomAndCapacity: false, sectionSchedule: false, dropEnrolment: false, mySections: true,
    });
    initBackend({ kind: "supabase" });
    expect(Object.values(coursesCapabilities()).every(Boolean)).toBe(true);
  });
});

describe("enrolments", () => {
  it("lists a section's enrolments (asking the API for that section only) oldest first, named from the learner list; withdrawn reads as dropped", async () => {
    boot({
      "GET /v1/rbac/permissions": permissions(...ADMIN_CODES),
      [`GET ${P}/he-enrolments`]: list("enrolments", [
        enrolment("n2", SEC_A, L2, "enrolled", "2026-05-03T08:00:00Z"), enrolment("n3", SEC_A, L3, "withdrawn", "2026-05-04T08:00:00Z"),
        enrolment("n1", SEC_A, L1, "enrolled", "2026-05-02T08:00:00Z"),
      ]),
      [`GET ${P}/learners`]: list("learners", [learner(L1, "Amina Ochieng", "ADM-1"), learner(L2, "Brian Kamau", "ADM-2")]),
    });
    const rows = await fetchEnrollmentsForSection(SEC_A);

    expect(api.callsTo(`GET ${P}/he-enrolments`)[0]?.query.get("sectionId")).toBe(SEC_A);
    expect(rows.map((r) => [r.enrollment_id, r.full_name, r.admission_no, r.status])).toEqual([
      ["n1", "Amina Ochieng", "ADM-1", "enrolled"], ["n2", "Brian Kamau", "ADM-2", "enrolled"], ["n3", "Unknown learner", "", "dropped"],
    ]);
    expect(api.callsTo(`GET ${P}/me/teaching/he-sections/${SEC_A}/enrolments`)).toHaveLength(0);
  });

  it("gives a lecturer (no Academics read) the roster of their own section from /me/teaching: enrolled learners by name, nothing school-wide", async () => {
    boot({
      "GET /v1/rbac/permissions": permissions(...LECTURER_CODES),
      [`GET ${P}/me/teaching/he-sections/${SEC_A}/enrolments`]: list("enrolments", [
        { id: "n1", learner_id: L1, full_name: "Amina Ochieng", admission_no: "ADM-1" },
        { id: "n2", learner_id: L2, full_name: "Brian Kamau", admission_no: "ADM-2" },
      ]),
    });
    const rows = await fetchEnrollmentsForSection(SEC_A);

    expect(rows).toEqual([
      { enrollment_id: "n1", student_id: L1, full_name: "Amina Ochieng", admission_no: "ADM-1", status: "enrolled" },
      { enrollment_id: "n2", student_id: L2, full_name: "Brian Kamau", admission_no: "ADM-2", status: "enrolled" },
    ]);
    // No request that a lecturer would be refused.
    expect(api.calls.map((c) => c.path).sort()).toEqual(["/v1/rbac/permissions", `${P}/me/teaching/he-sections/${SEC_A}/enrolments`]);
  });

  it("says 'not found' for a section that is not the lecturer's (the API's 404 is passed on, not turned into an empty roster)", async () => {
    boot({
      "GET /v1/rbac/permissions": permissions(...LECTURER_CODES),
      [`GET ${P}/me/teaching/he-sections/${SEC_B}/enrolments`]: refused("not_found", 404, "Section not found"),
    });
    const err = await fetchEnrollmentsForSection(SEC_B).catch((e) => e);
    expect(isApiError(err) && err.status === 404).toBe(true);
  });

  it("enrols each learner with its own call and does nothing for an empty list", async () => {
    boot({ [`POST ${P}/he-enrolments`]: { status: 201, body: { enrolment: enrolment("n9", SEC_A, L1, "enrolled", stamp.created_at) } } });
    await enrollStudents(T, SEC_A, []);
    expect(api.calls).toHaveLength(0);

    await enrollStudents(T, SEC_A, [L1, L2, L3]);
    expect(api.callsTo(`POST ${P}/he-enrolments`).map((c) => c.body)).toEqual([
      { section_id: SEC_A, learner_id: L1 }, { section_id: SEC_A, learner_id: L2 }, { section_id: SEC_A, learner_id: L3 },
    ]);
  });

  it("keeps going when one learner is refused, then says how many went in and why", async () => {
    boot({
      [`POST ${P}/he-enrolments`]: (call) => ((call.body as { learner_id: string }).learner_id === L2
        ? refused("conflict", 409, "Learner is already enrolled in this section")
        : { status: 201, body: { enrolment: enrolment("n9", SEC_A, L1, "enrolled", stamp.created_at) } }),
    });
    const err = (await enrollStudents(T, SEC_A, [L1, L2, L3]).then(() => null, (e: unknown) => e)) as Error;

    expect(api.callsTo(`POST ${P}/he-enrolments`)).toHaveLength(3);
    expect(err.message).toMatch(/^2 of 3 learners were enrolled\. The rest were refused: /);
    expect(err.message).toContain("already enrolled");
  });

  it("lists active learners by name for the roster's picker", async () => {
    boot({ [`GET ${P}/learners`]: list("learners", [learner(L2, "Brian Kamau", "ADM-2"), learner(L1, "Amina Ochieng", "ADM-1")]) });
    expect(await fetchActiveLearnerOptions(T)).toEqual([
      { id: L1, full_name: "Amina Ochieng", admission_no: "ADM-1" }, { id: L2, full_name: "Brian Kamau", admission_no: "ADM-2" },
    ]);
    expect(api.callsTo(`GET ${P}/learners`)[0]?.query.get("active")).toBe("true");
  });
});

describe("what the API cannot do", () => {
  it("throws NotOnApiError, without calling anything, for dropping a student and a schedule", async () => {
    boot({});
    const attempts = [
      setEnrollmentStatus("n1", "dropped"),
      fetchSectionTimetableSlots(SEC_A),
      saveSectionTimetable(T, SEC_A, []),
    ];
    for (const a of attempts) expect(isNotOnApiError(await a.catch((e) => e))).toBe(true);
    expect(api.calls).toHaveLength(0);
  });
});
