import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A stand-in for the Supabase client with a few tables in memory. `eq` filters really filter, `order` and `limit`
 * really order and cut, so what the loaders ask for (this term, that day, active learners) changes what they find.
 */
type Row = Record<string, unknown>;
const db: { tables: Record<string, Row[]>; fees: { data: unknown[] | null; error: { message: string } | null }; insertError: { message: string } | null } = {
  tables: {}, fees: { data: [], error: null }, insertError: null,
};
const inserted: { table: string; row: Row }[] = [];

function builder(table: string) {
  const filters: [string, unknown][] = [];
  let sort: { col: string; ascending: boolean } | null = null;
  let cut: number | null = null;
  const rows = () => {
    let out = (db.tables[table] ?? []).filter((r) => filters.every(([col, value]) => !(col in r) || r[col] === value));
    if (sort) {
      const { col, ascending } = sort;
      out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (ascending ? 1 : -1));
    }
    return cut === null ? out : out.slice(0, cut);
  };
  const proxy: unknown = new Proxy({}, {
    get(_t, method: string) {
      if (method === "then") return (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null });
      if (method === "maybeSingle") return () => Promise.resolve({ data: rows()[0] ?? null, error: null });
      if (method === "insert") return (row: Row) => { inserted.push({ table, row }); return Promise.resolve({ error: db.insertError }); };
      return (...args: unknown[]) => {
        if (method === "eq") filters.push([String(args[0]), args[1]]);
        if (method === "order") sort = { col: String(args[0]), ascending: (args[1] as { ascending?: boolean } | undefined)?.ascending !== false };
        if (method === "limit") cut = Number(args[0]);
        return proxy;
      };
    },
  });
  return proxy;
}

vi.mock("./supabase", () => ({
  supabase: () => ({
    from: (table: string) => builder(table),
    rpc: (name: string) => Promise.resolve(name === "term_fee_totals" ? db.fees : { data: null, error: { message: `no ${name}` } }),
  }),
}));

import {
  awayFromRegister, classesWithoutRegister, feeCollectedPct, fetchClassRegister, fetchLatestRegisters, fetchSchoolOverview, needsYou,
  NO_FEES, overviewAttendanceRate, registerDayLabel, remindClassTeacher, type SchoolOverview,
} from "./adminOverview";

const TERM = { id: "term-3", tenant_id: "school-1", name: "Term 3, 2026", is_current: true };
const learners = (classId: string, n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `${classId}-${i}`, class_id: classId, tenant_id: "school-1", active: true, full_name: `Learner ${i}`, admission_no: String(i) }));
const mark = (classId: string, i: number, m: string, day: string): Row => ({ id: `${classId}-${i}-${day}`, tenant_id: "school-1", term_id: "term-3", class_id: classId, student_id: `${classId}-${i}`, taken_on: day, mark: m });

beforeEach(() => {
  inserted.length = 0;
  db.insertError = null;
  db.fees = { data: [{ billed: 1000, paid: 250, invoices: 4, nothing_paid: 1, part_paid: 2, full_paid: 1, owing: 3 }], error: null };
  db.tables = {
    terms: [TERM, { ...TERM, id: "term-2", name: "Term 2, 2026", is_current: false }],
    classes: [
      { id: "c1", tenant_id: "school-1", name: "Form 1A", class_teacher_id: "t1" },
      { id: "c2", tenant_id: "school-1", name: "Form 1B", class_teacher_id: null },
      { id: "c3", tenant_id: "school-1", name: "Form 2A", class_teacher_id: "t3" },
    ],
    students: [...learners("c1", 4), ...learners("c2", 3), ...learners("c3", 5), { id: "gone", class_id: "c1", tenant_id: "school-1", active: false }],
    profiles: [{ id: "a" }, { id: "b" }],
    attendance: [
      // the newest day is 5 Nov: Form 1A (one late, one absent) and Form 1B took it; Form 2A did not
      mark("c1", 0, "present", "2026-11-05"), mark("c1", 1, "present", "2026-11-05"), mark("c1", 2, "late", "2026-11-05"), mark("c1", 3, "absent", "2026-11-05"),
      mark("c2", 0, "present", "2026-11-05"), mark("c2", 1, "excused", "2026-11-05"), mark("c2", 2, "present", "2026-11-05"),
      // an older day, which must not be counted
      mark("c3", 0, "present", "2026-11-04"),
    ],
  };
});

describe("fetchSchoolOverview", () => {
  it("reads the current term's newest register day, counting a late arrival as here and an excusal as not", async () => {
    const o = await fetchSchoolOverview("school-1");
    expect(o.term?.name).toBe("Term 3, 2026");
    expect(o.attendanceDate).toBe("2026-11-05");
    expect(o.presentByClass.get("c1")).toBe(3);
    expect(o.lateByClass.get("c1")).toBe(1);
    expect(o.absentByClass.get("c1")).toBe(1);
    expect(o.presentByClass.get("c2")).toBe(2);
    expect([...o.submittedClasses].sort()).toEqual(["c1", "c2"]);
    expect(o.presentByClass.has("c3")).toBe(false);
  });

  it("counts active learners per class, staff, and takes the fee totals the database added up", async () => {
    const o = await fetchSchoolOverview("school-1");
    expect(o.activeStudents).toBe(12);
    expect(o.studentsByClass.get("c1")).toBe(4);
    expect(o.staffCount).toBe(2);
    expect(o.fees.billed).toBe(1000);
    expect(o.classes.map((c) => c.name)).toEqual(["Form 1A", "Form 1B", "Form 2A"]);
  });

  // The tests below stand in for the date only: the database mock above filters by day exactly as the real one does.
  async function atTime(iso: string, run: () => Promise<void>): Promise<void> {
    vi.useFakeTimers({ toFake: ["Date"] });
    try { vi.setSystemTime(new Date(iso)); await run(); } finally { vi.useRealTimers(); }
  }

  it("FIG-1401: asked for today, a day on which no class has taken a register reads as nothing taken, not as the last day that has one", async () => {
    await atTime("2026-11-06T09:00:00Z", async () => {
      // the newest register in the data is 5 Nov; today is 6 Nov
      const o = await fetchSchoolOverview("school-1", "today");
      expect(o.attendanceDate).toBe("2026-11-06");
      expect(o.submittedClasses.size).toBe(0);
      expect(o.presentByClass.size).toBe(0);
      expect(overviewAttendanceRate(o)).toBeNull();
      expect(classesWithoutRegister(o).map((c) => c.name)).toEqual(["Form 1A", "Form 1B", "Form 2A"]);
    });
  });

  it("FIG-1401: asked for today, the classes that did take today's register are counted as before", async () => {
    await atTime("2026-11-05T09:00:00Z", async () => {
      const o = await fetchSchoolOverview("school-1", "today");
      expect(o.attendanceDate).toBe("2026-11-05");
      expect([...o.submittedClasses].sort()).toEqual(["c1", "c2"]);
      expect(o.presentByClass.get("c1")).toBe(3);
      expect(classesWithoutRegister(o).map((c) => c.name)).toEqual(["Form 2A"]);
    });
  });

  it("FIG-1401: today is the school's own day, so at 00:30 in Nairobi it is already the next date, whatever the date is in UTC", async () => {
    await atTime("2026-11-05T21:30:00Z", async () => {
      const o = await fetchSchoolOverview("school-1", "today");
      expect(o.attendanceDate).toBe("2026-11-06");
      expect(o.submittedClasses.size).toBe(0);
    });
  });

  it("FIG-1401: the default is still the newest register day, which is what the phone shows with a note that names the day", async () => {
    await atTime("2026-11-09T09:00:00Z", async () => {
      const o = await fetchSchoolOverview("school-1");
      expect(o.attendanceDate).toBe("2026-11-05");
      expect(o.submittedClasses.size).toBe(2);
    });
  });

  it("FIG-1409: a learner archived after the register was taken is in neither number, and the class still has its register", async () => {
    const archived = (row: Row): Row => ({ ...row, students: { active: false } });
    db.tables.attendance = [
      mark("c1", 0, "present", "2026-11-05"),
      archived(mark("c1", 1, "present", "2026-11-05")),
      mark("c1", 2, "late", "2026-11-05"),
      archived(mark("c1", 3, "absent", "2026-11-05")),
      // a class whose only row is an archived learner's: its register is in, with nobody on the roll to count
      archived(mark("c2", 0, "present", "2026-11-05")),
    ];
    const o = await fetchSchoolOverview("school-1");
    expect(o.presentByClass.get("c1")).toBe(2); // the present one and the late one; the archived present learner is left out
    expect(o.lateByClass.get("c1")).toBe(1);
    expect(o.absentByClass.get("c1") ?? 0).toBe(0); // the archived absent learner is left out
    expect([...o.submittedClasses].sort()).toEqual(["c1", "c2"]);
    expect(o.presentByClass.get("c2") ?? 0).toBe(0);
  });

  it("has no register day and no fee totals when the school has no current term", async () => {
    db.tables.terms = [];
    const o = await fetchSchoolOverview("school-1");
    expect(o.term).toBeNull();
    expect(o.attendanceDate).toBeNull();
    expect(o.submittedClasses.size).toBe(0);
    expect(o.fees).toEqual(NO_FEES);
  });

  it("fails with the database's own message when the fee totals cannot be read, rather than showing zeros", async () => {
    db.fees = { data: null, error: { message: "permission denied for term_fee_totals" } };
    await expect(fetchSchoolOverview("school-1")).rejects.toThrow("permission denied for term_fee_totals");
  });
});

describe("what the overview says", () => {
  async function overview(): Promise<SchoolOverview> { return fetchSchoolOverview("school-1"); }

  it("gives the attendance rate across the classes that took a register only", async () => {
    // 3 + 2 here of 4 + 3 on the rolls of the two classes that took it; Form 2A's 5 learners are not in it
    expect(overviewAttendanceRate(await overview())).toBe(Math.round((5 / 7) * 100));
  });

  it("has no attendance rate when no class took a register", async () => {
    db.tables.attendance = [];
    expect(overviewAttendanceRate(await overview())).toBeNull();
  });

  it("rounds the share of billing paid, and is zero when nothing is billed", () => {
    expect(feeCollectedPct({ ...NO_FEES, billed: 3, paid: 1 })).toBe(33);
    expect(feeCollectedPct(NO_FEES)).toBe(0);
  });

  it("lists the classes that have not taken the register", async () => {
    expect(classesWithoutRegister(await overview()).map((c) => c.name)).toEqual(["Form 2A"]);
  });

  it("says what needs the principal: the missing register, then the fee balances", async () => {
    expect(needsYou(await overview())).toEqual([
      { title: "1 class has not taken attendance", body: "Form 2A for 2026-11-05." },
      { title: "Term 3, 2026 fee balances are outstanding", body: "3 learners still owe a balance this term." },
    ]);
  });

  it("says nothing needs them when every class has taken it and nobody owes", async () => {
    db.tables.attendance = (db.tables.classes ?? []).map((c) => mark(String(c.id), 0, "present", "2026-11-05"));
    db.fees = { data: [{ ...NO_FEES, owing: 0 }], error: null };
    expect(needsYou(await overview())).toEqual([]);
  });

  it("pluralises the classes and the learners", () => {
    const o = {
      term: null, classes: [{ id: "a", name: "A", class_teacher_id: null }, { id: "b", name: "B", class_teacher_id: null }],
      studentsByClass: new Map(), activeStudents: 0, staffCount: 0, fees: { ...NO_FEES, owing: 1 }, attendanceDate: null,
      presentByClass: new Map(), lateByClass: new Map(), absentByClass: new Map(), submittedClasses: new Set<string>(),
    } satisfies SchoolOverview;
    expect(needsYou(o)).toEqual([
      { title: "2 classes have not taken attendance", body: "A, B." },
      { title: "Fee balances are outstanding", body: "1 learner still owes a balance this term." },
    ]);
  });
});

describe("remindClassTeacher", () => {
  it("sends the class teacher an in-app announcement, from the person asking, and no one else", async () => {
    await remindClassTeacher("school-1", "admin-1", { name: "Form 1A", class_teacher_id: "t1" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.table).toBe("announcements");
    expect(inserted[0]?.row).toMatchObject({
      tenant_id: "school-1", author_id: "admin-1", audience: { kind: "user", user_id: "t1" }, channels: ["in_app"],
      subject: "Attendance not yet taken — Form 1A",
    });
  });

  it("sends nothing when the class has no teacher, and says so", async () => {
    await expect(remindClassTeacher("school-1", "admin-1", { name: "Form 1B", class_teacher_id: null })).rejects.toThrow("Form 1B has no class teacher assigned yet.");
    expect(inserted).toHaveLength(0);
  });

  it("fails with the database's message when the note cannot be sent", async () => {
    db.insertError = { message: "row-level security" };
    await expect(remindClassTeacher("school-1", "admin-1", { name: "Form 1A", class_teacher_id: "t1" })).rejects.toThrow("row-level security");
  });
});

describe("fetchClassRegister", () => {
  it("lists the class's active learners with their mark that day, and reads no mark as present", async () => {
    const rows = await fetchClassRegister("c1", "2026-11-05");
    expect(rows.map((r) => [r.name, r.mark])).toEqual([["Learner 0", "present"], ["Learner 1", "present"], ["Learner 2", "late"], ["Learner 3", "absent"]]);
    const other = await fetchClassRegister("c1", "2026-11-04");
    expect(other.every((r) => r.mark === "present")).toBe(true);
  });

  it("leaves off those who were here and on time", async () => {
    expect((await fetchClassRegister("c1", "2026-11-05").then(awayFromRegister)).map((r) => r.mark)).toEqual(["late", "absent"]);
  });
});

describe("fetchLatestRegisters", () => {
  it("finds the newest register day across the school and which classes took it", async () => {
    const r = await fetchLatestRegisters("school-1");
    expect(r.date).toBe("2026-11-05");
    expect([...r.taken].sort()).toEqual(["c1", "c2"]);
    expect(r.present.get("c1")).toBe(3);
    expect(r.learners.get("c3")).toBe(5);
  });

  it("has no date when no class has taken a register", async () => {
    db.tables.attendance = [];
    expect((await fetchLatestRegisters("school-1")).date).toBeNull();
  });
});

describe("registerDayLabel", () => {
  // 10:00 in Nairobi on Friday 6 Nov 2026
  const now = new Date("2026-11-06T07:00:00Z");
  it("says today and yesterday in words", () => {
    expect(registerDayLabel("2026-11-06", now)).toBe("today");
    expect(registerDayLabel("2026-11-05", now)).toBe("yesterday");
  });
  it("names an older day by weekday, day and month", () => {
    expect(registerDayLabel("2026-11-04", now)).toBe("Wed 4 Nov");
  });
  it("goes by the school's day, not the phone's: 01:00 on the 7th in Nairobi is still the 6th in UTC", () => {
    const lateNight = new Date("2026-11-06T22:00:00Z");
    expect(registerDayLabel("2026-11-07", lateNight)).toBe("today");
    expect(registerDayLabel("2026-11-07", lateNight, "UTC")).not.toBe("today");
  });
  it("hands back what it cannot read", () => {
    expect(registerDayLabel("not-a-date", now)).toBe("not-a-date");
  });
});
