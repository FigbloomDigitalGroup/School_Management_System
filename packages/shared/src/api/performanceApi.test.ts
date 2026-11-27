import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { fetchCbeBandReport, fetchCbeLevels, fetchClassLearnerMeans, fetchClassLearnerNames, fetchClassOptions, fetchClassPerformance, fetchLearnerTrend } from "../performanceData";
import { examsOf, overallMeans, subjectStandings } from "../performance";
import { BASE, createFakeApi, type FakeApi, type FakeCall, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { examIdOf } from "./gradesApi";
import { classPerformanceRows, clearPublishedMarksCache, learnerHistoryRows, learnerMeanRows, PERFORMANCE_REFUSED } from "./performanceApi";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const YEAR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TERM1 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
const TERM2 = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const S1 = "51515151-5151-4515-8515-515151515151";
const S2 = "52525252-5252-4525-8525-525252525252";
const L1 = "10000001-1111-4111-8111-111111111111";
const L2 = "10000002-1111-4111-8111-111111111111";
const L3 = "10000003-1111-4111-8111-111111111111";
const ST1 = "a0000001-1111-4111-8111-111111111111";

const stamp = { created_at: "2026-05-01T08:00:00Z", updated_at: "2026-05-01T08:00:00Z" };
const paper = (id: string, o: Record<string, unknown> = {}) => ({
  id, tenantId: T, class_id: C1, subject_id: S1, term_id: TERM2, title: "Mock 1", kind: "exam", max_score: "50", status: "published",
  published_at: "2026-06-10T08:00:00Z", version: 2, ...stamp, ...o,
});
const mark = (assessment: string, learner: string, score: string) => ({
  id: `m-${assessment}-${learner}`, tenantId: T, assessment_id: assessment, learner_id: learner, score, grade: null, marked_at: "2026-06-01T08:00:00Z", marked_by: null, row_version: 1,
});
const page = { limit: 200, next_cursor: null };
const list = (key: string, items: unknown[]): FakeReply => ({ body: { [key]: items, page } });
const refused = (status = 403): FakeReply => ({ status, body: { error: { code: status === 403 ? "forbidden" : "not_found", message: "no" } } });
const term = (id: string, label: string, starts: string) => ({ id, tenantId: T, academic_year_id: YEAR, index: 1, label, starts_on: starts, ends_on: "2026-08-01", is_current: false, ...stamp });
const klass = { id: C1, tenantId: T, academic_year_id: YEAR, name: "Form 2 East", education_level: "secondary", form_level: 2, pathway: null, stream: null, class_teacher_staff_id: null, active: true, archived_at: null, ...stamp };
const subject = (id: string, name: string) => ({ id, tenantId: T, code: name.slice(0, 3), name, active: true, archived_at: null, ...stamp });
const year = { id: YEAR, tenantId: T, label: "2026", starts_on: "2026-01-01", ends_on: "2026-12-31", is_current: true, ...stamp };
const cbeAssessment = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, tenantId: T, class_id: C1, learning_area_id: S1, term_id: TERM2, rubric_config_id: null, title: "Strand check", status: "published",
  instrument_type: "rubric", assessment_date: "2026-06-10", instructions: null, strand_id: null, sub_strand_id: null, learning_outcome_id: null,
  curriculum_version_label: null, published_at: "2026-06-10T08:00:00Z", closed_at: null, row_version: 1, created_at: stamp.created_at, ...overrides,
});
const cbeResult = (id: string, learnerId: string, levelCode: string) => ({
  id, tenantId: T, cbe_assessment_id: "cbe-current", learner_id: learnerId, strand_id: null, learning_outcome_id: null, level_code: levelCode,
  points: "8", observation: null, teacher_feedback: null, evidence_asset_id: null, completion_status: "finalized", marked_at: stamp.created_at,
  marked_by: ST1, row_version: 1,
});
const learningArea = (id: string, name: string) => ({
  id, tenantId: T, provenance_id: "p0000000-0000-4000-8000-000000000001", code: name.slice(0, 3).toUpperCase(), name,
  education_level: "junior_secondary", min_grade: 7, max_grade: 9, pathway: null, is_core: true, official_catalogue: false, created_at: stamp.created_at,
});

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

beforeEach(() => clearPublishedMarksCache());
afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

// Two published papers of Mock 1 (out of 50) in Form 2 East, and one of Opener (out of 100) in the earlier term.
const papers = [
  paper("pa", { subject_id: S1 }), paper("pb", { subject_id: S2, published_at: "2026-06-12T08:00:00Z" }),
  paper("pc", { term_id: TERM1, title: "Opener", max_score: "100", published_at: "2026-02-20T08:00:00Z" }),
  paper("pd", { status: "draft", published_at: null, title: "Draft one" }),
  paper("pe", { kind: "homework", title: "Homework" }),
];
const marksOf: Record<string, unknown[]> = {
  pa: [mark("pa", L1, "40"), mark("pa", L2, "25")],
  pb: [mark("pb", L1, "30")],
  pc: [mark("pc", L1, "70"), mark("pc", L2, "50")],
};

function performanceRoutes(extra: Record<string, FakeRoute> = {}): Record<string, FakeRoute> {
  return {
    [`GET ${P}/assessments`]: (call: FakeCall) => list("assessments", call.query.get("classId") && call.query.get("classId") !== C1 ? [] : papers),
    ...Object.fromEntries(Object.entries(marksOf).map(([id, ms]) => [`GET ${P}/assessments/${id}/marks`, list("marks", ms)])),
    [`GET ${P}/academic-terms`]: list("terms", [term(TERM1, "Term 1, 2026", "2026-01-06"), term(TERM2, "Term 2, 2026", "2026-05-04")]),
    [`GET ${P}/subjects`]: list("subjects", [subject(S1, "Mathematics"), subject(S2, "English")]),
    [`GET ${P}/classes`]: list("classes", [klass]),
    [`GET ${P}/academic-years`]: list("academic_years", [year]),
    [`GET ${P}/teaching-assignments`]: list("assignments", [{ id: "ta", tenantId: T, staff_member_id: ST1, class_id: C1, subject_id: S1, active: true, archived_at: null, ...stamp }]),
    [`GET ${P}/staff`]: list("staff", [{ id: ST1, tenantId: T, userId: null, full_name: "Joyce Grader", classification: "teacher", active: true, ...stamp }]),
    ...extra,
  };
}

describe("class performance rows", () => {
  it("makes a row per published exam paper with marks as percentages of the paper's own total", async () => {
    boot(performanceRoutes());
    const rows = await fetchClassPerformance(T, null);
    // Only the three published papers of kind exam: not the draft, not the homework.
    expect(rows.map((r) => [r.exam_name, r.subject_name, r.learners, r.mean_score, r.scores])).toEqual([
      ["Mock 1", "Mathematics", 2, 65, [50, 80]],
      ["Mock 1", "English", 1, 60, [60]],
      ["Opener", "Mathematics", 2, 60, [50, 70]],
    ]);
    expect(rows[0]).toMatchObject({
      exam_id: examIdOf(TERM2, "Mock 1"), term_name: "Term 2, 2026", term_starts_on: "2026-05-04", class_name: "Form 2 East", teacher_name: "Joyce Grader", teacher_id: ST1,
      published_at: "2026-06-10T08:00:00Z",
    });
    // English has no teacher assigned.
    expect(rows[1]).toMatchObject({ teacher_id: null, teacher_name: null });
  });

  it("feeds the charts: exams oldest first by term, and the overall means", async () => {
    boot(performanceRoutes());
    const rows = await fetchClassPerformance(T, null);
    const exams = examsOf(rows);
    expect(exams.map((e) => e.name)).toEqual(["Opener", "Mock 1"]);
    // Mock 1: (80 + 50 + 60) / 3 marks = 63.3.
    expect(overallMeans(rows, exams)).toEqual([60, 63.3]);
  });

  it("asks for one class's papers only when a class is picked", async () => {
    boot(performanceRoutes());
    await fetchClassPerformance(T, C1);
    expect(api.callsTo(`GET ${P}/assessments`)[0]!.query.get("classId")).toBe(C1);
    boot(performanceRoutes());
    await fetchClassPerformance(T, null);
    expect(api.callsTo(`GET ${P}/assessments`)[0]!.query.get("classId")).toBeNull();
  });

  it("is empty when nothing is published, and reads no marks", async () => {
    boot(performanceRoutes({ [`GET ${P}/assessments`]: list("assessments", [papers[3]!]) }));
    expect(await fetchClassPerformance(T, null)).toEqual([]);
    expect(api.calls.filter((c) => c.path.endsWith("/marks"))).toHaveLength(0);
  });

  it("tells someone who may not read the terms and subjects what they are missing", async () => {
    boot(performanceRoutes({ [`GET ${P}/academic-terms`]: refused(), [`GET ${P}/subjects`]: refused() }));
    await expect(fetchClassPerformance(T, C1)).rejects.toThrow(PERFORMANCE_REFUSED);
  });

  it("shows teachers as unassigned when the staff list may not be read", async () => {
    boot(performanceRoutes({ [`GET ${P}/staff`]: refused() }));
    const rows = await fetchClassPerformance(T, null);
    expect(rows[0]).toMatchObject({ teacher_id: ST1, teacher_name: null });
  });

  it("stops when a paper's marks cannot be read, rather than averaging some of the papers", async () => {
    boot(performanceRoutes({ [`GET ${P}/assessments/pb/marks`]: refused() }));
    await expect(fetchClassPerformance(T, null)).rejects.toThrow();
  });

  it("reads each paper's marks once for a minute, so the page's other figures reuse them", async () => {
    boot(performanceRoutes());
    await fetchClassPerformance(T, null);
    await fetchClassPerformance(T, null);
    expect(api.callsTo(`GET ${P}/assessments/pa/marks`)).toHaveLength(1);
  });

  it("is a pure function of the papers, marks and names it is given", () => {
    const rows = classPerformanceRows({
      papers: [paper("pa") as never], marks: new Map([["pa", [mark("pa", L1, "50") as never]]]), terms: new Map(), classNames: new Map(), subjectNames: new Map(), teachers: new Map(),
    });
    expect(rows[0]).toMatchObject({ term_name: "Term", class_name: "Class", subject_name: "Subject", mean_score: 100, scores: [100] });
  });
});

describe("each learner's mean and one learner's history", () => {
  const roster = [
    { id: L1, tenantId: T, admission_no: "1", full_name: "Amina Otieno", gender: "female", boarding: false, active: true, date_of_birth: "2011-01-01", ...stamp },
    { id: L2, tenantId: T, admission_no: "2", full_name: "Brian Kamau", gender: "male", boarding: false, active: true, date_of_birth: "2011-01-01", ...stamp },
  ];
  const memberships = (learner?: string) => ["L1", "L2"].map((k, i) => ({ id: `cm${i}`, tenantId: T, learner_id: i === 0 ? L1 : L2, class_id: C1, academic_year_id: YEAR, active: true, archived_at: null, ...stamp })).filter((m) => !learner || m.learner_id === learner);

  it("works out each learner's mean over the subjects of an exam, by name", async () => {
    boot(performanceRoutes({
      [`GET ${P}/learners`]: list("learners", roster),
      [`GET ${P}/class-memberships`]: list("memberships", memberships()),
    }));
    const rows = await fetchClassLearnerMeans(C1);
    expect(rows.filter((r) => r.exam_id === examIdOf(TERM2, "Mock 1")).map((r) => [r.full_name, r.mean_score, r.subjects])).toEqual([
      ["Amina Otieno", 70, 2], // (80 + 60) / 2
      ["Brian Kamau", 50, 1],
    ]);
  });

  it("returns nothing for someone who may not read learners' names", async () => {
    boot(performanceRoutes({ [`GET ${P}/learners`]: refused(), [`GET ${P}/class-memberships`]: list("memberships", memberships()) }));
    expect(await fetchClassLearnerMeans(C1)).toEqual([]);
    expect(await fetchClassLearnerNames(C1)).toEqual([]);
  });

  it("lists the class's learners by name", async () => {
    boot(performanceRoutes({ [`GET ${P}/learners`]: list("learners", roster), [`GET ${P}/class-memberships`]: list("memberships", memberships()) }));
    expect(await fetchClassLearnerNames(C1)).toEqual([{ id: L1, full_name: "Amina Otieno" }, { id: L2, full_name: "Brian Kamau" }]);
  });

  it("builds one learner's trend: their score against the class mean of each paper, as percentages", async () => {
    boot(performanceRoutes({ [`GET ${P}/class-memberships`]: (call: FakeCall) => list("memberships", memberships(call.query.get("learnerId") ?? undefined)) }));
    const trend = await fetchLearnerTrend(L1);
    expect(trend.exams.map((e) => e.name)).toEqual(["Opener", "Mock 1"]);
    expect(trend.subjects.map((s) => [s.name, s.scores, s.classMeans])).toEqual([
      ["English", [null, 60], [null, 60]],
      ["Mathematics", [70, 80], [60, 65]],
    ]);
    // Mathematics (average 75) is stronger than English (60).
    expect(subjectStandings(trend)[0]!.name).toBe("Mathematics");
    expect(api.callsTo(`GET ${P}/class-memberships`)[0]!.query.get("learnerId")).toBe(L1);
  });

  it("has no trend for a learner who is in no class", async () => {
    boot(performanceRoutes({ [`GET ${P}/class-memberships`]: list("memberships", []) }));
    expect((await fetchLearnerTrend(L1)).exams).toEqual([]);
  });

  it("leaves out learners with no mark, and ones the roster does not name", () => {
    const rows = learnerMeanRows([paper("pa") as never], new Map([["pa", [mark("pa", L1, "10") as never, mark("pa", L2, "20") as never]]]), new Map([[L1, "Amina"]]));
    expect(rows).toEqual([{ exam_id: examIdOf(TERM2, "Mock 1"), student_id: L1, full_name: "Amina", mean_score: 20, subjects: 1 }]);
    expect(learnerHistoryRows(L2, [paper("pa") as never], new Map([["pa", [mark("pa", L1, "10") as never]]]), new Map(), new Map())).toEqual([]);
  });
});

describe("the pickers and the CBE charts", () => {
  it("lists the current year's classes, youngest year first", async () => {
    boot(performanceRoutes({
      [`GET ${P}/classes`]: list("classes", [{ ...klass, id: "c9", name: "Form 3 West", form_level: 3 }, klass, { ...klass, id: "c8", name: "Form 2 Alpha" }]),
    }));
    expect((await fetchClassOptions(T)).map((c) => c.name)).toEqual(["Form 2 Alpha", "Form 2 East", "Form 3 West"]);
    expect(api.callsTo(`GET ${P}/classes`)[0]!.query.get("academicYearId")).toBe(YEAR);
  });

  it("reads published CBE judgements once per assessment, within the requested class scope", async () => {
    const assessments = [
      cbeAssessment("cbe-current"),
      cbeAssessment("cbe-closed", { status: "closed", assessment_date: null, published_at: "2026-06-12T08:00:00Z" }),
      cbeAssessment("cbe-draft", { status: "draft", published_at: null }),
    ];
    boot({
      [`GET ${P}/cbe-assessments`]: (call: FakeCall) => list("cbe_assessments", call.query.get("classId") === C1 ? assessments : []),
      [`GET ${P}/cbe-assessments/cbe-current/results`]: list("results", [cbeResult("r1", L1, "EE1"), cbeResult("r2", L2, "ME2")]),
      [`GET ${P}/cbe-assessments/cbe-closed/results`]: list("results", [cbeResult("r3", L1, "BE1")]),
    });
    expect(await fetchCbeLevels({ classId: C1 })).toEqual([
      { assessedOn: "2026-06-10", levelCode: "EE1" },
      { assessedOn: "2026-06-10", levelCode: "ME2" },
      { assessedOn: "2026-06-12", levelCode: "BE1" },
    ]);
    expect(api.callsTo(`GET ${P}/cbe-assessments`)[0]!.query.get("classId")).toBe(C1);
    expect(api.callsTo(`GET ${P}/cbe-assessments/cbe-current/results`)).toHaveLength(1);
    expect(api.callsTo(`GET ${P}/cbe-assessments/cbe-closed/results`)).toHaveLength(1);
    expect(api.calls.some((call) => call.path.endsWith("cbe-draft/results"))).toBe(false);
  });

  it("filters a learner's CBE trend after the API has scoped the assessment list", async () => {
    boot({
      [`GET ${P}/cbe-assessments`]: list("cbe_assessments", [cbeAssessment("cbe-current")]),
      [`GET ${P}/cbe-assessments/cbe-current/results`]: list("results", [cbeResult("r1", L1, "EE1"), cbeResult("r2", L2, "ME2")]),
    });
    expect(await fetchCbeLevels({ studentId: L2 })).toEqual([{ assessedOn: "2026-06-10", levelCode: "ME2" }]);
    expect(api.callsTo(`GET ${P}/cbe-assessments`)[0]!.query.get("classId")).toBeNull();
  });

  it("does not read results when the scoped assessment list is refused", async () => {
    boot({ [`GET ${P}/cbe-assessments`]: refused() });
    await expect(fetchCbeLevels({ classId: C1 })).rejects.toThrow();
    expect(api.calls.some((call) => call.url.includes("/results"))).toBe(false);
  });

  it("counts the latest published assessment by class and learning area, with one result read per assessment", async () => {
    const assessments = [
      cbeAssessment("cbe-old", { assessment_date: "2026-06-01", title: "Old", published_at: "2026-06-01T08:00:00Z" }),
      cbeAssessment("cbe-current", { assessment_date: "2026-06-10", title: "Current" }),
      cbeAssessment("cbe-other-area", { learning_area_id: S2, assessment_date: "2026-06-09", title: "English" }),
      cbeAssessment("cbe-draft", { assessment_date: "2026-06-20", title: "Draft", status: "draft", published_at: null }),
      cbeAssessment("cbe-other-term", { term_id: TERM1, title: "Earlier term" }),
    ];
    boot({
      [`GET ${P}/cbe-assessments`]: list("cbe_assessments", assessments),
      [`GET ${P}/classes`]: list("classes", [{ ...klass, name: "Grade 7 East", education_level: "junior_secondary", form_level: 7 }]),
      [`GET ${P}/learning-areas`]: list("learning_areas", [learningArea(S1, "Mathematics"), learningArea(S2, "English")]),
      [`GET ${P}/cbe-assessments/cbe-current/results`]: list("results", [cbeResult("r1", L1, "EE1"), cbeResult("r2", L2, "ME2"), cbeResult("r3", L3, "ME1")]),
      [`GET ${P}/cbe-assessments/cbe-other-area/results`]: list("results", [cbeResult("r4", L1, "BE1")]),
    });
    const rows = await fetchCbeBandReport(T, TERM2, "KE");
    expect(rows.map((row) => [row.className, row.learningAreaName, row.assessmentTitle, row.learners])).toEqual([
      ["Grade 7 East", "English", "English", 1],
      ["Grade 7 East", "Mathematics", "Current", 3],
    ]);
    expect(rows.find((row) => row.learningAreaName === "Mathematics")!.counts).toEqual({ EE: 1, ME: 2, AE: 0, BE: 0 });
    expect(api.callsTo(`GET ${P}/cbe-assessments/cbe-current/results`)).toHaveLength(1);
    expect(api.callsTo(`GET ${P}/cbe-assessments/cbe-other-area/results`)).toHaveLength(1);
    expect(api.calls.some((call) => call.path.endsWith("cbe-old/results") || call.path.endsWith("cbe-draft/results") || call.path.endsWith("cbe-other-term/results"))).toBe(false);
  });
});
