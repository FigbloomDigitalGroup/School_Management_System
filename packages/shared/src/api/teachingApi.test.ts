import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { fetchMyClasses, fetchTeacherClasses } from "../teacherData";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { clearTeachingLookups } from "./teachingLookups";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const P = `/v1/tenants/${T}`;
const YEAR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const C2 = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";
const U1 = "20000001-1111-4111-8111-111111111111";
const ST_ME = "30000001-1111-4111-8111-111111111111";
const ST_OTHER = "30000002-1111-4111-8111-111111111111";
const MATH = "40000001-1111-4111-8111-111111111111";
const ENG = "40000002-1111-4111-8111-111111111111";
const L1 = "10000001-1111-4111-8111-111111111111";
const L2 = "10000002-1111-4111-8111-111111111111";
const L3 = "10000003-1111-4111-8111-111111111111";
const stamp = { created_at: "2026-05-01T08:00:00Z", updated_at: "2026-05-01T08:00:00Z" };

const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const list = (key: string, items: unknown[]): FakeReply => ({ body: { [key]: items, page: page() } });
const refused = (code: string, status: number): FakeReply => ({ status, body: { error: { code, message: "no" } } });
const year = () => ({ id: YEAR, tenantId: T, label: "2026", starts_on: "2026-01-01", ends_on: "2026-12-31", is_current: true, ...stamp });
const clsRow = (id: string, name: string, teacherStaffId: string | null) => ({
  id, tenantId: T, academic_year_id: YEAR, name, education_level: "secondary", form_level: 1, pathway: null, stream: null,
  class_teacher_staff_id: teacherStaffId, active: true, archived_at: null, ...stamp,
});
const staffRow = (id: string, userId: string | null, name: string) => ({
  id, tenantId: T, full_name: name, staff_title: null, classification: "teacher", phone: null, email: null, userId, active: true, archived_at: null, ...stamp,
});
const assignment = (id: string, staffId: string, classId: string, subjectId: string) => ({
  id, tenantId: T, staff_member_id: staffId, class_id: classId, subject_id: subjectId, active: true, archived_at: null, ...stamp,
});
const membership = (id: string, learnerId: string, classId: string) => ({
  id, tenantId: T, learner_id: learnerId, class_id: classId, academic_year_id: YEAR, active: true, archived_at: null, ...stamp,
});
const learner = (id: string) => ({
  id, tenantId: T, admission_no: id.slice(0, 6), full_name: `L ${id.slice(0, 3)}`, gender: "female", boarding: false, date_of_birth: "2011-01-01", active: true, archived_at: null, ...stamp,
});
const subject = (id: string, name: string) => ({ id, tenantId: T, code: name.slice(0, 3).toUpperCase(), name, active: true, archived_at: null, ...stamp });

let api: FakeApi;
function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  clearTeachingLookups();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: U1 }));
  setApiActiveTenant(T);
  return api;
}

beforeEach(() => clearTeachingLookups());
afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

// I teach Mathematics in Form 1 East and lead it; Mercy teaches English there; I also teach English in Form 2 West.
const ASSIGNMENTS = [
  assignment("a1", ST_ME, C1, MATH), assignment("a2", ST_OTHER, C1, ENG), assignment("a3", ST_ME, C2, ENG),
];
const MEMBERSHIPS = [membership("m1", L1, C1), membership("m2", L2, C1), membership("m3", L3, C2)];
const SUBJECTS = list("subjects", [subject(MATH, "Mathematics"), subject(ENG, "English")]);

describe("which class is mine to lead (class_teacher_id carries the teacher's sign-in id)", () => {
  it("maps the class a teacher leads to their own id, and leaves other classes' teachers as staff ids (staff list readable)", async () => {
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/classes`]: list("classes", [clsRow(C1, "Form 1 East", ST_ME), clsRow(C2, "Form 2 West", ST_OTHER)]),
      [`GET ${P}/staff`]: list("staff", [staffRow(ST_ME, U1, "David Kamau"), staffRow(ST_OTHER, null, "Mercy Wanjiru")]),
      [`GET ${P}/teaching-assignments`]: list("assignments", ASSIGNMENTS),
    });
    const classes = await fetchTeacherClasses(U1);

    expect(classes.map((c) => [c.name, c.class_teacher_id])).toEqual([["Form 1 East", U1], ["Form 2 West", ST_OTHER]]);
    // The staff list answered, so nobody asked who "me" is.
    expect(api.callsTo(`GET ${P}/staff/me`)).toHaveLength(0);
  });

  it("finds a plain teacher's own staff id with GET .../staff/me when they may not read the staff list", async () => {
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/classes`]: list("classes", [clsRow(C1, "Form 1 East", ST_ME), clsRow(C2, "Form 2 West", ST_OTHER)]),
      [`GET ${P}/staff`]: refused("forbidden", 403),
      [`GET ${P}/staff/me`]: { body: { staff: staffRow(ST_ME, U1, "David Kamau") } },
      [`GET ${P}/teaching-assignments`]: list("assignments", ASSIGNMENTS),
      ["GET /v1/rbac/permissions"]: { body: { role: "teacher", tenantId: T, mayAdminister: false, isOrgAdminForTenant: false, isSuperAdmin: false, delegatedPermissions: [], actingVia: "membership", items: ["resource.attendance.read"], page: page() } },
    });
    const classes = await fetchTeacherClasses(U1);

    expect(classes.map((c) => [c.name, c.class_teacher_id])).toEqual([["Form 1 East", U1], ["Form 2 West", ST_OTHER]]);
  });

  it("leaves every class as it was when the plain teacher has no staff record, instead of failing", async () => {
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/classes`]: list("classes", [clsRow(C1, "Form 1 East", ST_ME)]),
      [`GET ${P}/staff`]: refused("forbidden", 403),
      [`GET ${P}/staff/me`]: refused("not_found", 404),
      [`GET ${P}/teaching-assignments`]: list("assignments", []),
      ["GET /v1/rbac/permissions"]: { body: { role: "teacher", tenantId: T, mayAdminister: false, isOrgAdminForTenant: false, isSuperAdmin: false, delegatedPermissions: [], actingVia: "membership", items: [], page: page() } },
    });
    expect((await fetchTeacherClasses(U1)).map((c) => c.class_teacher_id)).toEqual([ST_ME]);
  });
});

describe("My classes on the API", () => {
  const plain = (over: Record<string, FakeRoute> = {}): Record<string, FakeRoute> => ({
    [`GET ${P}/academic-years`]: list("academic_years", [year()]),
    // OD-2: a plain teacher's class list, assignments and memberships are already only their classes.
    [`GET ${P}/classes`]: list("classes", [clsRow(C1, "Form 1 East", ST_ME), clsRow(C2, "Form 2 West", ST_OTHER)]),
    [`GET ${P}/staff`]: refused("forbidden", 403),
    [`GET ${P}/staff/me`]: { body: { staff: staffRow(ST_ME, U1, "David Kamau") } },
    [`GET ${P}/teaching-assignments`]: list("assignments", ASSIGNMENTS),
    [`GET ${P}/class-memberships`]: list("memberships", MEMBERSHIPS),
    [`GET ${P}/learners`]: refused("forbidden", 403),
    [`GET ${P}/subjects`]: SUBJECTS,
    ["GET /v1/rbac/permissions"]: { body: { role: "teacher", tenantId: T, mayAdminister: false, isOrgAdminForTenant: false, isSuperAdmin: false, delegatedPermissions: [], actingVia: "membership", items: [], page: page() } },
    ...over,
  });

  it("lists my classes with only MY subjects in each, the roll size, and the class I lead marked as mine", async () => {
    boot(plain());
    const rows = await fetchMyClasses(U1);

    expect(rows.map((r) => [r.name, r.class_teacher_id === U1, r.subjects, r.learnerCount])).toEqual([
      ["Form 1 East", true, ["Mathematics"], 2],
      ["Form 2 West", false, ["English"], 1],
    ]);
  });

  it("counts only active learners when the person may read learners (an archived learner keeps their membership)", async () => {
    // The API is asked for active learners only (L2 left, so is not in the answer).
    boot(plain({ [`GET ${P}/learners`]: list("learners", [learner(L1), learner(L3)]) }));
    const rows = await fetchMyClasses(U1);

    expect(rows.map((r) => r.learnerCount)).toEqual([1, 1]);
  });

  it("counts only the learners of the person's own classes", async () => {
    const OTHER_CLASS = "c9c9c9c9-c9c9-4c9c-8c9c-c9c9c9c9c9c9";
    boot(plain({
      [`GET ${P}/class-memberships`]: list("memberships", [...MEMBERSHIPS, membership("m9", "10000009-1111-4111-8111-111111111111", OTHER_CLASS)]),
    }));
    const rows = await fetchMyClasses(U1);
    expect(rows.map((r) => r.learnerCount)).toEqual([2, 1]);
  });

  it("names no subject the person may not read, and gives no subjects when their own staff id is unknown", async () => {
    boot(plain({ [`GET ${P}/subjects`]: refused("forbidden", 403) }));
    expect((await fetchMyClasses(U1)).map((r) => r.subjects)).toEqual([[], []]);

    boot(plain({ [`GET ${P}/staff/me`]: refused("not_found", 404) }));
    expect((await fetchMyClasses(U1)).map((r) => r.subjects)).toEqual([[], []]);
  });

  it("is empty for a teacher with no classes, without asking for anything else", async () => {
    boot({ ...plain(), [`GET ${P}/classes`]: refused("forbidden", 403) });
    expect(await fetchMyClasses(U1)).toEqual([]);
    expect(api.callsTo(`GET ${P}/subjects`)).toHaveLength(0);
    expect(api.callsTo(`GET ${P}/class-memberships`)).toHaveLength(0);
  });
});
