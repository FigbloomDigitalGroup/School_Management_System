import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@figbloom/shared";
import { classRegisterFigures, figureText, latestDate } from "./classRegisters";

const e = (student_id: string, session: "morning" | "afternoon", mark: SessionEntry["mark"], class_id = "c1"): SessionEntry =>
  ({ student_id, taken_on: "2026-11-06", session, mark, class_id });

describe("class register figures (FIG-1514)", () => {
  it("morning only matches the old counting", () => {
    const f = classRegisterFigures([e("a", "morning", "present"), e("b", "morning", "late"), e("c", "morning", "absent")], "session").get("c1")!;
    expect(f).toMatchObject({ amIn: true, pmIn: false, here: 2, total: 3, late: 1, absent: 1 });
  });

  it("counts both registers by session", () => {
    const f = classRegisterFigures([e("a", "morning", "present"), e("a", "afternoon", "absent")], "session").get("c1")!;
    expect(f).toMatchObject({ amIn: true, pmIn: true, here: 1, total: 2 });
  });

  it("counts a day once in day mode", () => {
    const f = classRegisterFigures([e("a", "morning", "present"), e("a", "afternoon", "absent")], "day").get("c1")!;
    expect(f).toMatchObject({ here: 1, total: 1 });
  });

  it("leaves out an afternoon absence after a live early sign-out", () => {
    const f = classRegisterFigures(
      [e("a", "morning", "present"), e("a", "afternoon", "absent")], "session",
      [{ student_id: "a", taken_on: "2026-11-06", voided_at: null }],
    ).get("c1")!;
    expect(f).toMatchObject({ here: 1, total: 1 });
  });

  it("an afternoon-only class is not in for the morning", () => {
    const f = classRegisterFigures([e("a", "afternoon", "present")], "session").get("c1")!;
    expect(f.amIn).toBe(false);
    expect(f.pmIn).toBe(true);
  });

  it("latestDate and figureText", () => {
    expect(latestDate("2026-11-05", "2026-11-06")).toBe("2026-11-06");
    expect(latestDate(null, "2026-11-06")).toBe("2026-11-06");
    expect(latestDate(null, null)).toBeNull();
    expect(figureText({ here: 3, total: 4 })).toBe("3 / 4");
  });
});
