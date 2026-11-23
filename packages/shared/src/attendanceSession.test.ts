import { describe, expect, it } from "vitest";
import {
  attendanceFigures, countAttendance, presentAmMissingPm, schoolClock, sessionAt, sessionsOffered,
  DEFAULT_ATTENDANCE_SETTINGS, QUEUE_CONFLICT_KEYS, REGISTER_TABLE, type SessionEntry,
} from "./index";

// 09:00 UTC = 12:00 Nairobi (UTC+3, no daylight saving)
const at = (iso: string) => new Date(iso);

describe("FIG-1514 session default (twin of attendance_session_at)", () => {
  it("is the morning before 12:00 school time and the afternoon from 12:00, when the school takes one", () => {
    expect(sessionAt(true, "Africa/Nairobi", at("2026-11-06T08:59:00Z"))).toBe("morning");   // 11:59
    expect(sessionAt(true, "Africa/Nairobi", at("2026-11-06T09:00:00Z"))).toBe("afternoon"); // 12:00
  });

  it("is always the morning when the school takes no afternoon register", () => {
    expect(sessionAt(false, "Africa/Nairobi", at("2026-11-06T09:00:00Z"))).toBe("morning");
    expect(sessionAt(false, "Africa/Nairobi", at("2026-11-06T15:00:00Z"))).toBe("morning");
  });

  it("uses the school's own time zone", () => {
    // 12:00 in Kampala is 09:00 UTC too; 12:00 in London (November, UTC+0) is 12:00 UTC
    expect(sessionAt(true, "Europe/London", at("2026-11-06T11:59:00Z"))).toBe("morning");
    expect(sessionAt(true, "Europe/London", at("2026-11-06T12:00:00Z"))).toBe("afternoon");
    expect(sessionAt(true, "Africa/Nairobi", at("2026-11-06T11:59:00Z"))).toBe("afternoon");
  });

  it("falls back to Nairobi when no time zone is given or the name is unknown", () => {
    expect(sessionAt(true, undefined, at("2026-11-06T09:00:00Z"))).toBe("afternoon");
    expect(schoolClock("Not/AZone", at("2026-11-06T09:00:00Z"))).toBe("12:00");
  });

  it("offers the afternoon only while the school takes it", () => {
    expect(sessionsOffered(DEFAULT_ATTENDANCE_SETTINGS)).toEqual(["morning"]);
    expect(sessionsOffered({ afternoon_enabled: true, percentage_mode: "session" })).toEqual(["morning", "afternoon"]);
  });

  it("keeps the morning register in the table installed phones write, and queues the afternoon on the same key", () => {
    expect(REGISTER_TABLE.morning).toBe("attendance");
    expect(REGISTER_TABLE.afternoon).toBe("attendance_afternoon");
    expect(QUEUE_CONFLICT_KEYS.attendance).toBe("student_id,taken_on");
    expect(QUEUE_CONFLICT_KEYS.attendance_afternoon).toBe("student_id,taken_on");
  });
});

const e = (student_id: string, taken_on: string, session: "morning" | "afternoon", mark: SessionEntry["mark"], class_id = "c1"): SessionEntry =>
  ({ student_id, taken_on, session, mark, class_id });

describe("FIG-1514 counting (twin of attendance_counted)", () => {
  const entries: SessionEntry[] = [
    e("a", "2026-11-02", "morning", "present"), e("a", "2026-11-02", "afternoon", "absent"),   // partial day
    e("a", "2026-11-03", "morning", "present"),                                               // morning only
    e("b", "2026-11-02", "morning", "absent"), e("b", "2026-11-02", "afternoon", "absent"),   // away all day
    e("b", "2026-11-03", "morning", "late"), e("b", "2026-11-03", "afternoon", "present"),
  ];

  it("by session: every entry is an opportunity, and a date with only a morning register counts once", () => {
    const f = attendanceFigures(countAttendance(entries, "session"));
    expect(f).toEqual({ here: 4, total: 7, pct: 57 });
  });

  it("by day: a learner-date counts once, present if present (or late) in either register", () => {
    const f = attendanceFigures(countAttendance(entries, "day"));
    // a 02 here, a 03 here, b 02 away, b 03 here
    expect(f).toEqual({ here: 3, total: 4, pct: 75 });
  });

  it("leaves an afternoon absence of a learner signed out early out of the figure, in both modes", () => {
    const signOuts = [{ student_id: "a", taken_on: "2026-11-02", voided_at: null }];
    expect(attendanceFigures(countAttendance(entries, "session", signOuts))).toEqual({ here: 4, total: 6, pct: 67 });
    expect(attendanceFigures(countAttendance(entries, "day", signOuts))).toEqual({ here: 3, total: 4, pct: 75 });
  });

  it("does not leave it out for a voided sign-out, nor leave out a morning absence", () => {
    const voided = [{ student_id: "a", taken_on: "2026-11-02", voided_at: "2026-11-02T10:00:00Z" }];
    expect(attendanceFigures(countAttendance(entries, "session", voided)).total).toBe(7);
    const bOut = [{ student_id: "b", taken_on: "2026-11-02", voided_at: null }];
    // b's afternoon absence goes; the morning absence stays
    expect(attendanceFigures(countAttendance(entries, "session", bOut))).toEqual({ here: 4, total: 6, pct: 67 });
  });

  it("leaves an excused afternoon of a signed-out learner out too (not an ordinary excusal)", () => {
    const x = [e("c", "2026-11-04", "morning", "present"), e("c", "2026-11-04", "afternoon", "excused")];
    expect(attendanceFigures(countAttendance(x, "session", [{ student_id: "c", taken_on: "2026-11-04", voided_at: null }]))).toEqual({ here: 1, total: 1, pct: 100 });
  });

  it("with no afternoon registers, both modes give the figure single registers always gave", () => {
    const am = entries.filter((x) => x.session === "morning");
    expect(attendanceFigures(countAttendance(am, "session"))).toEqual(attendanceFigures(countAttendance(am, "day")));
    expect(attendanceFigures(countAttendance(am, "session"))).toEqual({ here: 3, total: 4, pct: 75 });
  });

  it("by day takes the class of the morning entry", () => {
    const x = [e("d", "2026-11-05", "afternoon", "present", "pm-class"), e("d", "2026-11-05", "morning", "present", "am-class")];
    expect(countAttendance(x, "day")[0]!.class_id).toBe("am-class");
  });

  it("returns no percentage when there is nothing to count", () => {
    expect(attendanceFigures([])).toEqual({ here: 0, total: 0, pct: null });
  });
});

describe("FIG-1514 present in the morning, missing in the afternoon", () => {
  const entries: SessionEntry[] = [
    e("a", "2026-11-02", "morning", "present"), e("a", "2026-11-02", "afternoon", "absent"),
    e("b", "2026-11-02", "morning", "late"), e("b", "2026-11-02", "afternoon", "absent"),
    e("c", "2026-11-02", "morning", "absent"), e("c", "2026-11-02", "afternoon", "absent"),
    e("d", "2026-11-02", "morning", "present"), e("d", "2026-11-02", "afternoon", "excused"),
    e("f", "2026-11-02", "morning", "present"), e("f", "2026-11-02", "afternoon", "absent"),
  ];

  it("lists learners here in the morning and absent in the afternoon", () => {
    expect(presentAmMissingPm(entries).map((r) => r.student_id).sort()).toEqual(["a", "b", "f"]);
  });

  it("leaves out a live early sign-out, but not a voided one", () => {
    const out = presentAmMissingPm(entries, [
      { student_id: "a", taken_on: "2026-11-02", voided_at: null },
      { student_id: "f", taken_on: "2026-11-02", voided_at: "2026-11-02T11:00:00Z" },
    ]);
    expect(out.map((r) => r.student_id).sort()).toEqual(["b", "f"]);
  });
});
