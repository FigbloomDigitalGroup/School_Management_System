import { afterEach, describe, expect, it, vi } from "vitest";
import { attendanceRate, newRegister, today, toRecords } from "./attendance";
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
 * FIG-1400 is fixed: today() is the day in the school's own time zone, and the four tests that were written as open defects
 * (it.fails) are ordinary tests now.
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

  it("QA10-DATE FIG-1400: at midnight in Nairobi the app starts the new day", () => {
    expect(appSays("2026-10-30T21:00:00Z")).toBe(nairobiDay("2026-10-30T21:00:00Z"));
  });

  it("QA10-DATE FIG-1400: at 01:30 in Nairobi the register is filed under that day", () => {
    expect(appSays("2026-10-30T22:30:00Z")).toBe(nairobiDay("2026-10-30T22:30:00Z"));
  });

  it("QA10-DATE FIG-1400: at 02:59 in Nairobi the register is filed under that day", () => {
    expect(appSays("2026-10-30T23:59:59Z")).toBe(nairobiDay("2026-10-30T23:59:59Z"));
  });

  it("QA10-DATE FIG-1400: a register taken at 01:30 on Saturday does not share Friday 08:00's date, so it cannot overwrite it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T05:00:00Z"));
    const friday = newRegister("c1", "t1", ["a"]).date;
    vi.setSystemTime(new Date("2026-10-30T22:30:00Z"));
    const saturday = newRegister("c1", "t1", ["a"]).date;
    expect(saturday).not.toBe(friday);
  });

  it("a new register opens on today()'s date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T09:00:00Z"));
    expect(newRegister("c1", "t1", ["a"]).date).toBe("2026-10-30");
  });

  it("a time zone can be named: the same instant is a different day in Nairobi (UTC+3) and in Lagos (UTC+1)", () => {
    const instant = new Date("2026-10-30T22:30:00Z");
    expect(today("Africa/Nairobi", instant)).toBe("2026-10-31");
    expect(today("Africa/Lagos", instant)).toBe("2026-10-30");
  });

  it("on a device that cannot format a date in a time zone, it falls back to Nairobi's fixed UTC+3 and still files 01:30 under Saturday", () => {
    const real = Intl.DateTimeFormat;
    Intl.DateTimeFormat = (function () { throw new Error("no time-zone support"); }) as unknown as typeof Intl.DateTimeFormat;
    try {
      expect(today("Africa/Nairobi", new Date("2026-10-30T22:30:00Z"))).toBe("2026-10-31");
      expect(today("Africa/Nairobi", new Date("2026-10-30T20:59:59Z"))).toBe("2026-10-30");
    } finally { Intl.DateTimeFormat = real; }
  });

  it("on a device whose formatter ignores the requested layout, it does not return a date in the wrong shape", () => {
    const real = Intl.DateTimeFormat;
    Intl.DateTimeFormat = (function () { return { format: () => "10/31/2026" }; }) as unknown as typeof Intl.DateTimeFormat;
    try {
      expect(today("Africa/Nairobi", new Date("2026-10-30T22:30:00Z"))).toBe("2026-10-31");
    } finally { Intl.DateTimeFormat = real; }
  });
});

// FIG-1410: the database keeps the NEWEST register for a learner and day by the time it was taken, so each row carries it.
describe("toRecords stamps when the register was taken", () => {
  const reg = () => newRegister("c1", "t1", ["a", "b"], "2026-10-30");

  it("stamps every row with the moment it was built, unless told otherwise", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T05:00:00Z"));
    const rows = toRecords(reg(), "school", "teacher");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.marked_at)).toEqual(["2026-10-30T05:00:00.000Z", "2026-10-30T05:00:00.000Z"]);
  });

  it("uses the time it is given", () => {
    expect(toRecords(reg(), "school", "teacher", "2026-10-30T08:15:00.000Z").every((r) => r.marked_at === "2026-10-30T08:15:00.000Z")).toBe(true);
  });

  it("a register taken earlier is stamped earlier than a correction made later", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T05:00:00Z"));
    const held = toRecords(reg(), "school", "teacher")[0]!.marked_at!;
    vi.setSystemTime(new Date("2026-10-30T05:30:00Z"));
    const correction = toRecords(reg(), "school", "teacher")[0]!.marked_at!;
    expect(new Date(held).getTime()).toBeLessThan(new Date(correction).getTime());
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
