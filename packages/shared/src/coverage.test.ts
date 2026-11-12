import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A stand-in for the Supabase client with the school's tables in memory. `eq`, `neq`, `in`, `not ... is null`, `lte` and `gte`
 * really filter, so who is on leave, which slots a day has and who is teaching what decide what the loaders find.
 */
type Row = Record<string, unknown>;
const db: { tables: Record<string, Row[]>; error: { table: string; message: string } | null } = { tables: {}, error: null };
const upserts: { table: string; row: Row }[] = [];
const inserts: { table: string; row: Row }[] = [];

function builder(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  const rows = () => (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const answer = () => (db.error?.table === table ? { data: null, error: { message: db.error.message } } : { data: rows(), error: null });
  const proxy: unknown = new Proxy({}, {
    get(_t, method: string) {
      if (method === "then") return (resolve: (v: unknown) => unknown) => resolve(answer());
      if (method === "maybeSingle") return () => Promise.resolve(db.error?.table === table ? { data: null, error: { message: db.error.message } } : { data: rows()[0] ?? null, error: null });
      if (method === "insert") return (row: Row) => { inserts.push({ table, row }); return Promise.resolve({ error: null }); };
      if (method === "upsert") return (row: Row) => { upserts.push({ table, row }); return Promise.resolve({ error: null }); };
      return (...args: unknown[]) => {
        const col = String(args[0]);
        if (method === "eq") filters.push((r) => r[col] === args[1]);
        if (method === "neq") filters.push((r) => r[col] !== args[1]);
        if (method === "in") filters.push((r) => (args[1] as unknown[]).includes(r[col]));
        if (method === "not") filters.push((r) => r[col] !== null && r[col] !== undefined);
        if (method === "lte") filters.push((r) => String(r[col]) <= String(args[1]));
        if (method === "gte") filters.push((r) => String(r[col]) >= String(args[1]));
        return proxy;
      };
    },
  });
  return proxy;
}

vi.mock("./supabase", () => ({ supabase: () => ({ from: (table: string) => builder(table) }) }));

import { assignCoverage, currentWeekDates, fetchCoverageForDate, fetchCoverageThisWeek } from "./coverage";

const T = "school-1";
const WED = "2026-11-04";

beforeEach(() => {
  upserts.length = 0;
  inserts.length = 0;
  db.error = null;
  db.tables = {
    // Ann (t-ann) is on approved leave on Wednesday 4 Nov; Bea (t-bea) is on leave that day too; a rejected request does not count
    leave_requests: [
      { tenant_id: T, teacher_id: "t-ann", status: "approved", starts_on: "2026-11-03", ends_on: "2026-11-05" },
      { tenant_id: T, teacher_id: "t-bea", status: "approved", starts_on: "2026-11-04", ends_on: "2026-11-04" },
      { tenant_id: T, teacher_id: "t-cy", status: "rejected", starts_on: "2026-11-04", ends_on: "2026-11-04" },
    ],
    timetable_slots: [
      // Wednesday: Ann teaches Maths to Form 1A at 10:00; Cy teaches Maths to Form 1B at the same time; Ann has an unlinked Games period
      { tenant_id: T, day: "Wed", class_id: "c1", start_time: "10:00", label: "Maths", subject_id: "math" },
      { tenant_id: T, day: "Wed", class_id: "c2", start_time: "10:00", label: "Maths", subject_id: "math" },
      { tenant_id: T, day: "Wed", class_id: "c1", start_time: "11:00", label: "Games", subject_id: null },
      // Friday: Ann teaches English to Form 1A at 09:00
      { tenant_id: T, day: "Fri", class_id: "c1", start_time: "09:00", label: "English", subject_id: "eng" },
    ],
    classes: [{ id: "c1", tenant_id: T, name: "Form 1A" }, { id: "c2", tenant_id: T, name: "Form 1B" }],
    subjects: [{ id: "math", tenant_id: T, name: "Mathematics" }, { id: "eng", tenant_id: T, name: "English" }],
    profiles: [
      { id: "t-ann", tenant_id: T, role: "teacher", full_name: "Ann Wanjiru" },
      { id: "t-bea", tenant_id: T, role: "teacher", full_name: "Bea Achieng" },
      { id: "t-cy", tenant_id: T, role: "teacher", full_name: "Cy Mwangi" },
      { id: "t-dan", tenant_id: T, role: "teacher", full_name: "Dan Otieno" },
    ],
    teaching_assignments: [
      { tenant_id: T, class_id: "c1", subject_id: "math", teacher_id: "t-ann" },
      { tenant_id: T, class_id: "c2", subject_id: "math", teacher_id: "t-cy" },
      { tenant_id: T, class_id: "c1", subject_id: "eng", teacher_id: "t-ann" },
    ],
    // everyone below specialises in Maths; Ann herself too
    teacher_subjects: ["t-ann", "t-bea", "t-cy", "t-dan"].map((t) => ({ tenant_id: T, subject_id: "math", teacher_id: t })),
    coverage_assignments: [],
  };
});

describe("currentWeekDates", () => {
  it("is Monday to Friday of the week that today is in", () => {
    expect(currentWeekDates(new Date("2026-11-04T09:00:00Z"))).toEqual({
      Mon: "2026-11-02", Tue: "2026-11-03", Wed: "2026-11-04", Thu: "2026-11-05", Fri: "2026-11-06",
    });
  });
  it("counts a weekend as the end of the week that has just finished", () => {
    expect(currentWeekDates(new Date("2026-11-08T09:00:00Z")).Mon).toBe("2026-11-02");
    expect(currentWeekDates(new Date("2026-11-07T09:00:00Z")).Fri).toBe("2026-11-06");
  });
  it("goes by the school's day, not the clock's: 01:00 on Monday 9 Nov in Nairobi is still Sunday 8 Nov in UTC", () => {
    const justAfterMidnight = new Date("2026-11-08T22:00:00Z");
    expect(currentWeekDates(justAfterMidnight).Mon).toBe("2026-11-09");
    expect(currentWeekDates(justAfterMidnight, "UTC").Mon).toBe("2026-11-02");
  });
});

describe("fetchCoverageForDate", () => {
  it("lists the periods whose teacher is on approved leave that day, and nothing else", async () => {
    const items = await fetchCoverageForDate(T, "Wed", WED);
    // Ann's Maths with Form 1A. Cy's Maths (Cy's request was rejected) and the unlinked Games period are not flagged.
    expect(items.map((i) => [i.className, i.subjectName, i.time, i.absentTeacherName])).toEqual([["Form 1A", "Mathematics", "10:00", "Ann Wanjiru"]]);
    expect(items[0]).toMatchObject({ date: WED, weekday: "Wed", classId: "c1", subjectId: "math", absentTeacherId: "t-ann", assignment: null });
  });

  it("offers as substitutes only teachers of the subject who are free: not the absent teacher, not someone also on leave, not someone teaching another class then", async () => {
    const [item] = await fetchCoverageForDate(T, "Wed", WED);
    // Bea is on leave, Cy teaches Form 1B at 10:00, Ann is the one away: only Dan is free
    expect(item?.substitutes).toEqual([{ id: "t-dan", name: "Dan Otieno" }]);
  });

  it("does not offer someone already asked to cover another class at that time", async () => {
    db.tables.coverage_assignments = [{ tenant_id: T, date: WED, class_id: "c2", start_time: "10:00", covering_teacher_id: "t-dan", assigned_at: "2026-11-03T08:00:00Z" }];
    const [item] = await fetchCoverageForDate(T, "Wed", WED);
    expect(item?.substitutes).toEqual([]);
  });

  it("shows what was already decided: who covers, or that it runs free", async () => {
    db.tables.coverage_assignments = [{ tenant_id: T, date: WED, class_id: "c1", start_time: "10:00", covering_teacher_id: "t-dan", assigned_at: "2026-11-03T08:00:00Z" }];
    expect((await fetchCoverageForDate(T, "Wed", WED))[0]?.assignment).toEqual({ coveringTeacherId: "t-dan", coveringTeacherName: "Dan Otieno", assignedAt: "2026-11-03T08:00:00Z" });
    db.tables.coverage_assignments = [{ tenant_id: T, date: WED, class_id: "c1", start_time: "10:00", covering_teacher_id: null, assigned_at: "2026-11-03T08:00:00Z" }];
    expect((await fetchCoverageForDate(T, "Wed", WED))[0]?.assignment).toMatchObject({ coveringTeacherId: null, coveringTeacherName: null });
  });

  it("finds nothing when nobody is on leave that day", async () => {
    expect(await fetchCoverageForDate(T, "Wed", "2026-11-10")).toEqual([]);
  });

  it("fails with the database's own message when a table cannot be read", async () => {
    db.error = { table: "timetable_slots", message: "permission denied for table timetable_slots" };
    await expect(fetchCoverageForDate(T, "Wed", WED)).rejects.toThrow("permission denied for table timetable_slots");
  });
});

describe("fetchCoverageThisWeek", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-04T09:00:00Z")); });
  afterEach(() => vi.useRealTimers());

  it("looks at every day of this week, so leave for a day later in the week shows up now, in date order", async () => {
    const items = await fetchCoverageThisWeek(T);
    // Ann is on leave Tue to Thu: only her Wednesday Maths is on the timetable then (her Friday English is the day after her leave ends)
    expect(items.map((i) => `${i.date} ${i.time} ${i.subjectName}`)).toEqual(["2026-11-04 10:00 Mathematics"]);
    db.tables.leave_requests = [{ tenant_id: T, teacher_id: "t-ann", status: "approved", starts_on: "2026-11-04", ends_on: "2026-11-06" }];
    const later = await fetchCoverageThisWeek(T);
    expect(later.map((i) => `${i.date} ${i.time} ${i.subjectName}`)).toEqual(["2026-11-04 10:00 Mathematics", "2026-11-06 09:00 English"]);
  });
});

describe("assignCoverage", () => {
  const item = { date: WED, classId: "c1", className: "Form 1A", subjectId: "math", subjectName: "Mathematics", time: "10:00", absentTeacherId: "t-ann" };

  it("records the substitute for that exact period and tells them in the app", async () => {
    await assignCoverage({ tenantId: T, assignedBy: "admin-1", item, coveringTeacherId: "t-dan" });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.row).toMatchObject({
      tenant_id: T, date: WED, class_id: "c1", subject_id: "math", start_time: "10:00", absent_teacher_id: "t-ann", covering_teacher_id: "t-dan", assigned_by: "admin-1",
    });
    expect(inserts.map((i) => [i.table, i.row.subject, (i.row.audience as { user_id: string }).user_id])).toEqual([["announcements", "Covering Mathematics — Form 1A", "t-dan"]]);
  });

  it("marks a period free without telling anyone, when nobody had it before", async () => {
    await assignCoverage({ tenantId: T, assignedBy: "admin-1", item, coveringTeacherId: null });
    expect(upserts[0]?.row).toMatchObject({ covering_teacher_id: null });
    expect(inserts).toEqual([]);
  });

  it("tells the one who had it before when it is given to someone else, and when it is taken away", async () => {
    db.tables.coverage_assignments = [{ tenant_id: T, date: WED, class_id: "c1", start_time: "10:00", covering_teacher_id: "t-bea" }];
    await assignCoverage({ tenantId: T, assignedBy: "admin-1", item, coveringTeacherId: "t-dan" });
    expect(inserts.map((i) => (i.row.audience as { user_id: string }).user_id)).toEqual(["t-dan", "t-bea"]);
    expect(inserts[1]?.row.body).toContain("given to someone else");

    inserts.length = 0;
    await assignCoverage({ tenantId: T, assignedBy: "admin-1", item, coveringTeacherId: null });
    expect(inserts.map((i) => (i.row.audience as { user_id: string }).user_id)).toEqual(["t-bea"]);
    expect(inserts[0]?.row.body).toContain("free period");
  });

  it("does not tell the same person twice when the choice has not changed", async () => {
    db.tables.coverage_assignments = [{ tenant_id: T, date: WED, class_id: "c1", start_time: "10:00", covering_teacher_id: "t-dan" }];
    await assignCoverage({ tenantId: T, assignedBy: "admin-1", item, coveringTeacherId: "t-dan" });
    expect(inserts.map((i) => i.row.subject)).toEqual(["Covering Mathematics — Form 1A"]);
  });

  it("refuses a teacher who is teaching another class at that time, and writes nothing", async () => {
    await expect(assignCoverage({ tenantId: T, assignedBy: "admin-1", item, coveringTeacherId: "t-cy" }))
      .rejects.toThrow("That teacher is teaching another class at that time. Choose someone who is free.");
    expect(upserts).toEqual([]);
    expect(inserts).toEqual([]);
  });
});
