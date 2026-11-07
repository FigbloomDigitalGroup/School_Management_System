import { formatDateInput } from "./dateInput";

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
