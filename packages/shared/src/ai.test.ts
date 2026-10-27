import { describe, expect, it } from "vitest";
import { chunk, learnerForAi, questionDraftsFromAi } from "./ai";
import { buildReportCards } from "./reportCards";

const [card] = buildReportCards({
  school: { name: "Kijani", county: null, country: "KE", logoUrl: null, accent: "#1B4D2E" },
  term: { name: "Term 2 2026", year: 2026, startsOn: "2026-05-04", endsOn: "2026-08-07" },
  className: "Form 2 West", classTeacher: null, scheme: "kcse",
  exams: [{ id: "end", name: "End term", outOf: 100 }],
  learners: [{ id: "s1", name: "Amani Otieno Wekesa", admissionNo: "2401" }],
  marks: [{ studentId: "s1", examId: "end", subjectId: "m", subjectName: "Maths", subjectCode: "MAT", score: 72 }],
  attendance: new Map([["s1", { present: 50, days: 60 }]]),
  fees: new Map([["s1", { billedCents: 4_500_000, paidCents: 0 }]]),
  options: { showPosition: true, showAttendance: true, showFees: true, nextTermBegins: null },
  today: "2026-08-08",
});

describe("learnerForAi", () => {
  it("sends a first name and results, never the surname, admission number, fees or position", () => {
    const l = learnerForAi("card-1", card!, "  Good term. ");
    const sent = JSON.stringify(l);
    expect(l.firstName).toBe("Amani");
    expect(sent).not.toMatch(/Otieno|Wekesa|2401|4500000|position|ranked/);
    expect(l.subjects).toEqual([{ name: "Maths", average: 72, grade: "B+" }]);
    expect(l.attendancePct).toBe(83);
    expect(l.existing).toBe("Good term.");
  });
});

describe("questionDraftsFromAi", () => {
  it("keeps valid questions in the builder's shape and drops broken ones", () => {
    const drafts = questionDraftsFromAi([
      { kind: "choice", prompt: "2 + 2?", options: ["3", "4", "5", "6"], correct_option: 1, model_answer: "Add.", points: 1 },
      { kind: "choice", prompt: "Only one option", options: ["x"], correct_option: 0, model_answer: "", points: 1 },
      { kind: "choice", prompt: "Bad key", options: ["a", "b"], correct_option: 7, model_answer: "", points: 1 },
      { kind: "long", prompt: "Explain photosynthesis.", options: ["stray"], correct_option: -1, model_answer: "Light, water, CO2...", points: 8 },
      { kind: "short", prompt: "   ", options: [], correct_option: -1, model_answer: "", points: 2 },
    ]);
    expect(drafts).toHaveLength(3);
    expect(drafts[0]).toMatchObject({ kind: "choice", correctOption: 1, points: 1 });
    expect(drafts[1]).toMatchObject({ kind: "choice", correctOption: null });
    expect(drafts[2]).toMatchObject({ kind: "long", options: [], correctOption: null, points: 8 });
  });
});

describe("chunk", () => {
  it("splits a class into batches", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
