import { afterEach, describe, expect, it, vi } from "vitest";
import { today, type Register } from "../attendance";
import {
  DEFAULT_ATTENDANCE_SETTINGS, fetchAttendanceSettings, fetchMyAttendanceSettings, fetchSessionEntries, fetchSignOutDays, saveAttendanceSettings,
} from "../attendanceSession";
import { initBackend } from "../backend";
import {
  fetchCollectorDetails, fetchEarlySignOuts, fetchEarlySignOutsForStudents, fetchStudentEarlySignOuts, pushEarlySignOut, recordEarlySignOut, voidEarlySignOut,
} from "../earlySignOut";
import { fetchClassSickBay } from "../medical";
import { isRetryable } from "../queue";
import { fetchHealthFlagsForStudents } from "../studentHealth";
import {
  fetchClassRoster, fetchCurrentTerm, fetchTeacherClasses, fetchTeacherClassProgress, fetchTodayAttendanceMarks, writeAttendance,
} from "../teacherData";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const YEAR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TERM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const L1 = "10000001-1111-4111-8111-111111111111";
const L2 = "10000002-1111-4111-8111-111111111111";
const SO1 = "50000001-1111-4111-8111-111111111111";
const SO2 = "50000002-1111-4111-8111-111111111111";

const stamp = { created_at: "2026-05-01T08:00:00Z", updated_at: "2026-05-01T08:00:00Z" };
const year = (o: Record<string, unknown> = {}) => ({ id: YEAR, tenantId: T, label: "2026", starts_on: "2026-01-01", ends_on: "2026-12-31", is_current: true, ...stamp, ...o });
const term = (o: Record<string, unknown> = {}) => ({ id: TERM, tenantId: T, academic_year_id: YEAR, index: 2, label: "Term 2, 2026", starts_on: "2026-05-01", ends_on: "2026-08-01", is_current: true, ...stamp, ...o });
const regRow = (o: Record<string, unknown> = {}) => ({
  id: "r1", tenantId: T, session: "morning", learner_id: L1, class_id: C1, term_id: TERM, taken_by: "u1",
  taken_on: "2026-05-10", mark: "present", note: null, marked_at: "2026-05-10T08:00:00Z", ...o,
});
const signOutRow = (o: Record<string, unknown> = {}) => ({
  id: SO1, tenantId: T, learner_id: L1, class_id: C1, learner_name: "Amina Otieno", class_name: "Form 2 East",
  taken_on: "2026-05-10", signed_out_at: "2026-05-10T10:45:00Z", signed_out_local: "13:45:00",
  reason: "Clinic visit", collected_by_name: "Grace Otieno", collected_by_relationship: "Mother",
  recorded_by: "u1", voided_at: null, ...o,
});
const collector = (o: Record<string, unknown> = {}) => ({
  id_number: "12345678", phone: "+254712345678", authorised_by: "Deputy Principal", note: "Will return tomorrow", void_reason: null, ...o,
});
const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const list = (key: string, items: unknown[], next: string | null = null): FakeReply => ({ body: { [key]: items, page: page(next) } });
const refused = (code: string, status: number, message = "no") => ({ status, body: { error: { code, message } } });

let api: FakeApi;
const P = `/v1/tenants/${T}`;

function boot(routes: Record<string, FakeRoute>) {
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

describe("attendance settings on API", () => {
  it("reads and saves attendance settings, falling back to defaults on read error", async () => {
    boot({
      [`GET ${P}/attendance-settings`]: { body: { settings: { tenantId: T, afternoon_enabled: true, percentage_mode: "day", updated_at: null } } },
      [`PUT ${P}/attendance-settings`]: { body: { settings: { tenantId: T, afternoon_enabled: true, percentage_mode: "session", updated_at: "2026-05-10T08:00:00Z" } } },
    });

    expect(await fetchAttendanceSettings(T)).toEqual({ afternoon_enabled: true, percentage_mode: "day" });
    expect(await fetchMyAttendanceSettings()).toEqual({ afternoon_enabled: true, percentage_mode: "day" });
    expect(await saveAttendanceSettings(T, { afternoon_enabled: true, percentage_mode: "session" })).toEqual({
      afternoon_enabled: true, percentage_mode: "session",
    });

    boot({ [`GET ${P}/attendance-settings`]: refused("forbidden", 403) });
    expect(await fetchAttendanceSettings(T)).toEqual(DEFAULT_ATTENDANCE_SETTINGS);
  });
});

describe("registers on API", () => {
  it("reads session entries with date/student/term filters and today's marks", async () => {
    const d = today("Africa/Nairobi");
    boot({
      [`GET ${P}/attendance-registers`]: list("registers", [
        regRow({ learner_id: L1, taken_on: d, session: "morning", mark: "present" }),
        regRow({ id: "r2", learner_id: L2, taken_on: d, session: "afternoon", mark: "absent" }),
      ]),
    });

    const entries = await fetchSessionEntries({ tenantId: T, classId: C1, studentIds: [L1], from: d, to: d });
    expect(entries).toEqual([{ student_id: L1, taken_on: d, session: "morning", mark: "present", class_id: C1 }]);

    const marks = await fetchTodayAttendanceMarks(C1, "morning", "Africa/Nairobi");
    expect(marks).toHaveLength(2);
    expect(api.calls.at(-1)?.query.get("session")).toBe("morning");
    expect(api.calls.at(-1)?.query.get("takenOn")).toBe(d);
  });

  it("writes a class register one learner per request and surfaces partial/retryable failures as WriteError", async () => {
    boot({
      [`POST ${P}/attendance-registers`]: { status: 200, body: { register: regRow(), outcome: "applied" } },
    });

    const reg: Register = {
      classId: C1, termId: TERM, date: "2026-05-10",
      marks: { [L1]: "present", [L2]: "late" },
      notes: { [L2]: "Bus delay" },
    };
    await writeAttendance(reg, T, "u1", "morning");
    expect(api.calls).toHaveLength(2);
    expect(api.calls.map((c) => (c.body as { learner_id: string }).learner_id).sort()).toEqual([L1, L2]);

    // 503 failure marks the WriteError as retryable so offline queues hold it
    boot({
      [`POST ${P}/attendance-registers`]: (c) =>
        (c.body as { learner_id: string }).learner_id === L2
          ? refused("internal_error", 503, "Database busy")
          : { status: 200, body: { register: regRow(), outcome: "applied" } },
    });
    let caught: unknown;
    try {
      await writeAttendance(reg, T, "u1", "morning");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("Saved 1 of 2 marks");
    expect(isRetryable(caught)).toBe(true);
  });

  it("loads the current term via academic years & terms", async () => {
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/academic-terms`]: list("terms", [term()]),
    });
    const cur = await fetchCurrentTerm();
    expect(cur?.name).toBe("Term 2, 2026");
  });
});

describe("early sign-outs on API", () => {
  it("records, lists, fetches collector details, voids, and treats pushEarlySignOut as a no-op", async () => {
    boot({
      [`POST ${P}/early-sign-outs`]: { status: 201, body: { sign_out: signOutRow(), collector: collector() } },
      [`GET ${P}/early-sign-outs`]: list("sign_outs", [
        { sign_out: signOutRow({ id: SO1, learner_id: L1 }), collector: collector() },
        { sign_out: signOutRow({ id: SO2, learner_id: L2, signed_out_at: "2026-05-10T11:00:00Z" }), collector: null },
      ]),
      [`GET ${P}/early-sign-outs/${SO1}`]: { body: { sign_out: signOutRow({ id: SO1 }), collector: collector() } },
      [`GET ${P}/early-sign-outs/${SO2}`]: { body: { sign_out: signOutRow({ id: SO2 }), collector: null } },
      [`POST ${P}/early-sign-outs/${SO1}/void`]: { body: { sign_out: signOutRow({ voided_at: "2026-05-10T11:10:00Z" }), collector: collector({ void_reason: "Entered wrong learner" }) } },
    });

    const newId = await recordEarlySignOut({
      student_id: L1, reason: "Clinic visit", authorised_by: "Deputy Principal",
      collected_by_name: "Grace Otieno", collected_by_relationship: "Mother",
      collected_by_id_number: "12345678", collected_by_phone: "+254712345678",
      note: "Will return tomorrow", signed_out_time: "13:45",
    });
    expect(newId).toBe(SO1);

    const all = await fetchEarlySignOuts(T, "2026-05-10");
    expect(all.map((s) => s.id)).toEqual([SO1, SO2]);

    const filtered = await fetchEarlySignOutsForStudents([L1], "2026-05-10");
    expect(filtered.map((s) => s.student_id)).toEqual([L1]);

    const history = await fetchStudentEarlySignOuts(L1, 10);
    expect(history).toHaveLength(1);

    const days = await fetchSignOutDays({ tenantId: T, studentIds: [L1], from: "2026-05-10", to: "2026-05-10" });
    expect(days).toEqual([{ student_id: L1, taken_on: "2026-05-10", voided_at: null }]);

    const details = await fetchCollectorDetails([SO1, SO2]);
    expect(details.get(SO1)?.id_number).toBe("12345678");
    expect(details.has(SO2)).toBe(false);

    await voidEarlySignOut(SO1, "Entered wrong learner");
    await pushEarlySignOut(SO1);
  });
});

describe("teacher attendance console helpers on API", () => {
  const C2 = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";
  const U1 = "20000001-1111-4111-8111-111111111111";
  const S1 = "30000001-1111-4111-8111-111111111111";
  const clsRow = (id: string, name: string, teacherStaffId: string | null = null) => ({
    id, tenantId: T, academic_year_id: YEAR, name, education_level: "secondary", form_level: 1,
    pathway: null, stream: null, class_teacher_staff_id: teacherStaffId, active: true, archived_at: null, ...stamp,
  });
  const learnerRow = (id: string, full_name: string, admission_no: string) => ({
    id, tenantId: T, admission_no, full_name, gender: "female", boarding: false,
    date_of_birth: "2011-01-01", active: true, archived_at: null, ...stamp,
  });

  it("filters teacher classes by class_teacher_staff_id and teaching-assignments, falling back to all when unlinked", async () => {
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/classes`]: list("classes", [clsRow(C1, "Form 1 East", S1), clsRow(C2, "Form 2 West", null)]),
      [`GET ${P}/staff`]: list("staff", [{
        id: S1, tenantId: T, full_name: "David Kamau", staff_title: "Teacher", classification: "teacher",
        phone: null, email: "teacher@alliance.sc.ke", userId: U1, active: true, archived_at: null, ...stamp,
      }]),
      [`GET ${P}/teaching-assignments`]: list("assignments", []),
    });

    const mine = await fetchTeacherClasses(U1);
    expect(mine.map((c) => c.name)).toEqual(["Form 1 East"]);

    // Unlinked admin/user falls back to all current-year classes.
    const all = await fetchTeacherClasses("99999999-1111-4111-8111-111111111111");
    expect(all.map((c) => c.name)).toEqual(["Form 1 East", "Form 2 West"]);
  });

  it("builds class roster and today's class progress, and degrades health/sick-bay to empty maps", async () => {
    boot({
      [`GET ${P}/class-memberships`]: list("memberships", [
        { id: "m1", tenantId: T, learner_id: L2, class_id: C1, academic_year_id: YEAR, active: true, archived_at: null, ...stamp },
        { id: "m2", tenantId: T, learner_id: L1, class_id: C1, academic_year_id: YEAR, active: true, archived_at: null, ...stamp },
      ]),
      [`GET ${P}/learners`]: list("learners", [
        learnerRow(L2, "Zara Mwangi", "ADM-2"),
        learnerRow(L1, "Amina Ochieng", "ADM-1"),
      ]),
      [`GET ${P}/attendance-registers`]: list("registers", [
        regRow({ id: "r1", learner_id: L1, mark: "present", taken_on: today("Africa/Nairobi"), marked_at: "2026-05-10T08:05:00Z" }),
        regRow({ id: "r2", learner_id: L2, mark: "absent", note: "Sick", taken_on: today("Africa/Nairobi"), marked_at: "2026-05-10T08:01:00Z" }),
      ]),
    });

    const roster = await fetchClassRoster(C1);
    expect(roster.map((s) => s.full_name)).toEqual(["Amina Ochieng", "Zara Mwangi"]);

    const progress = await fetchTeacherClassProgress([{ id: C1, name: "Form 1 East" }], "morning", "Africa/Nairobi");
    expect(progress.get(C1)).toEqual({
      present: 1,
      absent: 1,
      late: 0,
      total: 2,
      submitted: true,
      submittedAt: "2026-05-10T08:01:00Z",
      away: [{ name: "Zara Mwangi", mark: "absent", note: "Sick" }],
    });

    expect((await fetchHealthFlagsForStudents([L1])).size).toBe(0);
    expect((await fetchClassSickBay(C1)).size).toBe(0);
  });
});
