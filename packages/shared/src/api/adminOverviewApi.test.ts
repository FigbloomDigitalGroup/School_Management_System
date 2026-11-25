import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NO_FEES, fetchClassAttendanceDetail, fetchOverviewBasics, fetchRegisterDays, remindClassTeacher,
} from "../adminOverview";
import { today } from "../attendance";
import { fetchPmMissingLearners } from "../attendanceSession";
import { initBackend } from "../backend";
import { NotOnApiError, dashboardCapabilities } from "../capabilities";
import { assignCoverage, fetchCoverageForDate, fetchCoverageThisWeek } from "../coverage";
import { fetchMySignatureRequests } from "../signatures";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { feeTotalsFromInvoices } from "./adminOverviewApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const YEAR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TERM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const C2 = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";
const L1 = "10000001-1111-4111-8111-111111111111";
const L2 = "10000002-1111-4111-8111-111111111111";
const L3 = "10000003-1111-4111-8111-111111111111";
const ST1 = "20000001-1111-4111-8111-111111111111";
const ST2 = "20000002-1111-4111-8111-111111111111";
const ST3 = "20000003-1111-4111-8111-111111111111";
const U1 = "30000001-1111-4111-8111-111111111111";
const SO1 = "50000001-1111-4111-8111-111111111111";

const stamp = { created_at: "2026-05-01T08:00:00Z", updated_at: "2026-05-01T08:00:00Z" };
const year = (o: Record<string, unknown> = {}) => ({
  id: YEAR, tenantId: T, label: "2026", starts_on: "2026-01-01", ends_on: "2026-12-31", is_current: true, ...stamp, ...o,
});
const term = (o: Record<string, unknown> = {}) => ({
  id: TERM, tenantId: T, academic_year_id: YEAR, index: 2, label: "Term 2, 2026", starts_on: "2026-05-01", ends_on: "2026-08-01", is_current: true, ...stamp, ...o,
});
const clsRow = (o: Record<string, unknown> = {}) => ({
  id: C1, tenantId: T, academic_year_id: YEAR, name: "Form 2 East", form_level: 2, stream: "East",
  education_level: "secondary", class_teacher_staff_id: ST1, active: true, ...stamp, ...o,
});
const learnerRow = (o: Record<string, unknown> = {}) => ({
  id: L1, tenantId: T, admission_no: "ADM001", full_name: "Amina Otieno", gender: "female",
  date_of_birth: "2010-03-01", boarding: false, active: true, archived_at: null, ...stamp, ...o,
});
const staffRow = (o: Record<string, unknown> = {}) => ({
  id: ST1, tenantId: T, full_name: "Grace Mwangi", staff_title: "Teacher", classification: "teacher",
  phone: null, email: "grace@school.ke", userId: U1, active: true, archived_at: null, ...stamp, ...o,
});
const invoiceRow = (o: Record<string, unknown> = {}) => ({
  id: "inv1", tenantId: T, learner_id: L1, term_id: TERM, currency: "KES", due_on: "2026-06-01",
  lines_minor: 10000, charges_minor: 0, adjustments_minor: 0, total_minor: 10000, paid_minor: 0,
  status: "issued", issued_at: "2026-05-01T08:00:00Z", voided_at: null, ...stamp, ...o,
});
const regRow = (o: Record<string, unknown> = {}) => ({
  id: "r1", tenantId: T, session: "morning", learner_id: L1, class_id: C1, term_id: TERM, taken_by: U1,
  taken_on: "2026-05-10", mark: "present", note: null, marked_at: "2026-05-10T08:00:00Z", ...o,
});
const signOutRow = (o: Record<string, unknown> = {}) => ({
  id: SO1, tenantId: T, learner_id: L1, class_id: C1, learner_name: "Amina Otieno", class_name: "Form 2 East",
  taken_on: "2026-05-10", signed_out_at: "2026-05-10T10:45:00Z", signed_out_local: "13:45:00",
  reason: "Clinic visit", collected_by_name: "Grace Otieno", collected_by_relationship: "Mother",
  recorded_by: U1, voided_at: null, ...o,
});
const collectorRow = {
  id_number: "12345678", phone: "+254712345678", authorised_by: "Deputy Principal", note: "Note", void_reason: null,
};
const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const list = (key: string, items: unknown[], next: string | null = null): FakeReply => ({ body: { [key]: items, page: page(next) } });
const refused = (code: string, status: number, message = "no") => ({ status, body: { error: { code, message } } });

const P = `/v1/tenants/${T}`;
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

afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

describe("feeTotalsFromInvoices", () => {
  it("aggregates billed, paid, and payment status buckets matching term_fee_totals", () => {
    expect(feeTotalsFromInvoices([])).toEqual(NO_FEES);
    expect(feeTotalsFromInvoices([
      { total_minor: 1000, paid_minor: 1000 }, // full_paid
      { total_minor: 2000, paid_minor: 2500 }, // overpaid counts as full_paid, not owing
      { total_minor: 1500, paid_minor: 500 },  // part_paid + owing
      { total_minor: 1200, paid_minor: 0 },    // nothing_paid + owing
      { total_minor: 0, paid_minor: 0 },       // zero-total: nothing_paid, not full_paid, not owing
    ])).toEqual({
      billed: 5700,
      paid: 4000,
      invoices: 5,
      nothing_paid: 2,
      part_paid: 1,
      full_paid: 2,
      owing: 2,
    });
  });
});

describe("fetchOverviewBasics on API", () => {
  it("loads term, classes, active learners (including unassigned), teaching/admin staff count, and fee totals", async () => {
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/academic-terms`]: list("terms", [term()]),
      [`GET ${P}/classes`]: list("classes", [
        clsRow({ id: C2, name: "Form 1 West", class_teacher_staff_id: null }),
        clsRow({ id: C1, name: "Form 2 East", class_teacher_staff_id: ST1 }),
      ]),
      [`GET ${P}/learners`]: list("learners", [
        learnerRow({ id: L1, full_name: "Amina Otieno" }),
        learnerRow({ id: L2, full_name: "Brian Kamau" }),
      ]),
      [`GET ${P}/class-memberships`]: list("memberships", [
        { id: "m1", tenantId: T, learner_id: L1, class_id: C1, academic_year_id: YEAR, active: true, ...stamp },
      ]),
      [`GET ${P}/staff`]: list("staff", [
        staffRow({ id: ST1, classification: "teacher" }),
        staffRow({ id: ST2, classification: "school_admin", userId: "u2" }),
        staffRow({ id: ST3, classification: "driver", userId: "u3" }),
      ]),
      [`GET ${P}/finance/invoices`]: list("invoices", [
        invoiceRow({ id: "i1", total_minor: 10000, paid_minor: 10000 }),
        invoiceRow({ id: "i2", learner_id: L2, total_minor: 8000, paid_minor: 2000 }),
        invoiceRow({ id: "i3", learner_id: L3, total_minor: 5000, paid_minor: 0, status: "voided" }),
      ]),
    });

    const basics = await fetchOverviewBasics(T);
    expect(basics.term?.id).toBe(TERM);
    expect(basics.classes).toEqual([
      { id: C2, name: "Form 1 West", class_teacher_id: null },
      { id: C1, name: "Form 2 East", class_teacher_id: ST1 },
    ]);
    expect(basics.students).toEqual([
      { id: L1, class_id: C1 },
      { id: L2, class_id: "" },
    ]);
    expect(basics.staffCount).toBe(2);
    expect(basics.fees).toEqual({
      billed: 18000,
      paid: 12000,
      invoices: 2,
      nothing_paid: 0,
      part_paid: 1,
      full_paid: 1,
      owing: 1,
    });
  });

  it("returns NO_FEES when there is no current term, throws on fee read error, and degrades non-fee reads", async () => {
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/academic-terms`]: list("terms", [term({ is_current: false })]),
      [`GET ${P}/classes`]: refused("forbidden", 403),
      [`GET ${P}/learners`]: refused("forbidden", 403),
      [`GET ${P}/class-memberships`]: refused("forbidden", 403),
      [`GET ${P}/staff`]: refused("forbidden", 403),
    });

    expect(await fetchOverviewBasics(T)).toEqual({
      term: null,
      classes: [],
      students: [],
      staffCount: 0,
      fees: NO_FEES,
    });

    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/academic-terms`]: list("terms", [term()]),
      [`GET ${P}/classes`]: list("classes", []),
      [`GET ${P}/learners`]: list("learners", []),
      [`GET ${P}/class-memberships`]: list("memberships", []),
      [`GET ${P}/staff`]: list("staff", []),
      [`GET ${P}/finance/invoices`]: refused("forbidden", 403, "Finance access denied"),
    });

    await expect(fetchOverviewBasics(T)).rejects.toThrow("Finance access denied");
  });
});

describe("remindClassTeacher on API", () => {
  it("resolves class teacher staff record to userId, creates and publishes an in-app user announcement", async () => {
    const server = boot({
      [`GET ${P}/staff`]: list("staff", [staffRow({ id: ST1, userId: U1 })]),
      [`POST ${P}/communications/announcements`]: { body: { announcement: { id: "ann-1" } } },
      [`POST ${P}/communications/announcements/ann-1/publish`]: { body: { announcement: { id: "ann-1" } } },
    });

    await remindClassTeacher(T, "ignored-author", { name: "Form 2 East", class_teacher_id: ST1 });

    const createCall = server.calls.find((c) => c.method === "POST" && c.path.endsWith("/communications/announcements"));
    expect(createCall?.body).toEqual({
      subject: "Attendance not yet taken — Form 2 East",
      body: "Form 2 East hasn't submitted today's attendance register yet. Please take it as soon as you can.",
      audience: { kind: "user", user_id: U1 },
      channels: ["in_app"],
    });
    expect(server.calls.some((c) => c.method === "POST" && c.path.endsWith("/communications/announcements/ann-1/publish"))).toBe(true);
  });

  it("throws when the class has no teacher or the staff record has no sign-in account", async () => {
    boot({
      [`GET ${P}/staff`]: list("staff", [staffRow({ id: ST1, full_name: "Grace Mwangi", userId: null })]),
    });

    await expect(remindClassTeacher(T, U1, { name: "Form 2 East", class_teacher_id: null }))
      .rejects.toThrow("Form 2 East has no class teacher assigned yet.");
    await expect(remindClassTeacher(T, U1, { name: "Form 2 East", class_teacher_id: ST1 }))
      .rejects.toThrow("Grace Mwangi does not have a sign-in account yet.");
  });
});

describe("fetchRegisterDays on API", () => {
  it("reads newest morning/afternoon dates with limit=1 and tolerates failed afternoon reads", async () => {
    const server = boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/classes`]: list("classes", [clsRow({ id: C1, name: "Form 2 East" })]),
      [`GET ${P}/attendance-registers`]: (req) => {
        if (req.query.get("session") === "afternoon") return refused("forbidden", 403);
        return list("registers", [regRow({ taken_on: "2026-05-12" })]);
      },
      [`GET ${P}/attendance-settings`]: {
        body: { settings: { tenantId: T, afternoon_enabled: true, percentage_mode: "day", updated_at: null } },
      },
    });

    const days = await fetchRegisterDays(T);
    expect(days).toEqual({
      classes: [{ id: C1, name: "Form 2 East" }],
      latestMorning: "2026-05-12",
      latestAfternoon: null,
      settings: { afternoon_enabled: true, percentage_mode: "day" },
    });

    const regCalls = server.calls.filter((c) => c.path.endsWith("/attendance-registers"));
    expect(regCalls.every((c) => c.query.get("limit") === "1")).toBe(true);
  });
});

describe("fetchClassAttendanceDetail on API", () => {
  it("merges roster, morning/afternoon marks, resolved classTeacherId, sign-outs, and collector details", async () => {
    const d = today("Africa/Nairobi");
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/classes`]: list("classes", [clsRow({ id: C1, class_teacher_staff_id: ST1 })]),
      [`GET ${P}/staff`]: list("staff", [staffRow({ id: ST1, userId: U1 })]),
      [`GET ${P}/class-memberships`]: list("memberships", [
        { id: "m1", tenantId: T, learner_id: L1, class_id: C1, academic_year_id: YEAR, active: true, ...stamp },
        { id: "m2", tenantId: T, learner_id: L2, class_id: C1, academic_year_id: YEAR, active: true, ...stamp },
      ]),
      [`GET ${P}/learners`]: list("learners", [
        learnerRow({ id: L1, full_name: "Amina Otieno", admission_no: "ADM001" }),
        learnerRow({ id: L2, full_name: "Brian Kamau", admission_no: "ADM002" }),
      ]),
      [`GET ${P}/attendance-registers`]: list("registers", [
        regRow({ learner_id: L1, taken_on: d, session: "morning", mark: "late" }),
        regRow({ id: "r2", learner_id: L2, taken_on: d, session: "afternoon", mark: "absent" }),
      ]),
      [`GET ${P}/attendance-settings`]: {
        body: { settings: { tenantId: T, afternoon_enabled: false, percentage_mode: "session", updated_at: null } },
      },
      [`GET ${P}/early-sign-outs`]: list("sign_outs", [{ sign_out: signOutRow({ taken_on: d }), collector: null }]),
      [`GET ${P}/early-sign-outs/${SO1}`]: { body: { sign_out: signOutRow({ taken_on: d }), collector: collectorRow } },
    });

    const detail = await fetchClassAttendanceDetail(C1, d, T);
    expect(detail.classTeacherId).toBe(U1);
    expect(detail.showPm).toBe(true);
    expect(detail.pmTaken).toBe(true);
    expect(detail.rows).toEqual([
      { id: L1, name: "Amina Otieno", admissionNo: "ADM001", mark: "late", pmMark: "present" },
      { id: L2, name: "Brian Kamau", admissionNo: "ADM002", mark: "present", pmMark: "absent" },
    ]);
    expect(detail.signOuts).toHaveLength(1);
    expect(detail.details.get(SO1)?.id_number).toBe("12345678");
  });
});

describe("fetchPmMissingLearners on API", () => {
  it("resolves learner names and classes, and returns restricted placeholders on 403", async () => {
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/classes`]: list("classes", [clsRow({ id: C1, name: "Form 2 East" })]),
      [`GET ${P}/class-memberships`]: list("memberships", [
        { id: "m1", tenantId: T, learner_id: L1, class_id: C1, academic_year_id: YEAR, active: true, ...stamp },
      ]),
      [`GET ${P}/learners`]: refused("forbidden", 403),
    });

    expect(await fetchPmMissingLearners(T, [L1, L1])).toEqual([
      { id: L1, name: "Learner (restricted)", admissionNo: "—", className: "Form 2 East" },
    ]);
  });
});

describe("dashboardCapabilities and deferred API features", () => {
  it("reports Supabase vs API capabilities and throws NotOnApiError on API for coverage and signatures", async () => {
    expect(dashboardCapabilities()).toEqual({ pendingSignatures: true, periodCoverage: true });

    initBackend({ kind: "api", apiUrl: BASE });
    expect(dashboardCapabilities()).toEqual({ pendingSignatures: false, periodCoverage: false });

    await expect(fetchCoverageForDate(T, "Mon", "2026-05-11")).rejects.toThrow(NotOnApiError);
    await expect(fetchCoverageThisWeek(T)).rejects.toThrow(NotOnApiError);
    await expect(assignCoverage({
      tenantId: T,
      assignedBy: U1,
      item: { date: "2026-05-11", classId: C1, className: "Form 2 East", subjectId: "s1", subjectName: "Math", time: "08:00", absentTeacherId: ST1 },
      coveringTeacherId: null,
    })).rejects.toThrow(NotOnApiError);
    await expect(fetchMySignatureRequests()).rejects.toThrow(NotOnApiError);
  });
});
