import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { isNotOnApiError, setupCapabilities } from "../capabilities";
import {
  createClass, createClasses, createSubject, createSubjects, deleteClass, fetchClassSubjects, fetchClassesOverview, fetchLatestExamMeans, fetchSubjects, fetchTermSetup,
  markLearnersLeft, moveLearnersToClass, fetchPromotionRoster, saveSchoolAccent, saveSchoolDetails, saveSchoolLogo, saveSchoolPaymentMethods, setClassRoom, setClassSubjectTeacher, setClassTeacher, startTerm,
  updateSubject,
} from "../schoolSetup";
import { BASE, createFakeApi, type FakeApi, type FakeCall, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { userMessage } from "./errors";
import { forgetApiSchools } from "./sessionApi";
import { classGroupFromApi, subjectFromApi, termFromApi, yearNumberOf } from "./setupApi";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const YEAR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OLD_YEAR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const C2 = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";
const S1 = "51515151-5151-4515-8515-515151515151";
const S2 = "52525252-5252-4525-8525-525252525252";
const TEACHER = "7e7e7e7e-7e7e-47e7-87e7-7e7e7e7e7e7e";
const TEACHER2 = "7f7f7f7f-7f7f-47f7-87f7-7f7f7f7f7f7f";

const stamp = { created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
const year = (o: Record<string, unknown> = {}) => ({ id: YEAR, tenantId: T, label: "2026", starts_on: "2026-01-01", ends_on: "2026-12-31", is_current: true, ...stamp, ...o });
const term = (o: Record<string, unknown> = {}) => ({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", tenantId: T, academic_year_id: YEAR, index: 2, label: "Term 2, 2026", starts_on: "2026-05-01", ends_on: "2026-08-01", is_current: true, ...stamp, ...o });
const klass = (o: Record<string, unknown> = {}) => ({ id: C1, tenantId: T, academic_year_id: YEAR, name: "Form 2 West", form_level: 2, education_level: "secondary", pathway: null, stream: "West", class_teacher_staff_id: TEACHER, room: null, active: true, archived_at: null, ...stamp, ...o });
const subject = (o: Record<string, unknown> = {}) => ({ id: S1, tenantId: T, code: "ENG", name: "English", education_level: null, min_form_level: null, max_form_level: null, is_core: true, active: true, archived_at: null, ...stamp, ...o });
const staff = (o: Record<string, unknown> = {}) => ({ id: TEACHER, tenantId: T, full_name: "Tabitha Teacher", staff_title: null, classification: "teacher", phone: null, email: null, userId: null, active: true, archived_at: null, ...stamp, ...o });
const assignment = (o: Record<string, unknown> = {}) => ({ id: "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0", tenantId: T, staff_member_id: TEACHER, class_id: C1, subject_id: S1, active: true, archived_at: null, ...stamp, ...o });
const membership = (classId: string, n: number) => ({ id: `m-${classId}-${n}`, tenantId: T, learner_id: `l-${n}`, class_id: classId, academic_year_id: YEAR, active: true, archived_at: null, ...stamp });
const learner = (n: number) => ({ id: `l-${n}`, tenantId: T, admission_no: String(1000 + n), full_name: `Learner ${n}`, gender: "female", boarding: false, date_of_birth: null, active: true, archived_at: null, ...stamp });
const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const list = (key: string, items: unknown[], next: string | null = null): FakeReply => ({ body: { [key]: items, page: page(next) } });

let api: FakeApi;

function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  forgetApiSchools();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: "u" }));
  // Writes that name no school (a class's teacher, a subject's details) go to the school the tab is in.
  setApiActiveTenant(T);
  return api;
}

afterEach(() => { vi.unstubAllGlobals(); resetApiClient(); initBackend({ kind: "supabase" }); });

const P = `/v1/tenants/${T}`;
const refused = (code: string, status: number, message = "no") => ({ status, body: { error: { code, message } } });

describe("mapping", () => {
  it("shapes a class, reading a missing level as 8-4-4 and a missing year as the level's first", () => {
    expect(classGroupFromApi(klass() as never, T)).toEqual({ id: C1, tenant_id: T, name: "Form 2 West", level: "secondary", form_level: 2, pathway: null, stream: "West", class_teacher_id: TEACHER, room: null });
    expect(classGroupFromApi(klass({ education_level: null, form_level: null }) as never, T)).toMatchObject({ level: "secondary", form_level: 1 });
    expect(classGroupFromApi(klass({ education_level: "junior_secondary", form_level: null }) as never, T)).toMatchObject({ level: "junior_secondary", form_level: 7 });
  });

  it("carries a class's room, and none when it has none", () => {
    expect(classGroupFromApi(klass({ room: "Block C-2" }) as never, T).room).toBe("Block C-2");
    expect(classGroupFromApi(klass({ room: null }) as never, T).room).toBeNull();
    // A class read from an older answer that has no room at all is read as having none.
    const { room: _room, ...older } = klass();
    expect(classGroupFromApi(older as never, T).room).toBeNull();
  });

  it("shapes a term, naming its year by the calendar year it starts in", () => {
    const t = termFromApi(term() as never, year() as never, T);
    expect(t).toMatchObject({ name: "Term 2, 2026", year: 2026, index: 2, is_current: true, starts_on: "2026-05-01" });
    expect(termFromApi(term({ index: 4 }) as never, undefined, T).index).toBe(3);
    expect(yearNumberOf({ starts_on: "2026-09-01", label: "2026/27" })).toBe(2026);
    // The date decides; the label is only a fallback for a date that cannot be read.
    expect(yearNumberOf({ starts_on: "2026-09-01", label: "Academic 2027" })).toBe(2026);
    expect(yearNumberOf({ starts_on: "unknown", label: "FY 2027" })).toBe(2027);
    expect(yearNumberOf({ starts_on: "unknown", label: "no year" })).toBe(new Date().getFullYear());
  });

  it("shapes a subject with its level, year range and core flag", () => {
    expect(subjectFromApi(subject() as never, T)).toEqual({
      id: S1, tenant_id: T, name: "English", code: "ENG", is_core: true, level: null, min_form_level: null, max_form_level: null, learning_area_id: null,
    });
    expect(subjectFromApi(subject({ education_level: "junior_secondary", min_form_level: 7, max_form_level: 9, is_core: false }) as never, T)).toMatchObject({
      level: "junior_secondary", min_form_level: 7, max_form_level: 9, is_core: false, learning_area_id: null,
    });
  });
});

describe("classes", () => {
  const overview = (extra: Record<string, FakeRoute> = {}) => ({
    [`GET ${P}/academic-years`]: list("academic_years", [year(), year({ id: OLD_YEAR, label: "2025", starts_on: "2025-01-01", is_current: false })]),
    [`GET ${P}/classes`]: list("classes", [klass(), klass({ id: C2, name: "Form 1 East", form_level: 1, stream: "East", class_teacher_staff_id: null })]),
    [`GET ${P}/staff`]: list("staff", [staff({ full_name: "Zed Teacher", id: TEACHER2 }), staff(), staff({ id: "x", full_name: "Driver Dan", classification: "driver" })]),
    [`GET ${P}/subjects`]: list("subjects", [subject({ id: S2, name: "Biology", code: "BIO" }), subject(), subject({ id: "gone", name: "Old", active: false })]),
    [`GET ${P}/class-memberships`]: list("memberships", [membership(C1, 1), membership(C1, 2), membership(C2, 3), membership("some-old-class", 4)]),
    [`GET ${P}/learners`]: list("learners", [learner(1), learner(2), learner(3), learner(4)]),
    ...extra,
  });

  it("gives the current year's classes in year order, the teachers, the subjects and the counts", async () => {
    boot(overview());
    const o = await fetchClassesOverview(T);
    expect(o.classes.map((c) => c.name)).toEqual(["Form 1 East", "Form 2 West"]);
    expect(o.teachers).toEqual([{ id: TEACHER, full_name: "Tabitha Teacher" }, { id: TEACHER2, full_name: "Zed Teacher" }]);
    expect(o.subjects).toEqual([{ id: S2, name: "Biology" }, { id: S1, name: "English" }]);
    expect([...o.studentCountByClass]).toEqual([[C1, 2], [C2, 1]]);
    const q = api.callsTo(`GET ${P}/classes`)[0]!.query;
    expect(q.get("academicYearId")).toBe(YEAR);
    expect(q.get("active")).toBe("true");
  });

  it("does not count the class membership of an archived learner (the API leaves it active)", async () => {
    // Learner 2 is archived: no longer in the active list, but their membership of C1 is still active.
    boot(overview({ [`GET ${P}/learners`]: list("learners", [learner(1), learner(3), learner(4)]) }));
    const o = await fetchClassesOverview(T);
    expect([...o.studentCountByClass]).toEqual([[C1, 1], [C2, 1]]);
    expect(api.callsTo(`GET ${P}/learners`)[0]!.query.get("active")).toBe("true");
  });

  it("counts every membership, and does not fail, for a person who may not read learners", async () => {
    boot(overview({ [`GET ${P}/learners`]: refused("forbidden", 403) }));
    const o = await fetchClassesOverview(T);
    expect([...o.studentCountByClass]).toEqual([[C1, 2], [C2, 1]]);
  });

  it("fails on any other error reading learners", async () => {
    boot(overview({ [`GET ${P}/learners`]: refused("internal_error", 500) }));
    await expect(fetchClassesOverview(T)).rejects.toMatchObject({ code: "internal_error" });
  });

  it("asks for every class when no year is current yet", async () => {
    boot(overview({ [`GET ${P}/academic-years`]: list("academic_years", []) }));
    await fetchClassesOverview(T);
    expect(api.callsTo(`GET ${P}/classes`)[0]!.query.has("academicYearId")).toBe(false);
  });

  it("follows the pages of a long list", async () => {
    boot(overview({
      [`GET ${P}/classes`]: (c: FakeCall) => (c.query.get("cursor") ? list("classes", [klass({ id: C2, name: "Form 3 South", form_level: 3 })]) : list("classes", [klass()], "p2")),
    }));
    expect((await fetchClassesOverview(T)).classes).toHaveLength(2);
  });

  it("shows teachers as none, not an error, for a person who may not read the staff list", async () => {
    boot(overview({ [`GET ${P}/staff`]: refused("forbidden", 403) }));
    expect((await fetchClassesOverview(T)).teachers).toEqual([]);
  });

  it("fails on any other error", async () => {
    boot(overview({ [`GET ${P}/classes`]: refused("internal_error", 500) }));
    await expect(fetchClassesOverview(T)).rejects.toMatchObject({ code: "internal_error" });
  });

  const newClass = { name: "Form 3 North", level: "secondary" as const, formLevel: 3, pathway: null, stream: "North", room: "R4", classTeacherId: TEACHER };

  it("makes a class in the current year, with its room", async () => {
    boot({ [`GET ${P}/academic-years`]: list("academic_years", [year()]), [`POST ${P}/classes`]: { status: 201, body: { school_class: klass() } } });
    await createClass(T, newClass);
    expect(api.callsTo(`POST ${P}/classes`)[0]!.body).toEqual({
      academic_year_id: YEAR, name: "Form 3 North", form_level: 3, education_level: "secondary", pathway: null, stream: "North", class_teacher_staff_id: TEACHER, room: "R4",
    });
  });

  it("shows each class's room in the overview", async () => {
    boot(overview({ [`GET ${P}/classes`]: list("classes", [klass({ room: "Block C-2" }), klass({ id: C2, name: "Form 1 East", form_level: 1, room: null })]) }));
    expect((await fetchClassesOverview(T)).classes.map((c) => [c.name, c.room])).toEqual([["Form 1 East", null], ["Form 2 West", "Block C-2"]]);
  });

  describe("changing a class", () => {
    const patch = `PATCH ${P}/classes/${C1}`;

    it("gives a class another teacher, or takes the teacher off with null, as the school in the tab", async () => {
      boot({ [patch]: { body: { school_class: klass({ class_teacher_staff_id: TEACHER2 }) } } });
      await setClassTeacher(C1, TEACHER2);
      await setClassTeacher(C1, null);
      const [a, b] = api.callsTo(patch);
      expect(a!.body).toEqual({ class_teacher_staff_id: TEACHER2 });
      expect(b!.body).toEqual({ class_teacher_staff_id: null });
      expect(a!.headers["x-tenant-id"]).toBe(T);
    });

    it("says so, in the API's words, when the new teacher is not an active member of staff", async () => {
      boot({ [patch]: refused("validation_error", 400, "class_teacher_staff_id must be an active staff member in this school") });
      const err = await setClassTeacher(C1, TEACHER2).then(() => null, (e: unknown) => e);
      expect(err).toMatchObject({ status: 400, code: "validation_error" });
      expect(userMessage(err)).toBe("class_teacher_staff_id must be an active staff member in this school");
    });

    it("refuses a class that was archived meanwhile, in the API's words", async () => {
      boot({ [patch]: refused("validation_error", 400, "Archived classes cannot be updated") });
      expect(userMessage(await setClassTeacher(C1, TEACHER).then(() => null, (e: unknown) => e))).toBe("Archived classes cannot be updated");
    });

    it("sets a class's room, trimmed, and clears it when blank", async () => {
      boot({ [patch]: { body: { school_class: klass({ room: "Block C-2" }) } } });
      await setClassRoom(C1, "  Block C-2 ");
      await setClassRoom(C1, "   ");
      await setClassRoom(C1, null);
      expect(api.callsTo(patch).map((c) => c.body)).toEqual([{ room: "Block C-2" }, { room: null }, { room: null }]);
    });

    it("needs a school: with none in the tab it asks nothing", async () => {
      boot({ [patch]: { body: { school_class: klass() } } });
      setApiActiveTenant(null);
      await expect(setClassTeacher(C1, TEACHER)).rejects.toThrow("No active school selected.");
      expect(api.calls).toHaveLength(0);
    });
  });

  describe("archiving a class (what the screens call deleting)", () => {
    const archive = `POST ${P}/classes/${C1}/archive`;

    it("archives it: one POST to the archive route, nothing deleted", async () => {
      boot({ [archive]: { body: { school_class: klass({ active: false, archived_at: "2026-02-01T00:00:00Z" }) } } });
      await deleteClass(C1);
      expect(api.calls.map((c) => `${c.method} ${c.path.replace(P, "")}`)).toEqual([`POST /classes/${C1}/archive`]);
      expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
    });

    it("is refused with 409 while an active learner is in the class, and the person is told how many and what to do", async () => {
      boot({ [archive]: refused("conflict", 409, "The class still has 2 learners. Move them to another class first.") });
      const err = await deleteClass(C1).then(() => null, (e: unknown) => e);
      expect(err).toMatchObject({ status: 409, code: "conflict" });
      expect(userMessage(err)).toBe("The class still has 2 learners. Move them to another class first.");
    });

    it("says it plainly for a class with one learner", async () => {
      boot({ [archive]: refused("conflict", 409, "The class still has 1 learner. Move them to another class first.") });
      expect(userMessage(await deleteClass(C1).then(() => null, (e: unknown) => e))).toBe("The class still has 1 learner. Move them to another class first.");
    });

    it("answers a class that is already archived with the API's 400", async () => {
      boot({ [archive]: refused("validation_error", 400, "Class is already archived") });
      expect(userMessage(await deleteClass(C1).then(() => null, (e: unknown) => e))).toBe("Class is already archived");
    });

    it("tells a person without the Academics area why, and does not retry", async () => {
      boot({ [archive]: refused("forbidden", 403, "Missing permission: resource.academics.write") });
      const err = await deleteClass(C1).then(() => null, (e: unknown) => e);
      expect(err).toMatchObject({ status: 403 });
      expect(api.callsTo(archive)).toHaveLength(1);
    });
  });

  it("says what to do first when there is no current year", async () => {
    boot({ [`GET ${P}/academic-years`]: list("academic_years", [year({ is_current: false })]) });
    await expect(createClass(T, newClass)).rejects.toThrow(/Start a term under School settings/);
    expect(api.callsTo(`POST ${P}/classes`)).toHaveLength(0);
  });

  it("makes several one by one, and says how far it got when one is refused", async () => {
    let n = 0;
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`POST ${P}/classes`]: () => (++n === 3 ? refused("conflict", 409, "A class with that name exists") : { status: 201, body: { school_class: klass() } }),
    });
    const three = ["A", "B", "C", "D"].map((name) => ({ ...newClass, name }));
    await expect(createClasses(T, three)).rejects.toThrow('2 of 4 classes were added. "C" was not: A class with that name exists');
    expect(api.callsTo(`POST ${P}/classes`)).toHaveLength(3);
  });

  it("passes the API's own error on when the first one is refused", async () => {
    boot({ [`GET ${P}/academic-years`]: list("academic_years", [year()]), [`POST ${P}/classes`]: refused("conflict", 409, "Taken") });
    await expect(createClasses(T, [newClass, newClass])).rejects.toMatchObject({ code: "conflict", message: "Taken" });
  });
});

describe("the term and the school's details", () => {
  const setup = (extra: Record<string, FakeRoute> = {}) => ({
    [`GET ${P}/academic-years`]: list("academic_years", [year()]),
    [`GET ${P}/academic-terms`]: list("terms", [term(), term({ id: "t1", index: 1, label: "Term 1, 2026", is_current: false })]),
    [`GET ${P}/classes`]: list("classes", [klass(), klass({ id: C2, name: "Form 1 East", form_level: 1, academic_year_id: OLD_YEAR })]),
    [`GET ${P}/subjects`]: list("subjects", [subject(), subject({ id: S2, name: "Maths", code: "MATH" })]),
    [`GET ${P}/staff`]: list("staff", [staff()]),
    [`GET ${P}/class-memberships`]: list("memberships", [membership(C1, 1), membership(C1, 2), membership(C2, 3)]),
    [`GET ${P}/learners`]: list("learners", [learner(1), learner(2), learner(3)]),
    ...extra,
  });

  it("reads the checklist's figures for the current term and year", async () => {
    boot(setup());
    const d = await fetchTermSetup(T);
    expect(d.term).toMatchObject({ name: "Term 2, 2026", year: 2026, index: 2 });
    expect(d.classes.map((c) => c.name)).toEqual(["Form 2 West"]);
    expect(d.subjectsCount).toBe(2);
    expect(d.activeStudents).toBe(2);
    expect(d.feeItemsCount).toBe(0);
    expect(d.teacherOptions).toEqual([{ id: TEACHER, full_name: "Tabitha Teacher" }]);
  });

  it("counts only active learners as enrolled in the current year", async () => {
    boot(setup({ [`GET ${P}/learners`]: list("learners", [learner(2), learner(3)]) }));
    expect((await fetchTermSetup(T)).activeStudents).toBe(1);
  });

  it("has no term when none is current", async () => {
    boot(setup({ [`GET ${P}/academic-terms`]: list("terms", [term({ is_current: false })]) }));
    expect((await fetchTermSetup(T)).term).toBeNull();
  });

  it("starts a term in a year that does not exist yet: makes the year, sets it current, makes the term, sets it current", async () => {
    const NEW_YEAR = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year({ is_current: true })]),
      [`POST ${P}/academic-years`]: { status: 201, body: { academic_year: year({ id: NEW_YEAR, label: "2027", starts_on: "2027-01-01", ends_on: "2027-12-31", is_current: false }) } },
      [`POST ${P}/academic-years/${NEW_YEAR}/set-current`]: { body: { academic_year: year({ id: NEW_YEAR }) } },
      [`GET ${P}/academic-terms`]: list("terms", []),
      [`POST ${P}/academic-terms`]: { status: 201, body: { term: term({ id: "new-term", academic_year_id: NEW_YEAR, index: 1, is_current: false }) } },
      [`POST ${P}/academic-terms/new-term/set-current`]: { body: { term: term({ id: "new-term" }) } },
    });
    await startTerm({ tenantId: T, year: 2027, index: 1, startsOn: "2027-01-10", endsOn: "2027-04-02" });
    expect(api.callsTo(`POST ${P}/academic-years`)[0]!.body).toEqual({ label: "2027", starts_on: "2027-01-01", ends_on: "2027-12-31" });
    expect(api.callsTo(`POST ${P}/academic-terms`)[0]!.body).toEqual({ academic_year_id: NEW_YEAR, index: 1, label: "Term 1, 2027", starts_on: "2027-01-10", ends_on: "2027-04-02" });
    expect(api.calls.map((c) => `${c.method} ${c.path.replace(P, "")}`).filter((c) => c.startsWith("POST"))).toEqual([
      "POST /academic-years", `POST /academic-years/${NEW_YEAR}/set-current`, "POST /academic-terms", "POST /academic-terms/new-term/set-current",
    ]);
  });

  it("reuses the year and the term when they exist, and sets nothing current that already is", async () => {
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/academic-terms`]: list("terms", [term()]),
    });
    await startTerm({ tenantId: T, year: 2026, index: 2, startsOn: "2026-05-01", endsOn: "2026-08-01" });
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("makes a term current in a year that is already there", async () => {
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/academic-terms`]: list("terms", [term({ index: 1, is_current: false, id: "t1" })]),
      [`POST ${P}/academic-terms/t1/set-current`]: { body: { term: term({ id: "t1" }) } },
    });
    await startTerm({ tenantId: T, year: 2026, index: 1, startsOn: "2026-01-10", endsOn: "2026-04-02" });
    expect(api.callsTo(`POST ${P}/academic-terms/t1/set-current`)).toHaveLength(1);
    expect(api.callsTo(`POST ${P}/academic-terms`)).toHaveLength(0);
  });

  it("stops where the API refuses a term, and says why", async () => {
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/academic-terms`]: list("terms", []),
      [`POST ${P}/academic-terms`]: refused("validation_error", 400, "The term must fall inside its year"),
    });
    await expect(startTerm({ tenantId: T, year: 2026, index: 3, startsOn: "2026-12-20", endsOn: "2027-01-20" })).rejects.toMatchObject({ message: "The term must fall inside its year" });
  });

  it("saves the school's details, sending a blank county or registration as none", async () => {
    boot({ [`PATCH ${P}/school-profile`]: { body: { schoolProfile: {} } } });
    await saveSchoolDetails(T, { name: "  Alliance High ", county: " ", moeRegistration: "" });
    await saveSchoolDetails(T, { name: "Alliance High", county: "Kiambu", moeRegistration: "MOE-1" });
    const [a, b] = api.callsTo(`PATCH ${P}/school-profile`);
    expect(a!.body).toEqual({ name: "Alliance High", county: null, moe_registration: null });
    expect(b!.body).toEqual({ name: "Alliance High", county: "Kiambu", moe_registration: "MOE-1" });
  });

  it("saves the accent", async () => {
    boot({ [`PATCH ${P}/school-profile`]: { body: { schoolProfile: {} } } });
    await saveSchoolAccent(T, "#112233");
    expect(api.callsTo(`PATCH ${P}/school-profile`)[0]!.body).toEqual({ accent: "#112233" });
  });
});

describe("subjects and who teaches them", () => {
  it("lists the active subjects by name as the screens expect them, with their level, years and core flag", async () => {
    boot({
      [`GET ${P}/subjects`]: list("subjects", [
        subject({ id: S2, name: "Biology", code: "BIO", education_level: "junior_secondary", min_form_level: 7, max_form_level: 9, is_core: false }),
        subject(),
        subject({ id: "g", name: "Old", active: false }),
      ]),
    });
    const s = await fetchSubjects(T);
    expect(s.map((x) => x.name)).toEqual(["Biology", "English"]);
    expect(s[0]).toMatchObject({ code: "BIO", level: "junior_secondary", min_form_level: 7, max_form_level: 9, is_core: false });
    expect(s[1]).toMatchObject({ code: "ENG", level: null, min_form_level: null, max_form_level: null, is_core: true });
  });

  it("adds a subject with its level, years and core flag", async () => {
    boot({ [`POST ${P}/subjects`]: { status: 201, body: { subject: subject() } } });
    await createSubject(T, { name: "English", code: "ENG", isCore: false, level: "secondary", minFormLevel: 1, maxFormLevel: 4 });
    expect(api.callsTo(`POST ${P}/subjects`)[0]!.body).toEqual({ code: "ENG", name: "English", is_core: false, education_level: "secondary", min_form_level: 1, max_form_level: 4 });
  });

  it("leaves the level out when none is given, so the API's own default applies, and sends a null level as any level", async () => {
    boot({ [`POST ${P}/subjects`]: { status: 201, body: { subject: subject() } } });
    await createSubject(T, { name: "History", code: "HIS", isCore: true, minFormLevel: null, maxFormLevel: null });
    await createSubject(T, { name: "Art", code: "ART", isCore: true, level: null, minFormLevel: null, maxFormLevel: 4 });
    const [a, b] = api.callsTo(`POST ${P}/subjects`);
    expect(a!.body).toEqual({ code: "HIS", name: "History", is_core: true, min_form_level: null, max_form_level: null });
    expect(b!.body).toEqual({ code: "ART", name: "Art", is_core: true, education_level: null, min_form_level: null, max_form_level: 4 });
  });

  it("refuses to add a subject from the KICD catalogue instead of dropping the link", async () => {
    boot({ [`POST ${P}/subjects`]: { status: 201, body: { subject: subject() } } });
    const err = await createSubject(T, { name: "Maths", code: "MAT", isCore: true, minFormLevel: null, maxFormLevel: null, learningAreaId: "la1" }).then(() => null, (e: unknown) => e);
    expect(isNotOnApiError(err)).toBe(true);
    expect(api.calls).toHaveLength(0);
  });

  it("adds several one by one and says how far it got", async () => {
    let n = 0;
    boot({ [`POST ${P}/subjects`]: () => (++n === 2 ? refused("conflict", 409, "That code is taken") : { status: 201, body: { subject: subject() } }) });
    await expect(createSubjects(T, [{ name: "A", code: "A", isCore: true, minFormLevel: null, maxFormLevel: null }, { name: "B", code: "B", isCore: true, minFormLevel: null, maxFormLevel: null }, { name: "C", code: "C", isCore: true, minFormLevel: null, maxFormLevel: null }]))
      .rejects.toThrow('1 of 3 subjects were added. "B" was not: That code is taken');
  });

  it("sends each bulk-added subject's years", async () => {
    boot({ [`POST ${P}/subjects`]: { status: 201, body: { subject: subject() } } });
    await createSubjects(T, [{ name: "Computer Studies", code: "COMP", isCore: true, minFormLevel: 1, maxFormLevel: 2 }]);
    expect(api.callsTo(`POST ${P}/subjects`)[0]!.body).toEqual({ code: "COMP", name: "Computer Studies", is_core: true, min_form_level: 1, max_form_level: 2 });
  });

  describe("changing a subject", () => {
    const patch = `PATCH ${P}/subjects/${S1}`;

    it("sends the code, name, years, and the level and core flag when they are given, as the school in the tab", async () => {
      boot({ [patch]: { body: { subject: subject({ name: "English Language" }) } } });
      await updateSubject(S1, { name: "English Language", code: "ENG", minFormLevel: 7, maxFormLevel: 9, level: "junior_secondary", isCore: false });
      const call = api.callsTo(patch)[0]!;
      expect(call.body).toEqual({ name: "English Language", code: "ENG", min_form_level: 7, max_form_level: 9, education_level: "junior_secondary", is_core: false });
      expect(call.headers["x-tenant-id"]).toBe(T);
    });

    it("leaves the level and the core flag alone when they are not given, and clears the years with null", async () => {
      boot({ [patch]: { body: { subject: subject() } } });
      await updateSubject(S1, { name: "English", code: "ENG", minFormLevel: null, maxFormLevel: null });
      expect(api.callsTo(patch)[0]!.body).toEqual({ name: "English", code: "ENG", min_form_level: null, max_form_level: null });
    });

    it("sends a null level as any level", async () => {
      boot({ [patch]: { body: { subject: subject() } } });
      await updateSubject(S1, { name: "English", code: "ENG", minFormLevel: null, maxFormLevel: null, level: null });
      expect(api.callsTo(patch)[0]!.body).toMatchObject({ education_level: null });
    });

    it("says that another subject has the code, in the API's words (409)", async () => {
      boot({ [patch]: refused("conflict", 409, "A subject with this code already exists") });
      const err = await updateSubject(S1, { name: "English", code: "MAT", minFormLevel: null, maxFormLevel: null }).then(() => null, (e: unknown) => e);
      expect(err).toMatchObject({ status: 409, code: "conflict" });
      expect(userMessage(err)).toBe("A subject with this code already exists");
    });

    it("says that years outside the level do not fit (400)", async () => {
      boot({ [patch]: refused("validation_error", 400, "min_form_level must be between 7 and 9 for junior_secondary") });
      const err = await updateSubject(S1, { name: "English", code: "ENG", minFormLevel: 1, maxFormLevel: 2, level: "junior_secondary" }).then(() => null, (e: unknown) => e);
      expect(userMessage(err)).toBe("min_form_level must be between 7 and 9 for junior_secondary");
    });

    it("says that an archived subject cannot be changed (400)", async () => {
      boot({ [patch]: refused("validation_error", 400, "Archived subjects cannot be updated") });
      expect(userMessage(await updateSubject(S1, { name: "English", code: "ENG", minFormLevel: null, maxFormLevel: null }).then(() => null, (e: unknown) => e))).toBe("Archived subjects cannot be updated");
    });
  });

  const classSubjects = (assignments: unknown[], subjects: unknown[] = [subject({ id: S2, name: "Biology", code: "BIO" }), subject()]) => ({
    [`GET ${P}/subjects`]: list("subjects", subjects),
    [`GET ${P}/teaching-assignments`]: list("assignments", assignments),
  });

  it("lists every subject with who teaches it in the class, and marks no teacher as qualified", async () => {
    boot(classSubjects([assignment()]));
    const r = await fetchClassSubjects(T, C1, "secondary", 2);
    expect(r.rows.map((x) => [x.subject.name, x.teacherId])).toEqual([["Biology", null], ["English", TEACHER]]);
    expect(r.qualifiedTeacherIdsBySubject.size).toBe(0);
    expect(api.callsTo(`GET ${P}/teaching-assignments`)[0]!.query.get("classId")).toBe(C1);
  });

  it("leaves out a subject whose level or years exclude the class, as the Subjects screen promises", async () => {
    boot(classSubjects([], [
      subject({ id: S2, name: "Biology", code: "BIO", education_level: "secondary", min_form_level: 3, max_form_level: 4 }),
      subject({ id: "s3", name: "Computer Studies", code: "COM", education_level: "secondary", min_form_level: 1, max_form_level: 2 }),
      subject({ id: "s4", name: "Grade 7 Science", code: "SCI", education_level: "junior_secondary", min_form_level: 7, max_form_level: 9 }),
      subject(),
    ]));
    const r = await fetchClassSubjects(T, C1, "secondary", 2);
    expect(r.rows.map((x) => x.subject.name)).toEqual(["Computer Studies", "English"]);
  });

  it("keeps an out-of-range subject in the list when it already has a teacher there, so the teacher can still be changed or cleared", async () => {
    boot(classSubjects([assignment({ subject_id: S2 })], [subject({ id: S2, name: "Biology", code: "BIO", education_level: "secondary", min_form_level: 3, max_form_level: 4 }), subject()]));
    const r = await fetchClassSubjects(T, C1, "secondary", 2);
    expect(r.rows.map((x) => [x.subject.name, x.teacherId])).toEqual([["Biology", TEACHER], ["English", null]]);
  });

  describe("naming, changing and clearing a subject's teacher in a class", () => {
    const AID = "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0";

    it("names a teacher for a subject nobody teaches yet", async () => {
      boot({ ...classSubjects([]), [`POST ${P}/teaching-assignments`]: { status: 201, body: { assignment: assignment() } } });
      await setClassSubjectTeacher({ tenantId: T, classId: C1, subjectId: S1, teacherId: TEACHER });
      expect(api.callsTo(`POST ${P}/teaching-assignments`)[0]!.body).toEqual({ staff_member_id: TEACHER, class_id: C1, subject_id: S1 });
    });

    it("gives the class's subject another teacher by changing the same assignment, not making a second", async () => {
      boot({ ...classSubjects([assignment()]), [`PATCH ${P}/teaching-assignments/${AID}`]: { body: { assignment: assignment({ staff_member_id: TEACHER2 }) } } });
      await setClassSubjectTeacher({ tenantId: T, classId: C1, subjectId: S1, teacherId: TEACHER2 });
      expect(api.callsTo(`PATCH ${P}/teaching-assignments/${AID}`)[0]!.body).toEqual({ staff_member_id: TEACHER2 });
      expect(api.callsTo(`POST ${P}/teaching-assignments`)).toHaveLength(0);
      expect(api.callsTo(`POST ${P}/teaching-assignments/${AID}/archive`)).toHaveLength(0);
    });

    it("clears the teacher by archiving the assignment", async () => {
      boot({ ...classSubjects([assignment()]), [`POST ${P}/teaching-assignments/${AID}/archive`]: { body: { assignment: assignment({ active: false }) } } });
      await setClassSubjectTeacher({ tenantId: T, classId: C1, subjectId: S1, teacherId: null });
      expect(api.callsTo(`POST ${P}/teaching-assignments/${AID}/archive`)).toHaveLength(1);
      expect(api.callsTo(`PATCH ${P}/teaching-assignments/${AID}`)).toHaveLength(0);
    });

    it("looks at the class's active assignments only", async () => {
      boot({ ...classSubjects([]), [`POST ${P}/teaching-assignments`]: { status: 201, body: { assignment: assignment() } } });
      await setClassSubjectTeacher({ tenantId: T, classId: C1, subjectId: S1, teacherId: TEACHER });
      const q = api.callsTo(`GET ${P}/teaching-assignments`)[0]!.query;
      expect([q.get("classId"), q.get("active")]).toEqual([C1, "true"]);
    });

    it("does nothing when the same teacher is named again, or none is named for an unassigned subject", async () => {
      boot(classSubjects([assignment()]));
      await setClassSubjectTeacher({ tenantId: T, classId: C1, subjectId: S1, teacherId: TEACHER });
      await setClassSubjectTeacher({ tenantId: T, classId: C1, subjectId: S2, teacherId: null });
      expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    });

    it("says, in the API's words, that the new teacher must be an active member of staff (400)", async () => {
      boot({ ...classSubjects([assignment()]), [`PATCH ${P}/teaching-assignments/${AID}`]: refused("validation_error", 400, "staff_member_id must be an active staff member in this school") });
      const err = await setClassSubjectTeacher({ tenantId: T, classId: C1, subjectId: S1, teacherId: TEACHER2 }).then(() => null, (e: unknown) => e);
      expect(err).toMatchObject({ status: 400 });
      expect(userMessage(err)).toBe("staff_member_id must be an active staff member in this school");
    });

    it("says so when the assignment was ended meanwhile (400 on change, 400 on clear)", async () => {
      boot({
        ...classSubjects([assignment()]),
        [`PATCH ${P}/teaching-assignments/${AID}`]: refused("validation_error", 400, "Archived teaching assignments cannot be changed; create a new one"),
        [`POST ${P}/teaching-assignments/${AID}/archive`]: refused("validation_error", 400, "Teaching assignment is already archived"),
      });
      expect(userMessage(await setClassSubjectTeacher({ tenantId: T, classId: C1, subjectId: S1, teacherId: TEACHER2 }).then(() => null, (e: unknown) => e)))
        .toBe("Archived teaching assignments cannot be changed; create a new one");
      expect(userMessage(await setClassSubjectTeacher({ tenantId: T, classId: C1, subjectId: S1, teacherId: null }).then(() => null, (e: unknown) => e)))
        .toBe("Teaching assignment is already archived");
    });
  });
});

describe("what the API cannot do yet", () => {
  it("throws NotOnApiError rather than doing nothing", async () => {
    boot({});
    const attempts = [
      () => saveSchoolPaymentMethods(T, { paybill: "1", till: "", bankDetails: "", notes: "" }), () => saveSchoolLogo(T, "https://x/logo.png"),
      () => fetchLatestExamMeans(T, ["a"]), () => markLearnersLeft(["a"]), () => moveLearnersToClass(C2, ["a"]), () => fetchPromotionRoster(C1),
    ];
    for (const attempt of attempts) {
      const err = await attempt().then(() => null, (e: unknown) => e);
      expect(isNotOnApiError(err)).toBe(true);
    }
    expect(api.calls).toHaveLength(0);
  });
});

describe("setupCapabilities", () => {
  it("offers every control on Supabase except the two that only the API has", () => {
    initBackend({ kind: "supabase" });
    const caps = setupCapabilities();
    expect(Object.entries(caps).filter(([, on]) => !on).map(([name]) => name).sort()).toEqual(["editClassRoom", "editSubjectLevelAndCore"]);
    // The Supabase screens keep the KICD catalogue and every wording they had.
    expect(caps.kicdCatalogue).toBe(true);
    expect(caps.deleteClass).toBe(true);
  });

  it("offers on the API what the API does, and nothing it cannot", () => {
    initBackend({ kind: "api", apiUrl: BASE });
    const caps = setupCapabilities();
    // Backed by migration 101 (docs/web-on-api/api-gap-fixes.md).
    for (const name of ["changeClassTeacher", "classRoom", "editClassRoom", "deleteClass", "editSubject", "subjectDetails", "editSubjectLevelAndCore", "changeSubjectTeacher"] as const) {
      expect(caps[name], name).toBe(true);
    }
    // Not backed, each for its own slice: the KICD catalogue needs a subject-to-learning-area link; the rest are other slices.
    for (const name of ["kicdCatalogue", "promoteClass", "classTimetable", "feeSetup", "schoolCrest", "aiSettings"] as const) {
      expect(caps[name], name).toBe(false);
    }
  });
});
