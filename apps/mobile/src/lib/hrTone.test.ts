import { hrStatusTone } from "./hrTone";

// The colour of a status in Figbloom HR's own words.

describe("the colour of a status in HR's words", () => {
  it("is done for what has been approved or completed, whatever its case", () => {
    for (const word of ["approved", "Approved", "done", "completed"]) expect(hrStatusTone(word)).toBe("ok");
  });
  it("is waiting for what is pending or the step in hand", () => {
    for (const word of ["pending", "current", "Waiting"]) expect(hrStatusTone(word)).toBe("warn");
  });
  it("is neither for declined, cancelled, upcoming and anything HR may add", () => {
    for (const word of ["declined", "cancelled", "upcoming", "not_reached", "something_new"]) expect(hrStatusTone(word)).toBe("muted");
  });
});
