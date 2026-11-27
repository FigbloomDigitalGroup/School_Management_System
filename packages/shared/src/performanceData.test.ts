import { afterEach, describe, expect, it, vi } from "vitest";
import * as client from "./supabase";
import { CBE_BANDS, fetchCbeBandReport, fetchClassLearnerNames, fetchClassOptions } from "./performanceData";

/** One request the code made: the table (or function) and every builder call chained on it, in order. */
interface Call { table?: string; ops: [string, unknown[]][] }
interface Answer { data?: unknown; error?: unknown }

const eqs = (call: Call) => Object.fromEntries(call.ops.filter(([op]) => op === "eq").map(([, args]) => [args[0] as string, args[1]]));
const op = (call: Call, name: string) => call.ops.find(([o]) => o === name)?.[1];

/** A stand-in Supabase client: every chain is recorded and answered by `answer`; a request nobody answers reads as no rows and no error. */
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
  const sb = { from: (table: string) => { const call: Call = { table, ops: [] }; calls.push(call); return chain(call); } };
  vi.spyOn(client, "supabase").mockReturnValue(sb as unknown as ReturnType<typeof client.supabase>);
  return { calls, on: (table: string) => calls.filter((c) => c.table === table) };
}

afterEach(() => vi.restoreAllMocks());

const REFUSED = Object.assign(new Error("permission denied for table classes"), { code: "42501" });

describe("fetchClassOptions", () => {
  it("reads the school's classes, youngest year first and then by name", async () => {
    const rows = [{ id: "c1", name: "Form 1 East", level: "secondary", form_level: 1 }];
    const sb = fake(() => ({ data: rows }));
    expect(await fetchClassOptions("t1")).toBe(rows);
    const call = sb.on("classes")[0]!;
    expect(op(call, "select")).toEqual(["id, name, level, form_level"]);
    expect(eqs(call)).toEqual({ tenant_id: "t1" });
    expect(call.ops.filter(([o]) => o === "order").map(([, a]) => a)).toEqual([["form_level"], ["name"]]);
  });

  it("answers an empty list for none, and throws the database's message as a plain Error", async () => {
    fake();
    expect(await fetchClassOptions("t1")).toEqual([]);
    fake(() => ({ error: REFUSED }));
    const err = await fetchClassOptions("t1").catch((e: unknown) => e);
    expect(err).not.toBe(REFUSED);
    expect(err).toEqual(new Error("permission denied for table classes"));
  });
});

describe("fetchClassLearnerNames", () => {
  it("reads one class's active learners by name", async () => {
    const rows = [{ id: "s1", full_name: "Amina Otieno" }];
    const sb = fake(() => ({ data: rows }));
    expect(await fetchClassLearnerNames("c1")).toBe(rows);
    const call = sb.on("students")[0]!;
    expect(op(call, "select")).toEqual(["id, full_name"]);
    expect(eqs(call)).toEqual({ class_id: "c1", active: true });
    expect(op(call, "order")).toEqual(["full_name"]);
  });

  it("answers an empty list for none, and throws the database's message as a plain Error", async () => {
    fake();
    expect(await fetchClassLearnerNames("c1")).toEqual([]);
    fake(() => ({ error: REFUSED }));
    const err = await fetchClassLearnerNames("c1").catch((e: unknown) => e);
    expect(err).not.toBe(REFUSED);
    expect(err).toEqual(new Error("permission denied for table classes"));
  });
});

describe("fetchCbeBandReport", () => {
  const grade7 = { name: "Grade 7 East", level: "junior_secondary", form_level: 7 };
  const grade4 = { name: "Grade 4 West", level: "primary", form_level: 4 };
  const assessment = (id: string, cls: typeof grade7, subjectId: string, subject: string, on: string, title = `${subject} ${on}`) => ({
    id, title, assessed_on: on, class_id: cls.name, subject_id: subjectId, subjects: { name: subject }, classes: cls,
  });
  const result = (studentId: string, level: string, a: ReturnType<typeof assessment>) => ({ student_id: studentId, level_code: level, cbe_assessments: a });

  const mathsOld = assessment("a1", grade7, "maths", "Mathematics", "2026-10-01");
  const mathsNew = assessment("a2", grade7, "maths", "Mathematics", "2026-11-05");
  const english4 = assessment("a3", grade4, "eng", "English", "2026-11-02");

  it("reads this term's published results for the school, with their assessment, class and learning area", async () => {
    const sb = fake(() => ({ data: [] }));
    await fetchCbeBandReport("t1", "term-3", "KE");
    const call = sb.on("cbe_results")[0]!;
    expect(op(call, "select")).toEqual(["student_id, level_code, cbe_assessments!inner(id, title, assessed_on, published_at, term_id, class_id, subject_id, subjects(name), classes(name, level, form_level))"]);
    expect(eqs(call)).toEqual({ tenant_id: "t1", "cbe_assessments.term_id": "term-3" });
    expect(op(call, "not")).toEqual(["cbe_assessments.published_at", "is", null]);
  });

  it("answers an empty report for no results, and throws the database's message as a plain Error", async () => {
    fake();
    expect(await fetchCbeBandReport("t1", "term-3", "KE")).toEqual([]);
    fake(() => ({ error: REFUSED }));
    const err = await fetchCbeBandReport("t1", "term-3", "KE").catch((e: unknown) => e);
    expect(err).not.toBe(REFUSED);
    expect(err).toEqual(new Error("permission denied for table classes"));
  });

  it("counts each class's learners by band for the latest assessment of each learning area only", async () => {
    fake(() => ({ data: [
      // the October assessment is superseded by November's: only November counts
      result("s1", "BE1", mathsOld), result("s2", "BE1", mathsOld),
      result("s1", "EE1", mathsNew), result("s2", "ME2", mathsNew), result("s3", "ME1", mathsNew),
    ] }));
    const [row] = await fetchCbeBandReport("t1", "term-3", "KE");
    expect(row).toMatchObject({ key: "Grade 7 East:maths", className: "Grade 7 East", learningAreaName: "Mathematics", assessmentTitle: "Mathematics 2026-11-05", learners: 3 });
    // 8 levels fold into their band: EE1 is EE, ME2 and ME1 are ME
    expect(row!.counts).toEqual({ EE: 1, ME: 2, AE: 0, BE: 0 });
  });

  it("gives each learner one overall level from all their strands in the assessment (the mean of their points)", async () => {
    fake(() => ({ data: [
      // EE1 (8 points) and BE1 (2): the mean is 5, which is ME2
      result("s1", "EE1", mathsNew), result("s1", "BE1", mathsNew),
      // a code that is not on the rubric counts for nothing: the learner has no level, so is in no band
      result("s2", "??", mathsNew),
    ] }));
    const [row] = await fetchCbeBandReport("t1", "term-3", "KE");
    expect(row!.counts).toEqual({ EE: 0, ME: 1, AE: 0, BE: 0 });
    expect(row!.learners).toBe(2);
  });

  it("reads a primary class on the four-level rubric", async () => {
    fake(() => ({ data: [result("s1", "EE", english4), result("s2", "AE", english4), result("s3", "BE", english4)] }));
    const [row] = await fetchCbeBandReport("t1", "term-3", "KE");
    expect(row!.counts).toEqual({ EE: 1, ME: 0, AE: 1, BE: 1 });
  });

  it("puts no learner in a band when the country has no rubric for the class", async () => {
    fake(() => ({ data: [result("s1", "EE", english4)] }));
    const [row] = await fetchCbeBandReport("t1", "XX", "XX");
    expect(row!.counts).toEqual({ EE: 0, ME: 0, AE: 0, BE: 0 });
    expect(row!.learners).toBe(1);
  });

  it("lists the youngest year first, then by class name, then by learning area", async () => {
    const grade7b = { name: "Grade 7 Alpha", level: "junior_secondary", form_level: 7 };
    const alphaMaths = assessment("a5", grade7b, "maths", "Mathematics", "2026-11-01");
    const eastArt = assessment("a6", grade7, "art", "Art", "2026-11-01");
    // given in an order that is neither the class order nor the learning-area order
    fake(() => ({ data: [
      result("s1", "EE1", mathsNew), result("s1", "EE1", alphaMaths), result("s1", "EE1", english4), result("s1", "EE1", eastArt),
    ] }));
    const rows = await fetchCbeBandReport("t1", "term-3", "KE");
    expect(rows.map((r) => `${r.className} / ${r.learningAreaName}`)).toEqual([
      "Grade 4 West / English", "Grade 7 Alpha / Mathematics", "Grade 7 East / Art", "Grade 7 East / Mathematics",
    ]);
  });

  it("names a class or learning area that is missing, and treats it as a primary class", async () => {
    fake(() => ({ data: [{ student_id: "s1", level_code: "EE", cbe_assessments: { id: "a9", title: "Check", assessed_on: "2026-11-01", class_id: "c9", subject_id: "x9", subjects: null, classes: null } }] }));
    const [row] = await fetchCbeBandReport("t1", "term-3", "KE");
    expect(row).toMatchObject({ className: "Class", learningAreaName: "Learning area", assessmentTitle: "Check" });
    expect(row!.counts.EE).toBe(1);
  });

  it("exports the four bands in order", () => {
    expect([...CBE_BANDS]).toEqual(["EE", "ME", "AE", "BE"]);
  });
});
