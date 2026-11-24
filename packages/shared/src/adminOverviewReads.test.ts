import { afterEach, describe, expect, it, vi } from "vitest";
import * as client from "./supabase";
import {
  fetchClassAttendanceDetail, fetchOverviewBasics, fetchRegisterDays, fetchSchoolOverview, fetchTermReport, NO_FEES,
} from "./adminOverview";

/** One request the code made: the table (or function) and every builder call chained on it, in order. */
interface Call {
  table?: string;
  rpc?: string;
  rpcArgs?: unknown;
  ops: [string, unknown[]][];
}

interface Answer { data?: unknown; error?: unknown }

/** Every `.eq("column", value)` filter on a call, as one object. */
const eqs = (call: Call) => Object.fromEntries(call.ops.filter(([op]) => op === "eq").map(([, args]) => [args[0] as string, args[1]]));
const op = (call: Call, name: string) => call.ops.find(([o]) => o === name)?.[1];

/**
 * A stand-in Supabase client. Any chain (`from(t).select(...).eq(...).order(...)`, `.maybeSingle()`, a bare await) is
 * recorded and answered by `answer`; a request nobody answers reads as no rows and no error.
 */
function fake(answer: (call: Call) => Answer | undefined = () => undefined) {
  const calls: Call[] = [];

  function chain(call: Call): unknown {
    return new Proxy({}, {
      get(_target, prop: string) {
        if (prop === "then") {
          return (resolve: (a: Answer) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(answer(call) ?? { data: null, error: null }).then(resolve, reject);
        }
        return (...args: unknown[]) => { call.ops.push([prop, args]); return chain(call); };
      },
    });
  }

  const sb = {
    from: (table: string) => { const call: Call = { table, ops: [] }; calls.push(call); return chain(call); },
    rpc: (fn: string, args: unknown) => { const call: Call = { rpc: fn, rpcArgs: args, ops: [] }; calls.push(call); return chain(call); },
  };
  vi.spyOn(client, "supabase").mockReturnValue(sb as unknown as ReturnType<typeof client.supabase>);
  return { calls, on: (table: string) => calls.filter((c) => c.table === table), rpcs: (fn: string) => calls.filter((c) => c.rpc === fn) };
}

afterEach(() => vi.restoreAllMocks());

const REFUSED = Object.assign(new Error("permission denied for table classes"), { code: "42501" });

const TERM = { id: "term-3", tenant_id: "t1", name: "Term 3, 2026", is_current: true };
const FEES = { billed: 1000, paid: 250, invoices: 4, nothing_paid: 1, part_paid: 2, full_paid: 1, owing: 3 };

// ---------------------------------------------------------------- fetchOverviewBasics

describe("fetchOverviewBasics", () => {
  const answers = (c: Call): Answer | undefined =>
    c.table === "terms" ? { data: TERM }
    : c.table === "classes" ? { data: [{ id: "c1", name: "Form 1 East", class_teacher_id: "p1" }] }
    : c.table === "students" ? { data: [{ id: "s1", class_id: "c1" }, { id: "s2", class_id: "c1" }] }
    : c.table === "profiles" ? { data: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] }
    : c.rpc === "term_fee_totals" ? { data: [FEES] }
    : undefined;

  it("reads the current term, the classes, the active learners, the staff and the term's fee totals, each for the school", async () => {
    const sb = fake(answers);
    const basics = await fetchOverviewBasics("t1");
    expect(basics).toEqual({
      term: TERM,
      classes: [{ id: "c1", name: "Form 1 East", class_teacher_id: "p1" }],
      students: [{ id: "s1", class_id: "c1" }, { id: "s2", class_id: "c1" }],
      staffCount: 3,
      fees: FEES,
    });

    expect(eqs(sb.on("terms")[0]!)).toEqual({ tenant_id: "t1", is_current: true });
    const classes = sb.on("classes")[0]!;
    expect(op(classes, "select")).toEqual(["id,name,class_teacher_id"]);
    expect(eqs(classes)).toEqual({ tenant_id: "t1" });
    expect(op(classes, "order")).toEqual(["name"]);
    const students = sb.on("students")[0]!;
    expect(eqs(students)).toEqual({ tenant_id: "t1", active: true });
    expect(op(students, "range")).toEqual([0, 999]);
    const staff = sb.on("profiles")[0]!;
    expect(eqs(staff)).toEqual({ tenant_id: "t1" });
    expect(op(staff, "in")).toEqual(["role", ["school_admin", "teacher"]]);
    expect(sb.rpcs("term_fee_totals")[0]!.rpcArgs).toEqual({ p_tenant_id: "t1", p_term_id: "term-3" });
  });

  it("with no current term, reads no fee totals and answers the empty ones", async () => {
    const sb = fake((c) => (c.table === "terms" ? { data: null } : answers(c)));
    const basics = await fetchOverviewBasics("t1");
    expect(basics.term).toBeNull();
    expect(basics.fees).toBe(NO_FEES);
    expect(sb.rpcs("term_fee_totals")).toHaveLength(0);
  });

  it("answers the empty fee totals when the database returns none", async () => {
    fake((c) => (c.rpc === "term_fee_totals" ? { data: [] } : answers(c)));
    expect((await fetchOverviewBasics("t1")).fees).toBe(NO_FEES);
  });

  it("throws the fee totals' message (as a plain Error) when they cannot be read", async () => {
    fake((c) => (c.rpc === "term_fee_totals" ? { data: null, error: REFUSED } : answers(c)));
    const err = await fetchOverviewBasics("t1").catch((e: unknown) => e);
    expect(err).not.toBe(REFUSED);
    expect(err).toEqual(new Error("permission denied for table classes"));
  });

  it("reads a failed term, classes, learners or staff read as nothing, and does not throw", async () => {
    fake((c) => (c.table === "terms" ? undefined : { data: null, error: REFUSED }));
    expect(await fetchOverviewBasics("t1")).toEqual({ term: null, classes: [], students: [], staffCount: 0, fees: NO_FEES });
  });

  it("fetchSchoolOverview (the phone's) still starts from the same reads and counts the same learners", async () => {
    fake((c) =>
      c.table === "attendance" ? { data: [] }
      : answers(c));
    const o = await fetchSchoolOverview("t1");
    expect(o.term).toEqual(TERM);
    expect(o.activeStudents).toBe(2);
    expect(o.staffCount).toBe(3);
    expect(o.fees).toEqual(FEES);
    expect(o.studentsByClass.get("c1")).toBe(2);
    expect(o.classes).toEqual([{ id: "c1", name: "Form 1 East", class_teacher_id: "p1" }]);
  });
});

// ---------------------------------------------------------------- fetchRegisterDays

describe("fetchRegisterDays", () => {
  const answers = (c: Call): Answer | undefined =>
    c.table === "classes" ? { data: [{ id: "c1", name: "Form 1 East" }] }
    : c.table === "attendance" ? { data: [{ taken_on: "2026-11-20" }] }
    : c.table === "attendance_afternoon" ? { data: [{ taken_on: "2026-11-19" }] }
    : c.table === "attendance_settings" ? { data: { afternoon_enabled: true, percentage_mode: "day" } }
    : undefined;

  it("reads the classes, the newest day of each register and the school's settings", async () => {
    const sb = fake(answers);
    expect(await fetchRegisterDays("t1")).toEqual({
      classes: [{ id: "c1", name: "Form 1 East" }],
      latestMorning: "2026-11-20",
      latestAfternoon: "2026-11-19",
      settings: { afternoon_enabled: true, percentage_mode: "day" },
    });
    const classes = sb.on("classes")[0]!;
    expect(op(classes, "select")).toEqual(["id,name"]);
    expect(eqs(classes)).toEqual({ tenant_id: "t1" });
    expect(op(classes, "order")).toEqual(["name"]);
    for (const table of ["attendance", "attendance_afternoon"]) {
      const c = sb.on(table)[0]!;
      expect(op(c, "select")).toEqual(["taken_on"]);
      expect(eqs(c)).toEqual({ tenant_id: "t1" });
      expect(op(c, "order")).toEqual(["taken_on", { ascending: false }]);
      expect(op(c, "limit")).toEqual([1]);
    }
    expect(eqs(sb.on("attendance_settings")[0]!)).toEqual({ tenant_id: "t1" });
  });

  it("answers null dates when no register has been taken", async () => {
    fake((c) => (c.table === "attendance" || c.table === "attendance_afternoon" ? { data: [] } : answers(c)));
    const days = await fetchRegisterDays("t1");
    expect(days.latestMorning).toBeNull();
    expect(days.latestAfternoon).toBeNull();
  });

  it("a failed afternoon read reads as no afternoon register and never hides the morning's", async () => {
    fake((c) => (c.table === "attendance_afternoon" ? { data: null, error: REFUSED } : answers(c)));
    const days = await fetchRegisterDays("t1");
    expect(days.latestAfternoon).toBeNull();
    expect(days.latestMorning).toBe("2026-11-20");
  });

  it("throws the classes' or the morning register's message (as a plain Error)", async () => {
    for (const table of ["classes", "attendance"]) {
      fake((c) => (c.table === table ? { data: null, error: REFUSED } : answers(c)));
      const err = await fetchRegisterDays("t1").catch((e: unknown) => e);
      expect(err).not.toBe(REFUSED);
      expect(err).toEqual(new Error("permission denied for table classes"));
    }
  });

  it("answers no classes, not null, when there are none", async () => {
    fake((c) => (c.table === "classes" ? { data: null } : answers(c)));
    expect((await fetchRegisterDays("t1")).classes).toEqual([]);
  });
});

// ---------------------------------------------------------------- fetchClassAttendanceDetail

describe("fetchClassAttendanceDetail", () => {
  const students = [{ id: "s1", full_name: "Amina Otieno", admission_no: "4101" }, { id: "s2", full_name: "Brian Kamau", admission_no: "4102" }];
  const SIGN_OUT = {
    id: "so1", tenant_id: "t1", student_id: "s2", class_id: "c1", student_name: "Brian Kamau", class_name: "Form 1 East", taken_on: "2026-11-20",
    signed_out_at: "2026-11-20T10:00:00Z", signed_out_local: "13:00:00", reason: "Clinic", collected_by_name: "Mum", collected_by_relationship: "mother",
    recorded_by: "p1", recorded_at: "2026-11-20T10:00:00Z", voided_at: null,
  };
  const COLLECTOR = { sign_out_id: "so1", id_number: "12345678", phone: "0712000000", authorised_by: "Principal", note: null, void_reason: null };

  const answers = (c: Call): Answer | undefined =>
    c.table === "students" ? { data: students }
    : c.table === "attendance" ? { data: [{ student_id: "s1", mark: "late" }] }
    : c.table === "classes" ? { data: { class_teacher_id: "p9" } }
    : c.table === "attendance_settings" ? { data: { afternoon_enabled: false, percentage_mode: "session" } }
    : c.table === "attendance_afternoon" ? { data: [] }
    : c.table === "early_sign_outs" ? { data: [SIGN_OUT] }
    : c.table === "early_sign_out_collectors" ? { data: [COLLECTOR] }
    : undefined;

  it("reads the class's active learners, its morning register for the day, its teacher, and who left early", async () => {
    const sb = fake(answers);
    const d = await fetchClassAttendanceDetail("c1", "2026-11-20", "t1");
    expect(d.rows).toEqual([
      { id: "s1", name: "Amina Otieno", admissionNo: "4101", mark: "late", pmMark: null },
      { id: "s2", name: "Brian Kamau", admissionNo: "4102", mark: "present", pmMark: null },
    ]);
    expect(d.classTeacherId).toBe("p9");
    expect(d.signOuts).toEqual([SIGN_OUT]);
    expect(d.details).toEqual(new Map([["so1", COLLECTOR]]));
    expect(d.showPm).toBe(false);
    expect(d.pmTaken).toBe(false);

    const roster = sb.on("students")[0]!;
    expect(op(roster, "select")).toEqual(["id, full_name, admission_no"]);
    expect(eqs(roster)).toEqual({ class_id: "c1", active: true });
    expect(op(roster, "order")).toEqual(["full_name"]);
    const am = sb.on("attendance")[0]!;
    expect(op(am, "select")).toEqual(["student_id, mark"]);
    expect(eqs(am)).toEqual({ class_id: "c1", taken_on: "2026-11-20" });
    expect(eqs(sb.on("classes")[0]!)).toEqual({ id: "c1" });
    expect(op(sb.on("classes")[0]!, "select")).toEqual(["class_teacher_id"]);
    const so = sb.on("early_sign_outs")[0]!;
    expect(op(so, "in")).toEqual(["student_id", ["s1", "s2"]]);
    expect(eqs(so)).toEqual({ taken_on: "2026-11-20" });
    expect(op(sb.on("early_sign_out_collectors")[0]!, "in")).toEqual(["sign_out_id", ["so1"]]);
    expect(eqs(sb.on("attendance_settings")[0]!)).toEqual({ tenant_id: "t1" });
  });

  it("shows the afternoon column while the school takes an afternoon register, with each learner's mark (present when none is on file)", async () => {
    const sb = fake((c) =>
      c.table === "attendance_settings" ? { data: { afternoon_enabled: true, percentage_mode: "session" } }
      : c.table === "attendance_afternoon" ? { data: [{ student_id: "s1", mark: "absent" }] }
      : answers(c));
    const d = await fetchClassAttendanceDetail("c1", "2026-11-20", "t1");
    expect(d.showPm).toBe(true);
    expect(d.pmTaken).toBe(true);
    expect(d.rows.map((r) => r.pmMark)).toEqual(["absent", "present"]);
    const pm = sb.on("attendance_afternoon")[0]!;
    expect(eqs(pm)).toEqual({ class_id: "c1", taken_on: "2026-11-20" });
    expect(op(pm, "select")).toEqual(["student_id, mark"]);
  });

  it("keeps showing the afternoon column when the class has one for the day even though the school has turned the afternoon off", async () => {
    fake((c) => (c.table === "attendance_afternoon" ? { data: [{ student_id: "s2", mark: "late" }] } : answers(c)));
    const d = await fetchClassAttendanceDetail("c1", "2026-11-20", "t1");
    expect(d.showPm).toBe(true);
    expect(d.rows.map((r) => r.pmMark)).toEqual(["present", "late"]);
  });

  it("shows no afternoon marks when the school takes an afternoon register but this class has not taken it", async () => {
    fake((c) => (c.table === "attendance_settings" ? { data: { afternoon_enabled: true, percentage_mode: "session" } } : answers(c)));
    const d = await fetchClassAttendanceDetail("c1", "2026-11-20", "t1");
    expect(d.showPm).toBe(true);
    expect(d.pmTaken).toBe(false);
    expect(d.rows.every((r) => r.pmMark === null)).toBe(true);
  });

  it("a failed afternoon, sign-out or collector read never hides the morning register", async () => {
    fake((c) =>
      c.table === "attendance_afternoon" || c.table === "early_sign_outs" || c.table === "early_sign_out_collectors" ? { data: null, error: REFUSED }
      : answers(c));
    const d = await fetchClassAttendanceDetail("c1", "2026-11-20", "t1");
    expect(d.rows).toHaveLength(2);
    expect(d.pmTaken).toBe(false);
    expect(d.signOuts).toEqual([]);
    expect(d.details).toEqual(new Map());
  });

  it("a failed collector read alone keeps the sign-outs", async () => {
    fake((c) => (c.table === "early_sign_out_collectors" ? { data: null, error: REFUSED } : answers(c)));
    const d = await fetchClassAttendanceDetail("c1", "2026-11-20", "t1");
    expect(d.signOuts).toEqual([SIGN_OUT]);
    expect(d.details).toEqual(new Map());
  });

  it("lists the voided sign-outs after the live ones", async () => {
    const voided = { ...SIGN_OUT, id: "so0", signed_out_at: "2026-11-20T08:00:00Z", voided_at: "2026-11-20T09:00:00Z" };
    fake((c) => (c.table === "early_sign_outs" ? { data: [voided, SIGN_OUT] } : answers(c)));
    expect((await fetchClassAttendanceDetail("c1", "2026-11-20", "t1")).signOuts.map((s) => s.id)).toEqual(["so1", "so0"]);
  });

  it("reads no sign-outs and no collectors for a class with no learners", async () => {
    const sb = fake((c) => (c.table === "students" ? { data: [] } : answers(c)));
    const d = await fetchClassAttendanceDetail("c1", "2026-11-20", "t1");
    expect(d.rows).toEqual([]);
    expect(sb.on("early_sign_outs")).toHaveLength(0);
    expect(sb.on("early_sign_out_collectors")).toHaveLength(0);
  });

  it("answers no class teacher when the class cannot be read", async () => {
    fake((c) => (c.table === "classes" ? { data: null } : answers(c)));
    expect((await fetchClassAttendanceDetail("c1", "2026-11-20", "t1")).classTeacherId).toBeNull();
  });

  it("throws the database's message (as a plain Error) when the roll, the morning register or the class cannot be read", async () => {
    for (const table of ["students", "attendance", "classes"]) {
      fake((c) => (c.table === table ? { data: null, error: REFUSED } : answers(c)));
      const err = await fetchClassAttendanceDetail("c1", "2026-11-20", "t1").catch((e: unknown) => e);
      expect(err).not.toBe(REFUSED);
      expect(err).toEqual(new Error("permission denied for table classes"));
    }
  });
});

// ---------------------------------------------------------------- fetchTermReport

describe("fetchTermReport", () => {
  const CLASSES = [
    { id: "c1", name: "Grade 7 East", form_level: 7, level: "junior_secondary" },
    { id: "c2", name: "Form 2 West", form_level: 2, level: "secondary" },
    { id: "c3", name: "Form 1 East", form_level: 1, level: "secondary" },
  ];
  const EXAM = { id: "exam-1", tenant_id: "t1", term_id: "term-3", name: "Mock 1", published_at: "2026-11-10T00:00:00Z" };
  const FIGURES = [
    { class_id: "c1", roster: 40, att_here: 380, att_total: 400, billed: 1000, paid: 400, mark_sum: 3030, mark_count: 50, learners_marked: 38 },
    { class_id: "c2", roster: 30, att_here: 0, att_total: 0, billed: 500, paid: 500, mark_sum: 0, mark_count: 0, learners_marked: 0 },
  ];
  const answers = (c: Call): Answer | undefined =>
    c.table === "terms" ? { data: TERM }
    : c.table === "classes" ? { data: CLASSES }
    : c.table === "exams" ? { data: [EXAM] }
    : c.rpc === "term_class_figures" ? { data: FIGURES }
    : c.table === "attendance_settings" ? { data: { afternoon_enabled: false, percentage_mode: "day" } }
    : undefined;

  it("adds each class's term up from the database's figures: attendance, fees and the latest exam's mean", async () => {
    const sb = fake(answers);
    const r = await fetchTermReport("t1", "KE");
    expect(r.term).toEqual(TERM);
    expect(r.percentageMode).toBe("day");
    expect(r.classes).toEqual(CLASSES);
    expect(r.latestExam).toEqual(EXAM);
    expect(r.attendanceByClass).toEqual(new Map([["c1", { present: 380, total: 400 }], ["c2", { present: 0, total: 0 }], ["c3", { present: 0, total: 0 }]]));
    expect(r.attendanceOverall).toEqual({ present: 380, total: 400 });
    expect(r.feeByClass).toEqual(new Map([["c1", { billed: 1000, paid: 400 }], ["c2", { billed: 500, paid: 500 }], ["c3", { billed: 0, paid: 0 }]]));
    expect(r.feeOverall).toEqual({ billed: 1500, paid: 900 });
    // 3030 / 50 = 60.6, rounded (not cut off); only a class with marks has a mean
    expect([...r.meanByClass.keys()]).toEqual(["c1"]);
    expect(r.meanByClass.get("c1")).toEqual({ mean: 61, marked: 38, roster: 40, scheme: "cbc" });

    expect(eqs(sb.on("terms")[0]!)).toEqual({ tenant_id: "t1", is_current: true });
    const classes = sb.on("classes")[0]!;
    expect(op(classes, "select")).toEqual(["id,name,form_level,level"]);
    expect(eqs(classes)).toEqual({ tenant_id: "t1" });
    expect(classes.ops.filter(([o]) => o === "order").map(([, a]) => a)).toEqual([["form_level"], ["name"]]);
    const exams = sb.on("exams")[0]!;
    expect(eqs(exams)).toEqual({ tenant_id: "t1", term_id: "term-3" });
    expect(op(exams, "not")).toEqual(["published_at", "is", null]);
    expect(op(exams, "order")).toEqual(["published_at", { ascending: false }]);
    expect(op(exams, "limit")).toEqual([1]);
    expect(sb.rpcs("term_class_figures")[0]!.rpcArgs).toEqual({ p_tenant_id: "t1", p_term_id: "term-3", p_exam_id: "exam-1" });
    expect(eqs(sb.on("attendance_settings")[0]!)).toEqual({ tenant_id: "t1" });
  });

  it("picks each class's grading scheme from the school's country and the class's level", async () => {
    fake((c) => (c.rpc === "term_class_figures" ? { data: [{ ...FIGURES[0]!, class_id: "c2" }] } : answers(c)));
    expect((await fetchTermReport("t1", "KE")).meanByClass.get("c2")!.scheme).toBe("kcse");
    fake(answers);
    // a country with no scheme of its own falls back to kcse for every level
    expect((await fetchTermReport("t1", "XX")).meanByClass.get("c1")!.scheme).toBe("kcse");
  });

  it("asks for the figures with no exam when none is published", async () => {
    const sb = fake((c) => (c.table === "exams" ? { data: [] } : answers(c)));
    const r = await fetchTermReport("t1", "KE");
    expect(r.latestExam).toBeNull();
    expect(sb.rpcs("term_class_figures")[0]!.rpcArgs).toEqual({ p_tenant_id: "t1", p_term_id: "term-3", p_exam_id: null });
  });

  it("with no current term, reads no exam and no figures and answers empty totals", async () => {
    const sb = fake((c) => (c.table === "terms" ? { data: null } : answers(c)));
    const r = await fetchTermReport("t1", "KE");
    expect(r.term).toBeNull();
    expect(r.attendanceByClass.size).toBe(0);
    expect(r.attendanceOverall).toEqual({ present: 0, total: 0 });
    expect(r.feeOverall).toEqual({ billed: 0, paid: 0 });
    expect(r.meanByClass.size).toBe(0);
    expect(r.classes).toEqual(CLASSES);
    expect(sb.on("exams")).toHaveLength(0);
    expect(sb.rpcs("term_class_figures")).toHaveLength(0);
    expect(r.percentageMode).toBe("day");
  });

  it("throws the figures' message (as a plain Error) when they cannot be read", async () => {
    fake((c) => (c.rpc === "term_class_figures" ? { data: null, error: REFUSED } : answers(c)));
    const err = await fetchTermReport("t1", "KE").catch((e: unknown) => e);
    expect(err).not.toBe(REFUSED);
    expect(err).toEqual(new Error("permission denied for table classes"));
  });

  it("reads a failed term, classes or exam read as nothing, and does not throw", async () => {
    fake((c) => (c.table === "classes" || c.table === "exams" ? { data: null, error: REFUSED } : answers(c)));
    const r = await fetchTermReport("t1", "KE");
    expect(r.classes).toEqual([]);
    expect(r.latestExam).toBeNull();
  });

  it("uses the default percentage mode when the school has no settings", async () => {
    fake((c) => (c.table === "attendance_settings" ? { data: null } : answers(c)));
    expect((await fetchTermReport("t1", "KE")).percentageMode).toBe("session");
  });
});
