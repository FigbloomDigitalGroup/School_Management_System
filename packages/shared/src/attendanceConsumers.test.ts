import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FIG-1514: the percentage consumers that read through the shared package are wired to both registers, the school's mode and the
 * early sign-outs, not just to countAttendance() in isolation (that is attendanceSession.test.ts).
 *
 *   - parent view, web and apps/mobile: loadParentData() -> attendancePct, absentDates
 *   - report cards: loadAttendance() -> buildReportCards()
 *   - AI comment drafting: learnerForAi() takes the report card's attendance
 *
 * One learner, s1, over three dates:
 *   d1  morning present, afternoon absent, a LIVE early sign-out   -> the afternoon absence is left out (decision K)
 *   d2  morning present, afternoon absent, no sign-out              -> counts as an absence
 *   d3  morning absent,  afternoon absent, a VOIDED sign-out        -> a voided sign-out excuses nothing
 * By session: 5 units counted (d1 PM out), 2 here -> 40%.  By day: 3 learner-days, d1 and d2 here -> 67%.
 * Morning register alone (what the screens showed before FIG-1514): 2 of 3 -> 67%; so session mode visibly reads both registers.
 */
type Call = { table: string; method: string; args: unknown[] };
const calls: Call[] = [];
let mode: "session" | "day" = "session";

const ROWS: Record<string, unknown[]> = {
  guardians: [{ students: { id: "s1", full_name: "Faith Achieng", admission_no: "A1", class_id: "c1", boarding: false, classes: { name: "Form 2", form_level: 2, level: "secondary" } } }],
  attendance: [
    { student_id: "s1", taken_on: "2026-10-01", mark: "present", class_id: "c1" },
    { student_id: "s1", taken_on: "2026-10-02", mark: "present", class_id: "c1" },
    { student_id: "s1", taken_on: "2026-10-03", mark: "absent", class_id: "c1" },
  ],
  attendance_afternoon: [
    { student_id: "s1", taken_on: "2026-10-01", mark: "absent", class_id: "c1" },
    { student_id: "s1", taken_on: "2026-10-02", mark: "absent", class_id: "c1" },
    { student_id: "s1", taken_on: "2026-10-03", mark: "absent", class_id: "c1" },
  ],
  early_sign_outs: [
    { student_id: "s1", taken_on: "2026-10-01", voided_at: null },
    { student_id: "s1", taken_on: "2026-10-03", voided_at: "2026-10-03T10:00:00Z" },
  ],
};

function builder(table: string) {
  const answer = { data: ROWS[table] ?? [], error: null };
  const proxy: unknown = new Proxy({}, {
    get(_t, method: string) {
      if (method === "then") return (resolve: (v: unknown) => unknown) => resolve(answer);
      if (method === "maybeSingle" || method === "single") {
        return () => Promise.resolve(
          table === "terms" ? { data: { id: "term-now", name: "Term 3, 2026" }, error: null }
          : table === "attendance_settings" ? { data: { afternoon_enabled: true, percentage_mode: mode }, error: null }
          : { data: null, error: null });
      }
      return (...args: unknown[]) => { calls.push({ table, method, args }); return proxy; };
    },
  });
  return proxy;
}

vi.mock("./supabase", () => ({
  supabase: () => ({
    from: (table: string) => builder(table),
    rpc: () => Promise.resolve({ data: [], error: null }),
  }),
}));

import { loadParentData } from "./parentData";
import { buildReportCards, loadAttendance } from "./reportCards";
import { learnerForAi } from "./ai";

beforeEach(() => { calls.length = 0; });

describe("parent view (web and apps/mobile share loadParentData)", () => {
  it("by session: both registers count, the afternoon absence of a learner signed out early is left out, a voided sign-out excuses nothing", async () => {
    mode = "session";
    const child = (await loadParentData("parent-1")).children[0]!;
    expect(child.attendancePct).toBe(40);
    // d1's afternoon absence is excused by the live sign-out; d2 (afternoon) and d3 (both) are absences
    expect(child.absentDates).toEqual(["2026-10-02", "2026-10-03"]);
    expect(calls.some((c) => c.table === "attendance_afternoon")).toBe(true);
    expect(calls.some((c) => c.table === "early_sign_outs")).toBe(true);
  });

  it("by day: a day counts once, here if here in either register", async () => {
    mode = "day";
    const child = (await loadParentData("parent-1")).children[0]!;
    expect(child.attendancePct).toBe(67);
    expect(child.absentDates).toEqual(["2026-10-02", "2026-10-03"]);
  });
});

describe("report cards and the AI attendance figure", () => {
  const card = (attendance: Map<string, { present: number; days: number }>) => buildReportCards({
    school: { name: "Alliance", county: null, country: "KE", logoUrl: null, accent: "#1B4D2E" },
    term: { name: "Term 3 2026", year: 2026, startsOn: "2026-09-01", endsOn: "2026-11-30" },
    className: "Form 2", classTeacher: null, scheme: "kcse",
    exams: [], learners: [{ id: "s1", name: "Faith Achieng", admissionNo: "A1" }], marks: [],
    attendance, fees: new Map(),
    options: { showPosition: false, showAttendance: true, showFees: false, showActivities: false, nextTermBegins: null },
    today: "2026-11-08",
  })[0]!;

  it("by session: the report card counts every register entry left after the sign-out rule, and the AI gets the same percentage", async () => {
    mode = "session";
    const att = await loadAttendance("tenant-1", ["s1"], "term-now");
    expect(att.get("s1")).toEqual({ present: 2, days: 5 });
    // the term filter reaches both registers
    expect(calls).toContainEqual({ table: "attendance", method: "eq", args: ["term_id", "term-now"] });
    expect(calls).toContainEqual({ table: "attendance_afternoon", method: "eq", args: ["term_id", "term-now"] });
    const c = card(att);
    expect(c.attendance).toEqual({ present: 2, days: 5 });
    expect(learnerForAi("card-1", c).attendancePct).toBe(40);
  });

  it("by day: one unit per learner-day, and the AI follows", async () => {
    mode = "day";
    const att = await loadAttendance("tenant-1", ["s1"], "term-now");
    expect(att.get("s1")).toEqual({ present: 2, days: 3 });
    expect(learnerForAi("card-1", card(att)).attendancePct).toBe(67);
  });
});
