import { describe, expect, it } from "vitest";
import {
  buildReportCards, defaultReportCardOptions, rankByMean, reportCardFileName, suggestComment, type ReportCardInput,
} from "./reportCards";

const base = (over: Partial<ReportCardInput> = {}): ReportCardInput => ({
  school: { name: "Kijani Ridge", county: "Nairobi", country: "KE", logoUrl: null, accent: "#1B4D2E" },
  term: { name: "Term 2 2026", year: 2026, startsOn: "2026-05-04", endsOn: "2026-08-07" },
  className: "Form 2 West",
  classTeacher: "Mary Wanjiku",
  scheme: "kcse",
  exams: [{ id: "cat", name: "CAT 1", outOf: 50 }, { id: "end", name: "End term", outOf: 100 }],
  learners: [
    { id: "a", name: "Amani Otieno", admissionNo: "1001" },
    { id: "b", name: "Baraka Kamau", admissionNo: "1002" },
    { id: "c", name: "Chebet Rono", admissionNo: "1003" },
  ],
  marks: [],
  options: { showPosition: true, showAttendance: true, showFees: false, nextTermBegins: null },
  today: "2026-08-08",
  ...over,
});

const m = (studentId: string, examId: string, subjectId: string, score: number | null) => ({
  studentId, examId, subjectId, subjectName: subjectId === "mat" ? "Mathematics" : "English", subjectCode: subjectId.toUpperCase(), score,
});

describe("buildReportCards", () => {
  it("turns each exam into a percentage and averages the exams sat", () => {
    const [a] = buildReportCards(base({ marks: [m("a", "cat", "mat", 40), m("a", "end", "mat", 70)] }));
    const maths = a!.subjects[0]!;
    expect(maths.scores).toEqual([80, 70]); // 40/50 = 80%
    expect(maths.average).toBe(75);
    expect(maths.grade).toBe("A-");
    expect(maths.points).toBe(11);
  });

  it("averages only the exams a learner sat, and shows the one missed as empty", () => {
    const [a] = buildReportCards(base({ marks: [m("a", "end", "mat", 64), m("a", "cat", "mat", null)] }));
    expect(a!.subjects[0]!.scores).toEqual([null, 64]);
    expect(a!.subjects[0]!.average).toBe(64);
  });

  it("works out class means over the learners who sat the subject", () => {
    const cards = buildReportCards(base({ marks: [m("a", "end", "mat", 80), m("b", "end", "mat", 60), m("b", "end", "eng", 50)] }));
    const maths = (id: string) => cards.find((c) => c.learner.id === id)!.subjects.find((s) => s.name === "Mathematics")!;
    expect(maths("a").classMean).toBe(70);
    expect(cards.find((c) => c.learner.id === "b")!.subjects.find((s) => s.name === "English")!.classMean).toBe(50);
  });

  it("summarises total, mean, grade and points", () => {
    const [a] = buildReportCards(base({ marks: [m("a", "end", "mat", 80), m("a", "end", "eng", 61)] }));
    expect(a!.summary).toMatchObject({ subjectsSat: 2, total: 141, mean: 71, grade: "B+", points: 12 + 8 });
  });

  it("ranks the class, ties sharing a place, and leaves a learner with no marks unranked", () => {
    const cards = buildReportCards(base({ marks: [m("a", "end", "mat", 70), m("b", "end", "mat", 70), m("c", "end", "eng", null)] }));
    const pos = Object.fromEntries(cards.map((c) => [c.learner.id, c.summary.position]));
    expect(pos).toEqual({ a: 1, b: 1, c: null });
    expect(cards[0]!.summary.ranked).toBe(2);
  });

  it("leaves position off when the school says so", () => {
    const cards = buildReportCards(base({ marks: [m("a", "end", "mat", 70)], options: { ...defaultReportCardOptions("cbc") } }));
    expect(cards[0]!.summary.position).toBeNull();
  });

  it("only carries attendance and fees when they're switched on", () => {
    const attendance = new Map([["a", { present: 58, days: 62 }]]);
    const fees = new Map([["a", { billedCents: 4_500_000, paidCents: 3_000_000 }]]);
    const on = buildReportCards(base({ attendance, fees, options: { showPosition: false, showAttendance: true, showFees: true, nextTermBegins: "2026-09-01" } }));
    expect(on[0]!.attendance).toEqual({ present: 58, days: 62 });
    expect(on[0]!.fees).toEqual({ billedCents: 4_500_000, paidCents: 3_000_000 });
    expect(on[0]!.nextTermBegins).toBe("2026-09-01");
    const off = buildReportCards(base({ attendance, fees, options: { showPosition: false, showAttendance: false, showFees: false, nextTermBegins: null } }));
    expect(off[0]!.attendance).toBeNull();
    expect(off[0]!.fees).toBeNull();
  });

  it("ignores marks for exams that weren't chosen", () => {
    const [a] = buildReportCards(base({ marks: [m("a", "mock", "mat", 99), m("a", "end", "mat", 50)] }));
    expect(a!.subjects[0]!.average).toBe(50);
  });

  it("grades CBC classes on the CBC scale", () => {
    const [a] = buildReportCards(base({ scheme: "cbc", marks: [m("a", "end", "mat", 92)] }));
    expect(a!.subjects[0]!.grade).toBe("EE1");
  });
});

describe("rankByMean", () => {
  it("skips the places after a tie (1, 2, 2, 4)", () => {
    const r = rankByMean(new Map([["w", 90], ["x", 80], ["y", 80], ["z", 70]]));
    expect([...r.values()]).toEqual([1, 2, 2, 4]);
  });
});

describe("suggestComment", () => {
  it("picks wording from the mean grade and uses the learner's first name", () => {
    expect(suggestComment("A", "Amani", "teacher")).toContain("Amani");
    expect(suggestComment("D+", "Baraka", "principal")).toContain("Baraka");
    expect(suggestComment("EE2", "Chebet", "teacher")).toMatch(/^Excellent/);
  });

  it("suggests nothing without a grade", () => {
    expect(suggestComment(null, "Amani", "teacher")).toBe("");
  });
});

describe("reportCardFileName", () => {
  it("is safe to save on any computer", () => {
    expect(reportCardFileName({ term: { name: "Term 2/2026", year: 2026, startsOn: "", endsOn: "" }, learner: { id: "a", name: 'Amani "AJ" Otieno', admissionNo: "", className: "" } }))
      .toBe("Term 2 2026 report card - Amani AJ Otieno.pdf");
  });
});
