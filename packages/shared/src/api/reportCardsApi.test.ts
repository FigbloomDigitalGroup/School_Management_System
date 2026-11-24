import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { isNotOnApiError, reportCardsCapabilities } from "../capabilities";
import { competencyKey, fetchCompetencyRatings, saveCompetencyRating } from "../competencies";
import {
  defaultReportCardOptions, fetchClassReportCards, fetchMyReportCards, fetchReportCardSetup, fetchTermExams,
  fetchUnpublishedMarks, prepareClassReportCards, saveReportCardComments, saveReportCards, saveTeacherComment,
  setReportCardsPublished,
} from "../reportCards";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { apiCanWriteCompetencyRatings, apiPublishClassReportCard, resetCompetencyRatingVersions } from "./reportCardsApi";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const Y1 = "22222222-2222-4222-8222-222222222222";
const TERM1 = "33333333-3333-4333-8333-333333333333";
const TERM2 = "44444444-4444-4444-8444-444444444444";
const CLS1 = "55555555-5555-4555-8555-555555555555";
const CLS2 = "66666666-6666-4666-8666-666666666666";
const SUBJ1 = "77777777-7777-4777-8777-777777777777";
const L1 = "88888888-8888-4888-8888-888888888888";
const L2 = "99999999-9999-4999-8999-999999999999";
const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RC1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RC2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const U_ADMIN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const U_TEACHER = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const list = (key: string, items: unknown[], next: string | null = null): FakeReply => ({ body: { [key]: items, page: page(next) } });
const forbidden = (): FakeReply => ({ status: 403, body: { error: { code: "forbidden", message: "Forbidden" } } });

const apiYear = (o: Record<string, unknown> = {}) => ({
  id: Y1, tenantId: T, label: "2026", starts_on: "2026-01-01", ends_on: "2026-12-31", is_current: true, ...o,
});
const apiTerm = (o: Record<string, unknown> = {}) => ({
  id: TERM1, tenantId: T, academic_year_id: Y1, label: "Term 1 2026", index: 1,
  starts_on: "2026-01-06", ends_on: "2026-04-03", is_current: false, ...o,
});
const apiClass = (o: Record<string, unknown> = {}) => ({
  id: CLS1, tenantId: T, academic_year_id: Y1, name: "Form 1 East", form_level: 1,
  education_level: "secondary", pathway: null, stream: "East", class_teacher_staff_id: null, active: true, ...o,
});
const apiSubject = (o: Record<string, unknown> = {}) => ({
  id: SUBJ1, tenantId: T, code: "MAT", name: "Mathematics", active: true, ...o,
});
const apiLearner = (o: Record<string, unknown> = {}) => ({
  id: L1, tenantId: T, admission_no: "1001", full_name: "Amani Otieno",
  date_of_birth: null, gender: "female", boarding: "day", active: true, ...o,
});
const apiAssessment = (o: Record<string, unknown> = {}) => ({
  id: A1, tenantId: T, class_id: CLS1, subject_id: SUBJ1, term_id: TERM1,
  title: "End Term Exam", kind: "exam", max_score: "100.00", status: "published",
  published_at: "2026-04-01T10:00:00Z", version: 1, created_at: "2026-03-20T08:00:00Z", updated_at: "2026-04-01T10:00:00Z", ...o,
});
const apiReportCard = (o: Record<string, unknown> = {}) => ({
  id: RC1,
  tenantId: T,
  term_id: TERM1,
  class_id: CLS1,
  published_at: "2026-04-02T12:00:00Z",
  published_by: U_ADMIN,
  figures: {
    method: "sum_and_mean_of_published_scores",
    assessment_ids: [A1],
    learners: [
      { learner_id: L1, sum: "80.00", count: 1, average: "80.00", grade: "A", assessment_ids: [A1] },
      { learner_id: L2, sum: "60.00", count: 1, average: "60.00", grade: "B-", assessment_ids: [A1] },
    ],
    cbe: { assessment_ids: [], learners: [] },
    competencies: { learners: [] },
  },
  ...o,
});

let api: FakeApi;
const P = `/v1/tenants/${T}`;

function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  resetCompetencyRatingVersions();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: U_ADMIN }));
  setApiActiveTenant(T);
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  resetCompetencyRatingVersions();
  initBackend({ kind: "supabase" });
});

describe("capabilities & unsupported writes", () => {
  it("disables API-unsupported report card controls on API and enables all on Supabase", () => {
    initBackend({ kind: "supabase" });
    expect(reportCardsCapabilities()).toEqual({
      selectExamsAndOptions: true, draftWorkflow: true, comments: true, signatures: true, aiComments: true, clearCompetencyRating: true,
    });
    initBackend({ kind: "api", apiUrl: BASE });
    expect(reportCardsCapabilities()).toEqual({
      selectExamsAndOptions: false, draftWorkflow: false, comments: false, signatures: false, aiComments: false, clearCompetencyRating: false,
    });
  });

  it("throws NotOnApiError for Supabase-only report card operations on API", async () => {
    boot({});
    const dummyInput = {
      tenantId: T,
      school: { name: "Test", county: null, country: "KE", logoUrl: null, accent: "#17402A" },
      termId: TERM1,
      classId: CLS1,
      examIds: [],
      options: defaultReportCardOptions("kcse"),
    };
    await expect(prepareClassReportCards(dummyInput)).rejects.toSatisfy(isNotOnApiError);
    await expect(saveReportCardComments(RC1, { teacher: "Well done" })).rejects.toSatisfy(isNotOnApiError);
    await expect(saveTeacherComment(RC1, "Well done")).rejects.toSatisfy(isNotOnApiError);
    await expect(setReportCardsPublished([RC1], false)).rejects.toSatisfy(isNotOnApiError);
    await expect(fetchMyReportCards([L1])).rejects.toSatisfy(isNotOnApiError);
    expect(api.calls).toHaveLength(0);
  });
});

describe("fetchReportCardSetup on API", () => {
  it("loads terms newest-first and classes sorted by year for admins", async () => {
    boot({
      [`GET ${P}/academic-terms`]: () => list("terms", [
        apiTerm({ id: TERM1, label: "Term 1 2026", starts_on: "2026-01-06", is_current: false }),
        apiTerm({ id: TERM2, label: "Term 2 2026", starts_on: "2026-05-04", is_current: true }),
      ]),
      [`GET ${P}/classes`]: () => list("classes", [
        apiClass({ id: CLS2, name: "Form 2 North", form_level: 2, education_level: "secondary" }),
        apiClass({ id: CLS1, name: "Grade 4 Blue", form_level: 4, education_level: "primary" }),
      ]),
    });
    const setup = await fetchReportCardSetup(T);
    expect(setup.terms.map((t) => [t.id, t.isCurrent])).toEqual([[TERM2, true], [TERM1, false]]);
    expect(setup.classes.map((c) => [c.id, c.name, c.level])).toEqual([
      [CLS1, "Grade 4 Blue", "primary"],
      [CLS2, "Form 2 North", "secondary"],
    ]);
  });

  it("discovers published terms for a plain teacher when /academic-terms returns 403", async () => {
    boot({
      [`GET ${P}/academic-terms`]: forbidden,
      [`GET ${P}/academic-years`]: forbidden,
      [`GET ${P}/classes`]: () => list("classes", [apiClass({ id: CLS1, name: "Form 1 East" })]),
      [`GET ${P}/staff`]: forbidden,
      [`GET ${P}/teaching-assignments`]: forbidden,
      "GET /v1/rbac/permissions": () => list("items", []),
      [`GET ${P}/report-cards`]: () => list("report_cards", [
        apiReportCard({ id: RC2, term_id: TERM2, published_at: "2026-08-01T10:00:00Z" }),
        apiReportCard({ id: RC1, term_id: TERM2, published_at: "2026-07-20T10:00:00Z" }),
        apiReportCard({ id: "12345678-1234-4123-8123-1234567890ab", term_id: TERM1, published_at: "2026-04-02T12:00:00Z" }),
      ]),
    });
    const setup = await fetchReportCardSetup(T, U_TEACHER);
    expect(setup.classes).toEqual([{ id: CLS1, name: "Form 1 East", level: "secondary" }]);
    expect(setup.terms).toEqual([
      { id: TERM2, name: "Latest published term", isCurrent: true },
      { id: TERM1, name: "Published term 2", isCurrent: false },
    ]);
  });
});

describe("fetchTermExams & fetchUnpublishedMarks on API", () => {
  it("maps published and closed assessments as published and draft as unpublished", async () => {
    boot({
      [`GET ${P}/assessments`]: () => list("assessments", [
        apiAssessment({ id: A2, title: "Draft CAT", max_score: "50.00", status: "draft", published_at: null }),
        apiAssessment({ id: A1, title: "End Term", max_score: "100.00", status: "closed", published_at: "2026-04-01T10:00:00Z" }),
      ]),
    });
    const exams = await fetchTermExams(TERM1);
    expect(exams).toEqual([
      { id: A1, name: "End Term", outOf: 100, published: true },
      { id: A2, name: "Draft CAT", outOf: 50, published: false },
    ]);
  });

  it("reports draft assessments as unpublished marks and skips network when examIds is empty", async () => {
    boot({
      [`GET ${P}/assessments`]: () => list("assessments", [
        apiAssessment({ id: A1, title: "End Term", status: "published" }),
        apiAssessment({ id: A2, title: "Mid Term CAT", status: "draft" }),
      ]),
      [`GET ${P}/subjects`]: () => list("subjects", [apiSubject({ id: SUBJ1, name: "Mathematics" })]),
    });
    expect(await fetchUnpublishedMarks(CLS1, [])).toEqual([]);
    expect(api.calls).toHaveLength(0);

    const left = await fetchUnpublishedMarks(CLS1, [A1, A2]);
    expect(left).toEqual([{ examId: A2, examName: "Mid Term CAT", subjectId: SUBJ1, subjectName: "Mathematics" }]);
  });
});

describe("fetchClassReportCards & publish on API", () => {
  it("hydrates the latest published snapshot with marks, CBE results, and competency ratings", async () => {
    boot({
      [`GET ${P}/report-cards`]: () => list("report_cards", [
        apiReportCard({
          id: RC2,
          published_at: "2026-04-03T09:00:00Z",
          figures: {
            method: "sum_and_mean_of_published_scores",
            assessment_ids: [A1],
            learners: [
              { learner_id: L1, sum: "84.00", count: 1, average: "84.00", grade: "A", assessment_ids: [A1] },
            ],
            cbe: {
              assessment_ids: ["cbe-1"],
              learners: [{
                learner_id: L2,
                results: [{
                  cbe_assessment_id: "cbe-1", title: "Science Project", instrument_type: "project",
                  strand_id: null, learning_outcome_id: null, level_code: "EE", points: "4.00",
                  observation: "Great teamwork", teacher_feedback: null, completion_status: "finalized", curriculum_version_label: null,
                }],
              }],
            },
            competencies: {
              learners: [{
                learner_id: L2,
                ratings: [{ kind: "competency", item: "communication", level_code: "ME" }],
              }],
            },
          },
        }),
        apiReportCard({ id: RC1, published_at: "2026-04-01T09:00:00Z" }),
      ]),
      [`GET ${P}`]: () => ({ body: { id: T, name: "Alliance High" } }),
      [`GET ${P}/school-profile`]: () => ({ body: { schoolProfile: { tenantId: T, name: "Alliance High", county: "Kiambu", country: "KE", accent: "#17402A" } } }),
      [`GET ${P}/academic-years`]: () => list("academic_years", [apiYear()]),
      [`GET ${P}/academic-terms`]: () => list("terms", [apiTerm()]),
      [`GET ${P}/classes`]: () => list("classes", [apiClass()]),
      [`GET ${P}/subjects`]: () => list("subjects", [apiSubject()]),
      [`GET ${P}/learners`]: () => list("learners", [
        apiLearner({ id: L2, full_name: "Baraka Kamau", admission_no: "1002" }),
        apiLearner({ id: L1, full_name: "Amani Otieno", admission_no: "1001" }),
      ]),
      [`GET ${P}/assessments`]: () => list("assessments", [apiAssessment()]),
      [`GET ${P}/assessments/${A1}/marks`]: () => list("marks", [
        { id: "m1", tenantId: T, assessment_id: A1, learner_id: L1, score: "84.00", grade: "A", marked_at: "2026-04-01T10:00:00Z", marked_by: U_ADMIN, row_version: 1 },
      ]),
    });

    const cards = await fetchClassReportCards(TERM1, CLS1);
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.data.learner.name)).toEqual(["Amani Otieno", "Baraka Kamau"]);
    expect(cards[0]!.id).toBe(`${RC2}:${L1}`);
    expect(cards[0]!.publishedAt).toBe("2026-04-03T09:00:00Z");
    expect(cards[0]!.data.summary.mean).toBe(84);
    expect(cards[0]!.data.subjects[0]!.name).toBe("Mathematics");
    expect(cards[1]!.data.cbe?.[0]).toMatchObject({ area: "Science Project", level: "EE", comment: "Great teamwork" });
    expect(cards[1]!.data.competencies?.[0]).toMatchObject({ kind: "competency", level: "ME" });
  });

  it("degrades cleanly for plain teachers when /learners and /academic-terms return 403", async () => {
    boot({
      [`GET ${P}/report-cards`]: () => list("report_cards", [apiReportCard()]),
      [`GET ${P}`]: forbidden,
      [`GET ${P}/school-profile`]: forbidden,
      [`GET ${P}/academic-years`]: forbidden,
      [`GET ${P}/academic-terms`]: forbidden,
      [`GET ${P}/classes`]: () => list("classes", [apiClass()]),
      [`GET ${P}/subjects`]: forbidden,
      [`GET ${P}/learners`]: forbidden,
      [`GET ${P}/assessments`]: () => list("assessments", [apiAssessment()]),
      [`GET ${P}/assessments/${A1}/marks`]: forbidden,
    });

    const cards = await fetchClassReportCards(TERM1, CLS1);
    expect(cards).toHaveLength(2);
    const l1 = cards.find((c) => c.studentId === L1)!;
    expect(l1.data.summary.mean).toBe(80);
    expect(l1.data.summary.grade).toBe("A");
    expect(l1.data.learner.name).toBe(`Learner ${L1.slice(0, 8)}`);
  });

  it("publishes a class report card snapshot via POST /report-cards", async () => {
    let postedBody: unknown = null;
    boot({
      [`POST ${P}/report-cards`]: (req) => {
        postedBody = req.body;
        return { status: 201, body: { report_card: apiReportCard() } };
      },
    });
    const out = await apiPublishClassReportCard(T, TERM1, CLS1);
    expect(postedBody).toEqual({ term_id: TERM1, class_id: CLS1 });
    expect(out).toEqual({ reportCardId: RC1, learnerCount: 2 });

    const saved = await saveReportCards(T, TERM1, CLS1, []);
    expect(saved).toEqual({ saved: 2, skippedPublished: 0 });
  });
});

describe("competency ratings on API", () => {
  it("fetches ratings, caches row_version, sends row_version on update, and rejects clearing", async () => {
    const posts: unknown[] = [];
    boot({
      [`GET ${P}/competency-ratings`]: () => list("ratings", [
        {
          id: "r1", tenantId: T, term_id: TERM1, learner_id: L1, kind: "competency", item: "communication",
          level_code: "ME", rated_at: "2026-04-01T08:00:00Z", rated_by: U_ADMIN, row_version: 2,
        },
        {
          id: "r2", tenantId: T, term_id: TERM1, learner_id: L2, kind: "value", item: "integrity",
          level_code: "EE", rated_at: "2026-04-01T08:00:00Z", rated_by: U_ADMIN, row_version: 1,
        },
      ]),
      [`POST ${P}/competency-ratings`]: (req) => {
        posts.push(req.body);
        const body = req.body as { row_version?: number; level_code: string; item: string; kind: string; learner_id: string };
        return {
          status: 200,
          body: {
            rating: {
              id: "r1", tenantId: T, term_id: TERM1, learner_id: body.learner_id, kind: body.kind, item: body.item,
              level_code: body.level_code, rated_at: "2026-04-02T08:00:00Z", rated_by: U_ADMIN, row_version: (body.row_version ?? 0) + 1,
            },
          },
        };
      },
    });

    const ratings = await fetchCompetencyRatings(TERM1, [L1]);
    expect(ratings.get(L1)?.get(competencyKey("competency", "communication"))).toBe("ME");
    expect(ratings.has(L2)).toBe(false);

    // Update existing rating -> sends cached row_version: 2, updates cache to 3.
    await saveCompetencyRating(T, TERM1, L1, "competency", "communication", "EE");
    await saveCompetencyRating(T, TERM1, L1, "competency", "communication", "AE");
    expect(posts).toEqual([
      { term_id: TERM1, learner_id: L1, kind: "competency", item: "communication", level_code: "EE", row_version: 2 },
      { term_id: TERM1, learner_id: L1, kind: "competency", item: "communication", level_code: "AE", row_version: 3 },
    ]);

    // Clearing is not supported on the API.
    await expect(saveCompetencyRating(T, TERM1, L1, "competency", "communication", null)).rejects.toSatisfy(isNotOnApiError);
  });

  it("checks resource.academics.write for apiCanWriteCompetencyRatings", async () => {
    boot({
      "GET /v1/rbac/permissions": () => list("items", ["resource.academics.write"]),
    });
    expect(await apiCanWriteCompetencyRatings(T)).toBe(true);

    boot({
      "GET /v1/rbac/permissions": () => list("items", ["resource.attendance.read"]),
    });
    expect(await apiCanWriteCompetencyRatings(T)).toBe(false);
  });
});
