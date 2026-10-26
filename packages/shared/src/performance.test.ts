import { describe, expect, it } from "vitest";
import {
  cbeLevelTrend, changeOver, compareExams, describeChange, examsOf, gradeBand, gradeDistributions, learnerTrend, movers,
  overallMeans, semesterGpaTrend, subjectComparison, subjectMeans, subjectStandings, teachingResults,
  type ClassPerformanceRow, type LearnerHistoryRow,
} from "./performance";

const T1 = { term_id: "t1", term_name: "Term 1 2026", term_starts_on: "2026-01-06" };
const T2 = { term_id: "t2", term_name: "Term 2 2026", term_starts_on: "2026-04-27" };
const OPENER = { exam_id: "e1", exam_name: "Opener", published_at: "2026-01-20T08:00:00Z", ...T1 };
const MID = { exam_id: "e2", exam_name: "Mid-term", published_at: "2026-02-25T08:00:00Z", ...T1 };
const END = { exam_id: "e3", exam_name: "End of term", published_at: "2026-05-30T08:00:00Z", ...T2 };

const mark = (exam: typeof OPENER, subject: string, score: number, classMean: number | null = null): LearnerHistoryRow => ({
  ...exam, subject_id: subject, subject_name: subject[0]!.toUpperCase() + subject.slice(1), score, class_mean: classMean,
});

describe("exam order", () => {
  it("goes by term, then publication, then name; unpublished last", () => {
    const refs = examsOf([END, MID, OPENER, { ...MID, exam_id: "e4", exam_name: "Draft", published_at: null }]);
    expect(refs.map((e) => e.name)).toEqual(["Opener", "Mid-term", "Draft", "End of term"]);
    expect(compareExams(refs[0]!, refs[0]!)).toBe(0);
  });
});

describe("learnerTrend", () => {
  const rows = [
    mark(OPENER, "maths", 60, 55), mark(OPENER, "english", 70, 65),
    mark(MID, "maths", 66, 58),
    mark(END, "maths", 72, 60), mark(END, "english", 64, 66),
  ];
  const t = learnerTrend(rows);

  it("orders exams and lines subjects up alphabetically, with gaps for papers not sat", () => {
    expect(t.exams.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
    expect(t.subjects.map((s) => s.name)).toEqual(["English", "Maths"]);
    expect(t.subjects[0]!.scores).toEqual([70, null, 64]);
  });
  it("means only the papers sat, and compares with the class on those same papers", () => {
    expect(t.overall).toEqual([65, 66, 68]);
    expect(t.classOverall).toEqual([60, 58, 63]);
  });
  it("ranks subjects strongest first, with change and distance from the class", () => {
    const s = subjectStandings(t);
    expect(s.map((x) => x.name)).toEqual(["English", "Maths"]);
    expect(s[0]).toMatchObject({ average: 67, latest: 64, change: -6, vsClass: 1.5, sittings: 2 });
    expect(s[1]).toMatchObject({ average: 66, latest: 72, change: 12, sittings: 3 });
  });
  it("is empty for a learner with nothing published", () => {
    expect(learnerTrend([])).toEqual({ exams: [], overall: [], classOverall: [], subjects: [] });
  });
});

describe("change", () => {
  it("skips gaps and needs two values", () => {
    expect(changeOver([null, 50, null, 58])).toMatchObject({ from: 50, to: 58, change: 8, fromIndex: 1, toIndex: 3 });
    expect(changeOver([null, 50])).toBeNull();
  });
  it("describes the change in words", () => {
    const exams = examsOf([OPENER, MID]);
    expect(describeChange([60, 66], exams)).toBe("Up 6 marks since Opener (Term 1 2026)");
    expect(describeChange([60, 57.5], exams)).toBe("Down 2.5 marks since Opener (Term 1 2026)");
    expect(describeChange([60, 60.2], exams)).toBe("Steady since Opener (Term 1 2026)");
    expect(describeChange([60], exams)).toBeNull();
  });
});

const perf = (exam: typeof OPENER, classId: string, subject: string, scores: number[], teacher: string | null = null): ClassPerformanceRow => ({
  ...exam, class_id: classId, class_name: classId.toUpperCase(), subject_id: subject, subject_name: subject, teacher_id: teacher, teacher_name: teacher,
  learners: scores.length, mean_score: scores.reduce((a, s) => a + s, 0) / scores.length, scores,
});

describe("class performance", () => {
  const rows = [
    perf(OPENER, "f2a", "maths", [40, 50, 60], "Otieno"), perf(OPENER, "f2a", "english", [80]),
    perf(MID, "f2a", "maths", [55, 65, 75], "Otieno"), perf(MID, "f2b", "maths", [20]),
  ];
  const exams = examsOf(rows);

  it("weights the overall mean by how many sat each paper", () => {
    expect(overallMeans(rows, exams)).toEqual([57.5, 53.8]);
  });
  it("gives one series per subject, merged across classes", () => {
    expect(subjectMeans(rows, exams)).toEqual([
      { id: "english", name: "english", means: [80, null] },
      { id: "maths", name: "maths", means: [50, 53.8] },
    ]);
  });
  it("compares subjects within one exam, highest first", () => {
    expect(subjectComparison(rows, "e1").map((s) => [s.name, s.mean, s.learners])).toEqual([["english", 80, 1], ["maths", 50, 3]]);
    expect(subjectComparison(rows, "nope")).toEqual([]);
  });
  it("bands KCSE by letter and CBC by level", () => {
    expect(gradeBand(77, "kcse")).toBe("A");
    expect(gradeBand(62, "kcse")).toBe("B");
    expect(gradeBand(92, "cbc")).toBe("EE");
    expect(gradeBand(45, "cbc")).toBe("ME");
  });
  it("counts marks per band per exam, best band first", () => {
    const d = gradeDistributions(rows, exams, "kcse");
    expect(d[0]).toMatchObject({ key: "e1", label: "Opener", total: 4, counts: [1, 1, 1, 1, 0] });
    expect(d[1]!.counts).toEqual([1, 1, 1, 0, 1]);
  });
  it("credits each class and subject's latest mean to today's teacher, with its change", () => {
    const t = teachingResults(rows);
    expect(t.map((r) => [r.className, r.subjectName, r.teacherName, r.latest, r.change])).toEqual([
      ["F2A", "english", null, 80, null],
      ["F2A", "maths", "Otieno", 65, 15],
      ["F2B", "maths", null, 20, null],
    ]);
  });
});

describe("movers", () => {
  const m = (exam: string, id: string, mean: number) => ({ exam_id: exam, student_id: id, full_name: id, mean_score: mean, subjects: 8 });
  const rows = [m("e1", "amani", 50), m("e2", "amani", 62), m("e1", "baraka", 70), m("e2", "baraka", 61), m("e1", "chebet", 55), m("e2", "chebet", 55), m("e2", "new", 80)];
  it("lists the biggest rises and falls among learners who sat both", () => {
    const r = movers(rows, "e1", "e2");
    expect(r.improved.map((x) => [x.name, x.change])).toEqual([["amani", 12]]);
    expect(r.dropped.map((x) => [x.name, x.change])).toEqual([["baraka", -9]]);
  });
  it("respects the limit", () => {
    expect(movers(rows, "e1", "e2", 0).improved).toEqual([]);
  });
});

describe("cbeLevelTrend", () => {
  it("counts levels per month, folding EE1/EE2 into EE", () => {
    const d = cbeLevelTrend([
      { assessedOn: "2026-03-10", levelCode: "EE1" }, { assessedOn: "2026-03-20", levelCode: "ee2" },
      { assessedOn: "2026-02-05", levelCode: "AE" }, { assessedOn: "2026-03-01", levelCode: "BE2" },
      { assessedOn: "2026-03-01", levelCode: "XX" },
    ]);
    expect(d.map((x) => [x.key, x.label, x.sublabel, x.counts, x.total])).toEqual([
      ["2026-02", "Feb", "2026", [0, 0, 1, 0], 1],
      ["2026-03", "Mar", "2026", [2, 0, 0, 1], 3],
    ]);
  });
});

describe("semesterGpaTrend", () => {
  it("credit-weights each semester and keeps a running cumulative", () => {
    const g = semesterGpaTrend([
      { semesterId: "s2", semesterName: "Sem 2", startsOn: "2026-05-01", credits: 3, gradePoints: 2.0 },
      { semesterId: "s1", semesterName: "Sem 1", startsOn: "2026-01-10", credits: 3, gradePoints: 4.0 },
      { semesterId: "s1", semesterName: "Sem 1", startsOn: "2026-01-10", credits: 1, gradePoints: 2.0 },
      { semesterId: "s3", semesterName: "Sem 3", startsOn: "2026-09-01", credits: 0, gradePoints: 4.0 },
    ]);
    expect(g).toEqual([
      { semesterId: "s1", name: "Sem 1", gpa: 3.5, cumulative: 3.5, credits: 4 },
      { semesterId: "s2", name: "Sem 2", gpa: 2, cumulative: 2.86, credits: 3 },
    ]);
  });
});
