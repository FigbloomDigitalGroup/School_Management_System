import { describe, expect, it } from "vitest";
import { buildReportCards, defaultReportCardOptions, type ReportCardInput } from "./reportCards";
import { renderReportCardsPdf } from "./reportCardPdf";
import { CBC, KCSE, expected } from "./gradeTables.fixture";
import { pdfPageTexts } from "./pdfText.fixture";

/**
 * QA 09 follow-up (FIG-1242): report cards, worked out BY HAND and typed here, not read from the code under test.
 *
 * One class of seven learners, two exams (CAT 1 out of 50, End of Term out of 100) and two subjects. Every figure below was
 * worked out on paper first:
 *
 *   Amani   Maths  CAT 45/50 = 90, End 70           average 80          A   12
 *           English CAT 30/50 = 60, End 59          average 59.5 -> 60  B-   8   (59.5 on its own would be a C+)
 *           total 140, mean 70, B+, 20 points
 *   Baraka  Maths  CAT 40/50 = 80, End ABSENT       average 80 (only the paper sat)   A   12
 *           English CAT 20/50 = 40, End 40          average 40          D+   4
 *           total 120, mean 60, B-, 16 points
 *   Chebet  Maths  0 and 0 (two real zeros)         average 0           E    1     no English marks: no English row
 *           total 0, mean 0, E, 1 point             a zero is a mark: still ranked, last
 *   Dalmas  no marks at all                         no subjects, no mean, no position
 *   Eve     Maths  CAT 35/50 = 70, End 70           average 70          B+  10
 *           English CAT 35/50 = 70, End 70          average 70          B+  10
 *           total 140, mean 70, B+, 20 points       ties with Amani
 *   Fatuma  Maths  End 81 (no CAT mark)             average 81          A   12
 *           English End 78                          average 78          A-  11
 *           total 159, mean 79.5 -> 80, A, 23 points   (the card grades the ROUNDED mean, as the gradebook does)
 *   Gathoni Maths  End 75, the only subject she took  average 75          A-  11
 *           total 75, mean 75, A-, 11 points        her TOTAL is below Baraka's 120 but her MEAN is above his 60
 *
 *   Class mean, Maths:   (80 + 80 + 0 + 70 + 81 + 75) / 6 = 386 / 6 = 64.33 -> 64    over the six who sat it, not seven
 *   Class mean, English: (60 + 40 + 70 + 78) / 4 = 62                                over the four who sat it
 *   Position by mean:    Fatuma 80 = 1st; Gathoni 75 = 2nd; Amani 70 and Eve 70 share 3rd; Baraka 60 = 5th (4th is skipped);
 *                        Chebet 0 = 6th. Dalmas has no mean and is not ranked, so the class is "6", not "7".
 *                        (Ranking on the total instead would put Baraka above Gathoni.)
 */

const m = (studentId: string, examId: string, subject: "Maths" | "English", score: number | null) =>
  ({ studentId, examId, subjectId: subject.toLowerCase(), subjectName: subject, subjectCode: subject === "Maths" ? "MAT" : "ENG", score });

const input = (overrides: Partial<ReportCardInput> = {}): ReportCardInput => ({
  school: { name: "Test School", county: "Nairobi", country: "KE", logoUrl: null, accent: "#1B4D2E" },
  term: { name: "Term 2 2026", year: 2026, startsOn: "2026-05-04", endsOn: "2026-08-07" },
  className: "Form 2 West",
  classTeacher: "Mary Wanjiku",
  scheme: "kcse",
  exams: [{ id: "cat", name: "CAT 1", outOf: 50 }, { id: "end", name: "End of Term", outOf: 100 }],
  learners: [
    { id: "a", name: "Amani Otieno", admissionNo: "4001" }, { id: "b", name: "Baraka Mwangi", admissionNo: "4002" },
    { id: "c", name: "Chebet Korir", admissionNo: "4003" }, { id: "d", name: "Dalmas Njoroge", admissionNo: "4004" },
    { id: "e", name: "Eve Atieno", admissionNo: "4005" }, { id: "f", name: "Fatuma Ali", admissionNo: "4006" },
    { id: "g", name: "Gathoni Wambui", admissionNo: "4007" },
  ],
  marks: [
    m("a", "cat", "Maths", 45), m("a", "end", "Maths", 70), m("a", "cat", "English", 30), m("a", "end", "English", 59),
    m("b", "cat", "Maths", 40), m("b", "end", "Maths", null), m("b", "cat", "English", 20), m("b", "end", "English", 40),
    m("c", "cat", "Maths", 0), m("c", "end", "Maths", 0),
    m("e", "cat", "Maths", 35), m("e", "end", "Maths", 70), m("e", "cat", "English", 35), m("e", "end", "English", 70),
    m("f", "end", "Maths", 81), m("f", "end", "English", 78),
    m("g", "end", "Maths", 75),
  ],
  options: { showPosition: true, showAttendance: false, showFees: false, nextTermBegins: null },
  today: "2026-08-08",
  ...overrides,
});

type Row = [subject: string, scores: (number | null)[], average: number, grade: string, points: number, classMean: number];
const MATHS_MEAN = 64, ENGLISH_MEAN = 62;
const hand: Record<string, { rows: Row[]; sat: number; total: number | null; mean: number | null; grade: string | null; points: number | null; position: number | null }> = {
  a: { rows: [["English", [60, 59], 60, "B-", 8, ENGLISH_MEAN], ["Maths", [90, 70], 80, "A", 12, MATHS_MEAN]], sat: 2, total: 140, mean: 70, grade: "B+", points: 20, position: 3 },
  b: { rows: [["English", [40, 40], 40, "D+", 4, ENGLISH_MEAN], ["Maths", [80, null], 80, "A", 12, MATHS_MEAN]], sat: 2, total: 120, mean: 60, grade: "B-", points: 16, position: 5 },
  c: { rows: [["Maths", [0, 0], 0, "E", 1, MATHS_MEAN]], sat: 1, total: 0, mean: 0, grade: "E", points: 1, position: 6 },
  d: { rows: [], sat: 0, total: null, mean: null, grade: null, points: null, position: null },
  e: { rows: [["English", [70, 70], 70, "B+", 10, ENGLISH_MEAN], ["Maths", [70, 70], 70, "B+", 10, MATHS_MEAN]], sat: 2, total: 140, mean: 70, grade: "B+", points: 20, position: 3 },
  f: { rows: [["English", [null, 78], 78, "A-", 11, ENGLISH_MEAN], ["Maths", [null, 81], 81, "A", 12, MATHS_MEAN]], sat: 2, total: 159, mean: 80, grade: "A", points: 23, position: 1 },
  g: { rows: [["Maths", [null, 75], 75, "A-", 11, MATHS_MEAN]], sat: 1, total: 75, mean: 75, grade: "A-", points: 11, position: 2 },
};

describe("a report card worked by hand", () => {
  const cards = buildReportCards(input());
  const byId = new Map(cards.map((c) => [c.learner.id, c]));

  it.each(Object.keys(hand))("learner %s: every figure on the card is the hand-worked one", (id) => {
    const want = hand[id]!;
    const card = byId.get(id)!;
    expect(card.subjects.map((s) => [s.name, s.scores, s.average, s.grade, s.points, s.classMean])).toEqual(want.rows);
    expect(card.summary).toEqual({
      subjectsSat: want.sat, total: want.total, mean: want.mean, grade: want.grade, points: want.points, position: want.position, ranked: 6,
    });
  });

  it("keeps the learners in the order given and the subjects in alphabetical order", () => {
    expect(cards.map((c) => c.learner.name)).toEqual(["Amani Otieno", "Baraka Mwangi", "Chebet Korir", "Dalmas Njoroge", "Eve Atieno", "Fatuma Ali", "Gathoni Wambui"]);
    expect(byId.get("a")!.subjects.map((s) => s.name)).toEqual(["English", "Maths"]);
  });

  it("an exam out of 50 is turned into a percentage (45 of 50 is 90, not 45)", () => {
    expect(byId.get("a")!.subjects.find((s) => s.name === "Maths")!.scores).toEqual([90, 70]);
  });

  it("an absent paper is empty and left out of the average; a zero is a mark and is counted", () => {
    expect(byId.get("b")!.subjects.find((s) => s.name === "Maths")).toMatchObject({ scores: [80, null], average: 80 });
    expect(byId.get("c")!.subjects.find((s) => s.name === "Maths")).toMatchObject({ scores: [0, 0], average: 0, grade: "E", points: 1 });
    // Chebet's zeros pull the Maths class mean down: six learners sat it, not five (80 + 80 + 0 + 70 + 81 + 75 = 386, 386 / 6 = 64.33)
    expect(MATHS_MEAN).toBe(Math.round(386 / 6));
  });

  it("the average is rounded half up BEFORE it is graded: 59.5 is 60, a B-, not a C+", () => {
    expect(byId.get("a")!.subjects.find((s) => s.name === "English")).toMatchObject({ average: 60, grade: "B-", points: 8 });
  });

  it("the mean is rounded half up BEFORE it is graded: 79.5 is 80, an A (the same rule as the gradebook's mean)", () => {
    expect(byId.get("f")!.summary).toMatchObject({ mean: 80, grade: "A" });
  });

  it("a learner with no marks has no subjects, no mean and no place, and is not counted in 'out of'", () => {
    expect(byId.get("d")!.subjects).toEqual([]);
    expect(byId.get("d")!.summary.position).toBeNull();
    expect(byId.get("d")!.summary.ranked).toBe(6);
  });

  it("learners with the same mean share a place and the next place is skipped: 1, 2, 3, 3, 5, 6", () => {
    expect(cards.map((c) => c.summary.position)).toEqual([3, 5, 6, null, 3, 1, 2]);
  });

  it("position follows the MEAN, not the total: Gathoni (one subject, 75) is above Baraka (two subjects, total 120, mean 60)", () => {
    expect(byId.get("b")!.summary.total).toBeGreaterThan(byId.get("g")!.summary.total!);
    expect(byId.get("g")!.summary.position!).toBeLessThan(byId.get("b")!.summary.position!);
  });

  it("position can be switched off, and then there is no 'out of' either", () => {
    const off = buildReportCards(input({ options: { showPosition: false, showAttendance: false, showFees: false, nextTermBegins: null } }));
    expect(off.every((c) => c.summary.position === null && c.summary.ranked === 0)).toBe(true);
    expect(off.map((c) => c.summary.mean)).toEqual(cards.map((c) => c.summary.mean));
  });

  it("position starts on for KCSE classes and off for CBC (CBC cards usually leave it out)", () => {
    expect(defaultReportCardOptions("kcse").showPosition).toBe(true);
    expect(defaultReportCardOptions("cbc").showPosition).toBe(false);
  });
});

describe("a report card shows the grade the gradebook shows: every whole mark, against the hand-typed tables", () => {
  // One learner per mark, one subject, one exam out of 100: the card's average is the mark itself.
  const learners = Array.from({ length: 101 }, (_, mark) => ({ id: `m${mark}`, name: `Mark ${mark}`, admissionNo: `${mark}` }));
  const marks = learners.map((l, mark) => ({ studentId: l.id, examId: "e", subjectId: "s", subjectName: "Chemistry", subjectCode: "CHE", score: mark }));
  const oneExam = (scheme: "kcse" | "cbc") => buildReportCards(input({ scheme, exams: [{ id: "e", name: "Mock 1", outOf: 100 }], learners, marks }));

  it("KCSE: grade and points of the subject and of the card's mean, for 0 to 100", () => {
    const cards = oneExam("kcse");
    for (let mark = 0; mark <= 100; mark++) {
      const [grade, points] = expected(KCSE, mark)!;
      const card = cards[mark]!;
      expect(card.subjects[0], `mark ${mark}`).toMatchObject({ scores: [mark], average: mark, grade, points });
      expect(card.summary, `mark ${mark}`).toMatchObject({ mean: mark, grade, points });
    }
  });

  it("CBC: grade and points for 1 to 100, and a 0 is the lowest level (BE2, 1 point), as in the gradebook", () => {
    const cards = oneExam("cbc");
    for (let mark = 1; mark <= 100; mark++) {
      const [grade, points] = expected(CBC, mark)!;
      const card = cards[mark]!;
      expect(card.subjects[0], `mark ${mark}`).toMatchObject({ average: mark, grade, points });
      expect(card.summary, `mark ${mark}`).toMatchObject({ mean: mark, grade, points });
    }
    expect(cards[0]!.subjects[0]).toMatchObject({ average: 0, grade: "BE2", points: 1 });
  });
});

describe("the PDF prints what the card says", () => {
  it("each learner's page carries the hand-worked rows and summary line, and nothing the card does not hold", async () => {
    const cards = buildReportCards(input());
    const pages = await pdfPageTexts(await renderReportCardsPdf(cards.map((data) => ({ data, teacherComment: "Good work.", principalComment: null }))));
    expect(pages).toHaveLength(7);
    const lines = (page: number) => pages[page]!.split("\n");
    /** The seven cells of a subject row, as the page draws them: name, one cell per exam, average, grade, points, class mean. */
    const row = (page: number, subject: string) => { const l = lines(page); const i = l.indexOf(subject); return l.slice(i, i + 7); };
    const cell = (n: number | null) => (n === null ? "-" : String(n));

    ["a", "b", "c", "e", "f", "g"].forEach((id) => {
      const page = ["a", "b", "c", "d", "e", "f", "g"].indexOf(id);
      const want = hand[id]!;
      expect(lines(page), id).toContain(cards[page]!.learner.name);
      for (const [subject, scores, average, grade, points, classMean] of want.rows) {
        expect(row(page, subject), `${id} ${subject}`).toEqual([subject, ...scores.map(cell), String(average), grade, String(points), String(classMean)]);
      }
      expect(lines(page), id).toContain(
        `Subjects: ${want.sat} · Total: ${want.total} · Mean: ${want.mean}% · Mean grade: ${want.grade} · Points: ${want.points} · Position: ${want.position} of 6`);
    });
  });

  it("a learner with no marks gets a page with no subject rows and no position", async () => {
    const cards = buildReportCards(input());
    const pages = await pdfPageTexts(await renderReportCardsPdf([{ data: cards[3]!, teacherComment: null, principalComment: null }]));
    const text = pages[0]!;
    expect(text).toContain("Dalmas Njoroge");
    expect(text).not.toMatch(/Position: \d/);
    expect(text).not.toContain("Maths");
  });
});
