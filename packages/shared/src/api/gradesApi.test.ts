import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { isNotOnApiError } from "../capabilities";
import { actOnPapers, countPaperMarks, createExam, deleteExam, fetchExamSetPapers, fetchExamSummaries, renameExam, topUpExam, validateExamOutOf } from "../exams";
import { fetchMarkAbsences } from "../examExtensions";
import { parseScoreInput } from "../grading";
import {
  correctPublishedMark, fetchExamsForTerm, fetchGradesAccess, fetchMarksForExamSubject, fetchPublishedSubjects, fetchTeacherSubjectsForClass, publishMarks, saveExamMarks, unpublishMarks,
} from "../teacherData";
import { BASE, createFakeApi, type FakeApi, type FakeCall, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { examIdOf, groupExams, parseExamId } from "./gradesApi";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const YEAR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TERM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const C2 = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";
const S1 = "51515151-5151-4515-8515-515151515151";
const S2 = "52525252-5252-4525-8525-525252525252";
const L1 = "10000001-1111-4111-8111-111111111111";
const L2 = "10000002-1111-4111-8111-111111111111";
const L3 = "10000003-1111-4111-8111-111111111111";
const ST1 = "a0000001-1111-4111-8111-111111111111";
const USER = "u0000001-1111-4111-8111-111111111111";

const stamp = { created_at: "2026-05-01T08:00:00Z", updated_at: "2026-05-01T08:00:00Z" };
const paper = (o: Record<string, unknown> = {}) => ({
  id: "p0000001-1111-4111-8111-111111111111", tenantId: T, class_id: C1, subject_id: S1, term_id: TERM, title: "Mock 1", kind: "exam", max_score: "50.00",
  status: "draft", published_at: null, archived_at: null, marks_entered: 0, version: 1, ...stamp, ...o,
});
const mark = (learner: string, score: string, rowVersion = 1) => ({
  id: `m-${learner}`, tenantId: T, assessment_id: "p0000001-1111-4111-8111-111111111111", learner_id: learner, score, grade: null,
  marked_at: "2026-05-02T08:00:00Z", marked_by: USER, row_version: rowVersion,
});
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
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: USER }));
  setApiActiveTenant(T);
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

const term = { id: TERM, tenantId: T, academic_year_id: YEAR, index: 2, label: "Term 2, 2026", starts_on: "2026-05-01", ends_on: "2026-08-01", is_current: true, ...stamp };
const klass = (id: string, name: string) => ({
  id, tenantId: T, academic_year_id: YEAR, name, education_level: "secondary", form_level: 2, pathway: null, stream: null, class_teacher_staff_id: null,
  active: true, archived_at: null, ...stamp,
});
const assignment = (cls: string, subject: string, staff = ST1) => ({ id: `ta-${cls}-${subject}`, tenantId: T, staff_member_id: staff, class_id: cls, subject_id: subject, active: true, archived_at: null, ...stamp });
const subject = (id: string, name: string) => ({ id, tenantId: T, code: name.slice(0, 3).toUpperCase(), name, active: true, archived_at: null, ...stamp });
const staffRow = (id: string, userId: string | null, name = "Joyce Grader") => ({ id, tenantId: T, userId, full_name: name, classification: "teacher", active: true, ...stamp });

describe("an exam is a title in a term", () => {
  it("encodes and reads back its id, titles with bars included", () => {
    expect(parseExamId(examIdOf(TERM, "Mock 1 | part 2"))).toEqual({ termId: TERM, title: "Mock 1 | part 2" });
    expect(() => parseExamId("no-term")).toThrow(/not one of this school's exams/);
  });

  it("groups papers of kind exam by term and title, ignoring case, and leaves homework out", () => {
    const groups = groupExams([
      paper({ id: "a", title: "Mock 1" }), paper({ id: "b", title: " mock 1 ", subject_id: S2 }), paper({ id: "c", title: "Mock 1", kind: "homework" }),
      paper({ id: "d", title: "Opener", max_score: "100" }),
    ] as Parameters<typeof groupExams>[0]);
    expect(groups.map((g) => [g.name, g.papers.length])).toEqual([["Mock 1", 2], ["Opener", 1]]);
  });

  it("lists the term's exams for the Gradebook with the paper's total and the earliest publication", async () => {
    boot({
      [`GET ${P}/assessments`]: list("assessments", [
        paper({ id: "a", status: "published", published_at: "2026-06-02T08:00:00Z" }),
        paper({ id: "b", subject_id: S2, status: "published", published_at: "2026-06-01T08:00:00Z" }),
        paper({ id: "c", kind: "other", title: "Quiz" }),
      ]),
    });
    const exams = await fetchExamsForTerm(TERM);
    expect(exams).toEqual([{ id: examIdOf(TERM, "Mock 1"), tenant_id: T, term_id: TERM, name: "Mock 1", out_of: 50, published_at: "2026-06-01T08:00:00Z" }]);
    expect(api.callsTo(`GET ${P}/assessments`)[0]!.query.get("termId")).toBe(TERM);
  });

  it("summarises each exam: its total, how many papers it has and how many are out", async () => {
    boot({
      [`GET ${P}/assessments`]: list("assessments", [
        paper({ id: "a", status: "published" }), paper({ id: "b", subject_id: S2, status: "closed" }), paper({ id: "c", class_id: C2 }),
      ]),
    });
    expect(await fetchExamSummaries(TERM)).toEqual([{ id: examIdOf(TERM, "Mock 1"), name: "Mock 1", outOf: 50, marksEntered: 0, resultsOut: 2, papers: 3 }]);
  });

  it("follows the API's pages to the end", async () => {
    boot({
      [`GET ${P}/assessments`]: (call: FakeCall) => (call.query.get("cursor") ? list("assessments", [paper({ id: "b", title: "Opener" })]) : list("assessments", [paper({ id: "a" })], "next")),
    });
    expect((await fetchExamsForTerm(TERM)).map((e) => e.name)).toEqual(["Mock 1", "Opener"]);
  });
});

describe("making an exam", () => {
  const routes = (existing: unknown[] = [], assignments: unknown[] = [assignment(C1, S1), assignment(C1, S2), assignment(C2, S1)]): Record<string, FakeRoute> => ({
    [`GET ${P}/academic-terms`]: list("terms", [term]),
    [`GET ${P}/classes`]: list("classes", [klass(C1, "Form 2 East")]),
    [`GET ${P}/teaching-assignments`]: list("assignments", assignments),
    [`GET ${P}/assessments`]: list("assessments", existing),
    [`POST ${P}/assessments`]: { status: 201, body: { assessment: paper() } },
  });

  it("makes one paper for each class of the term's year and subject that has a teacher, out of the chosen total", async () => {
    boot(routes());
    const res = await createExam(T, TERM, "Mock 1", 50);
    // C2 is not a class of the term's year, so its assignment is left out.
    expect(res).toEqual({ made: 2, alreadyThere: 0 });
    const posts = api.callsTo(`POST ${P}/assessments`);
    expect(posts.map((p) => p.body)).toEqual([
      { class_id: C1, subject_id: S1, term_id: TERM, title: "Mock 1", kind: "exam", max_score: 50 },
      { class_id: C1, subject_id: S2, term_id: TERM, title: "Mock 1", kind: "exam", max_score: 50 },
    ]);
  });

  it("is out of 100 unless told otherwise", async () => {
    boot(routes());
    await createExam(T, TERM, "Mock 1");
    expect((api.callsTo(`POST ${P}/assessments`)[0]!.body as { max_score: number }).max_score).toBe(100);
  });

  it("makes only the papers that are missing when run again for the same title", async () => {
    boot(routes([paper({ subject_id: S1 })]));
    expect(await topUpExam(examIdOf(TERM, "Mock 1"), 50)).toEqual({ made: 1, alreadyThere: 1 });
    expect(api.callsTo(`POST ${P}/assessments`)).toHaveLength(1);
  });

  it("makes nothing when every paper is there", async () => {
    boot(routes([paper({ subject_id: S1 }), paper({ id: "b", subject_id: S2 })]));
    expect(await topUpExam(examIdOf(TERM, "mock 1"), 50)).toEqual({ made: 0, alreadyThere: 2 });
    expect(api.callsTo(`POST ${P}/assessments`)).toHaveLength(0);
  });

  it("says what to do when no class has a subject teacher", async () => {
    boot(routes([], []));
    await expect(createExam(T, TERM, "Mock 1", 50)).rejects.toThrow(/No class has a subject teacher yet/);
    expect(api.callsTo(`POST ${P}/assessments`)).toHaveLength(0);
  });

  it("says how many papers were made when some are refused", async () => {
    let n = 0;
    boot({ ...routes(), [`POST ${P}/assessments`]: () => (++n === 2 ? refused("conflict", 409, "Class is archived") : { status: 201, body: { assessment: paper() } }) });
    await expect(createExam(T, TERM, "Mock 1", 50)).rejects.toThrow('Set up 1 of 2 papers (1 failed: Class is archived). Use "Add new class subjects" to finish.');
  });

  it("reports the plain error when every paper is refused", async () => {
    boot({ ...routes(), [`POST ${P}/assessments`]: refused("forbidden", 403, "Missing permission") });
    await expect(createExam(T, TERM, "Mock 1", 50)).rejects.toThrow(/permission/i);
  });

  it("keeps four writes in flight at most", async () => {
    let inFlight = 0;
    let peak = 0;
    boot({
      ...routes([], Array.from({ length: 10 }, (_, i) => assignment(C1, `5000000${i}-5151-4515-8515-515151515151`))),
      [`POST ${P}/assessments`]: async () => {
        inFlight += 1; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { status: 201, body: { assessment: paper() } };
      },
    });
    expect(await createExam(T, TERM, "Mock 1", 50)).toEqual({ made: 10, alreadyThere: 0 });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("does not offer rename or delete", async () => {
    boot({});
    for (const fn of [() => renameExam("x", "y"), () => deleteExam("x")]) {
      await expect(fn()).rejects.toSatisfy(isNotOnApiError);
    }
  });

  it("checks the total", () => {
    expect(validateExamOutOf("100")).toEqual({ ok: true, outOf: 100 });
    expect(validateExamOutOf(" 37.5 ")).toEqual({ ok: true, outOf: 37.5 });
    for (const bad of ["", "0", "-5", "abc", "10001", "1.234", "1e3"]) expect(validateExamOutOf(bad).ok).toBe(false);
  });
});

describe("the Exams page: papers, marks per paper, publish and close", () => {
  it("lists an exam's papers with class and subject names, in order", async () => {
    boot({
      [`GET ${P}/assessments`]: list("assessments", [
        paper({ id: "a", class_id: C2, subject_id: S1 }), paper({ id: "b", subject_id: S2, status: "published" }), paper({ id: "c", subject_id: S1 }), paper({ id: "d", title: "Opener" }),
      ]),
      [`GET ${P}/classes`]: list("classes", [klass(C1, "Form 2 East"), klass(C2, "Form 2 West")]),
      [`GET ${P}/subjects`]: list("subjects", [subject(S1, "Mathematics"), subject(S2, "English")]),
    });
    const papers = await fetchExamSetPapers(examIdOf(TERM, "Mock 1"));
    expect(papers.map((p) => [p.className, p.subjectName, p.status, p.outOf])).toEqual([
      ["Form 2 East", "English", "published", 50], ["Form 2 East", "Mathematics", "draft", 50], ["Form 2 West", "Mathematics", "draft", 50],
    ]);
  });

  it("counts the marks of each paper, leaving out a paper that cannot be read", async () => {
    boot({
      [`GET ${P}/assessments/a/marks`]: list("marks", [mark(L1, "10"), mark(L2, "20")]),
      [`GET ${P}/assessments/b/marks`]: refused("forbidden", 403),
    });
    expect([...(await countPaperMarks(["a", "b"])).entries()]).toEqual([["a", 2]]);
  });

  it("publishes and closes papers and says how many were done when some fail", async () => {
    boot({
      [`POST ${P}/assessments/a/publish`]: { body: { assessment: paper() } },
      [`POST ${P}/assessments/b/publish`]: refused("conflict", 409, "Already published"),
      [`POST ${P}/assessments/a/close`]: { body: { assessment: paper() } },
    });
    expect(await actOnPapers("publish", ["a", "b"])).toEqual({ done: 1, failed: 1, firstError: "Already published" });
    expect(await actOnPapers("close", ["a"])).toEqual({ done: 1, failed: 0, firstError: null });
  });
});

describe("the Gradebook", () => {
  const PAPER = "p0000001-1111-4111-8111-111111111111";

  it("reads a class's marks for one subject of an exam", async () => {
    boot({
      [`GET ${P}/assessments`]: list("assessments", [paper(), paper({ id: "other", subject_id: S2 })]),
      [`GET ${P}/assessments/${PAPER}/marks`]: list("marks", [mark(L1, "42.50"), mark(L2, "10"), mark(L3, "7")]),
    });
    const got = await fetchMarksForExamSubject(examIdOf(TERM, "Mock 1"), S1, [L1, L2], C1);
    expect(got).toEqual({ [L1]: 42.5, [L2]: 10 });
    const asked = api.callsTo(`GET ${P}/assessments`)[0]!.query;
    expect([asked.get("classId"), asked.get("termId")]).toEqual([C1, TERM]);
  });

  it("says there is no paper when the office has not set one up for that class and subject", async () => {
    boot({ [`GET ${P}/assessments`]: list("assessments", [paper({ subject_id: S2 })]) });
    await expect(fetchMarksForExamSubject(examIdOf(TERM, "Mock 1"), S1, [L1], C1)).rejects.toThrow(/no "Mock 1" paper for this class and subject yet/);
  });

  it("needs the class on the API", async () => {
    boot({});
    await expect(fetchMarksForExamSubject(examIdOf(TERM, "Mock 1"), S1, [L1])).rejects.toThrow(/Pick a class/);
    expect(await fetchMarksForExamSubject(examIdOf(TERM, "Mock 1"), S1, [], C1)).toEqual({});
  });

  it("knows which subjects are out for the class", async () => {
    boot({
      [`GET ${P}/assessments`]: list("assessments", [paper({ status: "published" }), paper({ id: "b", subject_id: S2 }), paper({ id: "c", title: "Opener", status: "published" })]),
    });
    expect([...(await fetchPublishedSubjects(examIdOf(TERM, "Mock 1"), C1))]).toEqual([S1]);
  });

  const saveRoutes = (extra: Record<string, FakeRoute> = {}, existing: unknown[] = [], status = "draft"): Record<string, FakeRoute> => ({
    [`GET ${P}/assessments`]: list("assessments", [paper({ status })]),
    [`GET ${P}/assessments/${PAPER}/marks`]: list("marks", existing),
    [`POST ${P}/assessments/${PAPER}/marks`]: (call: FakeCall) => ({ status: 201, body: { mark: mark((call.body as { learner_id: string }).learner_id, "1") } }),
    ...extra,
  });
  const row = (student_id: string, score: number | null) => ({ tenant_id: T, exam_id: examIdOf(TERM, "Mock 1"), student_id, subject_id: S1, score, entered_by: USER });
  const posted = () => api.callsTo(`POST ${P}/assessments/${PAPER}/marks`).map((c) => c.body);

  it("sends new marks without a row version and changed ones with the version they were read at", async () => {
    boot(saveRoutes({}, [mark(L2, "10", 3)]));
    await saveExamMarks([row(L1, 40), row(L2, 12.5)], C1);
    expect(posted()).toEqual([{ learner_id: L1, score: 40 }, { learner_id: L2, score: 12.5, row_version: 3 }]);
  });

  it("does not send a mark that has not changed", async () => {
    boot(saveRoutes({}, [mark(L1, "40.00", 2)]));
    await saveExamMarks([row(L1, 40), row(L2, 5)], C1);
    expect(posted()).toEqual([{ learner_id: L2, score: 5 }]);
  });

  it("sends nothing for an absent learner, and nothing at all for no rows", async () => {
    boot(saveRoutes());
    await saveExamMarks([row(L1, null), row(L2, 5)], C1);
    expect(posted()).toEqual([{ learner_id: L2, score: 5 }]);
    api.calls.length = 0;
    await saveExamMarks([], C1);
    expect(api.calls).toHaveLength(0);
  });

  it("refuses to change a saved mark back to absent, before writing anything", async () => {
    boot(saveRoutes({}, [mark(L1, "40", 1)]));
    await expect(saveExamMarks([row(L2, 5), row(L1, null)], C1)).rejects.toThrow(/cannot be changed back to absent/);
    expect(posted()).toEqual([]);
  });

  it("refuses a mark above the paper's total, and any save to a published paper", async () => {
    boot(saveRoutes());
    await expect(saveExamMarks([row(L1, 51)], C1)).rejects.toThrow("This paper is out of 50.");
    expect(posted()).toEqual([]);
    boot(saveRoutes({}, [], "published"));
    await expect(saveExamMarks([row(L1, 5)], C1)).rejects.toThrow(/published marks are final/);
    expect(posted()).toEqual([]);
  });

  it("needs the class, and a paper to exist", async () => {
    boot(saveRoutes());
    await expect(saveExamMarks([row(L1, 5)])).rejects.toThrow(/Pick a class/);
    boot({ [`GET ${P}/assessments`]: list("assessments", []) });
    await expect(saveExamMarks([row(L1, 5)], C1)).rejects.toThrow(/no "Mock 1" paper/);
  });

  it("says how many marks were saved when some fail, and the plain error when all do", async () => {
    boot(saveRoutes({ [`POST ${P}/assessments/${PAPER}/marks`]: (call: FakeCall) => ((call.body as { learner_id: string }).learner_id === L2 ? refused("conflict", 409, "The mark was updated by someone else") : { status: 201, body: { mark: mark(L1, "1") } }) }));
    await expect(saveExamMarks([row(L1, 5), row(L2, 6), row(L3, 7)], C1)).rejects.toThrow("Saved 2 of 3 marks (1 failed: The mark was updated by someone else)");
    boot(saveRoutes({ [`POST ${P}/assessments/${PAPER}/marks`]: refused("conflict", 409, "Marks of a published assessment are locked.") }));
    await expect(saveExamMarks([row(L1, 5)], C1)).rejects.toThrow("Marks of a published assessment are locked.");
  });

  it("records a published mark correction with the current version and a trimmed reason", async () => {
    boot(saveRoutes({
      [`POST ${P}/assessments/${PAPER}/mark-corrections`]: { status: 201, body: { correction: {}, mark: mark(L1, "12.5", 5) } },
    }, [mark(L1, "10", 4)], "published"));
    await correctPublishedMark({ examId: examIdOf(TERM, "Mock 1"), classId: C1, subjectId: S1, learnerId: L1, score: 12.5, reason: "  Checked against the source paper  " });
    expect(api.callsTo(`POST ${P}/assessments/${PAPER}/mark-corrections`).map((call) => call.body)).toEqual([{
      learner_id: L1, score: 12.5, reason: "Checked against the source paper", row_version: 4,
    }]);
  });

  it("uses version zero for a first mark and refuses drafts, unchanged marks, invalid reasons and out-of-range scores", async () => {
    boot(saveRoutes({ [`POST ${P}/assessments/${PAPER}/mark-corrections`]: { status: 201, body: { correction: {}, mark: mark(L1, "12") } } }, [], "closed"));
    await correctPublishedMark({ examId: examIdOf(TERM, "Mock 1"), classId: C1, subjectId: S1, learnerId: L1, score: 12, reason: "First mark entered" });
    expect(api.callsTo(`POST ${P}/assessments/${PAPER}/mark-corrections`)[0]!.body).toMatchObject({ row_version: 0 });

    boot(saveRoutes({}, [mark(L1, "12", 3)], "published"));
    const input = { examId: examIdOf(TERM, "Mock 1"), classId: C1, subjectId: S1, learnerId: L1, score: 12, reason: "Reviewed" };
    await expect(correctPublishedMark(input)).rejects.toThrow(/different mark/);
    await expect(correctPublishedMark({ ...input, score: 51, reason: "Valid reason" })).rejects.toThrow("This paper is out of 50.");
    await expect(correctPublishedMark({ ...input, score: 13, reason: "No" })).rejects.toThrow(/5 and 500/);
    boot(saveRoutes({}, [mark(L1, "12", 3)], "draft"));
    await expect(correctPublishedMark({ ...input, score: 13, reason: "Valid reason" })).rejects.toThrow(/still a draft/);
    expect(api.callsTo(`POST ${P}/assessments/${PAPER}/mark-corrections`)).toHaveLength(0);
  });

  it("explains that only Academics writers may correct marks", async () => {
    boot(saveRoutes({ [`POST ${P}/assessments/${PAPER}/mark-corrections`]: refused("forbidden", 403) }, [mark(L1, "10", 2)], "published"));
    await expect(correctPublishedMark({ examId: examIdOf(TERM, "Mock 1"), classId: C1, subjectId: S1, learnerId: L1, score: 11, reason: "Corrected after review" }))
      .rejects.toThrow(/Academics write access/);
  });

  it("publishes the paper, and says in words that only the office may", async () => {
    boot({ [`GET ${P}/assessments`]: list("assessments", [paper()]), [`POST ${P}/assessments/${PAPER}/publish`]: { body: { assessment: paper({ status: "published" }) } } });
    await publishMarks(examIdOf(TERM, "Mock 1"), C1, S1);
    expect(api.callsTo(`POST ${P}/assessments/${PAPER}/publish`)).toHaveLength(1);
    boot({ [`GET ${P}/assessments`]: list("assessments", [paper()]), [`POST ${P}/assessments/${PAPER}/publish`]: refused("forbidden", 403) });
    await expect(publishMarks(examIdOf(TERM, "Mock 1"), C1, S1)).rejects.toThrow(/Only the school office/);
  });

  it("cannot take published results back to draft", async () => {
    boot({});
    await expect(unpublishMarks(examIdOf(TERM, "Mock 1"), C1, S1)).rejects.toSatisfy(isNotOnApiError);
    expect(api.calls).toHaveLength(0);
  });

  it("has no absence records on the API", async () => {
    boot({});
    expect(await fetchMarkAbsences(examIdOf(TERM, "Mock 1"), S1, [L1])).toEqual({});
    expect(api.calls).toHaveLength(0);
  });

  it("finds a teacher's subjects in a class from their own teaching assignments", async () => {
    boot({
      [`GET ${P}/staff`]: list("staff", [staffRow(ST1, USER), staffRow("a0000002-1111-4111-8111-111111111111", "someone-else", "Other")]),
      [`GET ${P}/teaching-assignments`]: list("assignments", [assignment(C1, S1), assignment(C1, S2, "a0000002-1111-4111-8111-111111111111"), assignment(C2, S2)]),
      [`GET ${P}/subjects`]: list("subjects", [subject(S1, "Mathematics"), subject(S2, "English")]),
    });
    const got = await fetchTeacherSubjectsForClass(USER, C1);
    expect(got.map((s) => s.name)).toEqual(["Mathematics"]);
    const asked = api.callsTo(`GET ${P}/teaching-assignments`)[0]!.query;
    expect([asked.get("classId"), asked.get("staffMemberId")]).toEqual([C1, ST1]);
  });

  it("has no subjects to show someone who may not read the staff list, or who has no staff record", async () => {
    boot({ [`GET ${P}/staff`]: refused("forbidden", 403) });
    expect(await fetchTeacherSubjectsForClass(USER, C1)).toEqual([]);
    boot({ [`GET ${P}/staff`]: list("staff", [staffRow(ST1, "someone-else")]) });
    expect(await fetchTeacherSubjectsForClass(USER, C1)).toEqual([]);
  });
});

describe("what a person may do with grades", () => {
  const perms = (...codes: string[]) => ({ "GET /v1/rbac/permissions": list("items", codes) });

  it("opens the Gradebook to someone who reads academics and learners, and lets only an academics writer publish", async () => {
    boot(perms("resource.academics.read", "resource.learner.read"));
    expect(await fetchGradesAccess()).toEqual({ gradebook: true, gradebookReason: null, publish: false });
    boot(perms("resource.academics.read", "resource.academics.write", "resource.learner.read"));
    expect(await fetchGradesAccess()).toMatchObject({ gradebook: true, publish: true });
  });

  it("tells a plain teacher what is missing", async () => {
    boot(perms("identity.self.read", "tenant.read"));
    const access = await fetchGradesAccess();
    expect(access.gradebook).toBe(false);
    expect(access.gradebookReason).toMatch(/Academics and People areas/);
    expect(access.publish).toBe(false);
    boot(perms("resource.academics.read"));
    expect((await fetchGradesAccess()).gradebook).toBe(false);
  });

  it("is everything on Supabase, and asks nothing", async () => {
    boot({});
    initBackend({ kind: "supabase" });
    expect(await fetchGradesAccess()).toEqual({ gradebook: true, gradebookReason: null, publish: true });
    expect(api.calls).toHaveLength(0);
  });
});

describe("marks typed into the Gradebook", () => {
  it("keeps Supabase's whole numbers up to 999, and accepts decimals and bigger totals only when asked", () => {
    expect(parseScoreInput("72")).toEqual({ ok: true, score: 72 });
    expect(parseScoreInput("45.5")).toEqual({ ok: false, message: "Numbers only, or 'abs' if they missed it." });
    expect(parseScoreInput("101")).toEqual({ ok: false, message: "This paper is out of 100." });
    expect(parseScoreInput("45.5", 50, { decimals: true })).toEqual({ ok: true, score: 45.5 });
    expect(parseScoreInput("50.01", 50, { decimals: true })).toEqual({ ok: false, message: "This paper is out of 50." });
    expect(parseScoreInput("1.234", 50, { decimals: true }).ok).toBe(false);
    expect(parseScoreInput("1234", 5000, { decimals: true })).toEqual({ ok: true, score: 1234 });
    expect(parseScoreInput("abs", 50, { decimals: true })).toEqual({ ok: true, score: null });
  });
});
