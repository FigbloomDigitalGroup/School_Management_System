import { formatDateInput, formatTimeInput, joinDateTime, splitDateTime } from "./dateInput";

// A date typed on the number pad.

describe("a date typed as digits", () => {
  it("lays the digits out as YYYY-MM-DD as they come", () => {
    expect(formatDateInput("")).toBe("");
    expect(formatDateInput("2")).toBe("2");
    expect(formatDateInput("2026")).toBe("2026");
    expect(formatDateInput("20261")).toBe("2026-1");
    expect(formatDateInput("202611")).toBe("2026-11");
    expect(formatDateInput("2026110")).toBe("2026-11-0");
    expect(formatDateInput("20261109")).toBe("2026-11-09");
  });

  it("takes a date that already has its dashes, and one pasted with other marks in it", () => {
    expect(formatDateInput("2026-11-09")).toBe("2026-11-09");
    expect(formatDateInput("2026/11/09")).toBe("2026-11-09");
    expect(formatDateInput(" 2026.11.09 ")).toBe("2026-11-09");
  });

  it("stops at eight digits, and drops letters", () => {
    expect(formatDateInput("202611091")).toBe("2026-11-09");
    expect(formatDateInput("12ab34")).toBe("1234");
  });

  it("lets a dash be deleted without getting stuck on it", () => {
    // backspace over "2026-1" leaves "2026-": the formatter takes the dash away, and the next digit puts it back
    expect(formatDateInput("2026-")).toBe("2026");
    expect(formatDateInput("20261")).toBe("2026-1");
  });
});

describe("a time typed as digits", () => {
  it("lays the digits out as HH:MM as they come", () => {
    expect(formatTimeInput("")).toBe("");
    expect(formatTimeInput("0")).toBe("0");
    expect(formatTimeInput("08")).toBe("08");
    expect(formatTimeInput("083")).toBe("08:3");
    expect(formatTimeInput("0830")).toBe("08:30");
  });
  it("takes a time that already has its colon, stops at four digits and drops letters", () => {
    expect(formatTimeInput("08:30")).toBe("08:30");
    expect(formatTimeInput("08:305")).toBe("08:30");
    expect(formatTimeInput("8a")).toBe("8");
  });
  it("lets the colon be deleted without getting stuck on it", () => {
    expect(formatTimeInput("08:")).toBe("08");
  });
});

describe("a date and a time in two boxes", () => {
  it("joins them into the value fromLocalInput reads", () => {
    expect(joinDateTime("2026-11-09", "08:30")).toBe("2026-11-09T08:30");
  });
  it("is empty when both boxes are empty, so an optional closing time can be left out", () => {
    expect(joinDateTime("", "")).toBe("");
    expect(joinDateTime("  ", "")).toBe("");
  });
  it("refuses a box that is half typed, or only one of the two", () => {
    expect(joinDateTime("2026-11-09", "")).toBeNull();
    expect(joinDateTime("", "08:30")).toBeNull();
    expect(joinDateTime("2026-11", "08:30")).toBeNull();
    expect(joinDateTime("2026-11-09", "8:3")).toBeNull();
  });
  it("refuses a date or a time that does not exist", () => {
    expect(joinDateTime("2026-02-31", "08:30")).toBeNull();
    expect(joinDateTime("2026-13-01", "08:30")).toBeNull();
    expect(joinDateTime("2026-11-09", "25:00")).toBeNull();
    expect(joinDateTime("2026-11-09", "08:75")).toBeNull();
  });
  it("splits a saved moment back into the two boxes (what was typed comes back)", () => {
    const typed = joinDateTime("2026-11-09", "08:30")!;
    const iso = new Date(typed).toISOString();
    expect(splitDateTime(iso)).toEqual({ date: "2026-11-09", time: "08:30" });
  });
  it("splits nothing into two empty boxes", () => {
    expect(splitDateTime(null)).toEqual({ date: "", time: "" });
  });
});
