import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import {
  FULL_MEDICAL_ACCESS, MEDICAL_HEALTH_HIDDEN, MEDICAL_LEARNERS_HIDDEN, medicalAccessNotes, medicalCapabilities, NotOnApiError,
} from "../capabilities";
import {
  addVisitMedication, approveRequest, declineRequest, fetchChildMedical, fetchDoses, fetchMedicalAccess, fetchMedicalStock, fetchNotifyPolicy,
  fetchOpenVisits, fetchPendingRequests, fetchSchedules, fetchUnreadMedicalNotices, fetchVisits, findMedicalLearners, logVisit,
  markMedicalNoticesRead, markVisitAttendance, openMedicalRecord, pushMedicalNotices, recordDose, requestMedication, saveNotifyPolicy,
  saveSchedule, stopSchedule, updateVisit, withdrawMedicationRequest, type SickBayVisitDraft,
} from "../medical";
import { emptyHealth, fetchStudentHealth, saveStudentHealth } from "../studentHealth";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { isApiError } from "./errors";
import { apiOpenMedicalRecord, HIDDEN_LEARNER, resetMedicalApiCache, sickBayVisitFromApi, studentHealthFromApi } from "./medicalApi";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const YEAR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const L1 = "51111111-1111-4111-8111-111111111111";
const L2 = "52222222-2222-4222-8222-222222222222";
const V1 = "71111111-1111-4111-8111-111111111111";
const V2 = "72222222-2222-4222-8222-222222222222";
const U1 = "61111111-1111-4111-8111-111111111111";

const stamp = { created_at: "2026-11-20T08:00:00Z", updated_at: "2026-11-20T08:00:00Z" };
const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const list = (key: string, items: unknown[], next: string | null = null): FakeReply => ({ body: { [key]: items, page: page(next) } });
const refused = (code: string, status: number, message = "no"): FakeReply => ({ status, body: { error: { code, message } } });

const apiVisit = (o: Record<string, unknown> = {}) => ({
  id: V1, tenant_id: T, learner_id: L1, time_in: "2026-11-24T08:00:00Z", complaint: "Headache", temperature_c: "38.5", pulse_bpm: 90,
  observations: null, assessment: null, treatment: null, outcome: null, referred_to: null, time_out: null, follow_up: null,
  attendance_mark: null, attendance_marked_at: null, logged_by: U1, row_version: 1, correction_reason: null, updated_at: "2026-11-24T08:00:00Z", ...o,
});
const apiLearner = (o: Record<string, unknown> = {}) => ({
  id: L1, tenantId: T, admission_no: "ADM-1001", full_name: "Amina Ochieng", gender: "female", date_of_birth: "2011-03-14",
  boarding: false, active: true, archived_at: null, ...stamp, ...o,
});
const apiYear = { id: YEAR, tenantId: T, label: "2026", starts_on: "2026-01-01", ends_on: "2026-12-31", is_current: true, ...stamp };
const apiClass = { id: C1, tenantId: T, academic_year_id: YEAR, name: "Form 1 East", form_level: 1, education_level: "secondary", pathway: null, stream: "East", class_teacher_staff_id: null, active: true, archived_at: null, ...stamp };
const apiMembership = (learnerId: string) => ({ id: `m-${learnerId}`, tenantId: T, learner_id: learnerId, class_id: C1, academic_year_id: YEAR, active: true, archived_at: null, ...stamp });
const apiProfile = (o: Record<string, unknown> = {}) => ({
  id: "p1", tenant_id: T, learner_id: L1, blood_group: "O+", allergies: ["Peanuts"], chronic_conditions: ["Asthma"], dietary_notes: "No pork",
  emergency_notes: "Call the mother first", row_version: 1, updated_at: "2026-11-20T08:00:00Z", ...o,
});

const draft = (o: Partial<SickBayVisitDraft> = {}): SickBayVisitDraft => ({
  student_id: L1, time_in: "2026-11-24T08:00:00.000Z", complaint: " Headache ", temperature_c: 38.5, pulse_bpm: 90, observations: "", assessment: "",
  treatment: "", outcome: null, referred_to: "", time_out: null, follow_up: "", ...o,
});

const P = `/v1/tenants/${T}`;
const H = `${P}/health`;
const classRoutes = (...learnerIds: string[]): Record<string, FakeRoute> => ({
  [`GET ${P}/academic-years`]: list("academic_years", [apiYear]),
  [`GET ${P}/classes`]: list("classes", [apiClass]),
  [`GET ${P}/class-memberships`]: (call) => list("memberships", learnerIds.filter((id) => !call.query.get("learnerId") || call.query.get("learnerId") === id).map(apiMembership)),
});

let api: FakeApi;

function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: U1 }));
  setApiActiveTenant(T);
  return api;
}

beforeEach(() => resetMedicalApiCache());
afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

describe("what the sick bay screen offers", () => {
  it("offers everything on Supabase and hides what the API has no endpoint for", () => {
    initBackend({ kind: "supabase" });
    expect(medicalCapabilities()).toEqual({
      visitHistory: true, editVisitTimeIn: true, visitMedications: true, markVisitAttendance: true, medicationRound: true,
      medicationRequests: true, reports: true, guardianNoticesEmitted: true, recordOpenAudited: true,
    });
    initBackend({ kind: "api", apiUrl: BASE });
    expect(medicalCapabilities()).toEqual({
      visitHistory: false, editVisitTimeIn: false, visitMedications: false, markVisitAttendance: false, medicationRound: false,
      medicationRequests: false, reports: false, guardianNoticesEmitted: false, recordOpenAudited: false,
    });
  });

  it("says what is held back from someone who can open the page but not read learners or health records", () => {
    expect(medicalAccessNotes(FULL_MEDICAL_ACCESS)).toEqual([]);
    expect(medicalAccessNotes({ learners: false, healthRecords: true })).toEqual([MEDICAL_LEARNERS_HIDDEN]);
    expect(medicalAccessNotes({ learners: true, healthRecords: false })).toEqual([MEDICAL_HEALTH_HIDDEN]);
    expect(medicalAccessNotes({ learners: false, healthRecords: false })).toHaveLength(2);
  });

  it("works out access from the permissions: names need the learner read, health records the medication read", async () => {
    boot({ [`GET /v1/rbac/permissions`]: list("items", ["resource.medical.read", "resource.medical.write"]) });
    expect(await fetchMedicalAccess()).toEqual({ learners: false, healthRecords: false });
    api.on(`GET /v1/rbac/permissions`, list("items", ["resource.medical.read", "resource.learner.read", "resource.medication.read"]));
    expect(await fetchMedicalAccess()).toEqual({ learners: true, healthRecords: true });
    api.on(`GET /v1/rbac/permissions`, refused("forbidden", 403));
    expect(await fetchMedicalAccess()).toEqual({ learners: false, healthRecords: false });
    api.on(`GET /v1/rbac/permissions`, refused("internal_error", 500));
    await expect(fetchMedicalAccess()).rejects.toMatchObject({ code: "internal_error" });
  });

  it("gives full access on Supabase without asking the API", async () => {
    initBackend({ kind: "supabase" });
    expect(await fetchMedicalAccess()).toEqual(FULL_MEDICAL_ACCESS);
  });
});

describe("the board and finding a learner", () => {
  it("reads every page of open visits and gives each learner a name and a class", async () => {
    boot({
      [`GET ${H}/sick-bay/board`]: (call) => (call.query.get("cursor") === "p2"
        ? list("visits", [apiVisit({ id: V2, learner_id: L2, complaint: "Fever", temperature_c: null })])
        : list("visits", [apiVisit()], "p2")),
      [`GET ${P}/learners/${L1}`]: { body: { learner: apiLearner() } },
      [`GET ${P}/learners/${L2}`]: { body: { learner: apiLearner({ id: L2, admission_no: "ADM-1002", full_name: "Brian Mwangi" }) } },
      ...classRoutes(L1),
    });
    const visits = await fetchOpenVisits(T);
    expect(visits.map((v) => [v.id, v.student_id, v.complaint, v.temperature_c, v.students?.full_name, v.students?.admission_no, v.students?.classes?.name ?? null])).toEqual([
      [V1, L1, "Headache", 38.5, "Amina Ochieng", "ADM-1001", "Form 1 East"],
      [V2, L2, "Fever", null, "Brian Mwangi", "ADM-1002", null],
    ]);
    // a few visits cost a few calls: no list of the whole school is read
    expect(api.callsTo(`GET ${P}/learners`)).toHaveLength(0);
    expect(api.callsTo(`GET ${H}/sick-bay/board`)[0]!.query.get("limit")).toBe("200");
  });

  it("says the name is not shown when learners may not be read, and still lists the visit", async () => {
    boot({
      [`GET ${H}/sick-bay/board`]: list("visits", [apiVisit()]),
      [`GET ${P}/learners/${L1}`]: refused("forbidden", 403),
    });
    const [v] = await fetchOpenVisits(T);
    expect(v!.students).toEqual(HIDDEN_LEARNER);
    expect(v!.student_id).toBe(L1);
  });

  it("lists nothing, and reads nothing else, when nobody is in the sick bay", async () => {
    boot({ [`GET ${H}/sick-bay/board`]: list("visits", []) });
    expect(await fetchOpenVisits(T)).toEqual([]);
    expect(api.calls).toHaveLength(1);
  });

  it("refuses the board to someone without the Medical area", async () => {
    boot({ [`GET ${H}/sick-bay/board`]: refused("forbidden", 403, "Missing permission") });
    const err = await fetchOpenVisits(T).catch((e: unknown) => e);
    expect(isApiError(err) && err.code).toBe("forbidden");
  });

  it("searches learners with the API's own search, eight at most, with their classes", async () => {
    boot({
      [`GET ${P}/learners`]: list("learners", [apiLearner()]),
      ...classRoutes(L1),
    });
    expect(await findMedicalLearners(T, "a")).toEqual([]);
    expect(api.calls).toHaveLength(0);
    expect(await findMedicalLearners(T, " ami ")).toEqual([{ id: L1, full_name: "Amina Ochieng", admission_no: "ADM-1001", class_name: "Form 1 East" }]);
    const q = api.callsTo(`GET ${P}/learners`)[0]!.query;
    expect([q.get("q"), q.get("active"), q.get("limit"), q.get("sort")]).toEqual(["ami", "true", "8", "name"]);
  });

  it("finds learners without classes when classes may not be read, and fails for someone who may not read learners", async () => {
    boot({
      [`GET ${P}/learners`]: list("learners", [apiLearner()]),
      [`GET ${P}/academic-years`]: refused("forbidden", 403),
    });
    expect((await findMedicalLearners(T, "ami"))[0]!.class_name).toBeNull();
    api.on(`GET ${P}/learners`, refused("forbidden", 403));
    await expect(findMedicalLearners(T, "ami")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("maps a visit, keeping the temperature a number", () => {
    expect(sickBayVisitFromApi(apiVisit({ outcome: "home", referred_to: "Home" }) as never)).toMatchObject({
      id: V1, student_id: L1, temperature_c: 38.5, pulse_bpm: 90, outcome: "home", referred_to: "Home", time_out: null, visit_medications: [], students: null,
    });
  });
});

describe("logging and changing a visit", () => {
  it("logs a visit that is still being seen with one call, trimmed, and the server's own time in", async () => {
    boot({ [`POST ${H}/sick-bay/visits`]: { status: 201, body: { visit: apiVisit({ time_in: "2026-11-24T08:00:03Z" }) } } });
    const v = await logVisit(T, draft());
    expect(api.callsTo(`POST ${H}/sick-bay/visits`)[0]!.body).toEqual({
      learner_id: L1, complaint: "Headache", temperature_c: 38.5, pulse_bpm: 90, observations: null, assessment: null, treatment: null,
    });
    expect(api.callsTo(`PATCH ${H}/sick-bay/visits/${V1}`)).toHaveLength(0);
    expect(v.time_in).toBe("2026-11-24T08:00:03Z");
  });

  it("follows a new visit that has an outcome with a change, at the version the server gave", async () => {
    boot({
      [`POST ${H}/sick-bay/visits`]: { status: 201, body: { visit: apiVisit({ row_version: 1 }) } },
      [`PATCH ${H}/sick-bay/visits/${V1}`]: { body: { visit: apiVisit({ outcome: "home", time_out: "2026-11-24T09:00:00Z", row_version: 2 }) } },
    });
    const v = await logVisit(T, draft({ outcome: "home", time_out: "2026-11-24T09:00:00Z", follow_up: " Check tomorrow " }));
    expect(api.callsTo(`PATCH ${H}/sick-bay/visits/${V1}`)[0]!.body).toEqual({
      row_version: 1, outcome: "home", referred_to: null, time_out: "2026-11-24T09:00:00Z", follow_up: "Check tomorrow",
    });
    expect(v).toMatchObject({ outcome: "home", time_out: "2026-11-24T09:00:00Z" });
  });

  it("never sends a time out earlier than the time the server stamped (the database refuses it)", async () => {
    boot({
      [`POST ${H}/sick-bay/visits`]: { status: 201, body: { visit: apiVisit({ time_in: "2026-11-24T08:00:05Z" }) } },
      [`PATCH ${H}/sick-bay/visits/${V1}`]: { body: { visit: apiVisit({ outcome: "home" }) } },
    });
    await logVisit(T, draft({ outcome: "home", time_out: "2026-11-24T08:00:01Z" }));
    expect((api.callsTo(`PATCH ${H}/sick-bay/visits/${V1}`)[0]!.body as { time_out: string }).time_out).toBe("2026-11-24T08:00:05Z");
  });

  it("tells the nurse not to log it again when the visit was made but its outcome was refused", async () => {
    boot({
      [`POST ${H}/sick-bay/visits`]: { status: 201, body: { visit: apiVisit() } },
      [`PATCH ${H}/sick-bay/visits/${V1}`]: refused("validation_error", 400, "referred_to is required for hospital outcome"),
    });
    const err = await logVisit(T, draft({ outcome: "hospital" })).catch((e: unknown) => e);
    expect((err as Error).message).toContain("The visit was logged");
    expect((err as Error).message).toContain("referred_to is required for hospital outcome");
    expect((err as Error).message).toContain("Do not log it again");
    expect(api.callsTo(`POST ${H}/sick-bay/visits`)).toHaveLength(1);
  });

  it("asks for a learner before sending anything, and passes a refusal on", async () => {
    boot({ [`POST ${H}/sick-bay/visits`]: refused("forbidden", 403) });
    await expect(logVisit(T, draft({ student_id: null }))).rejects.toThrow("Pick the learner.");
    expect(api.calls).toHaveLength(0);
    await expect(logVisit(T, draft())).rejects.toMatchObject({ code: "forbidden" });
  });

  it("changes a visit at the version it was read at, and takes the new version from the answer", async () => {
    boot({
      [`GET ${H}/sick-bay/board`]: list("visits", [apiVisit({ row_version: 4 })]),
      [`GET ${P}/learners/${L1}`]: refused("forbidden", 403),
      [`PATCH ${H}/sick-bay/visits/${V1}`]: { body: { visit: apiVisit({ row_version: 5, treatment: "Rest" }) } },
    });
    await fetchOpenVisits(T);
    const v = await updateVisit(V1, draft({ treatment: "Rest", outcome: "rest" }));
    const body = api.callsTo(`PATCH ${H}/sick-bay/visits/${V1}`)[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ row_version: 4, complaint: "Headache", treatment: "Rest", outcome: "rest", time_out: null });
    expect(v.treatment).toBe("Rest");
    await updateVisit(V1, draft());
    expect((api.callsTo(`PATCH ${H}/sick-bay/visits/${V1}`)[1]!.body as { row_version: number }).row_version).toBe(5);
  });

  it("leaves the version out for a visit it never read, and passes a clash on", async () => {
    boot({ [`PATCH ${H}/sick-bay/visits/${V1}`]: refused("conflict", 409, "Sick bay visit was modified by another request (row_version mismatch)") });
    await expect(updateVisit(V1, draft())).rejects.toMatchObject({ code: "conflict" });
    expect("row_version" in (api.callsTo(`PATCH ${H}/sick-bay/visits/${V1}`)[0]!.body as object)).toBe(false);
  });
});

describe("a learner's health record", () => {
  it("reads it into the screen's shape: no blood group for 'unknown', blanks as nothing, and nothing for what the API does not hold", async () => {
    boot({ [`GET ${H}/learners/${L1}/profile`]: { body: { profile: apiProfile({ blood_group: "unknown", dietary_notes: "  " }) } } });
    expect(await fetchStudentHealth(L1)).toMatchObject({
      student_id: L1, allergies: ["Peanuts"], medical_conditions: ["Asthma"], blood_group: null, dietary_needs: null, notes: "Call the mother first",
      medications: null, special_needs: null, doctor_name: null, emergency_phone: null,
    });
    expect(studentHealthFromApi(apiProfile() as never).blood_group).toBe("O+");
  });

  it("answers nothing when there is no record or the person may not read it", async () => {
    boot({ [`GET ${H}/learners/${L1}/profile`]: { body: { profile: null } } });
    expect(await fetchStudentHealth(L1)).toBeNull();
    api.on(`GET ${H}/learners/${L1}/profile`, refused("forbidden", 403));
    expect(await fetchStudentHealth(L1)).toBeNull();
    api.on(`GET ${H}/learners/${L1}/profile`, refused("internal_error", 500));
    await expect(fetchStudentHealth(L1)).rejects.toMatchObject({ code: "internal_error" });
  });

  it("saves what the API holds, sending cleared fields as empty text so the old value does not stay", async () => {
    boot({ [`PUT ${H}/learners/${L1}/profile`]: { body: { profile: apiProfile({ blood_group: "unknown", dietary_notes: "", emergency_notes: "" }) } } });
    const saved = await saveStudentHealth(T, L1, { ...emptyHealth(), allergies: [" Peanuts ", "peanuts", "Eggs"], medical_conditions: ["Asthma"] });
    expect(api.callsTo(`PUT ${H}/learners/${L1}/profile`)[0]!.body).toEqual({
      blood_group: "unknown", allergies: ["Peanuts", "Eggs"], chronic_conditions: ["Asthma"], dietary_notes: "", emergency_notes: "",
    });
    expect(saved.dietary_needs).toBeNull();
    expect(saved.blood_group).toBeNull();
  });

  it("sends a blood group, diet and emergency notes as they are", async () => {
    boot({ [`PUT ${H}/learners/${L1}/profile`]: { body: { profile: apiProfile() } } });
    await saveStudentHealth(T, L1, { ...emptyHealth(), blood_group: "O+", dietary_needs: " No pork ", notes: "Call the mother first" });
    expect(api.callsTo(`PUT ${H}/learners/${L1}/profile`)[0]!.body).toMatchObject({ blood_group: "O+", dietary_notes: "No pork", emergency_notes: "Call the mother first" });
  });

  it("refuses a record with details the API cannot hold, before sending anything, and names them", async () => {
    boot({ [`PUT ${H}/learners/${L1}/profile`]: { body: { profile: apiProfile() } } });
    const err = await saveStudentHealth(T, L1, { ...emptyHealth(), medications: "Salbutamol", doctor_name: "Dr Njeri", emergency_phone: "0712" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotOnApiError);
    expect((err as Error).message).toContain("medicines taken, family doctor, emergency contact");
    expect(api.calls).toHaveLength(0);
  });

  it("passes a refusal to save on", async () => {
    boot({ [`PUT ${H}/learners/${L1}/profile`]: refused("forbidden", 403, "Missing permission") });
    await expect(saveStudentHealth(T, L1, emptyHealth())).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("one learner's medical record", () => {
  const now = new Date("2026-11-24T12:00:00Z");
  const mar = (id: string, outcome: string, scheduledFor: string, o: Record<string, unknown> = {}) => ({
    id, schedule_id: "s1", authorization_id: "au1", learner_id: L1, scheduled_for: scheduledFor, administered_at: outcome === "administered" ? scheduledFor : null,
    administered_by: U1, outcome, exception_reason: null, notes: null, created_at: scheduledFor, ...o,
  });

  it("gathers the health record, this learner's open visits and the last 60 days of doses, with corrections applied", async () => {
    boot({
      [`GET ${H}/learners/${L1}/profile`]: { body: { profile: apiProfile() } },
      [`GET ${H}/sick-bay/board`]: list("visits", [apiVisit(), apiVisit({ id: V2, learner_id: L2 })]),
      [`GET ${H}/learners/${L1}/medications/mar`]: {
        body: {
          records: [
            mar("m1", "administered", "2026-11-23T08:00:00Z"),
            mar("m2", "refused", "2026-11-22T08:00:00Z", { exception_reason: "Said no" }),
            mar("m3", "missed", "2026-11-21T08:00:00Z", { exception_reason: "Away" }),
            mar("m4", "delayed", "2026-11-20T08:00:00Z", { administered_at: "2026-11-20T09:00:00Z" }),
            mar("m5", "held", "2026-11-19T08:00:00Z", { exception_reason: "Vomiting" }),
            mar("m6", "exception", "2026-11-18T08:00:00Z", { exception_reason: "Trip" }),
            mar("m7", "administered", "2026-08-01T08:00:00Z"),
          ],
          corrections: [
            { id: "c1", mar_id: "m3", corrected_outcome: "administered", correction_reason: "Given late", corrected_by: U1, created_at: "2026-11-21T10:00:00Z" },
            { id: "c2", mar_id: "m3", corrected_outcome: "refused", correction_reason: "Re-checked", corrected_by: U1, created_at: "2026-11-21T11:00:00Z" },
          ],
        },
      },
    });
    const record = await apiOpenMedicalRecord(L1, now);
    expect(record.health?.allergies).toEqual(["Peanuts"]);
    expect(record.visits.map((v) => v.id)).toEqual([V1]);
    expect(Object.fromEntries(record.doses.map((d) => [d.id, d.status]))).toEqual({ m1: "given", m2: "refused", m3: "refused", m4: "given" });
    expect(record.doses.every((d) => /^\d\d:\d\d$/.test(d.due_time) && /^\d{4}-\d\d-\d\d$/.test(d.due_on))).toBe(true);
    expect(record.otherDoses).toBe(2);
    expect(record.schedules).toEqual([]);
    expect(record.requests).toEqual([]);
    expect(record.doses.find((d) => d.id === "m2")!.note).toBe("Said no");
  });

  it("opens through the shared function and leaves out the parts the person may not read", async () => {
    boot({
      [`GET ${H}/learners/${L1}/profile`]: refused("forbidden", 403),
      [`GET ${H}/sick-bay/board`]: list("visits", [apiVisit()]),
      [`GET ${H}/learners/${L1}/medications/mar`]: refused("forbidden", 403),
    });
    const record = await openMedicalRecord(L1);
    expect(record).toMatchObject({ health: null, doses: [], otherDoses: 0 });
    expect(record.visits).toHaveLength(1);
  });

  it("fails when the board itself cannot be read", async () => {
    boot({
      [`GET ${H}/learners/${L1}/profile`]: { body: { profile: null } },
      [`GET ${H}/sick-bay/board`]: refused("forbidden", 403),
      [`GET ${H}/learners/${L1}/medications/mar`]: { body: { records: [], corrections: [] } },
    });
    await expect(openMedicalRecord(L1)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("telling families", () => {
  it("reads and saves the policy", async () => {
    boot({
      [`GET ${H}/medical-settings`]: { body: { settings: { notify_guardians: "all", guardian_notices_available: false } } },
      [`PUT ${H}/medical-settings`]: { body: { settings: { notify_guardians: "serious", guardian_notices_available: false } } },
    });
    expect(await fetchNotifyPolicy(T)).toBe("all");
    await saveNotifyPolicy(T, "serious");
    expect(api.callsTo(`PUT ${H}/medical-settings`)[0]!.body).toEqual({ notify_guardians: "serious" });
  });

  it("passes a refusal to read or save on", async () => {
    boot({ [`GET ${H}/medical-settings`]: refused("forbidden", 403), [`PUT ${H}/medical-settings`]: refused("forbidden", 403) });
    await expect(fetchNotifyPolicy(T)).rejects.toMatchObject({ code: "forbidden" });
    await expect(saveNotifyPolicy(T, "all")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("sends no phone notices from the browser: the server does not emit them", async () => {
    boot({});
    await pushMedicalNotices(V1);
    expect(api.calls).toHaveLength(0);
  });
});

describe("what the API cannot do, which throws before any call", () => {
  it.each([
    ["visit history", () => fetchVisits(T, new Date(), new Date())],
    ["medicine given at a visit", () => addVisitMedication(T, V1, { drug: "Paracetamol", dose: "500mg", given_at: "2026-11-24T08:00:00Z", inventory_item_id: null, stock_quantity: null })],
    ["medical stock", () => fetchMedicalStock(T)],
    ["marking the register from a visit", () => markVisitAttendance(V1, "excused")],
    ["medication schedules", () => fetchSchedules(T, "2026-11-01", "2026-11-30")],
    ["medication doses", () => fetchDoses(T, "2026-11-01", "2026-11-30")],
    ["saving a schedule", () => saveSchedule(T, {} as never)],
    ["stopping a schedule", () => stopSchedule("s1")],
    ["recording a dose", () => recordDose(T, { schedule: {} as never, day: "2026-11-24", time: "08:00" }, "given")],
    ["pending medication requests", () => fetchPendingRequests(T)],
    ["approving a request", () => approveRequest("r1", { drug: "x", dose: "y", times: ["08:00"], starts_on: "2026-11-24", ends_on: null, notes: "" })],
    ["declining a request", () => declineRequest("r1", "no")],
    ["a child's medical history", () => fetchChildMedical(L1)],
    ["unread medical notices", () => fetchUnreadMedicalNotices(U1)],
    ["marking notices read", () => markMedicalNoticesRead(L1)],
    ["asking for medication", () => requestMedication(T, L1, {} as never, null)],
    ["withdrawing a request", () => withdrawMedicationRequest("r1")],
  ])("%s", async (_what, run) => {
    boot({});
    await expect(run()).rejects.toBeInstanceOf(NotOnApiError);
    expect(api.calls).toHaveLength(0);
  });
});
