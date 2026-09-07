import { describe, expect, it } from "vitest";
import { attendanceRate, newRegister, nextMark, submitWarning, tally, toRecords } from "./attendance";
import type { AttendanceRecord } from "./types";

describe("nextMark", () => {
  it("cycles present -> absent -> late -> present", () => {
    expect(nextMark("present")).toBe("absent");
    expect(nextMark("absent")).toBe("late");
    expect(nextMark("late")).toBe("present");
  });
});

describe("newRegister", () => {
  it("defaults everyone to present", () => {
    const r = newRegister("class-1", "term-1", ["s1", "s2", "s3"], "2026-06-01");
    expect(Object.values(r.marks)).toEqual(["present", "present", "present"]);
    expect(r.date).toBe("2026-06-01");
  });
});

describe("tally", () => {
  it("counts each mark and the total", () => {
    const r = newRegister("c1", "t1", ["a", "b", "c", "d"], "2026-06-01");
    r.marks.b = "absent";
    r.marks.c = "late";
    expect(tally(r)).toEqual({ present: 2, absent: 1, late: 1, excused: 0, total: 4 });
  });
});

describe("submitWarning", () => {
  it("flags an empty roster", () => {
    const r = newRegister("c1", "t1", [], "2026-06-01");
    expect(submitWarning(r)).toMatch(/nobody on this roster/);
  });
  it("asks for confirmation on an all-present register", () => {
    const r = newRegister("c1", "t1", ["a", "b"], "2026-06-01");
    expect(submitWarning(r)).toMatch(/Marking all 2 learners present/);
  });
  it("stays quiet once someone is marked absent or late", () => {
    const r = newRegister("c1", "t1", ["a", "b"], "2026-06-01");
    r.marks.a = "absent";
    expect(submitWarning(r)).toBeNull();
  });
});

describe("toRecords", () => {
  it("carries the note for a student and null for the rest", () => {
    const r = newRegister("c1", "t1", ["a", "b"], "2026-06-01");
    r.marks.a = "absent";
    r.notes.a = "Sick leave, mother called";
    const records = toRecords(r, "tenant-1", "teacher-1");
    const a = records.find((rec) => rec.student_id === "a")!;
    const b = records.find((rec) => rec.student_id === "b")!;
    expect(a.note).toBe("Sick leave, mother called");
    expect(a.mark).toBe("absent");
    expect(a.synced_at).toBeNull();
    expect(b.note).toBeNull();
    expect(b.tenant_id).toBe("tenant-1");
    expect(b.taken_by).toBe("teacher-1");
  });
});

describe("attendanceRate", () => {
  const rec = (mark: AttendanceRecord["mark"]): Pick<AttendanceRecord, "mark"> => ({ mark });

  it("is null with no records rather than dividing by zero", () => {
    expect(attendanceRate([])).toBeNull();
  });
  it("counts present and late as 'here', absent and excused as not", () => {
    const rate = attendanceRate([rec("present"), rec("late"), rec("absent"), rec("excused")]);
    expect(rate).toBe(50);
  });
});
