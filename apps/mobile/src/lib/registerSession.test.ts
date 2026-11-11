import { newRegister } from "@figbloom/shared";
import { defaultSession, queuedRegister, registerInTitle, sessionChoices, validSession } from "./registerSession";

const off = { afternoon_enabled: false, percentage_mode: "session" as const };
const on = { afternoon_enabled: true, percentage_mode: "session" as const };
// 2026-11-06 in Nairobi (UTC+3): 08:00 and 14:00.
const am = new Date("2026-11-06T05:00:00Z");
const pm = new Date("2026-11-06T11:00:00Z");

describe("defaultSession", () => {
  it("is the morning whenever the afternoon is off", () => {
    expect(defaultSession(off, "Africa/Nairobi", pm)).toBe("morning");
  });
  it("follows the school clock when the afternoon is on", () => {
    expect(defaultSession(on, "Africa/Nairobi", am)).toBe("morning");
    expect(defaultSession(on, "Africa/Nairobi", pm)).toBe("afternoon");
  });
});

describe("sessionChoices / validSession", () => {
  it("shows no switch without the afternoon, a Morning/Afternoon switch with it", () => {
    expect(sessionChoices(off)).toEqual([]);
    expect(sessionChoices(on).map((c) => c.name)).toEqual(["Morning", "Afternoon"]);
  });
  it("falls back to morning when the afternoon is not offered", () => {
    expect(validSession("afternoon", off)).toBe("morning");
    expect(validSession("afternoon", on)).toBe("afternoon");
  });
});

describe("queuedRegister", () => {
  const reg = newRegister("c1", "t1", ["s1", "s2"], "2026-11-06");
  it("queues the morning as exactly 'attendance' and the afternoon as 'attendance_afternoon', same rows", () => {
    const a = queuedRegister(reg, "tn", "tch", "morning");
    const b = queuedRegister(reg, "tn", "tch", "afternoon");
    expect(a.table).toBe("attendance");
    expect(b.table).toBe("attendance_afternoon");
    const strip = (rows: Record<string, unknown>[]) => rows.map(({ marked_at: _m, ...r }) => r);
    expect(strip(a.rows)).toEqual(strip(b.rows));
    expect(Object.keys(a.rows[0]!).sort()).toEqual(
      ["class_id", "marked_at", "mark", "note", "taken_by", "taken_on", "tenant_id", "student_id", "term_id"].sort(),
    );
  });
});

describe("registerInTitle", () => {
  it("keeps the old title when only the morning is taken", () => {
    expect(registerInTitle("Form 1A", "morning", off)).toBe("Form 1A register is in");
  });
  it("names the session when both are taken", () => {
    expect(registerInTitle("Form 1A", "afternoon", on)).toBe("Afternoon register is in · Form 1A");
  });
});
