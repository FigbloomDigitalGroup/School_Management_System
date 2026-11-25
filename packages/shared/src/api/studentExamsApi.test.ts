import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { NotOnApiError } from "../capabilities";
import { fetchSittingQuestions, saveExamAttempt, startExamAttempt } from "../examPapers";
import { canStartPaper, loadStudentPapers, paperStanding } from "../studentExams";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { forgetOwnLearner, setApiActiveRole } from "./ownLearner";
import { answersToScreen, answersToServer, forgetSittings, optionsOf, paperFromStudentExam, stateFromStudentExam } from "./studentExamsApi";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const L = "a1111111-1111-4111-8111-111111111111";
const CLS = "c1111111-1111-4111-8111-111111111111";
const SUBJ = "e1111111-1111-4111-8111-111111111111";
const PAPER = "b1111111-1111-4111-8111-111111111111";
const PAPER2 = "b2222222-2222-4222-8222-222222222222";
const ATT = "f1111111-1111-4111-8111-111111111111";
const P = `/v1/tenants/${T}`;

const questions = [
  { id: "q1", prompt: "2 + 2 = ?", kind: "mcq", options: ["3", "4", "5"], points: 2 },
  { id: "q2", prompt: "The sun is a star.", kind: "true_false", options: null, points: 1 },
];
const exam = (over: Record<string, unknown> = {}) => ({
  id: PAPER, title: "Algebra quiz", max_score: "3", class: { id: CLS, name: "Form 1 East" }, subject: { id: SUBJ, name: "Mathematics" },
  published_at: "2026-11-20T08:00:00.000Z", question_count: 2, attempts: [], ...over,
});
const attempt = (over: Record<string, unknown> = {}) => ({
  id: ATT, status: "in_progress", started_at: "2026-11-25T09:00:00.000Z", submitted_at: null, answers: {},
  paper: { id: PAPER, title: "Algebra quiz", max_score: "3", subject: { id: SUBJ, name: "Mathematics" }, questions }, ...over,
});

let api: FakeApi;
function boot(routes: Record<string, FakeRoute>, role: string | null = "student") {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: "u-student" }));
  setApiActiveTenant(T);
  setApiActiveRole(role);
  return api;
}
const ok = (body: unknown): FakeReply => ({ body });
const refused = (status: number, code: string, message = "no"): FakeReply => ({ status, body: { error: { code, message } } });
const LEARNER = `GET ${P}/me/learner`;
const learnerRoute = ok({ learner: { learner_id: L, full_name: "Amina Ochieng", admission_no: "ADM-1001", boarding: false, login_id: "ST-0001", class: { id: CLS, name: "Form 1 East", form_level: 1, stream: "East", academic_year_id: "y" } } });
const EXAMS = `GET ${P}/me/learner/online-exams`;
const START = `POST ${P}/online-exam-papers/${PAPER}/attempts`;
const ATTEMPT = `GET ${P}/me/learner/online-exam-attempts/${ATT}`;
const ANSWERS = `PUT ${P}/me/learner/online-exam-attempts/${ATT}/answers`;
const SUBMIT = `POST ${P}/online-exam-attempts/${ATT}/submit`;

afterEach(() => {
  vi.unstubAllGlobals();
  setApiActiveRole(null);
  forgetOwnLearner();
  forgetSittings();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

describe("a published paper as the Exams screen reads it", () => {
  it("is an online paper open from the day it was published, with no clock, no resit and no mark", () => {
    const row = paperFromStudentExam(exam() as never);
    expect(row).toMatchObject({ id: PAPER, mode: "online", title: "Algebra quiz", subjectName: "Mathematics", className: "Form 1 East", opensAt: "2026-11-20T08:00:00.000Z", closesAt: null, durationMinutes: null, questionCount: 2, maxScore: 3 });
    expect(stateFromStudentExam(exam() as never)).toMatchObject({ status: "not_started", attemptsUsed: 0, deadline: null, terms: { attemptsAllowed: 1, closesAt: null, extraMinutes: 0 } });
    const mid = stateFromStudentExam(exam({ attempts: [{ id: ATT, status: "in_progress", started_at: "2026-11-25T09:00:00Z", submitted_at: null }] }) as never);
    expect(mid).toMatchObject({ status: "in_progress", attemptsUsed: 1, startedAt: "2026-11-25T09:00:00Z", submittedAt: null });
    const done = stateFromStudentExam(exam({ attempts: [{ id: ATT, status: "submitted", started_at: "2026-11-25T09:00:00Z", submitted_at: "2026-11-25T09:20:00Z" }] }) as never);
    expect(done).toMatchObject({ status: "submitted", submittedAt: "2026-11-25T09:20:00Z" });
  });

  it("offers Start for a paper not started, Carry on for one under way, and Handed in once it is in (never a second start)", async () => {
    boot({
      [EXAMS]: ok({ papers: [
        exam(),
        exam({ id: PAPER2, title: "Reading", attempts: [{ id: "x", status: "submitted", started_at: "2026-11-24T09:00:00Z", submitted_at: "2026-11-24T09:20:00Z" }] }),
        exam({ id: "b3333333-3333-4333-8333-333333333333", title: "No questions yet", question_count: 0 }),
      ] }),
    });
    const papers = await loadStudentPapers(CLS, L);
    expect(papers.map((p) => p.paper.title)).toEqual(["Algebra quiz", "Reading"]);
    const now = Date.parse("2026-11-25T10:00:00Z");
    expect(canStartPaper(papers[0]!, now)).toBe(true);
    expect(paperStanding(papers[0]!, now)).toMatchObject({ label: "Open now", done: false });
    expect(canStartPaper(papers[1]!, now)).toBe(false);
    expect(paperStanding(papers[1]!, now)).toMatchObject({ label: "Handed in", done: true });
    expect(papers.every((p) => p.result === undefined && p.total === undefined)).toBe(true);
  });

  it("is refused for a parent (a child's papers are not in the API), without asking", async () => {
    boot({}, "parent");
    await expect(loadStudentPapers(CLS, L)).rejects.toBeInstanceOf(NotOnApiError);
    expect(api.calls).toHaveLength(0);
  });
});

describe("answers: the screen keeps option numbers, the server takes option text", () => {
  const qs = questions as never;
  it("offers True and False for a true or false question that has no options", () => {
    expect(optionsOf(questions[1] as never)).toEqual(["True", "False"]);
    expect(optionsOf(questions[0] as never)).toEqual(["3", "4", "5"]);
  });
  it("turns numbers into text on the way out, for this paper's questions only", () => {
    expect(answersToServer(qs, { q1: 1, q2: 0, other: 0, q9: "x" })).toEqual({ q1: "4", q2: "True" });
    expect(answersToServer(qs, { q1: 7 })).toEqual({});
    expect(answersToServer(qs, {})).toEqual({});
  });
  it("turns text back into numbers on the way in, ignoring case and spaces, and keeps text that matches no option", () => {
    expect(answersToScreen(qs, { q1: " 4 ", q2: "false" })).toEqual({ q1: 1, q2: 1 });
    expect(answersToScreen(qs, { q1: "banana" })).toEqual({ q1: "banana" });
  });
});

describe("sitting a paper", () => {
  it("starts the learner's own attempt with their own id, then reads the questions from it (without a key)", async () => {
    boot({ [EXAMS]: ok({ papers: [exam()] }), [LEARNER]: learnerRoute, [START]: { status: 201, body: { attempt: attempt() } } });
    const session = await startExamAttempt(PAPER);
    expect(api.callsTo(START)[0]!.body).toEqual({ learner_id: L });
    expect(session).toMatchObject({ id: ATT, paperId: PAPER, submittedAt: null, deadline: null, answers: {}, timedOut: false });
    const qs = await fetchSittingQuestions(PAPER);
    expect(qs).toEqual([
      { id: "q1", kind: "choice", prompt: "2 + 2 = ?", options: ["3", "4", "5"], points: 2 },
      { id: "q2", kind: "choice", prompt: "The sun is a star.", options: ["True", "False"], points: 1 },
    ]);
    // Nothing of the paper's answer key can be in what the screen gets.
    expect(JSON.stringify(qs)).not.toMatch(/correct/);
  });

  it("carries on an attempt already started, with its saved answers, and never starts a second", async () => {
    boot({
      [EXAMS]: ok({ papers: [exam({ attempts: [{ id: ATT, status: "in_progress", started_at: "2026-11-25T09:00:00Z", submitted_at: null }] })] }),
      [ATTEMPT]: ok({ attempt: attempt({ answers: { q1: "4" } }) }),
    });
    const session = await startExamAttempt(PAPER);
    expect(session.answers).toEqual({ q1: 1 });
    expect(api.callsTo(START)).toHaveLength(0);
  });

  it("is one start when the page asks twice at once (a page that renders twice)", async () => {
    boot({ [EXAMS]: ok({ papers: [exam()] }), [LEARNER]: learnerRoute, [START]: { status: 201, body: { attempt: attempt() } } });
    const [a, b] = await Promise.all([startExamAttempt(PAPER), startExamAttempt(PAPER)]);
    expect(a.id).toBe(b.id);
    expect(api.callsTo(START)).toHaveLength(1);
  });

  it("picks up the attempt another start made, when the server says the paper is already started (409)", async () => {
    let listed = 0;
    boot({
      [EXAMS]: () => ok({ papers: [exam(listed++ === 0 ? {} : { attempts: [{ id: ATT, status: "in_progress", started_at: "2026-11-25T09:00:00Z", submitted_at: null }] })] }),
      [LEARNER]: learnerRoute,
      [START]: refused(409, "conflict", "This paper is already started: open the attempt to carry on"),
      [ATTEMPT]: ok({ attempt: attempt() }),
    });
    expect((await startExamAttempt(PAPER)).id).toBe(ATT);
    expect(api.callsTo(START)).toHaveLength(1);
  });

  it("passes on what the server refuses: a paper that is not the learner's, and one with no questions", async () => {
    boot({ [EXAMS]: ok({ papers: [] }) });
    await expect(startExamAttempt(PAPER)).rejects.toThrow("not open to you");
    boot({ [EXAMS]: ok({ papers: [exam()] }), [LEARNER]: learnerRoute, [START]: refused(409, "conflict", "This paper has no questions to answer online") });
    await expect(startExamAttempt(PAPER)).rejects.toMatchObject({ code: "conflict", message: "This paper has no questions to answer online" });
  });

  it("saves the answers as option text (replacing the saved set) and hands in with the answers and no score", async () => {
    boot({
      [EXAMS]: ok({ papers: [exam()] }), [LEARNER]: learnerRoute, [START]: { status: 201, body: { attempt: attempt() } },
      [ANSWERS]: (call) => ok({ attempt: attempt({ answers: (call.body as { answers: Record<string, string> }).answers }) }),
      [SUBMIT]: ok({ id: ATT, status: "submitted", submitted_at: "2026-11-25T09:30:00.000Z" }),
    });
    await startExamAttempt(PAPER);
    const saved = await saveExamAttempt(PAPER, { q1: 1, q2: 1 }, false);
    expect(api.callsTo(ANSWERS)[0]!.body).toEqual({ answers: { q1: "4", q2: "False" } });
    expect(saved.answers).toEqual({ q1: 1, q2: 1 });
    expect(saved.submittedAt).toBeNull();

    const done = await saveExamAttempt(PAPER, { q1: 1 }, true);
    expect(api.callsTo(SUBMIT)[0]!.body).toEqual({ answers: { q1: "4" } });
    expect(done).toMatchObject({ id: ATT, submittedAt: "2026-11-25T09:30:00.000Z", answers: { q1: 1 } });
    expect(done).not.toHaveProperty("score");
  });

  it("does not carry a sitting over to the next person to sign in on the page", async () => {
    boot({ [EXAMS]: ok({ papers: [exam()] }), [LEARNER]: learnerRoute, [START]: { status: 201, body: { attempt: attempt() } } });
    await startExamAttempt(PAPER);
    // Someone else signs in: their save starts their own sitting first instead of using the earlier learner's attempt.
    resetApiClient();
    setApiTokenStore(createMemoryTokenStore({ token: "tok2", expiresAt: "2099-01-01T00:00:00Z", userId: "u-other" }));
    setApiActiveTenant(T);
    forgetOwnLearner();
    api.on(ANSWERS, ok({ attempt: attempt() }));
    await saveExamAttempt(PAPER, { q1: 0 }, false);
    expect(api.callsTo(START)).toHaveLength(2);
  });
});
