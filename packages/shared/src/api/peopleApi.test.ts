import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { isNotOnApiError, peopleCapabilities } from "../capabilities";
import { fetchLearnerGuardians } from "../learnerBio";
import { archiveLearners, deleteLearners, fetchArchivedLearners, restoreLearners } from "../learners";
import { addLearner, fetchPeopleRoster, reviewStaffPhoto, setTeacherQualified, updateLearnerDetails, updateStaffDetails } from "../peopleRoster";
import { BASE, createFakeApi, type FakeApi, type FakeCall, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { ApiError } from "./errors";
import {
  IMPORT_BATCH_ROWS, ImportRejectedError, LearnerPlacementError, apiAddGuardian, apiAddStaff, apiArchiveStaff, apiFetchArchivedStaff, apiImportLearners,
  apiRestoreStaff, classOfLearners, learnersCsv, peopleErrorText, readableApiError, rosterLearnerFromApi, rosterStaffFromApi, type ImportLearnerRow,
} from "./peopleApi";
import { forgetApiSchools } from "./sessionApi";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const YEAR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const YEAR2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const C2 = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";
const C27 = "c7c7c7c7-c7c7-4c7c-8c7c-c7c7c7c7c7c7";
const P = `/v1/tenants/${T}`;
const stamp = { created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };

const year = (o: Record<string, unknown> = {}) => ({ id: YEAR, tenantId: T, label: "2026", starts_on: "2026-01-01", ends_on: "2026-12-31", is_current: true, ...stamp, ...o });
const klass = (id: string, name: string, form: number, yearId = YEAR) => ({ id, tenantId: T, academic_year_id: yearId, name, form_level: form, education_level: "secondary", pathway: null, stream: null, class_teacher_staff_id: null, active: true, archived_at: null, ...stamp });
const learner = (n: number, o: Record<string, unknown> = {}) => ({ id: `l-${n}`, tenantId: T, admission_no: String(1000 + n), full_name: `Learner ${String(n).padStart(2, "0")}`, gender: n % 2 ? "female" : "male", boarding: false, date_of_birth: null, active: true, archived_at: null, ...stamp, ...o });
const member = (n: number, classId: string, yearId = YEAR, o: Record<string, unknown> = {}) => ({ id: `m-${n}-${classId.slice(0, 2)}`, tenantId: T, learner_id: `l-${n}`, class_id: classId, academic_year_id: yearId, active: true, archived_at: null, ...stamp, ...o });
const staffRec = (id: string, name: string, classification: string, o: Record<string, unknown> = {}) => ({ id, tenantId: T, full_name: name, staff_title: null, classification, phone: null, email: null, userId: null, active: true, archived_at: null, ...stamp, ...o });
const subject = (id: string, name: string, code: string) => ({ id, tenantId: T, code, name, active: true, archived_at: null, ...stamp });
const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const list = (key: string, items: unknown[], next: string | null = null): FakeReply => ({ body: { [key]: items, page: page(next) } });
const refused = (code: string, status: number, message = "no", details?: unknown) => ({ status, body: { error: { code, message, ...(details ? { details } : {}) } } });
const created = (key: string, body: unknown): FakeReply => ({ status: 201, body: { [key]: body } });
const TERM = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const term = (o: Record<string, unknown> = {}) => ({ id: TERM, tenantId: T, academic_year_id: YEAR, index: 2, label: "Term 2, 2026", starts_on: "2026-05-01", ends_on: "2026-08-01", is_current: true, ...stamp, ...o });
const invoice = (n: number, learnerId: string, total: number, paid: number, o: Record<string, unknown> = {}) => ({
  id: `inv-${n}`, tenantId: T, learner_id: learnerId, term_id: TERM, currency: "KES", due_on: "2026-05-15", lines_minor: total, charges_minor: 0, adjustments_minor: 0,
  total_minor: total, paid_minor: paid, balance_minor: total - paid, overpaid_minor: 0, unapplied_minor: 0, status: paid >= total ? "paid" : paid > 0 ? "part_paid" : "unpaid",
  billing_run_id: null, created_at: "2026-05-01T08:00:00Z", voided_at: null, void_reason: null, ...o,
});
/** What `GET /v1/rbac/permissions` answers: the codes the person holds in this school. */
const permissions = (...items: string[]): FakeReply => ({
  body: { role: "teacher", tenantId: T, mayAdminister: false, isOrgAdminForTenant: false, isSuperAdmin: false, delegatedPermissions: [], actingVia: "membership", items, page: page() },
});
const OFFICE = ["resource.learner.read", "resource.learner.write"];
const BURSAR = ["resource.finance.read", "resource.academics.read"];

let api: FakeApi;

function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  forgetApiSchools();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: "u" }));
  setApiActiveTenant(T);
  return api;
}

afterEach(() => { vi.unstubAllGlobals(); resetApiClient(); initBackend({ kind: "supabase" }); });

const writes = () => api.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path.replace(P, "")}`);

// ---------------------------------------------------------------- pure pieces

describe("mapping", () => {
  it("gives a learner the class of an active membership in a listed class, the first one, and nothing for other classes", () => {
    const m = [
      { learner_id: "a", class_id: C1 }, { learner_id: "a", class_id: C2 }, { learner_id: "b", class_id: C27 }, { learner_id: "c", class_id: C2 },
    ];
    const got = classOfLearners(m, new Set([C1, C2]));
    expect([...got]).toEqual([["a", C1], ["c", C2]]);
  });

  it("shapes a learner and a staff record as the screens expect them", () => {
    expect(rosterLearnerFromApi(learner(1, { boarding: true }) as never, C1)).toEqual({
      id: "l-1", admission_no: "1001", full_name: "Learner 01", class_id: C1, boarding: true, gender: "female", avatar_url: null, profile_id: null, login_id: null, archived_at: null,
    });
    expect(rosterLearnerFromApi(learner(2, { active: false, archived_at: "2026-03-01T00:00:00Z" }) as never, null).archived_at).toBe("2026-03-01T00:00:00Z");
    expect(rosterStaffFromApi(staffRec("s1", "Tabitha", "teacher", { staff_title: "HOD", phone: "0712 345 678", email: "t@x.co" }) as never)).toEqual({
      id: "s1", full_name: "Tabitha", role: "teacher", staff_title: "HOD", email: "t@x.co", phone: "0712 345 678", login_id: null, photo_changed_at: null, handles_visitors: false, avatar_url: null, user_id: null,
    });
  });
});

describe("readable errors", () => {
  const validation = (details: { field: string; code: string; message: string }[], message = "admission_no, full_name and gender (male|female) are required; optional boarding and date_of_birth") =>
    new ApiError({ status: 400, code: "validation_error", message, requestId: "req-1", details });

  it("says what is wrong, in words, instead of the API's list of everything required", () => {
    const e = readableApiError(validation([{ field: "gender", code: "invalid_value", message: "Invalid value" }, { field: "full_name", code: "too_big", message: "Value is too large" }]));
    expect((e as ApiError).message).toBe("Gender is not valid; Name is too long.");
    expect(e).toMatchObject({ code: "validation_error", status: 400, requestId: "req-1" });
  });

  it("names the field of a nested detail by its last part, says each thing once, and keeps three at most", () => {
    const e = readableApiError(validation([
      { field: "learners.0.relationship", code: "invalid_value", message: "x" }, { field: "relationship", code: "invalid_value", message: "x" },
      { field: "phone", code: "invalid_format", message: "x" }, { field: "email", code: "invalid_format", message: "x" }, { field: "alt_phone", code: "invalid_format", message: "x" },
    ]));
    expect((e as ApiError).message).toBe("Relationship is not valid; Phone is not in the right format; Email is not in the right format.");
  });

  it("leaves an answer with no usable details, and every other kind of error, as it is", () => {
    const rootOnly = validation([{ field: "(root)", code: "custom", message: "Invalid value" }], "At least one learner field is required");
    expect(readableApiError(rootOnly)).toBe(rootOnly);
    const conflict = new ApiError({ status: 409, code: "conflict", message: "Admission 1001 is already on the roster" });
    expect(readableApiError(conflict)).toBe(conflict);
    const plain = new Error("x");
    expect(readableApiError(plain)).toBe(plain);
  });

  it("gives the sentence for any failure", () => {
    expect(peopleErrorText(new ApiError({ status: 409, code: "conflict", message: "Admission 1001 is already on the roster" }))).toBe("Admission 1001 is already on the roster");
    expect(peopleErrorText(validation([{ field: "phone", code: "invalid_format", message: "x" }]))).toBe("Phone is not in the right format.");
    expect(peopleErrorText(new ApiError({ status: 0, code: "network_error", message: "x" }))).toMatch(/can't reach/i);
  });
});

// ---------------------------------------------------------------- the roster

describe("the roster", () => {
  const roster = (extra: Record<string, FakeRoute> = {}) => ({
    [`GET ${P}/academic-years`]: list("academic_years", [year(), year({ id: YEAR2, label: "2027", starts_on: "2027-01-01", is_current: false })]),
    [`GET ${P}/classes`]: list("classes", [klass(C2, "Form 2 West", 2), klass(C1, "Form 1 East", 1)]),
    [`GET ${P}/learners`]: list("learners", [learner(1), learner(2), learner(3)]),
    [`GET ${P}/class-memberships`]: list("memberships", [member(1, C1), member(2, C2), member(3, C27, YEAR2), member(9, C1)]),
    [`GET ${P}/staff`]: list("staff", [staffRec("s2", "Zed Driver", "driver"), staffRec("s1", "Abel Teacher", "teacher")]),
    [`GET ${P}/subjects`]: list("subjects", [subject("su2", "Maths", "MATH"), subject("su1", "English", "ENG")]),
    // an office person with no Fees area: nothing about fees is read
    ["GET /v1/rbac/permissions"]: permissions(...OFFICE),
    ...extra,
  });

  it("lists the learners with the class they are in this year, the classes in year order, the staff and the subjects", async () => {
    boot(roster());
    const r = await fetchPeopleRoster(T);
    expect(r.classes).toEqual([{ id: C1, name: "Form 1 East" }, { id: C2, name: "Form 2 West" }]);
    expect(r.students.map((s) => [s.full_name, s.class_id])).toEqual([["Learner 01", C1], ["Learner 02", C2], ["Learner 03", null]]);
    expect(r.staff.map((s) => [s.full_name, s.role])).toEqual([["Abel Teacher", "teacher"], ["Zed Driver", "driver"]]);
    expect(r.subjects.map((s) => s.name)).toEqual(["English", "Maths"]);
    expect(r.feeByStudent.size).toBe(0);
    expect(r.subjectIdsByTeacher.size).toBe(0);
  });

  it("asks only for active learners and staff, and the current year's classes", async () => {
    boot(roster());
    await fetchPeopleRoster(T);
    expect(api.callsTo(`GET ${P}/learners`)[0]!.query.get("active")).toBe("true");
    expect(api.callsTo(`GET ${P}/staff`)[0]!.query.get("active")).toBe("true");
    expect(api.callsTo(`GET ${P}/classes`)[0]!.query.get("academicYearId")).toBe(YEAR);
    expect(api.callsTo(`GET ${P}/learners`)[0]!.query.get("limit")).toBe("200");
  });

  it("follows the pages of a long list of learners", async () => {
    boot(roster({ [`GET ${P}/learners`]: (c: FakeCall) => (c.query.get("cursor") ? list("learners", [learner(4)]) : list("learners", [learner(1), learner(2)], "p2")) }));
    expect((await fetchPeopleRoster(T)).students.map((s) => s.id)).toEqual(["l-1", "l-2", "l-4"]);
  });

  it("still loads, with no classes, for a person who may read learners and staff but not Academics", async () => {
    boot(roster({
      [`GET ${P}/academic-years`]: refused("forbidden", 403), [`GET ${P}/classes`]: refused("forbidden", 403),
      [`GET ${P}/class-memberships`]: refused("forbidden", 403), [`GET ${P}/subjects`]: refused("forbidden", 403),
    }));
    const r = await fetchPeopleRoster(T);
    expect(r.classes).toEqual([]);
    expect(r.students.every((s) => s.class_id === null)).toBe(true);
    expect(r.students).toHaveLength(3);
    expect(r.staff).toHaveLength(2);
  });

  it("fails when learners cannot be read, and on any other failure, rather than showing an empty school", async () => {
    boot(roster({ [`GET ${P}/learners`]: refused("forbidden", 403, "Insufficient permissions") }));
    await expect(fetchPeopleRoster(T)).rejects.toMatchObject({ code: "forbidden" });
    boot(roster({ [`GET ${P}/staff`]: refused("internal_error", 500) }));
    await expect(fetchPeopleRoster(T)).rejects.toMatchObject({ code: "internal_error" });
  });

  it("uses every active class when no year is current yet", async () => {
    boot(roster({ [`GET ${P}/academic-years`]: list("academic_years", []) }));
    await fetchPeopleRoster(T);
    expect(api.callsTo(`GET ${P}/classes`)[0]!.query.has("academicYearId")).toBe(false);
  });
});

describe("the roster's fee status (the Fees column)", () => {
  const withFees = (extra: Record<string, FakeRoute> = {}) => ({
    [`GET ${P}/academic-years`]: list("academic_years", [year()]),
    [`GET ${P}/classes`]: list("classes", [klass(C1, "Form 1 East", 1)]),
    [`GET ${P}/learners`]: list("learners", [learner(1), learner(2), learner(3)]),
    [`GET ${P}/class-memberships`]: list("memberships", []),
    [`GET ${P}/staff`]: list("staff", []),
    [`GET ${P}/subjects`]: list("subjects", []),
    ["GET /v1/rbac/permissions"]: permissions(...OFFICE, ...BURSAR),
    [`GET ${P}/academic-terms`]: list("terms", [term({ id: "old-term", is_current: false, index: 1 }), term()]),
    [`GET ${P}/finance/invoices`]: list("invoices", [invoice(1, "l-1", 5_000_000, 5_000_000), invoice(2, "l-2", 5_000_000, 1_000_000)]),
    ...extra,
  });

  it("gives each learner the term's total and paid, in cents, from the current term's invoices", async () => {
    boot(withFees());
    const r = await fetchPeopleRoster(T);
    expect(r.feesReadable).toBe(true);
    expect([...r.feeByStudent]).toEqual([["l-1", { total: 5_000_000, paid: 5_000_000 }], ["l-2", { total: 5_000_000, paid: 1_000_000 }]]);
    expect(r.feeByStudent.has("l-3")).toBe(false);
    expect(api.callsTo(`GET ${P}/finance/invoices`)[0]!.query.get("termId")).toBe(TERM);
    expect(api.callsTo(`GET ${P}/finance/invoices`)[0]!.query.get("limit")).toBe("200");
  });

  it("leaves a voided invoice out, adds up a learner's several invoices, and follows the pages", async () => {
    boot(withFees({
      [`GET ${P}/finance/invoices`]: (c: FakeCall) => (c.query.get("cursor")
        ? list("invoices", [invoice(3, "l-1", 1_000_000, 0), invoice(4, "l-3", 9_000_000, 0, { status: "voided", voided_at: "2026-05-02T00:00:00Z" })])
        : list("invoices", [invoice(1, "l-1", 5_000_000, 5_000_000)], "p2")),
    }));
    const r = await fetchPeopleRoster(T);
    expect([...r.feeByStudent]).toEqual([["l-1", { total: 6_000_000, paid: 5_000_000 }]]);
  });

  it("reads no invoices, and says the column should not show, for a person without the finance right", async () => {
    boot(withFees({ ["GET /v1/rbac/permissions"]: permissions(...OFFICE, "resource.academics.read") }));
    const r = await fetchPeopleRoster(T);
    expect(r.feesReadable).toBe(false);
    expect(r.feeByStudent.size).toBe(0);
    expect(api.callsTo(`GET ${P}/finance/invoices`)).toHaveLength(0);
  });

  it("also hides it when the person may not read terms (the current term needs the Academics right)", async () => {
    boot(withFees({ ["GET /v1/rbac/permissions"]: permissions(...OFFICE, "resource.finance.read") }));
    const r = await fetchPeopleRoster(T);
    expect(r.feesReadable).toBe(false);
    expect(api.callsTo(`GET ${P}/finance/invoices`)).toHaveLength(0);
    expect(api.callsTo(`GET ${P}/academic-terms`)).toHaveLength(0);
  });

  it("hides it when the permission list itself is refused", async () => {
    boot(withFees({ ["GET /v1/rbac/permissions"]: refused("forbidden", 403, "Insufficient permissions") }));
    const r = await fetchPeopleRoster(T);
    expect(r.feesReadable).toBe(false);
    expect(r.students).toHaveLength(3);
  });

  it("shows the column with no invoices when no term is current yet", async () => {
    boot(withFees({ [`GET ${P}/academic-terms`]: list("terms", [term({ is_current: false })]) }));
    const r = await fetchPeopleRoster(T);
    expect(r.feesReadable).toBe(true);
    expect(r.feeByStudent.size).toBe(0);
    expect(api.callsTo(`GET ${P}/finance/invoices`)).toHaveLength(0);
  });

  it("fails the page, rather than showing everyone as 'No invoice', when the invoices cannot be read for another reason", async () => {
    boot(withFees({ [`GET ${P}/finance/invoices`]: refused("internal_error", 500, "boom") }));
    await expect(fetchPeopleRoster(T)).rejects.toMatchObject({ code: "internal_error" });
  });
});

describe("archived learners", () => {
  it("lists them most recently archived first, with the class they still hold", async () => {
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/classes`]: list("classes", [klass(C1, "Form 1 East", 1)]),
      [`GET ${P}/learners`]: list("learners", [learner(7, { active: false, archived_at: "2026-03-01T00:00:00Z" }), learner(8, { active: false, archived_at: "2026-05-01T00:00:00Z" })]),
      [`GET ${P}/class-memberships`]: list("memberships", [member(8, C1)]),
    });
    const a = await fetchArchivedLearners(T);
    expect(a.map((l) => [l.id, l.class_id, l.archived_at])).toEqual([["l-8", C1, "2026-05-01T00:00:00Z"], ["l-7", null, "2026-03-01T00:00:00Z"]]);
    expect(api.callsTo(`GET ${P}/learners`)[0]!.query.get("active")).toBe("false");
  });
});

// ---------------------------------------------------------------- adding and changing a learner

describe("adding a learner", () => {
  const input = { tenantId: T, admissionNo: "4501", fullName: "Wanjiku Kamau", gender: "female" as const, classId: C1, boarding: true, dateOfBirth: null, home: { address: "x", landmark: null, lat: 1, lng: 2 } };

  it("makes the learner, then places them in the class, and leaves the home address out", async () => {
    boot({ [`POST ${P}/learners`]: created("learner", learner(5)), [`POST ${P}/class-memberships`]: created("membership", member(5, C1)) });
    expect(await addLearner(input)).toBe("l-5");
    expect(api.callsTo(`POST ${P}/learners`)[0]!.body).toEqual({ admission_no: "4501", full_name: "Wanjiku Kamau", gender: "female", boarding: true, date_of_birth: null });
    expect(api.callsTo(`POST ${P}/class-memberships`)[0]!.body).toEqual({ learner_id: "l-5", class_id: C1 });
  });

  it("makes no membership when there is no class", async () => {
    boot({ [`POST ${P}/learners`]: created("learner", learner(5)) });
    await addLearner({ ...input, classId: "" });
    expect(api.callsTo(`POST ${P}/class-memberships`)).toHaveLength(0);
  });

  it("passes on a refusal in the API's words, and places nobody", async () => {
    boot({ [`POST ${P}/learners`]: refused("conflict", 409, "Admission 4501 is already on the roster") });
    await expect(addLearner(input)).rejects.toMatchObject({ code: "conflict", message: "Admission 4501 is already on the roster" });
    expect(api.callsTo(`POST ${P}/class-memberships`)).toHaveLength(0);
  });

  it("says what is wrong with the learner in words", async () => {
    boot({ [`POST ${P}/learners`]: refused("validation_error", 400, "admission_no, full_name and gender are required", [{ field: "date_of_birth", code: "custom", message: "Invalid value" }]) });
    await expect(addLearner(input)).rejects.toThrow("Date of birth is not valid.");
  });

  it("reports a learner who was made but could not be placed, with their id", async () => {
    boot({ [`POST ${P}/learners`]: created("learner", learner(5)), [`POST ${P}/class-memberships`]: refused("validation_error", 400, "Learner or class must belong to this school") });
    const err = await addLearner(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LearnerPlacementError);
    expect(err).toMatchObject({ learnerId: "l-5", message: "Learner or class must belong to this school" });
  });
});

describe("changing a learner's details and class", () => {
  const change = { fullName: "New Name", admissionNo: "1001", gender: "female" as const, classId: C2 as string | null, boarding: true };
  const routes = (memberships: unknown[], extra: Record<string, FakeRoute> = {}) => ({
    [`PATCH ${P}/learners/l-1`]: { body: { learner: learner(1) } },
    [`GET ${P}/class-memberships`]: (c: FakeCall) => list("memberships", c.query.get("learnerId") === "l-1" ? (memberships as { active: boolean }[]).filter((m) => !c.query.has("active") || m.active) : []),
    [`GET ${P}/classes/${C2}`]: { body: { school_class: klass(C2, "Form 2 West", 2) } },
    [`GET ${P}/classes/${C27}`]: { body: { school_class: klass(C27, "Form 2 East 2027", 2, YEAR2) } },
    [`GET ${P}/academic-years`]: list("academic_years", [year()]),
    [`POST ${P}/class-memberships`]: created("membership", member(1, C2)),
    [`POST ${P}/class-memberships/m-1-c1/archive`]: { body: { membership: member(1, C1, YEAR, { active: false }) } },
    ...extra,
  });

  it("changes the details, leaving the gender alone when none is chosen", async () => {
    boot(routes([member(1, C2)]));
    await updateLearnerDetails("l-1", change);
    expect(api.callsTo(`PATCH ${P}/learners/l-1`)[0]!.body).toEqual({ full_name: "New Name", admission_no: "1001", boarding: true, gender: "female" });
    await updateLearnerDetails("l-1", { ...change, gender: null });
    expect(api.callsTo(`PATCH ${P}/learners/l-1`)[1]!.body).toEqual({ full_name: "New Name", admission_no: "1001", boarding: true });
  });

  it("does nothing to the class when it has not changed", async () => {
    boot(routes([member(1, C2)]));
    await updateLearnerDetails("l-1", change);
    expect(writes()).toEqual(["PATCH /learners/l-1"]);
  });

  it("reads and writes nothing about the class when none is given (a People-only teacher may not read classes or memberships)", async () => {
    boot(routes([member(1, C1)], { [`GET ${P}/class-memberships`]: refused("forbidden", 403, "Forbidden") }));
    await updateLearnerDetails("l-1", { fullName: change.fullName, admissionNo: change.admissionNo, gender: change.gender, boarding: change.boarding });
    expect(api.calls.map((c) => `${c.method} ${c.path.replace(P, "")}`)).toEqual(["PATCH /learners/l-1"]);
  });

  it("moves a learner: ends the class they are in this year, then places them in the new one", async () => {
    boot(routes([member(1, C1)]));
    await updateLearnerDetails("l-1", change);
    expect(writes()).toEqual(["PATCH /learners/l-1", "POST /class-memberships/m-1-c1/archive", "POST /class-memberships"]);
    expect(api.callsTo(`POST ${P}/class-memberships`)[0]!.body).toEqual({ learner_id: "l-1", class_id: C2 });
  });

  it("places a learner who has no class", async () => {
    boot(routes([]));
    await updateLearnerDetails("l-1", change);
    expect(writes()).toEqual(["PATCH /learners/l-1", "POST /class-memberships"]);
  });

  it("reads only the learner's active memberships (an ended one blocks nothing since migration 101)", async () => {
    boot(routes([member(1, C2)]));
    await updateLearnerDetails("l-1", change);
    const read = api.callsTo(`GET ${P}/class-memberships`)[0]!;
    expect(read.query.get("active")).toBe("true");
    expect(read.query.get("learnerId")).toBe("l-1");
  });

  it("puts a learner back in a class they left earlier this year: the API allows it, so nothing is refused first", async () => {
    boot(routes([member(1, C1), member(1, C2, YEAR, { id: "m-old", active: false, archived_at: "2026-02-01T00:00:00Z" })]));
    await updateLearnerDetails("l-1", change);
    expect(writes()).toEqual(["PATCH /learners/l-1", "POST /class-memberships/m-1-c1/archive", "POST /class-memberships"]);
    expect(api.callsTo(`POST ${P}/class-memberships`)[0]!.body).toEqual({ learner_id: "l-1", class_id: C2 });
  });

  it("gives a learner the class they were just taken out of straight back", async () => {
    // unassign, then choose the same class again: the second step places them where they were
    boot(routes([member(1, C2)], { [`POST ${P}/class-memberships/m-1-c2/archive`]: { body: { membership: member(1, C2, YEAR, { active: false }) } } }));
    await updateLearnerDetails("l-1", { ...change, classId: null });
    expect(writes()).toEqual(["PATCH /learners/l-1", "POST /class-memberships/m-1-c2/archive"]);
    boot(routes([], {}));
    await updateLearnerDetails("l-1", change);
    expect(writes()).toEqual(["PATCH /learners/l-1", "POST /class-memberships"]);
  });

  it("says plainly that a learner has no class when the new class is refused after the old one ended (it cannot be given back)", async () => {
    boot(routes([member(1, C1)], { [`POST ${P}/class-memberships`]: refused("conflict", 409, "That class is full") }));
    await expect(updateLearnerDetails("l-1", change)).rejects.toThrow(
      "The learner was taken out of their class but could not be placed in Form 2 West: That class is full. They have no class now: choose one again.",
    );
    expect(writes()).toEqual(["PATCH /learners/l-1", "POST /class-memberships/m-1-c1/archive", "POST /class-memberships"]);
  });

  it("passes the API's own refusal on when a learner with no class cannot be placed (nothing was taken away)", async () => {
    boot(routes([], { [`POST ${P}/class-memberships`]: refused("validation_error", 400, "cannot assign an inactive learner to a class") }));
    await expect(updateLearnerDetails("l-1", change)).rejects.toMatchObject({ message: "cannot assign an inactive learner to a class" });
  });

  it("only adds a membership for a class of another year, keeping the history", async () => {
    boot(routes([member(1, C1)]));
    await updateLearnerDetails("l-1", { ...change, classId: C27 });
    expect(writes()).toEqual(["PATCH /learners/l-1", "POST /class-memberships"]);
  });

  it("takes a learner out of this year's class when 'Unassigned' is chosen, and not out of another year's", async () => {
    boot(routes([member(1, C1), member(1, C27, YEAR2)], { [`POST ${P}/class-memberships/m-1-c7/archive`]: { body: {} } }));
    await updateLearnerDetails("l-1", { ...change, classId: null });
    expect(writes()).toEqual(["PATCH /learners/l-1", "POST /class-memberships/m-1-c1/archive"]);
  });

  it("has nothing to end when 'Unassigned' is chosen for a learner with no class this year", async () => {
    boot(routes([member(1, C27, YEAR2)]));
    await updateLearnerDetails("l-1", { ...change, classId: null });
    expect(writes()).toEqual(["PATCH /learners/l-1"]);
  });

  it("does nothing about the class when no academic year is current (there is no year's class to end)", async () => {
    boot(routes([member(1, C1)], { [`GET ${P}/academic-years`]: list("academic_years", []) }));
    await updateLearnerDetails("l-1", { ...change, classId: null });
    expect(writes()).toEqual(["PATCH /learners/l-1"]);
  });

  it("passes on a refusal to end the class in the API's words (a person without the Academics area)", async () => {
    boot(routes([member(1, C1)], { [`POST ${P}/class-memberships/m-1-c1/archive`]: refused("forbidden", 403, "Insufficient permissions") }));
    await expect(updateLearnerDetails("l-1", { ...change, classId: null })).rejects.toMatchObject({ code: "forbidden", message: "Insufficient permissions" });
  });

  it("passes on the API's refusal to edit an archived learner", async () => {
    boot(routes([], { [`PATCH ${P}/learners/l-1`]: refused("validation_error", 400, "Archived learners cannot be updated; restore first") }));
    await expect(updateLearnerDetails("l-1", change)).rejects.toThrow("Archived learners cannot be updated; restore first");
    expect(writes()).toEqual(["PATCH /learners/l-1"]);
  });
});

describe("archiving and restoring learners", () => {
  const ok = (id: string) => ({ body: { learner: learner(Number(id.slice(2))) } });

  it("archives each learner and counts them, doing nothing for an empty list", async () => {
    boot({ [`POST ${P}/learners/l-1/archive`]: ok("l-1"), [`POST ${P}/learners/l-2/archive`]: ok("l-2") });
    expect(await archiveLearners(["l-1", "l-2"])).toBe(2);
    expect(await archiveLearners([])).toBe(0);
    expect(api.calls).toHaveLength(2);
  });

  it("restores each learner", async () => {
    boot({ [`POST ${P}/learners/l-1/restore`]: ok("l-1") });
    expect(await restoreLearners(["l-1"])).toBe(1);
  });

  it("skips a learner who is already in that state, without counting or failing", async () => {
    boot({
      [`POST ${P}/learners/l-1/archive`]: ok("l-1"),
      [`POST ${P}/learners/l-2/archive`]: refused("validation_error", 400, "Learner is already archived"),
      [`POST ${P}/learners/l-3/restore`]: refused("validation_error", 400, "Learner is not archived"),
    });
    expect(await archiveLearners(["l-1", "l-2"])).toBe(1);
    expect(await restoreLearners(["l-3"])).toBe(0);
  });

  it("does the rest and then says how far it got when one fails", async () => {
    boot({
      [`POST ${P}/learners/l-1/archive`]: ok("l-1"),
      [`POST ${P}/learners/l-2/archive`]: refused("forbidden", 403, "Insufficient permissions"),
      [`POST ${P}/learners/l-3/archive`]: ok("l-3"),
    });
    await expect(archiveLearners(["l-1", "l-2", "l-3"])).rejects.toThrow(/^2 of 3 archived\. /);
    expect(api.callsTo(`POST ${P}/learners/l-3/archive`)).toHaveLength(1);
  });

  it("gives the failure alone when nothing was changed", async () => {
    boot({ [`POST ${P}/learners/l-1/restore`]: refused("not_found", 404, "Learner not found") });
    await expect(restoreLearners(["l-1"])).rejects.toThrow("Learner not found");
  });

  it("never has more than four requests at once", async () => {
    let live = 0;
    let most = 0;
    const slow: FakeRoute = async () => { live++; most = Math.max(most, live); await new Promise((r) => setTimeout(r, 5)); live--; return { body: { learner: learner(1) } }; };
    const ids = Array.from({ length: 12 }, (_, i) => `l-${i + 1}`);
    boot(Object.fromEntries(ids.map((id) => [`POST ${P}/learners/${id}/archive`, slow])));
    expect(await archiveLearners(ids)).toBe(12);
    expect(most).toBeLessThanOrEqual(4);
    expect(most).toBeGreaterThan(1);
  });

  it("cannot delete a learner on the API", async () => {
    boot({});
    const err = await deleteLearners(["l-1"]).catch((e: unknown) => e);
    expect(isNotOnApiError(err)).toBe(true);
    expect(api.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- staff

describe("staff", () => {
  it("adds a member of staff to the directory", async () => {
    boot({ [`POST ${P}/staff`]: created("staff", staffRec("s9", "Otieno Ouma", "driver")) });
    const id = await apiAddStaff({ tenantId: T, fullName: "Otieno Ouma", role: "driver", staffTitle: null, phone: "0712 345 678", email: "otieno@school.test" });
    expect(id).toBe("s9");
    expect(api.callsTo(`POST ${P}/staff`)[0]!.body).toEqual({ full_name: "Otieno Ouma", classification: "driver", staff_title: null, phone: "0712 345 678", email: "otieno@school.test" });
  });

  it("says what is wrong with a phone number in words", async () => {
    boot({ [`POST ${P}/staff`]: refused("validation_error", 400, "Invalid request", [{ field: "phone", code: "invalid_format", message: "x" }]) });
    await expect(apiAddStaff({ tenantId: T, fullName: "A", role: "staff", staffTitle: "Librarian", phone: "abc", email: null })).rejects.toThrow("Phone is not in the right format.");
  });

  it("changes a member of staff's details, clearing a title or phone with null", async () => {
    boot({ [`PATCH ${P}/staff/s1`]: { body: { staff: staffRec("s1", "New", "teacher") } } });
    await updateStaffDetails("s1", { fullName: "New", staffTitle: null, phone: null });
    expect(api.callsTo(`PATCH ${P}/staff/s1`)[0]!.body).toEqual({ full_name: "New", staff_title: null, phone: null });
  });

  it("archives and restores a member of staff, and lists the archived by name", async () => {
    boot({
      [`POST ${P}/staff/s1/archive`]: { body: { staff: staffRec("s1", "A", "teacher", { active: false }) } },
      [`POST ${P}/staff/s1/restore`]: { body: { staff: staffRec("s1", "A", "teacher") } },
      [`GET ${P}/staff`]: list("staff", [staffRec("s3", "Zed", "staff", { active: false }), staffRec("s2", "Abel", "driver", { active: false })]),
    });
    await apiArchiveStaff("s1");
    await apiRestoreStaff("s1");
    expect(writes()).toEqual(["POST /staff/s1/archive", "POST /staff/s1/restore"]);
    expect((await apiFetchArchivedStaff(T)).map((s) => s.full_name)).toEqual(["Abel", "Zed"]);
    expect(api.callsTo(`GET ${P}/staff`)[0]!.query.get("active")).toBe("false");
  });

  it("cannot review a staff photo or set a teacher's subjects on the API", async () => {
    boot({});
    expect(isNotOnApiError(await reviewStaffPhoto("s1", true).catch((e: unknown) => e))).toBe(true);
    expect(isNotOnApiError(await setTeacherQualified({ tenantId: T, teacherId: "s1", subjectId: "su1", qualified: true }).catch((e: unknown) => e))).toBe(true);
  });
});

// ---------------------------------------------------------------- guardians

describe("guardians", () => {
  const item = (id: string, over: Record<string, unknown> = {}) => ({ id, tenantId: T, full_name: "Mary Kamau", phone: "0712 345 678", alt_phone: null, email: "m@x.co", linkId: `k-${id}`, relationship: "mother", is_primary_payer: true, created_at: "2026-01-01T00:00:00Z", ...over });

  it("lists a learner's guardians as contacts, keyed by the guardian's id", async () => {
    boot({ [`GET ${P}/learners/l-1/guardians`]: { body: { items: [item("g1"), item("g2", { relationship: "father", alt_phone: "0722 111 222", email: null })], page: page() } } });
    const g = await fetchLearnerGuardians("l-1");
    expect(g).toEqual([
      { profile_id: "g1", relationship: "mother", full_name: "Mary Kamau", phone: "0712 345 678", alt_phone: null, email: "m@x.co" },
      { profile_id: "g2", relationship: "father", full_name: "Mary Kamau", phone: "0712 345 678", alt_phone: "0722 111 222", email: null },
    ]);
  });

  it("says plainly who may see them when the person may not", async () => {
    boot({ [`GET ${P}/learners/l-1/guardians`]: refused("forbidden", 403, "Insufficient permissions") });
    await expect(fetchLearnerGuardians("l-1")).rejects.toThrow("Only the school administrator, and staff they allow, can see guardians.");
  });

  it("adds a guardian and links them to the learner", async () => {
    boot({ [`POST ${P}/guardians`]: created("guardian", { id: "g1", tenantId: T, links: [] }) });
    await apiAddGuardian("l-1", { fullName: "Mary Kamau", relationship: "mother", phone: "0712 345 678", altPhone: null, email: null, primaryPayer: true });
    expect(api.callsTo(`POST ${P}/guardians`)[0]!.body).toEqual({
      full_name: "Mary Kamau", phone: "0712 345 678", alt_phone: null, email: null, learners: [{ learner_id: "l-1", relationship: "mother", is_primary_payer: true }],
    });
  });

  it("says what is wrong with a guardian's details in words", async () => {
    boot({ [`POST ${P}/guardians`]: refused("validation_error", 400, "full_name and at least one learner are required", [{ field: "phone", code: "invalid_format", message: "x" }]) });
    await expect(apiAddGuardian("l-1", { fullName: "M", relationship: "mother", phone: "abc", altPhone: null, email: null, primaryPayer: false })).rejects.toThrow("Phone is not in the right format.");
  });
});

// ---------------------------------------------------------------- importing from a spreadsheet

describe("learnersCsv", () => {
  const row = (over: Partial<ImportLearnerRow> = {}): ImportLearnerRow => ({ line: 2, admissionNo: "4501", fullName: "Wanjiku Kamau", gender: "female", dateOfBirth: "2010-03-14", boarding: true, classId: C1, ...over });

  it("writes the API's five columns, a row each", () => {
    expect(learnersCsv([row(), row({ admissionNo: "4502", fullName: "Otieno", gender: "male", dateOfBirth: null, boarding: false })])).toBe(
      "admission_no,full_name,gender,date_of_birth,boarding\n4501,Wanjiku Kamau,female,2010-03-14,true\n4502,Otieno,male,,false",
    );
  });

  it("quotes a comma or a quote, and never lets a line break shift the line numbers", () => {
    const csv = learnersCsv([row({ fullName: 'Kamau, "Wanjiku"' }), row({ admissionNo: "4502", fullName: "Two\nLines\r\nHere" })]);
    expect(csv.split("\n")).toHaveLength(3);
    expect(csv).toContain('"Kamau, ""Wanjiku"""');
    expect(csv).toContain("Two Lines Here");
  });
});

describe("importing learners", () => {
  const row = (n: number, over: Partial<ImportLearnerRow> = {}): ImportLearnerRow => ({ line: n + 1, admissionNo: String(5000 + n), fullName: `Import ${n}`, gender: "female", dateOfBirth: null, boarding: false, classId: C1, ...over });
  const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i + 1));
  const preview = (id: string, n: number, errors: { line: number; message: string }[] = [], truncated = false): FakeReply => ({
    body: { preview: { import_id: id, row_count: n, valid_count: n - errors.length, error_count: errors.length, errors_truncated: truncated, errors, sample_valid: [] } },
  });
  const apply = (id: string, n: number): FakeReply => ({ body: { result: { created_count: n, import_id: id, replayed: false } } });
  const after = (n: number) => list("learners", Array.from({ length: n }, (_, i) => learner(i + 1, { id: `new-${i + 1}`, admission_no: String(5000 + i + 1) })));

  it("checks the file, makes the learners, and places each in their class", async () => {
    boot({
      [`POST ${P}/imports/learners/preview`]: preview("imp-1", 3), [`POST ${P}/imports/learners/apply`]: apply("imp-1", 3),
      [`GET ${P}/learners`]: after(3), [`POST ${P}/class-memberships`]: created("membership", member(1, C1)),
    });
    const out = await apiImportLearners(T, [row(1, { classId: C1 }), row(2, { classId: C2 }), row(3, { classId: C1 })]);
    expect(out).toEqual({ created: 3, placed: 3, unplaced: [] });
    expect(api.callsTo(`POST ${P}/imports/learners/preview`)[0]!.body).toEqual({ csv: learnersCsv([row(1), row(2), row(3)]) });
    expect(api.callsTo(`POST ${P}/imports/learners/apply`)[0]!.body).toEqual({ import_id: "imp-1" });
    const placed = api.callsTo(`POST ${P}/class-memberships`).map((c) => c.body as { learner_id: string; class_id: string }).sort((a, b) => a.learner_id.localeCompare(b.learner_id));
    expect(placed).toEqual([{ learner_id: "new-1", class_id: C1 }, { learner_id: "new-2", class_id: C2 }, { learner_id: "new-3", class_id: C1 }]);
  });

  it("makes nothing when the API refuses rows, and names each line in the person's own file", async () => {
    boot({ [`POST ${P}/imports/learners/preview`]: preview("imp-1", 3, [{ line: 3, message: "admission_no already exists in this school" }, { line: 4, message: "gender must be male or female" }]) });
    // the rows were on lines 10, 20 and 30 of the person's file
    const err = await apiImportLearners(T, [row(1, { line: 10 }), row(2, { line: 20 }), row(3, { line: 30 })]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportRejectedError);
    expect((err as ImportRejectedError).problems).toEqual([{ line: 20, message: "admission_no already exists in this school" }, { line: 30, message: "gender must be male or female" }]);
    expect((err as Error).message).toBe("2 rows need fixing: line 20: admission_no already exists in this school; line 30: gender must be male or female. Nothing was imported.");
    expect(api.callsTo(`POST ${P}/imports/learners/apply`)).toHaveLength(0);
  });

  it("counts every refused row when the API lists only the first ones, and says there are more", async () => {
    boot({
      [`POST ${P}/imports/learners/preview`]: {
        body: { preview: { import_id: "imp-1", row_count: 40, valid_count: 10, error_count: 30, errors_truncated: true, errors: [{ line: 2, message: "gender must be male or female" }], sample_valid: [] } },
      },
    });
    const err = await apiImportLearners(T, rows(40)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportRejectedError);
    expect((err as Error).message).toBe("30 rows need fixing: line 2: gender must be male or female; and more. Nothing was imported.");
    expect(api.callsTo(`POST ${P}/imports/learners/apply`)).toHaveLength(0);
  });

  it("lists five problems at most, then says there are more", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ line: i + 2, message: "x" }));
    expect(new ImportRejectedError(six, false).message).toBe("6 rows need fixing: line 2: x; line 3: x; line 4: x; line 5: x; line 6: x; and more. Nothing was imported.");
    expect(new ImportRejectedError(six.slice(0, 1), false).message).toBe("1 row needs fixing: line 2: x. Nothing was imported.");
    expect(new ImportRejectedError([], true, 3).message).toBe("3 rows need fixing. Nothing was imported.");
  });

  it("makes nothing when the API counts refused rows but lists none", async () => {
    boot({ [`POST ${P}/imports/learners/preview`]: { body: { preview: { import_id: "imp-1", row_count: 2, valid_count: 0, error_count: 2, errors_truncated: false, errors: [], sample_valid: [] } } } });
    await expect(apiImportLearners(T, rows(2))).rejects.toThrow("2 rows need fixing. Nothing was imported.");
    expect(api.callsTo(`POST ${P}/imports/learners/apply`)).toHaveLength(0);
  });

  it("never places more than four at once", async () => {
    let live = 0;
    let most = 0;
    const slow: FakeRoute = async () => { live++; most = Math.max(most, live); await new Promise((r) => setTimeout(r, 5)); live--; return created("membership", member(1, C1)); };
    boot({ [`POST ${P}/imports/learners/preview`]: preview("imp-1", 12), [`POST ${P}/imports/learners/apply`]: apply("imp-1", 12), [`GET ${P}/learners`]: after(12), [`POST ${P}/class-memberships`]: slow });
    expect(await apiImportLearners(T, rows(12))).toEqual({ created: 12, placed: 12, unplaced: [] });
    expect(most).toBeLessThanOrEqual(4);
    expect(most).toBeGreaterThan(1);
  });

  it("reports a learner the list after the import does not have as not placed", async () => {
    boot({ [`POST ${P}/imports/learners/preview`]: preview("imp-1", 3), [`POST ${P}/imports/learners/apply`]: apply("imp-1", 3), [`GET ${P}/learners`]: after(2), [`POST ${P}/class-memberships`]: created("membership", member(1, C1)) });
    expect(await apiImportLearners(T, rows(3))).toEqual({ created: 3, placed: 2, unplaced: [{ admissionNo: "5003", reason: "not found after the import" }] });
    expect(api.callsTo(`POST ${P}/class-memberships`)).toHaveLength(2);
  });

  it("sends a file of more than 1,000 learners in several, all checked before any is made", async () => {
    let previews = 0;
    let applies = 0;
    boot({
      [`POST ${P}/imports/learners/preview`]: (c: FakeCall) => { previews++; return preview(`imp-${previews}`, String((c.body as { csv: string }).csv).split("\n").length - 1); },
      [`POST ${P}/imports/learners/apply`]: (c: FakeCall) => { applies++; return apply((c.body as { import_id: string }).import_id, applies === 1 ? IMPORT_BATCH_ROWS : 1); },
    });
    const out = await apiImportLearners(T, rows(IMPORT_BATCH_ROWS + 1).map((r) => ({ ...r, classId: null })));
    expect(out).toEqual({ created: IMPORT_BATCH_ROWS + 1, placed: 0, unplaced: [] });
    const order = api.calls.filter((c) => c.method === "POST").map((c) => c.path.split("/").pop());
    expect(order).toEqual(["preview", "preview", "apply", "apply"]);
  });

  it("says how many were made when a later file is refused at the apply step", async () => {
    let applies = 0;
    boot({
      [`POST ${P}/imports/learners/preview`]: preview("imp", 1),
      [`POST ${P}/imports/learners/apply`]: () => (++applies === 1 ? apply("imp", IMPORT_BATCH_ROWS) : refused("conflict", 409, "Admission 6000 is already on the roster")),
    });
    await expect(apiImportLearners(T, rows(IMPORT_BATCH_ROWS + 1).map((r) => ({ ...r, classId: null })))).rejects.toThrow(
      "1000 learners were imported before this stopped: Admission 6000 is already on the roster",
    );
  });

  it("reports the learners who were made but could not be placed", async () => {
    boot({
      [`POST ${P}/imports/learners/preview`]: preview("imp-1", 3), [`POST ${P}/imports/learners/apply`]: apply("imp-1", 3), [`GET ${P}/learners`]: after(3),
      [`POST ${P}/class-memberships`]: (c: FakeCall) => ((c.body as { learner_id: string }).learner_id === "new-2" ? refused("validation_error", 400, "Learner or class must belong to this school") : created("membership", member(1, C1))),
    });
    const out = await apiImportLearners(T, rows(3));
    expect(out).toEqual({ created: 3, placed: 2, unplaced: [{ admissionNo: "5002", reason: "Learner or class must belong to this school" }] });
  });

  it("places nobody, and lists nobody, when no row has a class", async () => {
    boot({ [`POST ${P}/imports/learners/preview`]: preview("imp-1", 2), [`POST ${P}/imports/learners/apply`]: apply("imp-1", 2) });
    expect(await apiImportLearners(T, rows(2).map((r) => ({ ...r, classId: null })))).toEqual({ created: 2, placed: 0, unplaced: [] });
    expect(api.callsTo(`GET ${P}/learners`)).toHaveLength(0);
  });

  it("says the learners were made when they could not be looked up to be placed", async () => {
    boot({ [`POST ${P}/imports/learners/preview`]: preview("imp-1", 2), [`POST ${P}/imports/learners/apply`]: apply("imp-1", 2), [`GET ${P}/learners`]: refused("internal_error", 500) });
    await expect(apiImportLearners(T, rows(2))).rejects.toThrow(/^The 2 learners were imported, but could not be placed in their classes: .+ Place them from Manage\.$/);
  });

  it("does nothing for no rows", async () => {
    boot({});
    expect(await apiImportLearners(T, [])).toEqual({ created: 0, placed: 0, unplaced: [] });
    expect(api.calls).toHaveLength(0);
  });
});

describe("peopleCapabilities", () => {
  it("offers on Supabase everything it had, and not the API-only extras", () => {
    initBackend({ kind: "supabase" });
    const c = peopleCapabilities();
    expect(c).toMatchObject({ deleteLearner: true, learnerLogins: true, inviteGuardians: true, guardianInvitations: false, staffSignIn: false, staffAccounts: true, learnerHome: true, bulkChangeClass: true, staffArchive: false, guardianContactForm: false, learnerWithoutClass: false, importByAreaHolders: true, unassignClass: true });
  });

  it("offers on the API the learner record reads and writes it supports", () => {
    initBackend({ kind: "api", apiUrl: BASE });
    const c = peopleCapabilities();
    expect(c).toMatchObject({ staffArchive: true, guardianContactForm: true, learnerWithoutClass: true, learnerLogins: true, learnerFees: true, learnerEarlySignOuts: true, learnerActivities: true, unassignClass: true, inviteGuardians: false, guardianInvitations: true, staffSignIn: true, staffAccounts: false });
    // learnerBehaviour: the behaviour log is on the API (docs/web-on-api/behaviour.md)
    const on = ["staffArchive", "guardianContactForm", "learnerWithoutClass", "learnerLogins", "learnerFees", "learnerEarlySignOuts", "learnerActivities", "unassignClass", "guardianInvitations", "staffSignIn", "learnerBehaviour"];
    const off = Object.entries(c).filter(([k]) => !on.includes(k)).filter(([, v]) => v);
    expect(off).toEqual([]);
  });
});
