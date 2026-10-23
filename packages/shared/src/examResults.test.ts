import { describe, expect, it } from "vitest";
import { groupPublishedExams, newestExamNote } from "./examResults";

const mark = (student: string, exam: string, name: string, publishedAt: string | null, score: number | null) => ({
  student_id: student,
  exam_id: exam,
  score,
  exams: { name, published_at: publishedAt },
});

describe("groupPublishedExams", () => {
  it("lists a learner's exams newest first, counting the subjects out", () => {
    const grouped = groupPublishedExams([
      mark("s1", "mock", "Mock 1", "2026-10-01T08:00:00Z", 60),
      mark("s1", "mock", "Mock 1", "2026-10-01T08:00:00Z", 71),
      mark("s1", "mock", "Mock 1", "2026-10-01T08:00:00Z", 48),
      mark("s1", "end", "End of Term 3", "2026-10-20T08:00:00Z", 77),
    ]);
    expect(grouped.get("s1")).toEqual([
      { id: "end", name: "End of Term 3", subjectCount: 1 },
      { id: "mock", name: "Mock 1", subjectCount: 3 },
    ]);
  });

  it("keeps each learner's exams apart", () => {
    const grouped = groupPublishedExams([
      mark("s1", "mock", "Mock 1", "2026-10-01T08:00:00Z", 60),
      mark("s2", "end", "End of Term 3", "2026-10-20T08:00:00Z", 55),
    ]);
    expect(grouped.get("s1")?.map((e) => e.id)).toEqual(["mock"]);
    expect(grouped.get("s2")?.map((e) => e.id)).toEqual(["end"]);
  });

  it("does not count a missed paper as a subject, and drops an exam with nothing else", () => {
    const grouped = groupPublishedExams([
      mark("s1", "mock", "Mock 1", "2026-10-01T08:00:00Z", 60),
      mark("s1", "mock", "Mock 1", "2026-10-01T08:00:00Z", null),
      mark("s1", "end", "End of Term 3", "2026-10-20T08:00:00Z", null),
    ]);
    expect(grouped.get("s1")).toEqual([{ id: "mock", name: "Mock 1", subjectCount: 1 }]);
  });

  it("has no entry for a learner with no results out", () => {
    expect(groupPublishedExams([]).get("s1")).toBeUndefined();
    expect(groupPublishedExams([mark("s1", "end", "End of Term 3", null, null)]).get("s1")).toBeUndefined();
  });

  it("orders exams published at the same moment by name, and puts an unpublished-date exam last", () => {
    const grouped = groupPublishedExams([
      mark("s1", "b", "Beta", "2026-10-01T08:00:00Z", 50),
      mark("s1", "a", "Alpha", "2026-10-01T08:00:00Z", 50),
      mark("s1", "z", "Zed", null, 50),
    ]);
    expect(grouped.get("s1")?.map((e) => e.name)).toEqual(["Alpha", "Beta", "Zed"]);
  });

  it("skips a mark whose exam is not readable", () => {
    const grouped = groupPublishedExams([{ student_id: "s1", exam_id: "x", score: 60, exams: null }]);
    expect(grouped.size).toBe(0);
  });
});

describe("newestExamNote", () => {
  it("says how many subjects the newest exam covers", () => {
    expect(newestExamNote([{ id: "a", name: "A", subjectCount: 1 }, { id: "b", name: "B", subjectCount: 9 }])).toBe(" · 1 subject");
    expect(newestExamNote([{ id: "b", name: "B", subjectCount: 9 }])).toBe(" · 9 subjects");
  });
  it("is empty with no exam (or a cache from before exams were listed)", () => {
    expect(newestExamNote([])).toBe("");
  });
});
