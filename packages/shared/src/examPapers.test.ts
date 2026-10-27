import { describe, expect, it } from "vitest";
import {
  attemptDeadline, autoMark, blankQuestion, formatTimeLeft, paperWindow, publishProblem, scaleToExam, scoreLabel,
  timeLeftMs, validatePaper, validateQuestions, type PaperInput, type QuestionDraft,
} from "./examPapers";

const paper = (over: Partial<PaperInput> = {}): PaperInput => ({
  kind: "exam", title: "Mid-term Maths Paper 1", instructions: "", classId: "c1", subjectId: "s1", examId: null,
  mode: "online", body: "", opensAt: "2026-11-03T05:00:00.000Z", closesAt: null, durationMinutes: 60, ...over,
});

describe("validatePaper", () => {
  it("accepts an online paper and trims the title", () => {
    const r = validatePaper(paper({ title: "  Mid-term   Maths " }), { hasFile: false });
    expect(r).toEqual({ ok: true, value: paper({ title: "Mid-term Maths" }) });
  });
  it("needs a class, a subject and a title", () => {
    expect(validatePaper(paper({ classId: "" }), { hasFile: false })).toEqual({ ok: false, message: "Pick the class." });
    expect(validatePaper(paper({ subjectId: "" }), { hasFile: false })).toEqual({ ok: false, message: "Pick the subject." });
    expect(validatePaper(paper({ title: "  " }), { hasFile: false }).ok).toBe(false);
  });
  it("needs a file or typed text for a read-only paper", () => {
    expect(validatePaper(paper({ mode: "read", durationMinutes: null }), { hasFile: false })).toEqual({ ok: false, message: "Upload the paper as a PDF or type it in." });
    expect(validatePaper(paper({ mode: "read", durationMinutes: null }), { hasFile: true }).ok).toBe(true);
    expect(validatePaper(paper({ mode: "read", durationMinutes: null, body: "1. Define a prime." }), { hasFile: false }).ok).toBe(true);
  });
  it("drops the time limit on a read-only paper", () => {
    const r = validatePaper(paper({ mode: "read", body: "x", durationMinutes: 45 }), { hasFile: false });
    expect(r.ok && r.value.durationMinutes).toBe(null);
  });
  it("needs it to close after it opens", () => {
    expect(validatePaper(paper({ closesAt: "2026-11-03T05:00:00.000Z" }), { hasFile: false })).toEqual({ ok: false, message: "The paper has to close after it opens." });
  });
  it("refuses a time limit that isn't a sensible whole number of minutes", () => {
    expect(validatePaper(paper({ durationMinutes: 0 }), { hasFile: false }).ok).toBe(false);
    expect(validatePaper(paper({ durationMinutes: 1.5 }), { hasFile: false }).ok).toBe(false);
    expect(validatePaper(paper({ durationMinutes: null }), { hasFile: false }).ok).toBe(true);
  });
});

const choice = (over: Partial<QuestionDraft> = {}): QuestionDraft => ({
  ...blankQuestion("choice"), prompt: "2 + 2 =", options: ["3", "4"], correctOption: 1, ...over,
});

describe("validateQuestions", () => {
  it("accepts choice and written questions", () => {
    const r = validateQuestions([choice(), { ...blankQuestion("long"), prompt: "Explain photosynthesis.", points: 10, modelAnswer: "  light → sugar " }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value[1]!.modelAnswer).toBe("light → sugar");
  });
  it("names the question that's wrong", () => {
    expect(validateQuestions([choice(), choice({ prompt: " " })])).toEqual({ ok: false, message: "Question 2 has no question written." });
  });
  it("needs a correct option, distinct non-empty options, and sensible marks", () => {
    expect(validateQuestions([choice({ correctOption: null })])).toEqual({ ok: false, message: "Question 1: pick the correct option." });
    expect(validateQuestions([choice({ correctOption: 2 })]).ok).toBe(false);
    expect(validateQuestions([choice({ options: ["4", " 4 "] })])).toEqual({ ok: false, message: "Question 1 has the same option twice." });
    expect(validateQuestions([choice({ options: ["4", ""] })]).ok).toBe(false);
    expect(validateQuestions([choice({ options: ["4"] })]).ok).toBe(false);
    expect(validateQuestions([choice({ points: 0 })]).ok).toBe(false);
  });
});

describe("publishProblem", () => {
  it("needs questions online and content to read", () => {
    expect(publishProblem({ mode: "online", hasContent: false, questionCount: 0 })).toMatch(/question/);
    expect(publishProblem({ mode: "read", hasContent: false, questionCount: 0 })).toMatch(/Upload/);
    expect(publishProblem({ mode: "online", hasContent: false, questionCount: 3 })).toBe(null);
  });
});

describe("autoMark", () => {
  const qs = [
    { id: "a", kind: "choice" as const, points: 2, correctOption: 1 },
    { id: "b", kind: "choice" as const, points: 2, correctOption: 0 },
    { id: "c", kind: "short" as const, points: 5, correctOption: null },
  ];
  it("marks choice questions and waits for the teacher on written ones", () => {
    expect(autoMark(qs, { a: 1, b: 1, c: "chlorophyll" })).toEqual({ marks: { a: 2, b: 0 }, auto: 2, final: null });
  });
  it("gives a blank written answer 0, so a script can be complete without the teacher", () => {
    expect(autoMark(qs, { a: 1, b: 0 })).toEqual({ marks: { a: 2, b: 2, c: 0 }, auto: 4, final: 4 });
  });
  it("keeps the teacher's marks and totals them", () => {
    expect(autoMark(qs, { a: 1, c: "x" }, { c: 4 }).final).toBe(6);
  });
});

describe("scores", () => {
  it("labels a score", () => {
    expect(scoreLabel(14, 20)).toBe("14 / 20 · 70%");
    expect(scoreLabel(null, 20)).toBe("Not marked yet");
  });
  it("scales to the exam total", () => {
    expect(scaleToExam(14, 20, 100)).toBe(70);
    expect(scaleToExam(1, 3, 100)).toBe(33);
    expect(scaleToExam(5, 0, 100)).toBe(0);
  });
});

describe("the clock", () => {
  const start = "2026-11-03T05:00:00.000Z";
  it("is the time limit or the closing time, whichever is first", () => {
    expect(attemptDeadline(start, 60, null)?.toISOString()).toBe("2026-11-03T06:00:00.000Z");
    expect(attemptDeadline(start, 60, "2026-11-03T05:30:00.000Z")?.toISOString()).toBe("2026-11-03T05:30:00.000Z");
    expect(attemptDeadline(start, null, "2026-11-03T07:00:00.000Z")?.toISOString()).toBe("2026-11-03T07:00:00.000Z");
    expect(attemptDeadline(start, null, null)).toBe(null);
  });
  it("counts down using the server's clock", () => {
    const deadline = "2026-11-03T06:00:00.000Z";
    const now = Date.parse("2026-11-03T05:50:00.000Z");
    expect(timeLeftMs(deadline, now)).toBe(600_000);
    expect(timeLeftMs(deadline, now, 60_000)).toBe(540_000);
    expect(timeLeftMs(deadline, now + 3_600_000)).toBe(0);
  });
  it("formats time left", () => {
    expect(formatTimeLeft(9_000)).toBe("0:09");
    expect(formatTimeLeft(724_000)).toBe("12:04");
    expect(formatTimeLeft(3_909_000)).toBe("1:05:09");
    expect(formatTimeLeft(-5)).toBe("0:00");
  });
  it("knows whether a paper is upcoming, open or closed", () => {
    const p = { opensAt: start, closesAt: "2026-11-03T07:00:00.000Z" };
    expect(paperWindow(p, Date.parse(start) - 1)).toBe("upcoming");
    expect(paperWindow(p, Date.parse(start))).toBe("open");
    expect(paperWindow(p, Date.parse("2026-11-03T07:00:00.000Z"))).toBe("closed");
    expect(paperWindow({ opensAt: start, closesAt: null }, Date.parse("2030-01-01"))).toBe("open");
  });
});
