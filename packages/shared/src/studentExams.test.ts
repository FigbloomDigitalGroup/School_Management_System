import { describe, expect, it } from "vitest";
import type { LearnerExamState } from "./examExtensions";
import type { AttemptRow, ExamPaperRow } from "./examPapers";
import { canStartPaper, paperResitWaiting, paperStanding, studentWindow, type StudentPaper } from "./studentExams";

const OPEN = "2026-11-03T05:00:00.000Z";
const CLOSE = "2026-11-03T07:00:00.000Z";
const at = (iso: string) => Date.parse(iso);
const BEFORE = at("2026-11-03T04:00:00.000Z");
const DURING = at("2026-11-03T05:30:00.000Z");
const AFTER = at("2026-11-03T08:00:00.000Z");

const paper = (over: Partial<ExamPaperRow> = {}): ExamPaperRow => ({
  id: "p1", kind: "exam", title: "Mock 1", instructions: "", classId: "c1", className: "Form 2 West", subjectId: "s1", subjectName: "Chemistry",
  examId: null, examName: null, mode: "online", filePath: null, fileName: null, opensAt: OPEN, closesAt: CLOSE, durationMinutes: 60,
  publishedAt: OPEN, resultsReleasedAt: null, questionCount: 3, attemptCount: 0, ...over,
});

const state = (over: Partial<LearnerExamState> = {}, terms: Partial<LearnerExamState["terms"]> = {}): LearnerExamState => ({
  paperId: "p1",
  terms: { opensAt: OPEN, closesAt: CLOSE, extraMinutes: 0, attemptsAllowed: 1, counting: "latest", ...terms },
  attemptsUsed: 0, startedAt: null, submittedAt: null, deadline: null, status: "not_started", ...over,
});

const marked = (): AttemptRow => ({
  id: "a1", studentId: "st1", attemptNo: 1, startedAt: OPEN, submittedAt: "2026-11-03T05:40:00.000Z",
  answers: {}, questionMarks: {}, questionNotes: {}, autoScore: 5, finalScore: 7, feedback: null,
});

/** `s` is null for "this learner has no state on the paper" (a read-only paper); undefined would pick the default. */
const view = (p: Partial<ExamPaperRow> = {}, s: LearnerExamState | null = state(), r?: AttemptRow): StudentPaper => ({
  paper: paper(p), state: s ?? undefined, result: r, total: r ? 10 : undefined,
});

/** Handed in once, a resit granted: a second sitting allowed, with the learner's own window. */
const resit = (terms: Partial<LearnerExamState["terms"]> = {}) =>
  state({ attemptsUsed: 1, submittedAt: "2026-11-03T05:40:00.000Z", status: "submitted" }, { attemptsAllowed: 2, ...terms });

describe("studentWindow", () => {
  it("is the paper's window when the learner has no terms of their own", () => {
    expect(studentWindow(view({}, null))).toEqual({ opensAt: OPEN, closesAt: CLOSE });
  });
  it("is the learner's own window where their teacher gave them one", () => {
    expect(studentWindow(view({}, state({}, { opensAt: "2026-11-04T05:00:00.000Z", closesAt: "2026-11-04T07:00:00.000Z" }))))
      .toEqual({ opensAt: "2026-11-04T05:00:00.000Z", closesAt: "2026-11-04T07:00:00.000Z" });
  });
});

describe("canStartPaper", () => {
  it("lets a learner start an open online paper", () => {
    expect(canStartPaper(view(), DURING)).toBe(true);
  });
  it("not before it opens, nor after it closes", () => {
    expect(canStartPaper(view(), BEFORE)).toBe(false);
    expect(canStartPaper(view(), AFTER)).toBe(false);
  });
  it("never for a paper that is only read (it has no learner state)", () => {
    expect(canStartPaper(view({ mode: "read" }, null), DURING)).toBe(false);
  });
  it("not when excused", () => {
    expect(canStartPaper(view({}, state({ status: "excused" })), DURING)).toBe(false);
  });
  it("not when the sittings allowed are used up", () => {
    expect(canStartPaper(view({}, state({ attemptsUsed: 1, submittedAt: "2026-11-03T05:40:00.000Z", status: "submitted" })), DURING)).toBe(false);
  });
  it("not while a sitting is under way: that is 'carry on', not a new start", () => {
    expect(canStartPaper(view({}, state({ attemptsUsed: 1, status: "in_progress" }, { attemptsAllowed: 2 })), DURING)).toBe(false);
  });
  it("yes for a granted resit once the first is handed in", () => {
    expect(canStartPaper(view({}, resit()), DURING)).toBe(true);
  });
});

describe("paperResitWaiting", () => {
  it("is a resit granted after a handed-in sitting", () => {
    expect(paperResitWaiting(view({}, resit()))).toBe(true);
  });
  it("not when only one sitting is allowed, none has been made, or one is still under way", () => {
    expect(paperResitWaiting(view({}, state({ attemptsUsed: 1, submittedAt: "2026-11-03T05:40:00.000Z" })))).toBe(false);
    expect(paperResitWaiting(view({}, state({}, { attemptsAllowed: 2 })))).toBe(false);
    expect(paperResitWaiting(view({}, state({ attemptsUsed: 1, submittedAt: null }, { attemptsAllowed: 2 })))).toBe(false);
    expect(paperResitWaiting(view({}, null))).toBe(false);
  });
});

describe("paperStanding: a paper that is only read", () => {
  const read = (r?: AttemptRow) => view({ mode: "read" }, null, r);
  it("is coming up, open, then closed", () => {
    expect(paperStanding(read(), BEFORE)).toEqual({ label: "Coming up", tone: "info", done: false });
    expect(paperStanding(read(), DURING)).toEqual({ label: "Open", tone: "warn", done: false });
    expect(paperStanding(read(), AFTER)).toEqual({ label: "Closed", tone: "muted", done: true });
  });
  it("is results out once there is a result", () => {
    expect(paperStanding(read(marked()), DURING)).toEqual({ label: "Results out", tone: "ok", done: true });
  });
});

describe("paperStanding: a paper sat online", () => {
  it("is coming up before it opens and open now after", () => {
    expect(paperStanding(view(), BEFORE)).toEqual({ label: "Coming up", tone: "info", done: false });
    expect(paperStanding(view(), DURING)).toEqual({ label: "Open now", tone: "warn", done: false });
  });
  it("is in progress while a sitting is under way, wherever the clock is", () => {
    const v = view({}, state({ status: "in_progress", attemptsUsed: 1 }));
    expect(paperStanding(v, DURING)).toEqual({ label: "In progress", tone: "warn", done: false });
    expect(paperStanding(v, AFTER)).toEqual({ label: "In progress", tone: "warn", done: false });
  });
  it("is handed in once submitted, until the results are out", () => {
    const sub = state({ status: "submitted", attemptsUsed: 1, submittedAt: "2026-11-03T05:40:00.000Z" });
    expect(paperStanding(view({}, sub), DURING)).toEqual({ label: "Handed in", tone: "muted", done: true });
    expect(paperStanding(view({}, { ...sub, status: "marked" }), DURING)).toEqual({ label: "Handed in", tone: "muted", done: true });
    expect(paperStanding(view({}, { ...sub, status: "marked" }, marked()), DURING)).toEqual({ label: "Results out", tone: "ok", done: true });
  });
  it("is excused, never a score, never missed", () => {
    expect(paperStanding(view({}, state({ status: "excused" })), AFTER)).toEqual({ label: "Excused", tone: "muted", done: true });
  });
  it("is missed when the server says so, or when the window closed with nothing handed in", () => {
    expect(paperStanding(view({}, state({ status: "missed" })), DURING)).toEqual({ label: "Missed", tone: "muted", done: true });
    expect(paperStanding(view({}, state()), AFTER)).toEqual({ label: "Missed", tone: "muted", done: true });
    expect(paperStanding(view({}, null), AFTER)).toEqual({ label: "Missed", tone: "muted", done: true });
  });
  it("a granted resit is open now, or coming up if its own window has not opened", () => {
    expect(paperStanding(view({}, resit()), DURING)).toEqual({ label: "Resit open", tone: "warn", done: false });
    const later = resit({ opensAt: "2026-11-04T05:00:00.000Z", closesAt: "2026-11-04T07:00:00.000Z" });
    expect(paperStanding(view({}, later), DURING)).toEqual({ label: "Resit coming up", tone: "info", done: false });
  });
  it("a waiting resit outranks the result of the first sitting, but not once its window has closed", () => {
    expect(paperStanding(view({}, resit(), marked()), DURING)).toEqual({ label: "Resit open", tone: "warn", done: false });
    expect(paperStanding(view({}, resit(), marked()), AFTER)).toEqual({ label: "Results out", tone: "ok", done: true });
  });
});
