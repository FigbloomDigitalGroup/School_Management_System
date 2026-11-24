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

  describe("which classes a teacher gets", () => {
    const C3 = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
    const S2 = "30000002-1111-4111-8111-111111111111";
    const U2 = "20000002-1111-4111-8111-111111111111";
    const UNLINKED = "99999999-1111-4111-8111-111111111111";
    const SUBJECT = "40000001-1111-4111-8111-111111111111";
    const staffRow = (id: string, userId: string | null, full_name: string) => ({
      id, tenantId: T, full_name, staff_title: "Teacher", classification: "teacher",
      phone: null, email: null, userId, active: true, archived_at: null, ...stamp,
    });
    const assignment = (id: string, staffId: string, classId: string) => ({
      id, tenantId: T, staff_member_id: staffId, class_id: classId, subject_id: SUBJECT, active: true, archived_at: null, ...stamp,
    });
    const permissions = (items: string[]): FakeReply => ({
      body: {
        role: "teacher", tenantId: T, mayAdminister: false, isOrgAdminForTenant: false, isSuperAdmin: false,
        delegatedPermissions: [], actingVia: "membership", items, page: page(),
      },
    });
    // The whole school, as someone who may read every class sees it.
    const wholeSchool = [clsRow(C1, "Form 1 East", S1), clsRow(C2, "Form 2 West", S2), clsRow(C3, "Form 3 North", null)];
    const staffList = list("staff", [staffRow(S1, U1, "David Kamau"), staffRow(S2, U2, "Mercy Wanjiru")]);
    const assignments = list("assignments", [assignment("a1", S1, C3), assignment("a2", S2, C2)]);
    const names = (cs: { name: string }[]) => cs.map((c) => c.name);

    it("keeps the classes the teacher's staff record teaches: class teacher or a teaching assignment", async () => {
      boot({
        [`GET ${P}/academic-years`]: list("academic_years", [year()]),
        [`GET ${P}/classes`]: list("classes", wholeSchool),
        [`GET ${P}/staff`]: staffList,
        [`GET ${P}/teaching-assignments`]: assignments,
      });

      expect(names(await fetchTeacherClasses(U1))).toEqual(["Form 1 East", "Form 3 North"]);
      expect(names(await fetchTeacherClasses(U2))).toEqual(["Form 2 West"]);
      expect(api.callsTo(`GET ${P}/classes`)[0]?.query.get("academicYearId")).toBe(YEAR);
      expect(api.callsTo("GET /v1/rbac/permissions")).toHaveLength(0);
    });

    it("gives a teacher with no class and no assignment no classes, not the whole school", async () => {
      boot({
        [`GET ${P}/academic-years`]: list("academic_years", [year()]),
        [`GET ${P}/classes`]: list("classes", [clsRow(C1, "Form 1 East", S1), clsRow(C3, "Form 3 North", null)]),
        [`GET ${P}/staff`]: staffList,
        [`GET ${P}/teaching-assignments`]: list("assignments", []),
      });

      expect(await fetchTeacherClasses(U2)).toEqual([]);
    });

    it("gives someone with no staff record (an admin who does not teach) no classes, not the whole school", async () => {
      boot({
        [`GET ${P}/academic-years`]: list("academic_years", [year()]),
        [`GET ${P}/classes`]: list("classes", wholeSchool),
        [`GET ${P}/staff`]: staffList,
        [`GET ${P}/teaching-assignments`]: assignments,
      });

      expect(await fetchTeacherClasses(UNLINKED)).toEqual([]);
    });

    it("trusts the API's own scoping when the teacher may read neither the staff list nor every class", async () => {
      // OD-2: without academics read, /classes already answers with only the classes this teacher teaches.
      boot({
        [`GET ${P}/academic-years`]: list("academic_years", [year()]),
        [`GET ${P}/classes`]: list("classes", [clsRow(C1, "Form 1 East", S1), clsRow(C3, "Form 3 North", null)]),
        [`GET ${P}/staff`]: refused("forbidden", 403),
        [`GET ${P}/teaching-assignments`]: list("assignments", [assignment("a1", S1, C3)]),
        ["GET /v1/rbac/permissions"]: permissions(["resource.attendance.read"]),
      });

      expect(names(await fetchTeacherClasses(U1))).toEqual(["Form 1 East", "Form 3 North"]);
      expect(api.callsTo("GET /v1/rbac/permissions")).toHaveLength(1);
    });

    it("shows no classes when the teacher may read every class but not the staff list (nothing says which are theirs)", async () => {
      // A teacher holding the Academics area and not People: /classes is the whole school, /staff is refused.
      boot({
        [`GET ${P}/academic-years`]: list("academic_years", [year()]),
        [`GET ${P}/classes`]: list("classes", wholeSchool),
        [`GET ${P}/staff`]: refused("forbidden", 403),
        [`GET ${P}/teaching-assignments`]: assignments,
        ["GET /v1/rbac/permissions"]: permissions(["resource.academics.read", "resource.academics.write"]),
      });

      expect(await fetchTeacherClasses(U1)).toEqual([]);
    });

    it("gives a teacher who teaches nothing no classes when the API refuses the class list, instead of an error", async () => {
      boot({
        [`GET ${P}/academic-years`]: list("academic_years", [year()]),
        [`GET ${P}/classes`]: refused("forbidden", 403),
        [`GET ${P}/staff`]: refused("forbidden", 403),
        [`GET ${P}/teaching-assignments`]: refused("forbidden", 403),
      });

      expect(await fetchTeacherClasses(U1)).toEqual([]);
      expect(api.callsTo("GET /v1/rbac/permissions")).toHaveLength(0);
    });

    it("passes on failures other than a refusal", async () => {
      boot({
        [`GET ${P}/academic-years`]: list("academic_years", [year()]),
        [`GET ${P}/classes`]: list("classes", wholeSchool),
        [`GET ${P}/staff`]: refused("internal", 500, "boom"),
        [`GET ${P}/teaching-assignments`]: assignments,
      });

      await expect(fetchTeacherClasses(U1)).rejects.toThrow();
    });
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
