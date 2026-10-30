import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PostgrestError } from "@supabase/supabase-js";
import { initSupabase, supabase } from "../../packages/shared/src/supabase";
import { fetchPublishedExams } from "../../packages/shared/src/examResults";
import { TEST_ROLES, signInAs, type SignedIn } from "./support/signInAs";
import { assertLocalSupabaseUrl } from "./support/localGuard";

/**
 * QA 09 (FIG-1242): entering marks and publishing them, through the same API the gradebook and the family screens use.
 *
 * The teacher is the seeded Alliance teacher (TC-0002), who teaches only Chemistry in these two classes; the second subject is entered
 * and published by the school admin (the office may do both). The parent is the seeded parent (PT-0002), whose two children are in
 * DIFFERENT classes (Faith in Form 2 West, Samuel in Form 4 East), which is exactly what "a learner in another class never sees
 * marks that class has not published" needs. Everything happens in a throwaway term with a throwaway exam out of 100; afterAll
 * deletes the term, which takes the exam, its marks and its publications with it. The audit events that publishing writes
 * cannot be deleted by a school admin and stay in the local database.
 *
 * Every expected number is worked out by hand in the test. The known defects use it.fails: they pass while the defect exists
 * and fail when it is fixed. Then change it.fails to it.
 */

const run = Date.now().toString(36);
let admin: SignedIn, teacher: SignedIn, parent: SignedIn, student: SignedIn;
let tenantId = "", termId = "", examId = "";
let faith = { id: "", classId: "" }, samuel = { id: "", classId: "" };
let subject1 = "", subject2 = "";
let roster: string[] = []; // the other learners of Faith's class

type Row = { tenant_id: string; exam_id: string; student_id: string; subject_id: string; score: number | null; entered_by: string; absence?: string };
/** Subject 1 is the teacher's; subject 2 belongs to the office in these classes. */
const actorFor = (subjectId: string) => (subjectId === subject2 ? admin : teacher);
const mark = (studentId: string, subjectId: string, score: number | null, extra: Partial<Row> = {}): Row =>
  ({ tenant_id: tenantId, exam_id: examId, student_id: studentId, subject_id: subjectId, score, entered_by: actorFor(subjectId).userId, ...extra });

/** Exactly what the gradebook does: one upsert on (exam, learner, subject), by whoever may write that subject. */
const save = async (rows: Row[]) => {
  const onConflict = "exam_id,student_id,subject_id";
  const own = rows.filter((r) => r.subject_id !== subject2);
  const office = rows.filter((r) => r.subject_id === subject2);
  const a = own.length ? await teacher.client.from("marks").upsert(own, { onConflict }) : { error: null as PostgrestError | null };
  const b = office.length ? await admin.client.from("marks").upsert(office, { onConflict }) : { error: null as PostgrestError | null };
  return { error: a.error ?? b.error };
};
const publish = (classId: string, subjectId: string, as: SignedIn = actorFor(subjectId)) => as.client.rpc("publish_marks", { p_exam_id: examId, p_class_id: classId, p_subject_id: subjectId });
const withdraw = (classId: string, subjectId: string) => actorFor(subjectId).client.rpc("unpublish_marks", { p_exam_id: examId, p_class_id: classId, p_subject_id: subjectId });
const code = (e: PostgrestError | null) => e?.code ?? null;

/** What a parent or learner can read of this exam: [learner, subject, score], sorted. */
async function visibleTo(who: SignedIn): Promise<string[]> {
  const { data, error } = await who.client.from("marks").select("student_id, subject_id, score").eq("exam_id", examId);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => `${r.student_id}|${r.subject_id}|${r.score}`).sort();
}
const means = async (classId: string) => {
  const { data, error } = await parent.client.rpc("class_means_for_exam", { p_exam_id: examId, p_class_id: classId });
  if (error) throw new Error(error.message);
  return Object.fromEntries((data as { subject_id: string; mean_score: number }[]).map((r) => [r.subject_id, Number(r.mean_score)]));
};
const examPublishedAt = async () => ((await admin.client.from("exams").select("published_at").eq("id", examId).single()).data?.published_at as string | null) ?? null;

beforeAll(async () => {
  const signedIn = await Promise.all((["school_admin", "teacher", "parent", "student"] as const).map((r) => signInAs(r)));
  admin = signedIn[0]!; teacher = signedIn[1]!; parent = signedIn[2]!; student = signedIn[3]!;
  tenantId = (await admin.client.from("profiles").select("tenant_id").eq("id", admin.userId).single()).data!.tenant_id as string;
  await admin.client.from("terms").delete().eq("tenant_id", tenantId).like("name", "QA09 %");

  const kids = await parent.client.from("students").select("id, class_id, full_name").order("admission_no");
  expect(kids.data, "the seeded parent has two children").toHaveLength(2);
  const children = kids.data!.map((k) => ({ id: k.id as string, classId: k.class_id as string }));
  faith = children[0]!; samuel = children[1]!;
  expect(faith.classId, "the two children are in different classes").not.toBe(samuel.classId);

  const ta = await teacher.client.from("teaching_assignments").select("class_id, subject_id").eq("teacher_id", teacher.userId);
  const taught = (cls: string) => new Set((ta.data ?? []).filter((r) => r.class_id === cls).map((r) => r.subject_id as string));
  const shared = [...taught(faith.classId)].filter((s) => taught(samuel.classId).has(s));
  expect(shared.length, "the teacher teaches a subject in both classes").toBeGreaterThanOrEqual(1);
  subject1 = shared[0]!;
  const other = await admin.client.from("subjects").select("id").eq("tenant_id", tenantId).neq("id", subject1).order("id").limit(1);
  subject2 = other.data![0]!.id as string;

  const others = await admin.client.from("students").select("id").eq("class_id", faith.classId).eq("active", true).neq("id", faith.id).order("id").limit(6);
  roster = (others.data ?? []).map((s) => s.id as string);
  expect(roster.length).toBeGreaterThanOrEqual(5);

  const term = await admin.client.from("terms").insert({ tenant_id: tenantId, name: `QA09 term ${run}`, year: 2035, index: 1, starts_on: "2035-01-05", ends_on: "2035-04-02", is_current: false }).select("id").single();
  if (term.error) throw new Error(`could not make the term: ${term.error.message}`);
  termId = term.data.id as string;
  const exam = await admin.client.from("exams").insert({ tenant_id: tenantId, term_id: termId, name: `QA09 exam ${run}`, out_of: 100 }).select("id").single();
  if (exam.error) throw new Error(`could not make the exam: ${exam.error.message}`);
  examId = exam.data.id as string;
}, 60_000);

afterAll(async () => {
  if (admin && termId) await admin.client.from("terms").delete().eq("id", termId);
}, 60_000);

// ---------------------------------------------------------------- 1. entering marks, in the database
describe("marks entry: what the database accepts, field by field", () => {
  const lone = () => roster[0]!;

  it("accepts 0 and 100, and a zero is stored as 0, not as nothing", async () => {
    expect((await save([mark(roster[0]!, subject1, 0), mark(roster[1]!, subject1, 100)])).error).toBeNull();
    const rows = await teacher.client.from("marks").select("student_id, score").eq("exam_id", examId).eq("subject_id", subject1).in("student_id", [roster[0]!, roster[1]!]);
    const byLearner = Object.fromEntries((rows.data ?? []).map((r) => [r.student_id, r.score]));
    expect(byLearner[roster[0]!]).toBe(0);
    expect(byLearner[roster[1]!]).toBe(100);
  });

  it("refuses a negative mark", async () => {
    expect(code((await save([mark(lone(), subject1, -1)])).error)).toBe("23514");
  });

  it("refuses a mark above the paper total, in words", async () => {
    const res = await save([mark(lone(), subject1, 101)]);
    expect(res.error?.message).toMatch(/exceeds the paper total/);
    expect(code((await save([mark(lone(), subject1, 100000)])).error)).not.toBeNull();
  });

  it("refuses a fraction and text", async () => {
    expect(code((await save([mark(lone(), subject1, 72.5)])).error)).toBe("22P02");
    expect(code((await save([mark(lone(), subject1, "abc" as unknown as number)])).error)).toBe("22P02");
    expect(code((await save([mark(lone(), subject1, "7e1" as unknown as number)])).error)).toBe("22P02");
  });

  it("stores no score as null, which is a different thing from 0", async () => {
    expect((await save([mark(roster[2]!, subject1, null)])).error).toBeNull();
    const r = await teacher.client.from("marks").select("score, absence").eq("exam_id", examId).eq("subject_id", subject1).eq("student_id", roster[2]!).single();
    expect(r.data).toEqual({ score: null, absence: null });
  });

  it("records a missed or excused paper only with no score, and a score clears it", async () => {
    expect((await save([mark(roster[3]!, subject1, null, { absence: "missed" })])).error).toBeNull();
    expect((await save([mark(roster[4]!, subject1, null, { absence: "excused" })])).error).toBeNull();
    expect(code((await save([mark(roster[3]!, subject1, null, { absence: "late" })])).error)).toBe("23514");
    // a score and an absence in one write: the score wins and the absence is dropped, silently
    expect((await save([mark(roster[3]!, subject1, 55, { absence: "missed" })])).error).toBeNull();
    const r = await teacher.client.from("marks").select("score, absence").eq("exam_id", examId).eq("subject_id", subject1).eq("student_id", roster[3]!).single();
    expect(r.data).toEqual({ score: 55, absence: null });
  });

  it("refuses a second row for the same learner, exam and subject; the gradebook's upsert replaces it", async () => {
    expect((await save([mark(roster[0]!, subject1, 40)])).error).toBeNull();
    const dup = await teacher.client.from("marks").insert(mark(roster[0]!, subject1, 41));
    expect(code(dup.error)).toBe("23505");
    expect((await save([mark(roster[0]!, subject1, 42)])).error).toBeNull();
    const r = await teacher.client.from("marks").select("score").eq("exam_id", examId).eq("subject_id", subject1).eq("student_id", roster[0]!);
    expect(r.data).toEqual([{ score: 42 }]);
  });

  it("refuses two rows for one learner inside a single batch, as the gradebook's upsert would send them", async () => {
    const res = await save([mark(roster[0]!, subject1, 10), mark(roster[0]!, subject1, 20)]);
    expect(res.error, "the whole batch is refused, so no row of it is saved").not.toBeNull();
  });

  it("a learner's marks are tied to their school: a mark for a learner of another school is refused", async () => {
    const other = await signInAs("platform_staff");
    const foreign = await other.client.from("students").select("id, tenant_id").neq("tenant_id", tenantId).limit(1).single();
    const res = await save([mark(foreign.data!.id as string, subject1, 50)]);
    expect(res.error).not.toBeNull();
  });

  // entered_by says who typed the mark. Nothing checks it is the person writing: a teacher can sign a mark with a colleague's name.
  it.fails("FIG-1376 (open): a mark cannot be saved in someone else's name", async () => {
    const res = await save([mark(roster[0]!, subject1, 33, { entered_by: admin.userId })]);
    expect(res.error, "writing a mark as the school admin").not.toBeNull();
  });
});

// ---------------------------------------------------------------- 2. publishing
describe("publication: per exam, class and subject", () => {
  let faithSubject1 = "";

  it("sets up: Faith 90, four classmates 80 / 71 / 0 / absent, and Samuel (another class) 66, all as drafts", async () => {
    const rows = [
      mark(faith.id, subject1, 90), mark(roster[0]!, subject1, 80), mark(roster[1]!, subject1, 71), mark(roster[2]!, subject1, 0),
      mark(roster[3]!, subject1, null, { absence: "missed" }),
      mark(samuel.id, subject1, 66),
      mark(faith.id, subject2, 84), mark(roster[0]!, subject2, 85), // a second subject for the half-and-half cases
    ];
    expect((await save(rows)).error).toBeNull();
    faithSubject1 = `${faith.id}|${subject1}|90`;
  });

  it("nothing is out yet: the parent, the learner and the exam list see none of it", async () => {
    expect(await visibleTo(parent)).toEqual([]);
    expect(await visibleTo(student)).toEqual([]);
    expect(await means(faith.classId)).toEqual({});
    initSupabase({ url: assertLocalSupabaseUrl(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL).origin, anonKey: process.env.VITE_SUPABASE_ANON_KEY!, detectSessionInUrl: false });
    await supabase().auth.signInWithPassword({ email: TEST_ROLES.parent.email, password: TEST_ROLES.parent.password });
    const exams = await fetchPublishedExams([faith.id, samuel.id]);
    expect([...(exams.get(faith.id) ?? []), ...(exams.get(samuel.id) ?? [])].filter((e) => e.id === examId)).toEqual([]);
    expect(await examPublishedAt()).toBeNull();
  });

  it("publishing Faith's class and subject shows the parent Faith's mark and NOT Samuel's, whose class has not published", async () => {
    expect((await publish(faith.classId, subject1)).error).toBeNull();
    expect(await visibleTo(parent)).toEqual([faithSubject1]);
    expect(await visibleTo(student), "Faith's own login sees the same single mark").toEqual([faithSubject1]);
    expect(await examPublishedAt()).not.toBeNull();
  });

  it("the second subject, not yet published for that class, stays hidden even though the first is out", async () => {
    expect((await visibleTo(parent)).some((r) => r.includes(`|${subject2}|`))).toBe(false);
  });

  it("the class mean follows publication and is worked out by hand: (90 + 80 + 71 + 0) / 4 = 60.25, rounded to 60; the zero counts, the absent learner does not", async () => {
    expect(await means(faith.classId)).toEqual({ [subject1]: 60 });
    expect(await means(samuel.classId), "Samuel's class has published nothing, so it has no means").toEqual({});
  });

  it("the exam list shows the exam for Faith, whose class has published, and not for Samuel", async () => {
    const exams = await fetchPublishedExams([faith.id, samuel.id]);
    expect((exams.get(faith.id) ?? []).filter((e) => e.id === examId)).toEqual([{ id: examId, name: `QA09 exam ${run}`, subjectCount: 1 }]);
    expect((exams.get(samuel.id) ?? []).filter((e) => e.id === examId)).toEqual([]);
  });

  it("publishing Samuel's class then shows him his mark, and both exam lists have the exam", async () => {
    expect((await publish(samuel.classId, subject1)).error).toBeNull();
    expect(await visibleTo(parent)).toEqual([faithSubject1, `${samuel.id}|${subject1}|66`].sort());
    const exams = await fetchPublishedExams([faith.id, samuel.id]);
    expect((exams.get(samuel.id) ?? []).some((e) => e.id === examId)).toBe(true);
  });

  it("a second subject is its own publication: out for one class, hidden for the other", async () => {
    expect((await save([mark(samuel.id, subject2, 59)])).error).toBeNull();
    expect((await publish(samuel.classId, subject2)).error).toBeNull();
    const seen = await visibleTo(parent);
    expect(seen).toContain(`${samuel.id}|${subject2}|59`);
    expect(seen.some((r) => r.startsWith(`${faith.id}|${subject2}|`)), "Faith's class has not published subject 2").toBe(false);
    expect(await means(samuel.classId)).toEqual({ [subject1]: 66, [subject2]: 59 });
    expect(await means(faith.classId)).toEqual({ [subject1]: 60 });
  });

  it("withdrawing hides it again, takes the mean and the exam-list entry with it, and leaves the other class alone", async () => {
    expect((await withdraw(faith.classId, subject1)).error).toBeNull();
    expect((await visibleTo(parent)).some((r) => r.startsWith(`${faith.id}|`))).toBe(false);
    expect(await visibleTo(student)).toEqual([]);
    expect(await means(faith.classId)).toEqual({});
    const exams = await fetchPublishedExams([faith.id, samuel.id]);
    expect((exams.get(faith.id) ?? []).some((e) => e.id === examId)).toBe(false);
    expect((exams.get(samuel.id) ?? []).some((e) => e.id === examId), "Samuel's class is still out").toBe(true);
    expect(await examPublishedAt(), "still published while any class is out").not.toBeNull();
  });

  it("withdrawing the last one makes the exam unpublished again", async () => {
    expect((await withdraw(samuel.classId, subject1)).error).toBeNull();
    expect((await withdraw(samuel.classId, subject2)).error).toBeNull();
    expect(await visibleTo(parent)).toEqual([]);
    expect(await examPublishedAt()).toBeNull();
  });

  it("publishing twice is harmless (no second audit entry), and withdrawing something not out is harmless too", async () => {
    const audit = async () => (await admin.client.from("audit_events").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).like("event", "%QA09 exam%")).count ?? 0;
    expect((await publish(faith.classId, subject1)).error).toBeNull();
    const once = await audit();
    expect((await publish(faith.classId, subject1)).error).toBeNull();
    expect(await audit()).toBe(once);
    expect((await withdraw(faith.classId, subject1)).error).toBeNull();
    expect((await withdraw(faith.classId, subject1)).error).toBeNull();
  });

  it("changing a mark that is already out is live at once, with no second publish", async () => {
    expect((await publish(faith.classId, subject1)).error).toBeNull();
    expect((await save([mark(faith.id, subject1, 91)])).error).toBeNull();
    expect(await visibleTo(parent)).toEqual([`${faith.id}|${subject1}|91`]);
    expect((await save([mark(faith.id, subject1, 90)])).error).toBeNull();
    expect((await withdraw(faith.classId, subject1)).error).toBeNull();
  });

  // The Publish button stays disabled until every learner has an entry (web and phone). The database asks only that there is at
  // least one mark row, so the same class can be published from a script or a changed app with most of the roster missing, and
  // class_means_for_exam then averages the few that exist and shows parents a "class mean" of a handful of learners.
  it.fails("FIG-1375 (open): the server refuses to publish a class and subject while learners of the class have no entry", async () => {
    // subject 2 for Faith's class has only two learners entered (84 and 85) out of a whole class
    const res = await publish(faith.classId, subject2);
    expect(res.error, "publishing 2 of the class").not.toBeNull();
  });

  it("(what the partial publication leaves behind) the class mean is the mean of the two entered, 84.5 rounded to 85", async () => {
    // subject 2 is out for Faith's class if the defect above is still there; if it is fixed this test sees an empty set
    const m = await means(faith.classId);
    if (m[subject2] === undefined) return; // fixed: nothing published, nothing to check
    expect(m[subject2]).toBe(85); // (84 + 85) / 2 = 84.5 -> 85
    expect((await withdraw(faith.classId, subject2)).error).toBeNull();
  });

  it("only a teacher of the subject (or the office) may publish: a parent, a learner, and the teacher for a subject they do not teach, may not", async () => {
    expect(code((await publish(faith.classId, subject1, parent)).error)).toBe("42501");
    expect(code((await publish(faith.classId, subject1, student)).error)).toBe("42501");
    expect(code((await publish(faith.classId, subject2, teacher)).error)).toBe("42501");
  });

  it("refuses to publish a class and subject that have no marks at all", async () => {
    const second = await admin.client.from("exams").insert({ tenant_id: tenantId, term_id: termId, name: `QA09 empty ${run}`, out_of: 100 }).select("id").single();
    expect(second.error).toBeNull();
    const res = await teacher.client.rpc("publish_marks", { p_exam_id: second.data!.id, p_class_id: faith.classId, p_subject_id: subject1 });
    expect(code(res.error)).toBe("22023");
    expect(res.error?.message).toMatch(/no marks to publish/i);
  });
});
