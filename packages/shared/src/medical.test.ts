import { describe, expect, it } from "vitest";
import {
  addDays, commonComplaints, expandSlots, frequentVisitors, medicationCompliance, notifiesGuardians, offersAttendanceMark,
  outcomeClosesVisit, overdueDoses, parseTimes, roundList, scheduleActiveOn, sickBayBoard, slotState, suggestTimes,
  sickBayVisitProblem, visitsCsv, visitsPerDay, visitsPerWeek, weekOf, requestDraftProblem,
  type MedicationDose, type MedicationSchedule, type SickBayVisit, type SickBayVisitDraft,
} from "./medical";

const schedule = (over: Partial<MedicationSchedule> = {}): MedicationSchedule => ({
  id: "s1", tenant_id: "t1", student_id: "l1", drug: "Amoxicillin", dose: "250mg", times: ["07:00", "13:00", "19:00"],
  starts_on: "2026-10-26", ends_on: "2026-10-30", prescribed_by: "doctor", prescriber: null, notes: null, stopped_at: null,
  created_at: "2026-10-26T05:00:00Z", students: { full_name: "Amani Wanjiru", admission_no: "1001" }, ...over,
});

const dose = (over: Partial<MedicationDose> = {}): MedicationDose => ({
  id: "d1", schedule_id: "s1", student_id: "l1", due_on: "2026-10-27", due_time: "07:00", status: "given",
  recorded_at: "2026-10-27T04:05:00Z", given_by: "n1", note: null, ...over,
});

const visit = (over: Partial<SickBayVisit> = {}): SickBayVisit => ({
  id: "v1", tenant_id: "t1", student_id: "l1", time_in: "2026-10-27T07:00:00", complaint: "Headache", temperature_c: null,
  pulse_bpm: null, observations: null, assessment: null, treatment: null, outcome: null, referred_to: null, time_out: null,
  follow_up: null, attendance_mark: null, attendance_marked_at: null, logged_by: "n1", updated_at: "2026-10-27T07:00:00",
  students: { full_name: "Amani Wanjiru", admission_no: "1001" }, ...over,
});

const draft = (over: Partial<SickBayVisitDraft> = {}): SickBayVisitDraft => ({
  student_id: "l1", time_in: "2026-10-27T07:00:00.000Z", complaint: "Fever", temperature_c: 38.5, pulse_bpm: null,
  observations: "", assessment: "", treatment: "", outcome: null, referred_to: "", time_out: null, follow_up: "", ...over,
});

describe("outcomes", () => {
  it("tells guardians about serious outcomes only, unless the school says every visit", () => {
    expect(notifiesGuardians("home", "serious")).toBe(true);
    expect(notifiesGuardians("hospital", undefined)).toBe(true);
    expect(notifiesGuardians("admitted", null)).toBe(true);
    expect(notifiesGuardians("class", "serious")).toBe(false);
    expect(notifiesGuardians("rest", "serious")).toBe(false);
    expect(notifiesGuardians("class", "all")).toBe(true);
    expect(notifiesGuardians(null, "all")).toBe(false);
  });
  it("closes a visit when the learner leaves the sick bay", () => {
    expect(outcomeClosesVisit("class")).toBe(true);
    expect(outcomeClosesVisit("home")).toBe(true);
    expect(outcomeClosesVisit("rest")).toBe(false);
    expect(outcomeClosesVisit("admitted")).toBe(false);
    expect(outcomeClosesVisit("admitted", "Kenyatta National Hospital")).toBe(true);
    expect(outcomeClosesVisit(null)).toBe(false);
  });
  it("offers the register only for learners who left school", () => {
    expect(offersAttendanceMark("home")).toBe(true);
    expect(offersAttendanceMark("admitted")).toBe(true);
    expect(offersAttendanceMark("class")).toBe(false);
    expect(offersAttendanceMark("rest")).toBe(false);
  });
});

describe("sickBayVisitProblem", () => {
  it("accepts a complete draft", () => expect(sickBayVisitProblem(draft())).toBeNull());
  it("needs a learner and a complaint", () => {
    expect(sickBayVisitProblem(draft({ student_id: null }))).toBe("Pick the learner.");
    expect(sickBayVisitProblem(draft({ complaint: " " }))).toBe("Say what brought them in.");
  });
  it("checks the numbers and the referral", () => {
    expect(sickBayVisitProblem(draft({ temperature_c: 101 }))).toMatch(/°C/);
    expect(sickBayVisitProblem(draft({ pulse_bpm: 5 }))).toMatch(/Pulse/);
    expect(sickBayVisitProblem(draft({ outcome: "hospital" }))).toMatch(/hospital/);
    expect(sickBayVisitProblem(draft({ time_out: "2026-10-27T06:00:00.000Z" }))).toMatch(/leave before/);
  });
});

describe("sickBayBoard", () => {
  it("is everyone without a time out, oldest first, whatever the day", () => {
    const board = sickBayBoard([
      visit({ id: "a", time_in: "2026-10-27T09:00:00" }),
      visit({ id: "b", time_in: "2026-10-27T08:00:00", time_out: "2026-10-27T08:30:00" }),
      visit({ id: "c", time_in: "2026-10-26T20:00:00" }),
    ]);
    expect(board.map((v) => v.id)).toEqual(["c", "a"]);
  });
});

describe("times", () => {
  it("reads typed times", () => {
    expect(parseTimes("8:00, 14:00; 20:00")).toEqual(["08:00", "14:00", "20:00"]);
    expect(parseTimes("20:00 08:00 08:00")).toEqual(["08:00", "20:00"]);
    expect(parseTimes("0730")).toEqual(["07:30"]);
    expect(parseTimes("25:00")).toBeNull();
    expect(parseTimes("morning")).toBeNull();
    expect(parseTimes("")).toBeNull();
  });
  it("suggests round times for N a day", () => {
    expect(suggestTimes(3)).toEqual(["07:00", "13:00", "19:00"]);
    expect(suggestTimes(9)).toEqual([]);
  });
  it("counts days across a month end, and finds the week's Monday", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(weekOf("2026-10-29")).toBe("2026-10-26");
    expect(weekOf("2026-11-01")).toBe("2026-10-26");
    expect(weekOf("2026-10-26")).toBe("2026-10-26");
  });
});

describe("the medication round", () => {
  it("runs a schedule inside its dates until it is stopped", () => {
    const s = schedule();
    expect(scheduleActiveOn(s, "2026-10-25")).toBe(false);
    expect(scheduleActiveOn(s, "2026-10-26")).toBe(true);
    expect(scheduleActiveOn(s, "2026-10-30")).toBe(true);
    expect(scheduleActiveOn(s, "2026-10-31")).toBe(false);
    expect(scheduleActiveOn(schedule({ ends_on: null }), "2027-01-01")).toBe(true);
    expect(scheduleActiveOn(s, "2026-10-28", "2026-10-28")).toBe(false);
    expect(scheduleActiveOn(s, "2026-10-27", "2026-10-28")).toBe(true);
  });
  it("is upcoming, due from 30 minutes before, and overdue an hour after", () => {
    expect(slotState("13:00", 12 * 60)).toBe("upcoming");
    expect(slotState("13:00", 12 * 60 + 30)).toBe("due");
    expect(slotState("13:00", 14 * 60)).toBe("due");
    expect(slotState("13:00", 14 * 60 + 1)).toBe("overdue");
    expect(slotState("13:00", null)).toBe("unrecorded");
  });
  it("lists today's doses in time order with what was recorded", () => {
    const now = new Date(2026, 9, 27, 13, 45);
    const round = roundList(
      [schedule(), schedule({ id: "s2", student_id: "l2", times: ["13:00"], students: { full_name: "Baraka Otieno", admission_no: "1002" } })],
      [dose()], now,
    );
    expect(round.map((r) => `${r.time} ${r.schedule.students?.full_name} ${r.state}`)).toEqual([
      "07:00 Amani Wanjiru given",
      "13:00 Amani Wanjiru due",
      "13:00 Baraka Otieno due",
      "19:00 Amani Wanjiru upcoming",
    ]);
  });
  it("flags doses left unrecorded for over an hour", () => {
    const late = overdueDoses([schedule()], [dose()], new Date(2026, 9, 27, 14, 1));
    expect(late.map((r) => r.time)).toEqual(["13:00"]);
    expect(overdueDoses([schedule()], [dose(), dose({ id: "d2", due_time: "13:00", status: "refused" })], new Date(2026, 9, 27, 14, 1))).toEqual([]);
  });
});

describe("reports", () => {
  it("counts visits per day, with the empty days, and per week", () => {
    const days = visitsPerDay([visit(), visit({ time_in: "2026-10-27T10:00:00" }), visit({ time_in: "2026-10-29T10:00:00" })], "2026-10-26", "2026-11-02");
    expect(days.slice(0, 4)).toEqual([
      { day: "2026-10-26", count: 0 }, { day: "2026-10-27", count: 2 }, { day: "2026-10-28", count: 0 }, { day: "2026-10-29", count: 1 },
    ]);
    expect(visitsPerWeek(days)).toEqual([{ day: "2026-10-26", count: 3 }, { day: "2026-11-02", count: 0 }]);
  });
  it("groups complaints ignoring case and spacing", () => {
    expect(commonComplaints([visit({ complaint: "Headache" }), visit({ complaint: "headache " }), visit({ complaint: "Stomach  ache" })]))
      .toEqual([{ complaint: "Headache", count: 2 }, { complaint: "Stomach ache", count: 1 }]);
  });
  it("finds learners who keep coming back", () => {
    const vs = [visit(), visit({ time_in: "2026-10-28T07:00:00" }), visit({ time_in: "2026-10-29T07:00:00" }), visit({ student_id: "l2" })];
    expect(frequentVisitors(vs, 3)).toEqual([{ student_id: "l1", name: "Amani Wanjiru", admission_no: "1001", count: 3, last: "2026-10-29T07:00:00" }]);
  });
  it("works out compliance from past doses, not ones still to come", () => {
    const slots = expandSlots([schedule()], [
      dose({ due_on: "2026-10-26", due_time: "07:00" }), dose({ id: "d2", due_on: "2026-10-26", due_time: "13:00", status: "refused" }),
      dose({ id: "d3", due_on: "2026-10-27", due_time: "07:00" }),
    ], "2026-10-26", "2026-10-30", "2026-10-27", 8 * 60);
    // 26th: given, refused, nothing at 19:00; 27th: given at 07:00, 13:00 and 19:00 still to come
    const [row] = medicationCompliance(slots);
    expect(row).toMatchObject({ due: 4, given: 2, refused: 1, unrecorded: 1, missed: 0, rate: 50 });
  });
  it("exports visits as CSV", () => {
    const csv = visitsCsv([visit({ complaint: "Cough, cold", outcome: "home" })]);
    expect(csv.split("\n")[0]).toBe("time_in,learner,admission_no,class,complaint,temperature_c,outcome,referred_to,time_out");
    expect(csv.split("\n")[1]).toContain('"Cough, cold"');
    expect(csv.split("\n")[1]).toContain("Sent home");
  });
});

describe("requestDraftProblem", () => {
  const ok = { drug: "Amoxicillin", dose: "250mg", times_per_day: 3, starts_on: "2026-10-27", ends_on: "2026-10-31", instructions: "", prescriber: "" };
  it("accepts a complete request", () => expect(requestDraftProblem(ok)).toBeNull());
  it("needs the medicine, dose, frequency and sensible dates", () => {
    expect(requestDraftProblem({ ...ok, drug: "" })).toBe("Name the medicine.");
    expect(requestDraftProblem({ ...ok, dose: " " })).toMatch(/dose/);
    expect(requestDraftProblem({ ...ok, times_per_day: 0 })).toMatch(/times a day/);
    expect(requestDraftProblem({ ...ok, ends_on: "2026-10-01" })).toMatch(/before the first/);
  });
});
