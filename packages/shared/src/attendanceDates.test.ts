import { afterEach, describe, expect, it, vi } from "vitest";
import { attendanceRate, newRegister, today } from "./attendance";
import type { AttendanceMark } from "./types";

/**
 * QA 10 (FIG-1243): the date a register is filed under, and the one rule every attendance percentage starts from.
 *
 * today() is what the screens file a register under, and what "already taken today" looks for. It is the UTC date from the
 * device's clock. Nairobi is three hours ahead of UTC, so from 21:00 to 23:59 UTC (00:00 to 02:59 in Nairobi) the app thinks it is
 * still yesterday: a register taken then is filed under yesterday, over the top of yesterday's real one (one row per learner and
 * day), and "already taken today" is answered from yesterday's rows. The expected day is worked out here with Intl for
 * Africa/Nairobi, not by calling today() the other way round. Every other hour of the day gives the same date either way, so
 * those cases are controls that must pass before and after a fix.
 *
 * Open defects are written as the behaviour we want and use it.fails: they pass while the defect exists and fail the day it is
 * fixed. Then change it.fails to it and remove the pin at the end.
 */

const nairobiDay = (utc: string) => new Date(utc).toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
const appSays = (utc: string) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(utc));
  return today();
};

afterEach(() => { vi.useRealTimers(); });

describe("the date of a register, against the school's own day (Nairobi)", () => {
  it("the hand-worked expected days: 08:00 on Friday 30 October is Friday, 01:30 on Saturday 31 October is Saturday", () => {
    expect(nairobiDay("2026-10-30T05:00:00Z")).toBe("2026-10-30");
    expect(nairobiDay("2026-10-30T22:30:00Z")).toBe("2026-10-31");
  });

  it("agrees with Nairobi through the school day: 08:00 and midday", () => {
    expect(appSays("2026-10-30T05:00:00Z")).toBe("2026-10-30");
    expect(appSays("2026-10-30T09:00:00Z")).toBe("2026-10-30");
  });

  it("agrees with Nairobi at the last second before midnight in Nairobi (23:59:59, 20:59:59 UTC) and just after UTC midnight (03:00 in Nairobi)", () => {
    expect(appSays("2026-10-30T20:59:59Z")).toBe(nairobiDay("2026-10-30T20:59:59Z"));
    expect(appSays("2026-10-31T00:00:00Z")).toBe(nairobiDay("2026-10-31T00:00:00Z"));
  });

  it.fails("QA10-DATE FIG-1400 (open): at midnight in Nairobi the app starts the new day", () => {
    expect(appSays("2026-10-30T21:00:00Z")).toBe(nairobiDay("2026-10-30T21:00:00Z"));
  });

  it.fails("QA10-DATE FIG-1400 (open): at 01:30 in Nairobi the register is filed under that day", () => {
    expect(appSays("2026-10-30T22:30:00Z")).toBe(nairobiDay("2026-10-30T22:30:00Z"));
  });

  it.fails("QA10-DATE FIG-1400 (open): at 02:59 in Nairobi the register is filed under that day", () => {
    expect(appSays("2026-10-30T23:59:59Z")).toBe(nairobiDay("2026-10-30T23:59:59Z"));
  });

  it.fails("QA10-DATE FIG-1400 (open): a register taken at 01:30 on Saturday does not share Friday 08:00's date, so it cannot overwrite it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T05:00:00Z"));
    const friday = newRegister("c1", "t1", ["a"]).date;
    vi.setSystemTime(new Date("2026-10-30T22:30:00Z"));
    const saturday = newRegister("c1", "t1", ["a"]).date;
    expect(saturday).not.toBe(friday);
  });

  it("(what the open defect leaves behind) the date is the device's UTC date, so 01:30 on Saturday in Nairobi is still Friday's", () => {
    expect(appSays("2026-10-30T22:30:00Z")).toBe("2026-10-30");
  });

  it("a new register opens on today()'s date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T09:00:00Z"));
    expect(newRegister("c1", "t1", ["a"]).date).toBe("2026-10-30");
  });
});

describe("attendanceRate: the rule every percentage starts from, worked by hand", () => {
  const marks = (...m: AttendanceMark[]) => m.map((mark) => ({ mark }));

  it("2 here of 3 is 67% (66.67 rounds up)", () => {
    expect(attendanceRate(marks("present", "present", "absent"))).toBe(67);
  });
  it("1 here of 3 is 33% (33.33 rounds down)", () => {
    expect(attendanceRate(marks("present", "absent", "absent"))).toBe(33);
  });
  it("5 here of 8 is 63%: exactly 62.5 rounds up, not to the even 62", () => {
    expect(attendanceRate(marks("present", "present", "present", "late", "late", "absent", "absent", "excused"))).toBe(63);
  });
  it("1 here of 8 is 13%: exactly 12.5 rounds up", () => {
    expect(attendanceRate(marks("present", "absent", "absent", "absent", "absent", "absent", "absent", "absent"))).toBe(13);
  });
  it("a late arrival was here: one late learner is 100%, a late and an absent learner is 50%", () => {
    expect(attendanceRate(marks("late"))).toBe(100);
    expect(attendanceRate(marks("late", "absent"))).toBe(50);
  });
  it("an excused learner counts as not here: one excused learner is 0%, one present and one excused is 50%", () => {
    expect(attendanceRate(marks("excused"))).toBe(0);
    expect(attendanceRate(marks("present", "excused"))).toBe(50);
  });
  it("a day nobody turned up is 0%, not 'no data'", () => {
    expect(attendanceRate(marks("absent", "absent"))).toBe(0);
  });
});
