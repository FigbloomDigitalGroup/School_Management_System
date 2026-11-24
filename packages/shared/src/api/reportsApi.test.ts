import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTermReport } from "../adminOverview";
import { initBackend } from "../backend";
import { BASE, createFakeApi, type FakeApi, type FakeCall, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { classMeans, termFigures } from "./reportsApi";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const YEAR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TERM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const C2 = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";
const S1 = "51515151-5151-4515-8515-515151515151";
const L1 = "10000001-1111-4111-8111-111111111111";
const L2 = "10000002-1111-4111-8111-111111111111";
const L3 = "10000003-1111-4111-8111-111111111111";
const L4 = "10000004-1111-4111-8111-111111111111";

const stamp = { created_at: "2026-05-01T08:00:00Z", updated_at: "2026-05-01T08:00:00Z" };
const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const list = (key: string, items: unknown[], next: string | null = null): FakeReply => ({ body: { [key]: items, page: page(next) } });
const year = { id: YEAR, tenantId: T, label: "2026", starts_on: "2026-01-01", ends_on: "2026-12-31", is_current: true, ...stamp };
const term = { id: TERM, tenantId: T, academic_year_id: YEAR, index: 2, label: "Term 2, 2026", starts_on: "2026-05-01", ends_on: "2026-08-01", is_current: true, ...stamp };
const klass = (id: string, name: string, level = "secondary", form = 2) => ({
  id, tenantId: T, academic_year_id: YEAR, name, education_level: level, form_level: form, pathway: null, stream: null, class_teacher_staff_id: null, active: true, archived_at: null, ...stamp,
});
const learner = (id: string) => ({ id, tenantId: T, admission_no: id.slice(0, 8), full_name: id.slice(0, 8), gender: "female", boarding: false, active: true, date_of_birth: "2011-01-01", ...stamp });
const membership = (learner_id: string, class_id: string) => ({ id: `cm-${learner_id}`, tenantId: T, learner_id, class_id, academic_year_id: YEAR, active: true, archived_at: null, ...stamp });
const invoice = (learner_id: string, total: number, paid: number, status = "open") => ({ id: `i-${learner_id}`, tenantId: T, learner_id, term_id: TERM, status, total_minor: total, paid_minor: paid, charges_minor: total, overpaid_minor: 0, unapplied_minor: 0 });
const paper = (id: string, o: Record<string, unknown> = {}) => ({
  id, tenantId: T, class_id: C1, subject_id: S1, term_id: TERM, title: "Mock 1", kind: "exam", max_score: "50", status: "published", published_at: "2026-06-10T08:00:00Z", version: 2, ...stamp, ...o,
});
const mark = (assessment: string, learner_id: string, score: string) => ({ id: `m-${assessment}-${learner_id}`, tenantId: T, assessment_id: assessment, learner_id, score, grade: null, marked_at: "2026-06-01T08:00:00Z", marked_by: null, row_version: 1 });
const entry = (class_id: string, here: boolean, learner = L1) => ({ class_id, learner_id: learner, taken_on: "2026-05-10", session: "day", here });

const P = `/v1/tenants/${T}`;
let api: FakeApi;

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

describe("the term's figures by class", () => {
  it("counts attendance per class, here or not, and fees by the class each active learner is in now", () => {
    const f = termFigures({
      classIds: [C1, C2],
      attendance: [entry(C1, true), entry(C1, false), entry(C1, true), entry(C2, true), { class_id: "gone", learner_id: L1, here: true } as never].map((e) => ({ class_id: e.class_id, here: e.here })),
      invoices: [
        { learner_id: L1, total_minor: 1000, paid_minor: 400 }, { learner_id: L2, total_minor: 2000, paid_minor: 2000 },
        { learner_id: L3, total_minor: 500, paid_minor: 0 }, { learner_id: "archived", total_minor: 9999, paid_minor: 9999 },
      ],
      classOfLearner: new Map([[L1, C1], [L2, C1], [L3, C2]]),
    });
    expect(f.attendance.get(C1)).toEqual({ present: 2, total: 3 });
    expect(f.attendance.get(C2)).toEqual({ present: 1, total: 1 });
    expect(f.attendance.has("gone")).toBe(false);
    expect(f.fees.get(C1)).toEqual({ billed: 3000, paid: 2400 });
    expect(f.fees.get(C2)).toEqual({ billed: 500, paid: 0 });
  });

  it("gives every class a row, even with no entries", () => {
    const f = termFigures({ classIds: [C1], attendance: [], invoices: [], classOfLearner: new Map() });
    expect(f.attendance.get(C1)).toEqual({ present: 0, total: 0 });
    expect(f.fees.get(C1)).toEqual({ billed: 0, paid: 0 });
  });

  it("works out a class mean from percentages of each paper's total, with learners marked and the roster", () => {
    const means = classMeans({
      papers: [paper("pa") as never, paper("pb", { max_score: "100", class_id: C1 }) as never, paper("pc", { class_id: C2 }) as never],
      marks: new Map([["pa", [mark("pa", L1, "40"), mark("pa", L2, "25")] as never], ["pb", [mark("pb", L1, "60")] as never], ["pc", [] as never]]),
      rosterByClass: new Map([[C1, 3]]), levelOf: new Map([[C1, "kcse"], [C2, "cbc"]]),
    });
    // 80, 50 and 60 per cent: 63.3, rounded to 63. Two learners marked of a roster of 3. C2 has no marks, so no row.
    expect(means.get(C1)).toEqual({ mean: 63, marked: 2, roster: 3, scheme: "kcse" });
    expect(means.has(C2)).toBe(false);
  });
});

describe("the Reports page's term report on the API", () => {
  const routes = (extra: Record<string, FakeRoute> = {}): Record<string, FakeRoute> => ({
    [`GET ${P}/academic-years`]: list("academic_years", [year]),
    [`GET ${P}/academic-terms`]: list("terms", [term]),
    [`GET ${P}/classes`]: list("classes", [klass(C2, "Form 3 West", "secondary", 3), klass(C1, "Form 2 East")]),
    [`GET ${P}/attendance-settings`]: { body: { settings: { afternoon_enabled: false, percentage_mode: "day" } } },
    [`GET ${P}/attendance-counted`]: (call: FakeCall) => (call.query.get("cursor")
      ? list("entries", [entry(C2, true, L3)])
      : list("entries", [entry(C1, true), entry(C1, false, L2), entry(C1, true, L4)], "next")),
    [`GET ${P}/finance/invoices`]: list("invoices", [invoice(L1, 100_000, 25_000), invoice(L2, 200_000, 200_000), invoice(L3, 50_000, 0), invoice(L4, 70_000, 70_000, "voided")]),
    [`GET ${P}/learners`]: list("learners", [learner(L1), learner(L2), learner(L3)]),
    [`GET ${P}/class-memberships`]: list("memberships", [membership(L1, C1), membership(L2, C1), membership(L3, C2), membership(L4, C1)]),
    [`GET ${P}/assessments`]: list("assessments", [
      paper("pa"), paper("pb", { subject_id: "52525252-5252-4525-8525-525252525252", published_at: "2026-06-12T08:00:00Z" }),
      paper("pd", { title: "Opener", published_at: "2026-02-01T08:00:00Z", max_score: "100" }), paper("pe", { title: "Draft", status: "draft", published_at: null }),
    ]),
    [`GET ${P}/assessments/pa/marks`]: list("marks", [mark("pa", L1, "40"), mark("pa", L2, "25")]),
    [`GET ${P}/assessments/pb/marks`]: list("marks", [mark("pb", L1, "30")]),
    ...extra,
  });

  it("adds the term up by class: attendance across pages, fees of active learners, and the latest exam's mean", async () => {
    boot(routes());
    const r = await fetchTermReport(T, "KE");
    expect(r.term?.name).toBe("Term 2, 2026");
    expect(r.percentageMode).toBe("day");
    // Youngest year first.
    expect(r.classes.map((c) => c.name)).toEqual(["Form 2 East", "Form 3 West"]);
    expect(r.attendanceByClass.get(C1)).toEqual({ present: 2, total: 3 });
    expect(r.attendanceByClass.get(C2)).toEqual({ present: 1, total: 1 });
    expect(r.attendanceOverall).toEqual({ present: 3, total: 4 });
    // The voided invoice and the learner no longer on the roll (L4 is not in /learners) are left out.
    expect(r.feeByClass.get(C1)).toEqual({ billed: 300_000, paid: 225_000 });
    expect(r.feeByClass.get(C2)).toEqual({ billed: 50_000, paid: 0 });
    expect(r.feeOverall).toEqual({ billed: 350_000, paid: 225_000 });
    // Mock 1 went out last (12 June): its marks are 80, 50 and 60 per cent. Two learners marked, of the three on C1's roll (L4's membership is
    // there but L4 is not an active learner, so the roll is 2).
    expect(r.latestExam).toMatchObject({ name: "Mock 1", out_of: 50 });
    expect(r.meanByClass.get(C1)).toEqual({ mean: 63, marked: 2, roster: 2, scheme: "kcse" });
    expect(r.meanByClass.has(C2)).toBe(false);
    expect(api.callsTo(`GET ${P}/attendance-counted`)).toHaveLength(2);
    expect(api.callsTo(`GET ${P}/attendance-counted`)[0]!.query.get("termId")).toBe(TERM);
  });

  it("has no latest exam when nothing is published, and reads no marks", async () => {
    boot(routes({ [`GET ${P}/assessments`]: list("assessments", [paper("pe", { status: "draft", published_at: null })]) }));
    const r = await fetchTermReport(T, "KE");
    expect(r.latestExam).toBeNull();
    expect(r.meanByClass.size).toBe(0);
    expect(api.calls.filter((c) => c.path.endsWith("/marks"))).toHaveLength(0);
  });

  it("is empty with no term open, and reads no term data", async () => {
    boot(routes({ [`GET ${P}/academic-terms`]: list("terms", []) }));
    const r = await fetchTermReport(T, "KE");
    expect(r.term).toBeNull();
    expect(r.classes).toHaveLength(2);
    expect(api.callsTo(`GET ${P}/attendance-counted`)).toHaveLength(0);
    expect(api.callsTo(`GET ${P}/finance/invoices`)).toHaveLength(0);
  });

  it("fails with the API's own sentence when attendance may not be read", async () => {
    boot(routes({ [`GET ${P}/attendance-counted`]: { status: 403, body: { error: { code: "forbidden", message: "Missing resource.attendance.read" } } } }));
    await expect(fetchTermReport(T, "KE")).rejects.toThrow(/attendance/);
  });
});
