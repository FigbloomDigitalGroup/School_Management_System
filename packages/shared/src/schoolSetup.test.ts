import { afterEach, describe, expect, it, vi } from "vitest";
import * as client from "./supabase";
import {
  createClass, createClasses, createSubject, createSubjects, deleteClass, fetchClassSubjects, fetchClassesOverview, fetchGuardianProfileIds,
  fetchLatestExamMeans, fetchPromotionRoster, fetchSubjects, fetchTermSetup, markLearnersLeft, moveLearnersToClass, saveSchoolAccent,
  saveSchoolDetails, saveSchoolLogo, saveSchoolPaymentMethods, sendInAppNotices, setClassSubjectTeacher, setClassTeacher, startTerm,
  updateSubject,
} from "./schoolSetup";

/** One request the code made: the table (or function) and every builder call chained on it, in order. */
interface Call {
  table?: string;
  rpc?: string;
  rpcArgs?: unknown;
  ops: [string, unknown[]][];
}

interface Answer { data?: unknown; error?: unknown; count?: number | null }

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
  return { calls, on: (table: string) => calls.filter((c) => c.table === table) };
}

afterEach(() => vi.restoreAllMocks());

const REFUSED = Object.assign(new Error("new row violates row-level security policy"), { code: "42501" });

describe("fetchClassesOverview", () => {
  const classRows = [
    { id: "c3", name: "Form 1 East", level: "secondary", form_level: 1, tenant_id: "t1" },
    { id: "c2", name: "Grade 7 West", level: "junior_secondary", form_level: 7, tenant_id: "t1" },
    { id: "c1", name: "Grade 7 East", level: "junior_secondary", form_level: 7, tenant_id: "t1" },
    { id: "c0", name: "PP1", level: "pre_primary", form_level: 1, tenant_id: "t1" },
  ];

  it("reads the school's classes, teachers, active learners and subjects, each filtered to the school", async () => {
    const sb = fake((c) => c.table === "classes" ? { data: classRows } : undefined);
    await fetchClassesOverview("t1");
    expect(sb.calls.map((c) => c.table).sort()).toEqual(["classes", "profiles", "students", "subjects"]);
    for (const c of sb.calls) expect(eqs(c).tenant_id).toBe("t1");
    expect(eqs(sb.on("profiles")[0]!)).toMatchObject({ role: "teacher" });
    expect(eqs(sb.on("students")[0]!)).toMatchObject({ active: true });
  });

  it("orders classes youngest first across levels, then by name, and counts learners per class", async () => {
    fake((c) =>
      c.table === "classes" ? { data: classRows }
      : c.table === "students" ? { data: [{ id: "s1", class_id: "c1" }, { id: "s2", class_id: "c1" }, { id: "s3", class_id: "c3" }] }
      : undefined);
    const o = await fetchClassesOverview("t1");
    expect(o.classes.map((c) => c.name)).toEqual(["PP1", "Grade 7 East", "Grade 7 West", "Form 1 East"]);
    expect(o.studentCountByClass.get("c1")).toBe(2);
    expect(o.studentCountByClass.get("c3")).toBe(1);
    expect(o.studentCountByClass.get("c0")).toBeUndefined();
  });

  it("answers empty lists, not null, when the school has nothing yet", async () => {
    fake();
    expect(await fetchClassesOverview("t1")).toEqual({ classes: [], teachers: [], subjects: [], studentCountByClass: new Map() });
  });

  it("throws the database's own error for whichever of the four reads fails", async () => {
    for (const table of ["classes", "profiles", "students", "subjects"]) {
      fake((c) => c.table === table ? { data: null, error: REFUSED } : undefined);
      await expect(fetchClassesOverview("t1")).rejects.toBe(REFUSED);
    }
  });
});

describe("classes", () => {
  const NEW = { name: "Grade 7 East", level: "junior_secondary" as const, formLevel: 7, pathway: null, stream: "East", room: "C-2", classTeacherId: "p1" };

  it("createClass inserts one row with the school's id and the database's column names", async () => {
    const sb = fake();
    await createClass("t1", NEW);
    expect(sb.on("classes")[0]!.ops).toEqual([["insert", [{
      tenant_id: "t1", name: "Grade 7 East", level: "junior_secondary", form_level: 7, pathway: null, stream: "East", room: "C-2", class_teacher_id: "p1",
    }]]]);
  });

  it("createClasses inserts every row in one request", async () => {
    const sb = fake();
    await createClasses("t1", [NEW, { ...NEW, name: "Grade 7 West", stream: "West", room: null, classTeacherId: null, pathway: "stem" }]);
    expect(sb.on("classes")).toHaveLength(1);
    const rows = op(sb.on("classes")[0]!, "insert")![0] as Record<string, unknown>[];
    expect(rows.map((r) => [r.name, r.stream, r.room, r.class_teacher_id, r.pathway])).toEqual([
      ["Grade 7 East", "East", "C-2", "p1", null],
      ["Grade 7 West", "West", null, null, "stem"],
    ]);
  });

  it("setClassTeacher updates that class's teacher, or clears it with null", async () => {
    const sb = fake();
    await setClassTeacher("c1", "p9");
    await setClassTeacher("c2", null);
    expect(sb.on("classes").map((c) => [op(c, "update"), eqs(c)])).toEqual([
      [[{ class_teacher_id: "p9" }], { id: "c1" }],
      [[{ class_teacher_id: null }], { id: "c2" }],
    ]);
  });

  it("deleteClass deletes that class only", async () => {
    const sb = fake();
    await deleteClass("c1");
    expect(sb.on("classes")[0]!.ops.map(([o]) => o)).toEqual(["delete", "eq"]);
    expect(eqs(sb.on("classes")[0]!)).toEqual({ id: "c1" });
  });

  it("each throws the database's own error when it refuses", async () => {
    fake(() => ({ error: REFUSED }));
    await expect(createClass("t1", NEW)).rejects.toBe(REFUSED);
    await expect(createClasses("t1", [NEW])).rejects.toBe(REFUSED);
    await expect(setClassTeacher("c1", "p1")).rejects.toBe(REFUSED);
    await expect(deleteClass("c1")).rejects.toBe(REFUSED);
  });
});

describe("fetchTermSetup", () => {
  it("counts what the checklist shows, reading the fee items of the current term only", async () => {
    const sb = fake((c) =>
      c.table === "terms" ? { data: { id: "term1", name: "Term 2, 2026" } }
      : c.table === "classes" ? { data: [{ id: "c1" }] }
      : c.table === "subjects" ? { count: 9 }
      : c.table === "fee_items" ? { count: 4 }
      : c.table === "profiles" ? { data: [{ id: "p1", full_name: "Asha" }] }
      : c.table === "students" ? { count: 120 }
      : undefined);
    const d = await fetchTermSetup("t1");
    expect(d).toEqual({
      term: { id: "term1", name: "Term 2, 2026" }, classes: [{ id: "c1" }], subjectsCount: 9, feeItemsCount: 4,
      teacherOptions: [{ id: "p1", full_name: "Asha" }], activeStudents: 120,
    });
    expect(eqs(sb.on("terms")[0]!)).toEqual({ tenant_id: "t1", is_current: true });
    expect(eqs(sb.on("fee_items")[0]!)).toEqual({ tenant_id: "t1", term_id: "term1" });
    expect(eqs(sb.on("students")[0]!)).toEqual({ tenant_id: "t1", active: true });
  });

  it("asks for no fee items, and counts none, when there is no current term", async () => {
    const sb = fake();
    const d = await fetchTermSetup("t1");
    expect(sb.on("fee_items")).toEqual([]);
    expect(d).toEqual({ term: null, classes: [], subjectsCount: 0, feeItemsCount: 0, teacherOptions: [], activeStudents: 0 });
  });

  it("counts a part it cannot read as nothing, and raises no error (as the screen always did)", async () => {
    fake(() => ({ data: null, error: REFUSED, count: null }));
    expect(await fetchTermSetup("t1")).toEqual({ term: null, classes: [], subjectsCount: 0, feeItemsCount: 0, teacherOptions: [], activeStudents: 0 });
  });
});

describe("the term and the school's details", () => {
  it("startTerm sends the whole term to start_term, in one call", async () => {
    const sb = fake();
    await startTerm({ tenantId: "t1", year: 2026, index: 3, startsOn: "2026-09-01", endsOn: "2026-11-27" });
    expect(sb.calls).toHaveLength(1);
    expect(sb.calls[0]).toMatchObject({ rpc: "start_term", rpcArgs: { p_tenant_id: "t1", p_year: 2026, p_index: 3, p_starts_on: "2026-09-01", p_ends_on: "2026-11-27" } });
  });

  it("saveSchoolDetails, saveSchoolPaymentMethods, saveSchoolLogo and saveSchoolAccent call their own functions with the database's parameter names", async () => {
    const sb = fake();
    await saveSchoolDetails("t1", { name: "Alliance", county: "Kiambu", moeRegistration: "MoE/1" });
    await saveSchoolPaymentMethods("t1", { paybill: "522522", till: "", bankDetails: "Equity 01", notes: "Use the ID" });
    await saveSchoolLogo("t1", "https://x/logo.png");
    await saveSchoolAccent("t1", "#17402A");
    expect(sb.calls.map((c) => [c.rpc, c.rpcArgs])).toEqual([
      ["set_school_details", { p_tenant_id: "t1", p_name: "Alliance", p_county: "Kiambu", p_moe_registration: "MoE/1" }],
      ["set_school_payment_methods", { p_tenant_id: "t1", p_paybill: "522522", p_till: "", p_bank_details: "Equity 01", p_notes: "Use the ID" }],
      ["set_school_logo", { p_tenant_id: "t1", p_logo_url: "https://x/logo.png" }],
      ["set_school_accent", { p_tenant_id: "t1", p_accent: "#17402A" }],
    ]);
  });

  it("each throws the database's own error when it refuses", async () => {
    fake(() => ({ error: REFUSED }));
    await expect(startTerm({ tenantId: "t1", year: 2026, index: 1, startsOn: "a", endsOn: "b" })).rejects.toBe(REFUSED);
    await expect(saveSchoolDetails("t1", { name: "x", county: "y", moeRegistration: "" })).rejects.toBe(REFUSED);
    await expect(saveSchoolPaymentMethods("t1", { paybill: "", till: "", bankDetails: "", notes: "" })).rejects.toBe(REFUSED);
    await expect(saveSchoolLogo("t1", "u")).rejects.toBe(REFUSED);
    await expect(saveSchoolAccent("t1", "#000000")).rejects.toBe(REFUSED);
  });
});

describe("promoting a class", () => {
  it("fetchPromotionRoster reads the class's active learners by name", async () => {
    const sb = fake(() => ({ data: [{ id: "s1", full_name: "Amina", admission_no: "A1", profile_id: null }] }));
    expect(await fetchPromotionRoster("c1")).toHaveLength(1);
    const call = sb.on("students")[0]!;
    expect(eqs(call)).toEqual({ class_id: "c1", active: true });
    expect(op(call, "order")).toEqual(["full_name"]);
  });

  it("fetchPromotionRoster throws a plain Error carrying the database's words", async () => {
    fake(() => ({ error: REFUSED }));
    const err = await fetchPromotionRoster("c1").catch((e: unknown) => e);
    expect(err).not.toBe(REFUSED);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(REFUSED.message);
  });

  describe("fetchLatestExamMeans", () => {
    it("asks nothing for no learners", async () => {
      const sb = fake();
      expect((await fetchLatestExamMeans("t1", [])).size).toBe(0);
      expect(sb.calls).toEqual([]);
    });

    it("finds no means when no exam has been published", async () => {
      const sb = fake((c) => c.table === "exams" ? { data: [] } : undefined);
      expect((await fetchLatestExamMeans("t1", ["s1"])).size).toBe(0);
      expect(sb.on("marks")).toEqual([]);
      const exams = sb.on("exams")[0]!;
      expect(eqs(exams)).toEqual({ tenant_id: "t1" });
      expect(op(exams, "not")).toEqual(["published_at", "is", null]);
      expect(op(exams, "order")).toEqual(["published_at", { ascending: false }]);
      expect(op(exams, "limit")).toEqual([1]);
    });

    it("averages each learner's marks in the latest exam, rounded, skipping unset marks and leaving out learners with none", async () => {
      const sb = fake((c) =>
        c.table === "exams" ? { data: [{ id: "e9" }] }
        : c.table === "marks" ? { data: [
            { student_id: "s1", score: 80 }, { student_id: "s1", score: 71 }, { student_id: "s1", score: null },
            { student_id: "s2", score: null },
          ] }
        : undefined);
      const means = await fetchLatestExamMeans("t1", ["s1", "s2", "s3"]);
      expect([...means]).toEqual([["s1", 76]]); // (80 + 71) / 2 = 75.5, rounded up
      const marks = sb.on("marks")[0]!;
      expect(eqs(marks)).toEqual({ exam_id: "e9" });
      expect(op(marks, "in")).toEqual(["student_id", ["s1", "s2", "s3"]]);
    });

    it("throws a plain Error when either read fails", async () => {
      fake((c) => c.table === "exams" ? { error: REFUSED } : undefined);
      await expect(fetchLatestExamMeans("t1", ["s1"])).rejects.toThrow(REFUSED.message);
      fake((c) => c.table === "exams" ? { data: [{ id: "e9" }] } : c.table === "marks" ? { error: REFUSED } : undefined);
      const err = await fetchLatestExamMeans("t1", ["s1"]).catch((e: unknown) => e);
      expect(err).not.toBe(REFUSED);
      expect((err as Error).message).toBe(REFUSED.message);
    });
  });

  it("markLearnersLeft takes those learners off the roll with a plain update, and nothing else", async () => {
    const sb = fake();
    await markLearnersLeft(["s1", "s2"]);
    const call = sb.on("students")[0]!;
    expect(call.ops).toEqual([["update", [{ active: false }]], ["in", ["id", ["s1", "s2"]]]]);
  });

  it("moveLearnersToClass moves those learners to that class", async () => {
    const sb = fake();
    await moveLearnersToClass("c2", ["s1", "s2"]);
    expect(sb.on("students")[0]!.ops).toEqual([["update", [{ class_id: "c2" }]], ["in", ["id", ["s1", "s2"]]]]);
  });

  it("both throw the database's own error", async () => {
    fake(() => ({ error: REFUSED }));
    await expect(markLearnersLeft(["s1"])).rejects.toBe(REFUSED);
    await expect(moveLearnersToClass("c2", ["s1"])).rejects.toBe(REFUSED);
  });

  it("fetchGuardianProfileIds groups every guardian by learner", async () => {
    const sb = fake(() => ({ data: [
      { student_id: "s1", profile_id: "g1" }, { student_id: "s1", profile_id: "g2" }, { student_id: "s2", profile_id: "g3" },
    ] }));
    const byStudent = await fetchGuardianProfileIds(["s1", "s2", "s3"]);
    expect([...byStudent]).toEqual([["s1", ["g1", "g2"]], ["s2", ["g3"]]]);
    expect(op(sb.on("guardians")[0]!, "in")).toEqual(["student_id", ["s1", "s2", "s3"]]);
  });

  it("fetchGuardianProfileIds throws the database's own error", async () => {
    fake(() => ({ error: REFUSED }));
    await expect(fetchGuardianProfileIds(["s1"])).rejects.toBe(REFUSED);
  });

  describe("sendInAppNotices", () => {
    it("sends nothing, and asks nothing, for an empty list", async () => {
      const sb = fake();
      await sendInAppNotices({ tenantId: "t1", authorId: "a1", notices: [] });
      expect(sb.calls).toEqual([]);
    });

    it("inserts one in-app announcement per person, published now, aimed at that person only", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-23T09:30:00.000Z"));
      try {
        const sb = fake();
        await sendInAppNotices({
          tenantId: "t1", authorId: "a1",
          notices: [{ userId: "g1", subject: "Congratulations, Amina!", body: "Promoted." }, { userId: "g2", subject: "S", body: "B" }],
        });
        expect(sb.on("announcements")).toHaveLength(1);
        expect(op(sb.on("announcements")[0]!, "insert")![0]).toEqual([
          { tenant_id: "t1", author_id: "a1", subject: "Congratulations, Amina!", body: "Promoted.", audience: { kind: "user", user_id: "g1" }, channels: ["in_app"], published_at: "2026-11-23T09:30:00.000Z" },
          { tenant_id: "t1", author_id: "a1", subject: "S", body: "B", audience: { kind: "user", user_id: "g2" }, channels: ["in_app"], published_at: "2026-11-23T09:30:00.000Z" },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("throws the database's own error", async () => {
      fake(() => ({ error: REFUSED }));
      await expect(sendInAppNotices({ tenantId: "t1", authorId: "a1", notices: [{ userId: "g1", subject: "s", body: "b" }] })).rejects.toBe(REFUSED);
    });
  });
});

describe("subjects", () => {
  it("fetchSubjects reads the school's subjects by name, and throws a plain Error carrying the database's words", async () => {
    const sb = fake(() => ({ data: [{ id: "sub1", name: "Maths" }] }));
    expect(await fetchSubjects("t1")).toEqual([{ id: "sub1", name: "Maths" }]);
    expect(eqs(sb.on("subjects")[0]!)).toEqual({ tenant_id: "t1" });
    expect(op(sb.on("subjects")[0]!, "order")).toEqual(["name"]);

    fake(() => ({ error: REFUSED }));
    const err = await fetchSubjects("t1").catch((e: unknown) => e);
    expect(err).not.toBe(REFUSED);
    expect((err as Error).message).toBe(REFUSED.message);
  });

  it("createSubject sends one row, with its level when given (null = any level)", async () => {
    const sb = fake();
    await createSubject("t1", { name: "Maths", code: "MAT", isCore: true, level: null, minFormLevel: 1, maxFormLevel: 4 });
    await createSubject("t1", { name: "Art", code: "ART", isCore: true, level: "junior_secondary", minFormLevel: null, maxFormLevel: null });
    expect(sb.on("subjects").map((c) => op(c, "insert"))).toEqual([
      [{ tenant_id: "t1", name: "Maths", code: "MAT", is_core: true, level: null, min_form_level: 1, max_form_level: 4 }],
      [{ tenant_id: "t1", name: "Art", code: "ART", is_core: true, level: "junior_secondary", min_form_level: null, max_form_level: null }],
    ]);
  });

  it("createSubjects sends a level only for a subject that names one, and the KICD learning area when given", async () => {
    const sb = fake();
    await createSubjects("t1", [
      { name: "History", code: "HIS", isCore: true, minFormLevel: 1, maxFormLevel: 4 },
      { name: "Maths", code: "MAT", isCore: false, level: "junior_secondary", minFormLevel: 7, maxFormLevel: 9, learningAreaId: "la1" },
    ]);
    expect(sb.on("subjects")).toHaveLength(1);
    expect(op(sb.on("subjects")[0]!, "insert")![0]).toEqual([
      { tenant_id: "t1", name: "History", code: "HIS", is_core: true, min_form_level: 1, max_form_level: 4 },
      { tenant_id: "t1", name: "Maths", code: "MAT", is_core: false, level: "junior_secondary", min_form_level: 7, max_form_level: 9, learning_area_id: "la1" },
    ]);
    const first = (op(sb.on("subjects")[0]!, "insert")![0] as Record<string, unknown>[])[0]!;
    expect("level" in first).toBe(false);
    expect("learning_area_id" in first).toBe(false);
  });

  it("updateSubject changes the name, code and year bounds of that subject only", async () => {
    const sb = fake();
    await updateSubject("sub1", { name: "Mathematics", code: "MATH", minFormLevel: null, maxFormLevel: 4 });
    expect(sb.on("subjects")[0]!.ops).toEqual([
      ["update", [{ name: "Mathematics", code: "MATH", min_form_level: null, max_form_level: 4 }]],
      ["eq", ["id", "sub1"]],
    ]);
  });

  it("the writes throw the database's own error", async () => {
    fake(() => ({ error: REFUSED }));
    await expect(createSubject("t1", { name: "n", code: "c", isCore: true, minFormLevel: null, maxFormLevel: null })).rejects.toBe(REFUSED);
    await expect(createSubjects("t1", [])).rejects.toBe(REFUSED);
    await expect(updateSubject("sub1", { name: "n", code: "c", minFormLevel: null, maxFormLevel: null })).rejects.toBe(REFUSED);
  });
});

describe("who teaches what in a class", () => {
  const subjects = [
    { id: "sub1", name: "Maths", code: "MAT", min_form_level: null, max_form_level: null, level: null },
    { id: "sub2", name: "Computer Studies", code: "COM", min_form_level: 1, max_form_level: 2, level: "secondary" },
    { id: "sub3", name: "Kiswahili", code: "KIS", min_form_level: 7, max_form_level: 9, level: "junior_secondary" },
  ];

  it("lists the subjects that apply to the class, who teaches each, and which teachers say they teach each", async () => {
    const sb = fake((c) =>
      c.table === "subjects" ? { data: subjects }
      : c.table === "teaching_assignments" ? { data: [{ subject_id: "sub1", teacher_id: "p1" }] }
      : c.table === "teacher_subjects" ? { data: [{ subject_id: "sub1", teacher_id: "p1" }, { subject_id: "sub1", teacher_id: "p2" }] }
      : undefined);
    const d = await fetchClassSubjects("t1", "c1", "secondary", 3);
    // Computer Studies is Form 1-2 only, and Kiswahili is a junior-school subject: neither is offered to Form 3
    expect(d.rows.map((r) => [r.subject.id, r.teacherId])).toEqual([["sub1", "p1"]]);
    expect([...d.qualifiedTeacherIdsBySubject.get("sub1")!]).toEqual(["p1", "p2"]);
    expect(eqs(sb.on("subjects")[0]!)).toEqual({ tenant_id: "t1" });
    expect(eqs(sb.on("teaching_assignments")[0]!)).toEqual({ class_id: "c1" });
    expect(eqs(sb.on("teacher_subjects")[0]!)).toEqual({ tenant_id: "t1" });
  });

  it("offers a Form 2 class Computer Studies, and leaves its teacher unset when nobody teaches it", async () => {
    fake((c) => c.table === "subjects" ? { data: subjects } : undefined);
    const d = await fetchClassSubjects("t1", "c1", "secondary", 2);
    expect(d.rows.map((r) => [r.subject.id, r.teacherId])).toEqual([["sub1", null], ["sub2", null]]);
  });

  it("throws a plain Error carrying the database's words when any of the three reads fails", async () => {
    for (const table of ["subjects", "teaching_assignments", "teacher_subjects"]) {
      fake((c) => c.table === table ? { error: REFUSED } : undefined);
      const err = await fetchClassSubjects("t1", "c1", "secondary", 1).catch((e: unknown) => e);
      expect(err).not.toBe(REFUSED);
      expect((err as Error).message).toBe(REFUSED.message);
    }
  });

  it("setClassSubjectTeacher names a teacher with one upsert on class and subject", async () => {
    const sb = fake();
    await setClassSubjectTeacher({ tenantId: "t1", classId: "c1", subjectId: "sub1", teacherId: "p2" });
    expect(sb.on("teaching_assignments")).toHaveLength(1);
    expect(sb.on("teaching_assignments")[0]!.ops).toEqual([["upsert", [
      { tenant_id: "t1", class_id: "c1", subject_id: "sub1", teacher_id: "p2" },
      { onConflict: "class_id,subject_id" },
    ]]]);
  });

  it("setClassSubjectTeacher clears the teacher by deleting that class's assignment for the subject", async () => {
    const sb = fake();
    await setClassSubjectTeacher({ tenantId: "t1", classId: "c1", subjectId: "sub1", teacherId: null });
    expect(sb.on("teaching_assignments")[0]!.ops.map(([o]) => o)).toEqual(["delete", "eq", "eq"]);
    expect(eqs(sb.on("teaching_assignments")[0]!)).toEqual({ class_id: "c1", subject_id: "sub1" });
  });

  it("setClassSubjectTeacher throws the database's own error on either path", async () => {
    fake(() => ({ error: REFUSED }));
    await expect(setClassSubjectTeacher({ tenantId: "t1", classId: "c1", subjectId: "sub1", teacherId: "p2" })).rejects.toBe(REFUSED);
    await expect(setClassSubjectTeacher({ tenantId: "t1", classId: "c1", subjectId: "sub1", teacherId: null })).rejects.toBe(REFUSED);
  });
});
