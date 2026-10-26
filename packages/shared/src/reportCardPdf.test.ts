import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { buildReportCards, type ReportCardInput } from "./reportCards";
import { meritOrder, pdfText, renderReportCardsPdf, renderResultsSheetPdf } from "./reportCardPdf";

const input = (learners: number, subjects = 8): ReportCardInput => ({
  school: { name: "Kijani Ridge School", county: "Nairobi", country: "KE", logoUrl: null, accent: "#1B4D2E" },
  term: { name: "Term 2 2026", year: 2026, startsOn: "2026-05-04", endsOn: "2026-08-07" },
  className: "Form 2 West",
  classTeacher: "Mary Wanjiku",
  scheme: "kcse",
  exams: [{ id: "cat", name: "CAT 1", outOf: 50 }, { id: "end", name: "End of term examination", outOf: 100 }],
  learners: Array.from({ length: learners }, (_, i) => ({ id: `s${i}`, name: `Learner ${i} Ñjeri Wairimũ`, admissionNo: `${1000 + i}` })),
  marks: Array.from({ length: learners }, (_, i) => Array.from({ length: subjects }, (_, j) => [
    { studentId: `s${i}`, examId: "cat", subjectId: `sub${j}`, subjectName: `Subject ${j}`, subjectCode: `S${j}`, score: (i * 7 + j * 3) % 50 },
    { studentId: `s${i}`, examId: "end", subjectId: `sub${j}`, subjectName: `Subject ${j}`, subjectCode: `S${j}`, score: (i * 11 + j * 5) % 100 },
  ]).flat()).flat(),
  attendance: new Map([["s0", { present: 50, days: 60 }]]),
  fees: new Map([["s0", { billedCents: 4_500_000, paidCents: 1_000_000 }]]),
  options: { showPosition: true, showAttendance: true, showFees: true, nextTermBegins: "2026-09-01" },
  today: "2026-08-08",
});

describe("pdfText", () => {
  it("keeps what the standard fonts can draw and simplifies the rest", () => {
    expect(pdfText("Wanjikũ Ñjeri — 90%")).toBe("Wanjiku Ñjeri — 90%");
    expect(pdfText("Grade 🎉 A")).toBe("Grade ? A");
    expect(pdfText(null)).toBe("");
  });
});

describe("renderReportCardsPdf", () => {
  it("draws one page per learner, with names outside Latin-1", async () => {
    const cards = buildReportCards(input(3)).map((data) => ({ data, teacherComment: "Good work this term.", principalComment: null }));
    const bytes = await renderReportCardsPdf(cards);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getTitle()).toContain("Term 2 2026");
  });

  it("carries a long card onto a second page instead of running off the bottom", async () => {
    const [data] = buildReportCards(input(1, 40));
    const long = "This is a long comment. ".repeat(40);
    const doc = await PDFDocument.load(await renderReportCardsPdf([{ data: data!, teacherComment: long, principalComment: long }]));
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it("still makes a file for an empty class", async () => {
    const doc = await PDFDocument.load(await renderReportCardsPdf([]));
    expect(doc.getPageCount()).toBe(1);
  });
});

describe("renderResultsSheetPdf", () => {
  it("fits a class on landscape pages, repeating the header as it goes", async () => {
    const doc = await PDFDocument.load(await renderResultsSheetPdf(buildReportCards(input(60))));
    const [w, h] = [doc.getPage(0).getWidth(), doc.getPage(0).getHeight()];
    expect(w).toBeGreaterThan(h);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });
});

describe("meritOrder", () => {
  it("puts the best mean first and learners without one last", () => {
    const cards = buildReportCards({ ...input(3), marks: [
      { studentId: "s0", examId: "end", subjectId: "m", subjectName: "Maths", subjectCode: "M", score: 40 },
      { studentId: "s2", examId: "end", subjectId: "m", subjectName: "Maths", subjectCode: "M", score: 90 },
    ] });
    expect(meritOrder(cards).map((c) => c.learner.id)).toEqual(["s2", "s0", "s1"]);
  });
});
