import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MedicationDose, MedicationSchedule, SickBayVisit } from "./medical";

// The sick bay as one answer: the readers it is made of are the ones the web's board uses, so they are stood in for here.
const readers = vi.hoisted(() => ({ fetchSchedules: vi.fn(), fetchDoses: vi.fn(), fetchOpenVisits: vi.fn(), fetchVisits: vi.fn() }));
vi.mock("./medical", async (importOriginal) => ({ ...(await importOriginal<typeof import("./medical")>()), ...readers }));

import { fetchSickBayBoard, visitClock, visitLearnerLine, visitWhen } from "./adminSickBay";

const NOW = new Date(2026, 10, 7, 11, 30); // 7 Nov 2026, 11:30 on this device's clock

const schedule = (id: string, times: string[], over: Partial<MedicationSchedule> = {}): MedicationSchedule => ({
  id, tenant_id: "school-1", student_id: `st-${id}`, drug: "Amoxicillin", dose: "250mg", times, starts_on: "2026-11-01", ends_on: null,
  prescribed_by: "doctor", prescriber: null, notes: null, stopped_at: null, created_at: "2026-11-01T08:00:00Z",
  students: { full_name: `Learner ${id}`, admission_no: "1", classes: { name: "Form 1A" } }, ...over,
});
const dose = (scheduleId: string, time: string): MedicationDose => ({
  id: `d-${scheduleId}-${time}`, schedule_id: scheduleId, student_id: `st-${scheduleId}`, due_on: "2026-11-07", due_time: time, status: "given", recorded_at: "x", given_by: null, note: null,
});
const visit = (id: string, timeIn: string, over: Partial<SickBayVisit> = {}): SickBayVisit => ({
  id, tenant_id: "school-1", student_id: `st-${id}`, time_in: timeIn, complaint: "Headache", temperature_c: null, pulse_bpm: null, observations: null, assessment: null,
  treatment: null, outcome: null, referred_to: null, time_out: null, follow_up: null, attendance_mark: null, attendance_marked_at: null, logged_by: null, updated_at: "x", ...over,
});

beforeEach(() => {
  Object.values(readers).forEach((r) => r.mockReset());
  readers.fetchSchedules.mockResolvedValue([]);
  readers.fetchDoses.mockResolvedValue([]);
  readers.fetchOpenVisits.mockResolvedValue([]);
  readers.fetchVisits.mockResolvedValue([]);
});

describe("the sick bay, as one answer", () => {
  it("asks for today's medication and today's visits (from the start of the day, for a day), and everyone still in", async () => {
    await fetchSickBayBoard("school-1", NOW);
    expect(readers.fetchSchedules).toHaveBeenCalledWith("school-1", "2026-11-07", "2026-11-07");
    expect(readers.fetchDoses).toHaveBeenCalledWith("school-1", "2026-11-07", "2026-11-07");
    expect(readers.fetchOpenVisits).toHaveBeenCalledWith("school-1");
    const [, since, until] = readers.fetchVisits.mock.calls[0]!;
    expect(since).toEqual(new Date(2026, 10, 7, 0, 0));
    expect((until as Date).getTime() - (since as Date).getTime()).toBe(86_400_000);
  });

  it("flags doses more than an hour past their time with nothing recorded, and only those", async () => {
    // at 11:30: 08:00 is long past (overdue), 10:00 is 90 minutes past (overdue), 11:00 is 30 past (due, not overdue), 14:00 is to come
    readers.fetchSchedules.mockResolvedValue([schedule("a", ["08:00", "10:00", "11:00", "14:00"]), schedule("b", ["09:00"])]);
    readers.fetchDoses.mockResolvedValue([dose("a", "08:00")]);
    const board = await fetchSickBayBoard("school-1", NOW);
    expect(board.overdue.map((s) => `${s.schedule.id} ${s.time}`)).toEqual(["b 09:00", "a 10:00"]);
  });

  it("leaves out a schedule that has ended or been stopped", async () => {
    readers.fetchSchedules.mockResolvedValue([schedule("ended", ["08:00"], { ends_on: "2026-11-06" }), schedule("stopped", ["08:00"], { stopped_at: "2026-11-05T09:00:00" })]);
    expect((await fetchSickBayBoard("school-1", NOW)).overdue).toEqual([]);
  });

  it("lists who is still in the sick bay, longest first, and not those who have left", async () => {
    readers.fetchOpenVisits.mockResolvedValue([visit("late", "2026-11-07T10:00:00"), visit("early", "2026-11-06T15:00:00"), visit("left", "2026-11-07T09:00:00", { time_out: "2026-11-07T09:20:00" })]);
    expect((await fetchSickBayBoard("school-1", NOW)).open.map((v) => v.id)).toEqual(["early", "late"]);
  });

  it("gives today's visits as the database returned them (newest first)", async () => {
    readers.fetchVisits.mockResolvedValue([visit("v2", "2026-11-07T10:00:00"), visit("v1", "2026-11-07T08:00:00")]);
    expect((await fetchSickBayBoard("school-1", NOW)).today.map((v) => v.id)).toEqual(["v2", "v1"]);
  });

  it("says what a reader said when one of them fails, instead of an answer with a hole in it", async () => {
    readers.fetchOpenVisits.mockRejectedValue(new Error("permission denied for table sick_bay_visits"));
    await expect(fetchSickBayBoard("school-1", NOW)).rejects.toThrow("permission denied for table sick_bay_visits");
  });
});

describe("the times and the learner's line", () => {
  it("gives the time on this device's clock, with two digits each", () => {
    expect(visitClock(new Date(2026, 10, 7, 9, 5).toISOString())).toBe("09:05");
    expect(visitClock(new Date(2026, 10, 7, 14, 30).toISOString())).toBe("14:30");
  });

  it("gives the time alone for today, and the day with it for an earlier one", () => {
    expect(visitWhen(new Date(2026, 10, 7, 9, 5).toISOString(), NOW)).toBe("09:05");
    expect(visitWhen(new Date(2026, 10, 5, 15, 0).toISOString(), NOW)).toMatch(/^Thu,? 5 Nov,? 15:00$|^Thu 5 Nov, 15:00$|5 Nov.*15:00/);
  });

  it("says admission number and class, and nothing for a visit that names no learner", () => {
    expect(visitLearnerLine({ students: { full_name: "Ann", admission_no: "1042", classes: { name: "Form 1A" } } })).toBe("ADM 1042 · Form 1A");
    expect(visitLearnerLine({ students: { full_name: "Ann", admission_no: "1042", classes: null } })).toBe("ADM 1042");
    expect(visitLearnerLine({ students: null })).toBe("");
    expect(visitLearnerLine({})).toBe("");
  });
});
