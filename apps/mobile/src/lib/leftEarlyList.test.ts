import { leftEarlyLines } from "./leftEarlyList";

const roster = [
  { id: "a", full_name: "Amina Otieno" },
  { id: "b", full_name: "Brian Kamau" },
  { id: "c", full_name: "Cynthia Wanjiru" },
];
const so = (t: string) => ({ signed_out_local: t });

describe("leftEarlyLines", () => {
  it("gives one line per signed-out learner, in roster order", () => {
    const m = new Map([["c", so("14:05:00")], ["a", so("10:45:00")]]);
    expect(leftEarlyLines(roster, m)).toEqual([
      { studentId: "a", text: "Amina Otieno - left early at 10:45" },
      { studentId: "c", text: "Cynthia Wanjiru - left early at 14:05" },
    ]);
  });

  it("shows nothing for an empty map or no roster", () => {
    expect(leftEarlyLines(roster, new Map())).toEqual([]);
    expect(leftEarlyLines(null, new Map([["a", so("10:45:00")]]))).toEqual([]);
  });

  it("ignores sign-outs of learners not in this class", () => {
    expect(leftEarlyLines(roster, new Map([["z", so("10:45:00")]]))).toEqual([]);
  });
});
