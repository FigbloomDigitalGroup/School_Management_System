import { describe, expect, it } from "vitest";
import { currentPeriodIndex, todayWeekday, type TimetableRow } from "./timetable";

const rows: TimetableRow[] = [
  ["08:00:00", "Maths", "Rm 1"],
  ["09:00:00", "English", "Rm 2"],
  ["10:00:00", "Chemistry", "Lab 1"],
];

describe("currentPeriodIndex", () => {
  it("is -1 before the first period starts", () => {
    expect(currentPeriodIndex(rows, new Date("2026-01-05T07:30:00"))).toBe(-1);
  });
  it("is the period whose start_time has just passed", () => {
    expect(currentPeriodIndex(rows, new Date("2026-01-05T08:15:00"))).toBe(0);
    expect(currentPeriodIndex(rows, new Date("2026-01-05T09:59:00"))).toBe(1);
  });
  it("is the last period once the day's periods have all started", () => {
    expect(currentPeriodIndex(rows, new Date("2026-01-05T15:00:00"))).toBe(2);
  });
  it("is -1 for an empty day", () => {
    expect(currentPeriodIndex([], new Date("2026-01-05T09:00:00"))).toBe(-1);
  });
});

describe("todayWeekday", () => {
  it("returns the short weekday for a school day", () => {
    expect(todayWeekday(new Date("2026-01-05T09:00:00"))).toBe("Mon"); // 5 Jan 2026 is a Monday
  });
  it("is null on a weekend", () => {
    expect(todayWeekday(new Date("2026-01-04T09:00:00"))).toBeNull(); // Sunday
    expect(todayWeekday(new Date("2026-01-03T09:00:00"))).toBeNull(); // Saturday
  });
});
