import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { NotOnApiError, examPapersCapabilities } from "../capabilities";
import {
  createExamPaper, createOnlineExamPaper, deleteExamPaper, fetchCurrentTermExams, fetchExamPapers, fetchPaperContent,
  fetchPaperScripts, markExamAttempt, releaseExamResults, saveExamQuestions, savePaperBody, sendExamScoresToGradebook,
  setPaperFile, setPaperPublished, updateExamPaper, type QuestionDraft,
} from "../examPapers";
import { fetchClassSizes } from "../homework";
import { fetchSchoolClassOptions, fetchSchoolSubjectOptions } from "../teacherData";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { apiQuestionsFromDrafts } from "./examPapersApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const YEAR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const C2 = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";
const S1 = "s1s1s1s1-s1s1-4s1s-8s1s-s1s1s1s1s1s1";
const S2 = "s2s2s2s2-s2s2-4s2s-8s2s-s2s2s2s2s2s2";
const L1 = "10000001-1111-4111-8111-111111111111";
const L2 = "10000002-1111-4111-8111-111111111111";
const U1 = "30000001-1111-4111-8111-111111111111";

const stamp = { created_at: "2026-05-01T08:00:00Z", updated_at: "2026-05-01T08:00:00Z" };
const year = (o: Record<string, unknown> = {}) => ({
  id: YEAR, tenantId: T, label: "2026", starts_on: "2026-01-01", ends_on: "2026-12-31", is_current: true, ...stamp, ...o,
});
const clsRow = (o: Record<string, unknown> = {}) => ({
  id: C1, tenantId: T, academic_year_id: YEAR, name: "Form 2 East", form_level: 2, stream: "East",
  education_level: "secondary", class_teacher_staff_id: null, active: true, ...stamp, ...o,
});
const subRow = (o: Record<string, unknown> = {}) => ({
  id: S1, tenantId: T, code: "MATH", name: "Mathematics", active: true, ...stamp, ...o,
});
const learnerRow = (o: Record<string, unknown> = {}) => ({
  id: L1, tenantId: T, admission_no: "ADM001", full_name: "Amina Otieno", gender: "female",
  date_of_birth: "2010-03-01", boarding: false, active: true, archived_at: null, ...stamp, ...o,
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
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: U1 }));
  setApiActiveTenant(T);
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

const choiceDraft: QuestionDraft = {
  kind: "choice",
  prompt: "  Symbol for sodium?  ",
  options: [" Na ", " S "],
  points: 2,
  correctOption: 0,
  modelAnswer: "",
};

describe("apiQuestionsFromDrafts", () => {
  it("maps multiple-choice drafts to strict API mcq questions with correct_answer text", () => {
    expect(apiQuestionsFromDrafts([choiceDraft])).toEqual([
      { id: "q1", prompt: "Symbol for sodium?", kind: "mcq", options: ["Na", "S"], correct_answer: "Na", points: 2 },
    ]);
  });

  it("rejects written questions, long prompts/options, and missing correct option", () => {
    expect(() => apiQuestionsFromDrafts([{ ...choiceDraft, kind: "short" }])).toThrow("only multiple-choice");
    expect(() => apiQuestionsFromDrafts([{ ...choiceDraft, prompt: "x".repeat(1001) }])).toThrow("1000 characters");
    expect(() => apiQuestionsFromDrafts([{ ...choiceDraft, options: ["x".repeat(201), "b"] }])).toThrow("200 characters");
    expect(() => apiQuestionsFromDrafts([{ ...choiceDraft, correctOption: null }])).toThrow("pick the correct option");
  });
});

describe("fetchExamPapers and createOnlineExamPaper on API", () => {
  it("lists papers across pages and resolves class and subject names", async () => {
    boot({
      [`GET ${P}/online-exam-papers`]: (req) => (
        req.query.get("cursor")
          ? list("papers", [
              { id: "p2", tenantId: T, class_id: C2, subject_id: S2, title: "Paper 2", max_score: "50", created_at: "2026-05-02T08:00:00Z", questions: null },
            ])
          : list("papers", [
              { id: "p1", tenantId: T, class_id: C1, subject_id: S1, title: "Paper 1", max_score: "40", created_at: "2026-05-03T08:00:00Z", questions: [{}] },
            ], "next-1")
      ),
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/classes`]: list("classes", [clsRow({ id: C1, name: "Form 2 East" }), clsRow({ id: C2, name: "Form 1 West" })]),
      [`GET ${P}/subjects`]: list("subjects", [subRow({ id: S1, name: "Mathematics" }), subRow({ id: S2, name: "Biology" })]),
    });

    const rows = await fetchExamPapers(T);
    expect(rows.map((r) => ({ id: r.id, title: r.title, className: r.className, subjectName: r.subjectName, maxScore: r.maxScore, questionCount: r.questionCount }))).toEqual([
      { id: "p1", title: "Paper 1", className: "Form 2 East", subjectName: "Mathematics", maxScore: 40, questionCount: 1 },
      { id: "p2", title: "Paper 2", className: "Form 1 West", subjectName: "Biology", maxScore: 50, questionCount: 0 },
    ]);
  });

  it("tolerates 403 on classes/subjects when listing papers", async () => {
    boot({
      [`GET ${P}/online-exam-papers`]: list("papers", [
        { id: "p1", tenantId: T, class_id: C1, subject_id: S1, title: "Paper 1", max_score: "100", created_at: "2026-05-03T08:00:00Z" },
      ]),
      [`GET ${P}/academic-years`]: refused("forbidden", 403),
      [`GET ${P}/classes`]: refused("forbidden", 403),
      [`GET ${P}/subjects`]: refused("forbidden", 403),
    });

    const rows = await fetchExamPapers(T);
    expect(rows[0]!.className).toBe("—");
    expect(rows[0]!.subjectName).toBe("—");
  });

  it("creates an online paper with inline questions or explicit maxScore", async () => {
    const server = boot({
      [`POST ${P}/online-exam-papers`]: {
        status: 201,
        body: { paper: { id: "new-1", tenantId: T, class_id: C1, subject_id: S1, title: "Mid-term", max_score: "2", created_at: "2026-05-03T08:00:00Z" } },
      },
    });

    const id1 = await createOnlineExamPaper(T, { classId: C1, subjectId: S1, title: "  Mid-term  ", maxScore: 100, questions: [choiceDraft] });
    expect(id1).toBe("new-1");
    expect(server.calls[0]!.body).toEqual({
      class_id: C1,
      subject_id: S1,
      title: "Mid-term",
      max_score: 2,
      questions: [{ id: "q1", prompt: "Symbol for sodium?", kind: "mcq", options: ["Na", "S"], correct_answer: "Na", points: 2 }],
    });

    await createOnlineExamPaper(T, { classId: C1, subjectId: S1, title: "Paper B", maxScore: 50, questions: [] });
    expect(server.calls[1]!.body).toEqual({
      class_id: C1,
      subject_id: S1,
      title: "Paper B",
      max_score: 50,
      questions: null,
    });
  });
});

describe("school options and class sizes on API", () => {
  it("lists sorted class/subject options and counts active learners per class", async () => {
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/classes`]: list("classes", [clsRow({ id: C2, name: "Form 1 West" }), clsRow({ id: C1, name: "Form 2 East" })]),
      [`GET ${P}/subjects`]: list("subjects", [subRow({ id: S1, name: "Mathematics" }), subRow({ id: S2, name: "Biology" })]),
      [`GET ${P}/class-memberships`]: list("memberships", [
        { id: "m1", tenantId: T, learner_id: L1, class_id: C1, academic_year_id: YEAR, active: true, ...stamp },
        { id: "m2", tenantId: T, learner_id: L2, class_id: C1, academic_year_id: YEAR, active: true, ...stamp },
      ]),
      [`GET ${P}/learners`]: list("learners", [learnerRow({ id: L1 })]), // L2 archived/inactive
    });

    expect(await fetchSchoolClassOptions(T)).toEqual([
      { id: C2, name: "Form 1 West" },
      { id: C1, name: "Form 2 East" },
    ]);
    expect(await fetchSchoolSubjectOptions(T)).toEqual([
      { id: S2, name: "Biology" },
      { id: S1, name: "Mathematics" },
    ]);
    expect(await fetchClassSizes([C1, C2])).toEqual({ [C1]: 1, [C2]: 0 });
  });
});

describe("examPapersCapabilities and NotOnApiError guards", () => {
  it("hides unsupported paper features on API and guards Supabase-only mutations", async () => {
    expect(examPapersCapabilities().draftWorkflow).toBe(true);
    expect(examPapersCapabilities().promptMaxChars).toBe(4000);

    initBackend({ kind: "api", apiUrl: BASE });
    expect(examPapersCapabilities()).toEqual({
      readMode: false, scheduling: false, fileAttachments: false, examLink: false, draftWorkflow: false,
      editPaper: false, deletePaper: false, writtenQuestions: false, scripts: false, promptMaxChars: 1000,
    });
    expect(await fetchCurrentTermExams(T)).toEqual([]);

    const sampleInput = {
      kind: "exam" as const, title: "Test", instructions: "", classId: C1, subjectId: S1, examId: null,
      mode: "online" as const, body: "", opensAt: "2026-05-01T08:00:00Z", closesAt: null, durationMinutes: 60,
    };
    await expect(fetchPaperContent("p1")).rejects.toThrow(NotOnApiError);
    await expect(createExamPaper(T, sampleInput)).rejects.toThrow(NotOnApiError);
    await expect(updateExamPaper("p1", sampleInput)).rejects.toThrow(NotOnApiError);
    await expect(savePaperBody("p1", "body")).rejects.toThrow(NotOnApiError);
    await expect(setPaperFile("p1", null)).rejects.toThrow(NotOnApiError);
    await expect(saveExamQuestions("p1", [choiceDraft])).rejects.toThrow(NotOnApiError);
    await expect(setPaperPublished("p1", true)).rejects.toThrow(NotOnApiError);
    await expect(deleteExamPaper("p1")).rejects.toThrow(NotOnApiError);
    await expect(fetchPaperScripts({ id: "p1", classId: C1, mode: "online" })).rejects.toThrow(NotOnApiError);
    await expect(markExamAttempt("a1", {}, {}, "")).rejects.toThrow(NotOnApiError);
    await expect(releaseExamResults("p1", true)).rejects.toThrow(NotOnApiError);
    await expect(sendExamScoresToGradebook("p1")).rejects.toThrow(NotOnApiError);
  });
});
