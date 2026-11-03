import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initSupabase, supabase } from "../../packages/shared/src/supabase";
import {
  defaultReportCardOptions, fetchClassReportCards, fetchMyReportCards, fetchTermExams, prepareClassReportCards,
  saveReportCardComments, saveReportCards, saveTeacherComment, setReportCardsPublished,
  type ReportCardData, type StoredReportCard,
} from "../../packages/shared/src/reportCards";
import { renderReportCardsPdf } from "../../packages/shared/src/reportCardPdf";
import { pdfPageTexts } from "../../packages/shared/src/pdfText.fixture";
import { TEST_ROLES, signInAs, type SignedIn, type TestRole } from "./support/signInAs";
import { assertLocalSupabaseUrl } from "./support/localGuard";

/**
 * QA 09 follow-up (FIG-1242): report cards, from the marks in the gradebook to the card a family downloads.
 *
 * It runs the app's own functions (prepareClassReportCards, saveReportCards, setReportCardsPublished, fetchMyReportCards,
 * saveTeacherComment) as the people who call them, against the local database, in a throwaway term with two throwaway exams
 * out of 100. afterAll deletes the term, which takes the exams, marks, publications and report cards with it. The audit events
 * that publishing writes cannot be deleted by a school admin and stay in the local database.
 *
 * Seeded people: the school admin; teacher TC-0002, who is class teacher of Form 2 West and of no other class; the parent PT-0002,
 * whose children are Faith (Form 2 West) and Samuel (Form 4 East, no class teacher); and the learner ST-0002, who IS Faith.
 *
 * Every expected figure is worked out by hand below (the grade tables are typed in gradeTables.fixture.ts). Faith's class,
 * two exams (E1, E2) and two subjects (S1: entered by the teacher, S2: entered by the office):
 *
 *   Faith   S1  90, 70 -> average 80 -> A 12      S2  59, 60 -> 59.5 -> 60 -> B- 8      total 140, mean 70, B+, 20 points
 *   Aisha   S1  80, [missed]  -> 80 -> A 12                                               mean 80
 *   Brian   S1  71, [no row]  -> 71 -> B+ 10                                              mean 71
 *   Cheche  S1  0, 0          -> 0 -> E 1         (a zero is a mark)                      mean 0
 *   Dedan   S1  [missed], 50  -> 50 -> C 6                                                mean 50
 *   Emma    S1  50, 50        -> 50 -> C 6                                                mean 50 (ties with Dedan)
 *   everyone else in the class: no marks, no subjects, no mean, no place
 *   Class mean S1: (80 + 80 + 71 + 0 + 50 + 50) / 6 = 331 / 6 = 55.17 -> 55;  S2: 60 (only Faith sat it)
 *   Position by mean: Aisha 80 = 1st, Brian 71 = 2nd, Faith 70 = 3rd, Dedan and Emma 50 share 4th, Cheche 0 = 6th; ranked 6.
 * Samuel's class: S1 66, 64 -> 65 -> B 9; he is the only one with marks, so mean 65, position 1 of 1, class mean 65.
 *
 * The known defects use it.fails: they pass while the defect exists and fail when it is fixed. Then change it.fails to it.
 */

const run = Date.now().toString(36);
let admin: SignedIn, teacher: SignedIn, parent: SignedIn, student: SignedIn, driver: SignedIn;
let tenantId = "", termId = "", exam1 = "", exam2 = "";
let school: ReportCardData["school"];
let faith = { id: "", classId: "" }, samuel = { id: "", classId: "" };
let subject1 = "", subject2 = "", name1 = "", name2 = "";
let others: string[] = []; // Aisha, Brian, Cheche, Dedan, Emma
let preparedFaithClass: ReportCardData[] = [];
let faithCard: StoredReportCard, samuelCard: StoredReportCard, aishaCard: StoredReportCard;

// ---------------------------------------------------------------- helpers

/** Points the app's own functions (which use the global client) at one signed-in role. */
let current: TestRole | null = null;
async function useAs(role: TestRole) {
  if (current === role) return;
  initSupabase({ url: assertLocalSupabaseUrl(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL).origin, anonKey: process.env.VITE_SUPABASE_ANON_KEY!, detectSessionInUrl: false });
  const { error } = await supabase().auth.signInWithPassword({ email: TEST_ROLES[role].email, password: TEST_ROLES[role].password });
  if (error) throw new Error(`could not sign in as ${role}: ${error.message}`);
  current = role;
}

type MarkRow = { tenant_id: string; exam_id: string; student_id: string; subject_id: string; score: number | null; entered_by: string; absence?: string };
const mark = (studentId: string, examId: string, subjectId: string, score: number | null, absence?: string): MarkRow =>
  ({ tenant_id: tenantId, exam_id: examId, student_id: studentId, subject_id: subjectId, score, entered_by: admin.userId, ...(absence ? { absence } : {}) });
const enter = async (rows: MarkRow[]) => {
  const { error } = await admin.client.from("marks").upsert(rows, { onConflict: "exam_id,student_id,subject_id" });
  if (error) throw new Error(`could not enter marks: ${error.message}`);
};
const publishMarks = async (examId: string, classId: string, subjectId: string) => {
  const { error } = await admin.client.rpc("publish_marks", { p_exam_id: examId, p_class_id: classId, p_subject_id: subjectId });
  if (error) throw new Error(`could not publish marks: ${error.message}`);
};
const auditFor = async (cardId: string) => {
  const { data, error } = await admin.client.from("audit_events").select("event").eq("tenant_id", tenantId).contains("metadata", { report_card_id: cardId }).order("created_at");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => r.event as string);
};
const cardFor = (cards: ReportCardData[], studentId: string) => cards.find((c) => c.learner.id === studentId)!;
const rowsOf = (card: ReportCardData) => card.subjects.map((s) => [s.name, s.scores, s.average, s.grade, s.points, s.classMean]);
/** The card as the database stores it, for one learner of a class, as staff read it. */
const storedFor = async (classId: string, studentId: string) => (await fetchClassReportCards(termId, classId)).find((c) => c.studentId === studentId)!;

// ---------------------------------------------------------------- set up

beforeAll(async () => {
  const signedIn = await Promise.all((["school_admin", "teacher", "parent", "student", "driver"] as const).map((r) => signInAs(r)));
  [admin, teacher, parent, student, driver] = signedIn as [SignedIn, SignedIn, SignedIn, SignedIn, SignedIn];
  tenantId = (await admin.client.from("profiles").select("tenant_id").eq("id", admin.userId).single()).data!.tenant_id as string;
  await admin.client.from("terms").delete().eq("tenant_id", tenantId).like("name", "QA09 rc %");

  const t = await admin.client.from("tenants").select("name, county, country, logo_url, accent").eq("id", tenantId).single();
  school = { name: t.data!.name as string, county: t.data!.county as string | null, country: t.data!.country as string, logoUrl: t.data!.logo_url as string | null, accent: t.data!.accent as string };

  const kids = await parent.client.from("students").select("id, class_id").order("admission_no");
  expect(kids.data, "the seeded parent has two children").toHaveLength(2);
  faith = { id: kids.data![0]!.id as string, classId: kids.data![0]!.class_id as string };
  samuel = { id: kids.data![1]!.id as string, classId: kids.data![1]!.class_id as string };
  expect(faith.classId, "the two children are in different classes").not.toBe(samuel.classId);

  const ta = await teacher.client.from("teaching_assignments").select("class_id, subject_id").eq("teacher_id", teacher.userId);
  const taught = (cls: string) => new Set((ta.data ?? []).filter((r) => r.class_id === cls).map((r) => r.subject_id as string));
  subject1 = [...taught(faith.classId)].find((s) => taught(samuel.classId).has(s))!;
  const second = await admin.client.from("subjects").select("id, name").eq("tenant_id", tenantId).neq("id", subject1).order("id").limit(1);
  subject2 = second.data![0]!.id as string;
  const names = await admin.client.from("subjects").select("id, name").in("id", [subject1, subject2]);
  name1 = names.data!.find((s) => s.id === subject1)!.name as string;
  name2 = names.data!.find((s) => s.id === subject2)!.name as string;

  const roster = await admin.client.from("students").select("id").eq("class_id", faith.classId).eq("active", true).neq("id", faith.id).order("id").limit(5);
  others = (roster.data ?? []).map((s) => s.id as string);
  expect(others).toHaveLength(5);

  const term = await admin.client.from("terms").insert({ tenant_id: tenantId, name: `QA09 rc ${run}`, year: 2036, index: 1, starts_on: "2036-01-05", ends_on: "2036-04-02", is_current: false }).select("id").single();
  if (term.error) throw new Error(`could not make the term: ${term.error.message}`);
  termId = term.data.id as string;
  const e1 = await admin.client.from("exams").insert({ tenant_id: tenantId, term_id: termId, name: `QA09 rc 1 CAT ${run}`, out_of: 100 }).select("id").single();
  const e2 = await admin.client.from("exams").insert({ tenant_id: tenantId, term_id: termId, name: `QA09 rc 2 End ${run}`, out_of: 100 }).select("id").single();
  if (e1.error || e2.error) throw new Error(`could not make the exams: ${e1.error?.message ?? e2.error?.message}`);
  exam1 = e1.data.id as string; exam2 = e2.data.id as string;
}, 60_000);

afterAll(async () => {
  if (admin && termId) await admin.client.from("terms").delete().eq("id", termId);
}, 60_000);

// ---------------------------------------------------------------- 1. the card is the gradebook's marks, worked out

describe("report cards: from the gradebook's marks to the card", () => {
  it("sets up the hand-worked marks, and publishes Samuel's class so that both exams count as 'results out'", async () => {
    const [aisha, brian, cheche, dedan, emma] = others as [string, string, string, string, string];
    await enter([
      mark(faith.id, exam1, subject1, 90), mark(faith.id, exam2, subject1, 70), mark(faith.id, exam1, subject2, 59), mark(faith.id, exam2, subject2, 60),
      mark(aisha, exam1, subject1, 80), mark(aisha, exam2, subject1, null, "missed"),
      mark(brian, exam1, subject1, 71),
      mark(cheche, exam1, subject1, 0), mark(cheche, exam2, subject1, 0),
      mark(dedan, exam1, subject1, null, "missed"), mark(dedan, exam2, subject1, 50),
      mark(emma, exam1, subject1, 50), mark(emma, exam2, subject1, 50),
      mark(samuel.id, exam1, subject1, 66), mark(samuel.id, exam2, subject1, 64),
    ]);
    await publishMarks(exam1, samuel.classId, subject1);
    await publishMarks(exam2, samuel.classId, subject1);
    await useAs("school_admin");
    const exams = await fetchTermExams(termId);
    expect(exams.map((e) => e.published), "what the screen ticks by default").toEqual([true, true]);
  });

  it("prepares Faith's class: every figure on every card is the hand-worked one", async () => {
    await useAs("school_admin");
    const exams = (await fetchTermExams(termId)).filter((e) => e.published).map((e) => e.id);
    preparedFaithClass = await prepareClassReportCards({ tenantId, school, termId, classId: faith.classId, examIds: exams, options: defaultReportCardOptions("kcse") });
    const [aisha, brian, cheche, dedan, emma] = others as [string, string, string, string, string];
    // subjects on a card are in alphabetical order of name
    const rows = (s1: unknown[] | null, s2: unknown[] | null) => [[name1, ...(s1 ?? [])], [name2, ...(s2 ?? [])]].filter((r, i) => (i === 0 ? s1 : s2) !== null).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(rowsOf(cardFor(preparedFaithClass, faith.id))).toEqual(rows([[90, 70], 80, "A", 12, 55], [[59, 60], 60, "B-", 8, 60]));
    expect(rowsOf(cardFor(preparedFaithClass, aisha))).toEqual(rows([[80, null], 80, "A", 12, 55], null));
    expect(rowsOf(cardFor(preparedFaithClass, brian))).toEqual(rows([[71, null], 71, "B+", 10, 55], null));
    expect(rowsOf(cardFor(preparedFaithClass, cheche))).toEqual(rows([[0, 0], 0, "E", 1, 55], null));
    expect(rowsOf(cardFor(preparedFaithClass, dedan))).toEqual(rows([[null, 50], 50, "C", 6, 55], null));
    expect(rowsOf(cardFor(preparedFaithClass, emma))).toEqual(rows([[50, 50], 50, "C", 6, 55], null));

    const summary = (id: string) => { const s = cardFor(preparedFaithClass, id).summary; return [s.subjectsSat, s.total, s.mean, s.grade, s.points, s.position, s.ranked]; };
    expect(summary(faith.id)).toEqual([2, 140, 70, "B+", 20, 3, 6]);
    expect(summary(aisha)).toEqual([1, 80, 80, "A", 12, 1, 6]);
    expect(summary(brian)).toEqual([1, 71, 71, "B+", 10, 2, 6]);
    expect(summary(cheche)).toEqual([1, 0, 0, "E", 1, 6, 6]);
    expect(summary(dedan)).toEqual([1, 50, 50, "C", 6, 4, 6]);
    expect(summary(emma)).toEqual([1, 50, 50, "C", 6, 4, 6]);

    const withMarks = new Set([faith.id, ...others]);
    const rest = preparedFaithClass.filter((c) => !withMarks.has(c.learner.id));
    expect(rest.length, "the rest of the class").toBe(preparedFaithClass.length - 6);
    for (const c of rest) expect(c, c.learner.name).toMatchObject({ subjects: [], summary: { mean: null, grade: null, position: null, subjectsSat: 0 } });
  });

  it("the card's marks are the marks the gradebook holds: read back from the marks table, learner by learner", async () => {
    const { data } = await admin.client.from("marks").select("student_id, exam_id, subject_id, score").in("exam_id", [exam1, exam2]).in("student_id", [faith.id, ...others]);
    const examOrder = [exam1, exam2];
    for (const card of preparedFaithClass.filter((c) => c.subjects.length)) {
      for (const subject of card.subjects) {
        const subjectId = subject.name === name1 ? subject1 : subject2;
        const fromGradebook = examOrder.map((e) => (data ?? []).find((r) => r.student_id === card.learner.id && r.exam_id === e && r.subject_id === subjectId)?.score ?? null);
        expect(subject.scores, `${card.learner.name} ${subject.name}`).toEqual(fromGradebook);
      }
    }
  });

  it("the card keeps what the gradebook shows for the learner: the mean on the card is the mean of the subject averages, graded by the same table", async () => {
    // The gradebook shows a grade per mark; the card shows one per average. For the learners with a single subject and a single mark that
    // counts (Aisha 80, Brian 71, Cheche 0, Dedan 50, Emma 50) the two must be the same line of the KCSE table.
    const table: [number, string][] = [[80, "A"], [71, "B+"], [0, "E"], [50, "C"]];
    for (const [score, grade] of table) {
      const card = preparedFaithClass.find((c) => c.summary.mean === score && c.subjects.length === 1)!;
      expect(card.summary.grade, `a mean of ${score}`).toBe(grade);
      expect(card.subjects[0]!.grade, `an average of ${score}`).toBe(grade);
    }
  });

  it("prepares Samuel's class too: he is alone with marks, so mean 65 (B, 9), 1st of 1, and the class mean of S1 is his own average", async () => {
    await useAs("school_admin");
    const examIds = (await fetchTermExams(termId)).map((e) => e.id);
    const cards = await prepareClassReportCards({ tenantId, school, termId, classId: samuel.classId, examIds, options: defaultReportCardOptions("kcse") });
    const s = cardFor(cards, samuel.id);
    expect(rowsOf(s)).toEqual([[name1, [66, 64], 65, "B", 9, 65]]);
    expect(s.summary).toMatchObject({ subjectsSat: 1, total: 65, mean: 65, grade: "B", points: 9, position: 1, ranked: 1 });
    const saved = await saveReportCards(tenantId, termId, samuel.classId, cards);
    expect(saved).toEqual({ saved: cards.length, skippedPublished: 0 });
    samuelCard = await storedFor(samuel.classId, samuel.id);
  });

  // KNOWN: the screen ticks every exam with "results out", and that is a fact about the exam, not about a class and subject. The cards
  // are then worked out from every mark in the chosen exams, published to the class or not.
  it.fails("FIG-1388 (open): a card carries only subjects whose marks were published to the class", async () => {
    const faithCardData = cardFor(preparedFaithClass, faith.id);
    const published = await admin.client.from("mark_publications").select("subject_id").eq("class_id", faith.classId).in("exam_id", [exam1, exam2]);
    expect(published.data, "nothing of Faith's class has been published").toHaveLength(0);
    expect(faithCardData.subjects.map((s) => s.name), "so the card has no subject rows yet").toEqual([]);
  });
});

// ---------------------------------------------------------------- 2. storing, comments, who may do what

describe("storing the cards, and who may change them", () => {
  it("saves one card per learner of the class, and the stored card is the prepared one", async () => {
    await useAs("school_admin");
    const result = await saveReportCards(tenantId, termId, faith.classId, preparedFaithClass);
    expect(result).toEqual({ saved: preparedFaithClass.length, skippedPublished: 0 });
    const stored = await fetchClassReportCards(termId, faith.classId);
    expect(stored).toHaveLength(preparedFaithClass.length);
    faithCard = stored.find((c) => c.studentId === faith.id)!;
    aishaCard = stored.find((c) => c.studentId === others[0])!;
    expect(faithCard.data).toEqual(cardFor(preparedFaithClass, faith.id));
    expect(faithCard).toMatchObject({ termId, classId: faith.classId, publishedAt: null, teacherComment: null, principalComment: null });
  });

  it("preparing again updates the drafts and keeps the comments", async () => {
    await useAs("school_admin");
    await saveReportCardComments(faithCard.id, { teacher: "  Steady work.  ", principal: "Well done." });
    const again = await prepareClassReportCards({ tenantId, school, termId, classId: faith.classId, examIds: [exam1, exam2], options: defaultReportCardOptions("kcse") });
    await saveReportCards(tenantId, termId, faith.classId, again);
    faithCard = await storedFor(faith.classId, faith.id);
    expect(faithCard).toMatchObject({ teacherComment: "Steady work.", principalComment: "Well done." });
  });

  it("the class teacher reads every draft card of the school but cannot write one, or send one out", async () => {
    await useAs("teacher");
    const read = await teacher.client.from("report_cards").select("id").eq("term_id", termId);
    expect(read.data!.length, "staff read the drafts of both classes").toBeGreaterThanOrEqual(preparedFaithClass.length + 1);
    const edit = await teacher.client.from("report_cards").update({ principal_comment: "Changed by the teacher" }).eq("id", faithCard.id).select("id");
    expect(edit.data ?? [], "an update through the API changes no row").toHaveLength(0);
    const send = await teacher.client.from("report_cards").update({ published_at: new Date().toISOString() }).eq("id", faithCard.id).select("id");
    expect(send.data ?? [], "sending a card out changes no row").toHaveLength(0);
    const after = await storedFor(faith.classId, faith.id);
    expect(after).toMatchObject({ principalComment: "Well done.", publishedAt: null });
  });

  it("the class teacher writes the class teacher's comment on their own class, and the comment is cut at 600 characters", async () => {
    await useAs("teacher");
    await saveTeacherComment(faithCard.id, "  Faith works hard and asks good questions.  ");
    expect((await storedFor(faith.classId, faith.id)).teacherComment).toBe("Faith works hard and asks good questions.");
    await saveTeacherComment(faithCard.id, "x".repeat(700));
    expect((await storedFor(faith.classId, faith.id)).teacherComment).toHaveLength(600);
    await saveTeacherComment(faithCard.id, "Faith works hard and asks good questions.");
  });

  it("the office, writing directly, is stopped at 600 characters by the database instead", async () => {
    const tooLong = await admin.client.from("report_cards").update({ principal_comment: "y".repeat(601) }).eq("id", faithCard.id);
    expect(tooLong.error?.code).toBe("23514");
  });

  it("a teacher who is not the class teacher cannot comment: Samuel's class has none", async () => {
    await useAs("teacher");
    await expect(saveTeacherComment(samuelCard.id, "A comment")).rejects.toThrow("Only the class teacher can comment on this report card.");
    expect((await storedFor(samuel.classId, samuel.id)).teacherComment).toBeNull();
  });

  it("a parent, a learner and a driver read no draft card, and a parent cannot change one", async () => {
    for (const who of [parent, student, driver]) {
      const read = await who.client.from("report_cards").select("id").eq("term_id", termId);
      expect(read.error).toBeNull();
      expect(read.data, who.role).toEqual([]);
    }
    const edit = await parent.client.from("report_cards").update({ teacher_comment: "I wrote this" }).eq("id", faithCard.id).select("id");
    expect(edit.data ?? []).toHaveLength(0);
    await useAs("parent");
    expect(await fetchMyReportCards([faith.id, samuel.id]), "the family screen").toEqual([]);
  });
});

// ---------------------------------------------------------------- 3. sending out, withdrawing, what the family holds

describe("sending report cards to families", () => {
  it("sending Faith's card out shows it to the parent and to Faith, and not Samuel's, and leaves an audit entry", async () => {
    await useAs("school_admin");
    await setReportCardsPublished([faithCard.id], true);
    await useAs("parent");
    const mine = await fetchMyReportCards([faith.id, samuel.id]);
    expect(mine.map((c) => c.studentId), "only the card that was sent").toEqual([faith.id]);
    expect(mine[0]!.data).toEqual(faithCard.data);
    expect(mine[0]!.teacherComment).toBe("Faith works hard and asks good questions.");
    await useAs("student");
    expect((await fetchMyReportCards([faith.id])).map((c) => c.studentId)).toEqual([faith.id]);
    expect(await auditFor(faithCard.id)).toEqual([`Report card published for ${faithCard.data.learner.name}`]);
  });

  it("another learner's sent card is not the parent's to read", async () => {
    await useAs("school_admin");
    await setReportCardsPublished([aishaCard.id], true);
    const asParent = await parent.client.from("report_cards").select("student_id").eq("term_id", termId);
    expect(asParent.data!.map((r) => r.student_id)).toEqual([faith.id]);
    const asStudent = await student.client.from("report_cards").select("student_id").eq("term_id", termId);
    expect(asStudent.data!.map((r) => r.student_id)).toEqual([faith.id]);
    await setReportCardsPublished([aishaCard.id], false);
  });

  it("the same numbers reach the family by both routes: the marks the class has published and the card", async () => {
    await publishMarks(exam1, faith.classId, subject1);
    await publishMarks(exam2, faith.classId, subject1);
    const marks = await parent.client.from("marks").select("exam_id, subject_id, score").eq("student_id", faith.id).in("exam_id", [exam1, exam2]);
    const seen = (e: string, s: string) => (marks.data ?? []).find((r) => r.exam_id === e && r.subject_id === s)?.score ?? null;
    await useAs("parent");
    const card = (await fetchMyReportCards([faith.id]))[0]!;
    const s1 = card.data.subjects.find((s) => s.name === name1)!;
    expect(s1.scores).toEqual([seen(exam1, subject1), seen(exam2, subject1)]);
    expect(s1.scores).toEqual([90, 70]);
    expect(s1).toMatchObject({ average: 80, grade: "A", points: 12 });
  });

  // What FIG-1388 leaves behind: the family holds a subject's marks on the card that the class never published as marks.
  it("(what the open defect leaves behind) the card shows the family S2 marks that the marks screen hides from them", async () => {
    const marks = await parent.client.from("marks").select("score").eq("student_id", faith.id).eq("subject_id", subject2).in("exam_id", [exam1, exam2]);
    expect(marks.data, "the marks screen: nothing for S2").toEqual([]);
    await useAs("parent");
    const card = (await fetchMyReportCards([faith.id]))[0]!;
    expect(card.data.subjects.find((s) => s.name === name2)).toMatchObject({ scores: [59, 60], average: 60, grade: "B-" });
  });

  it("the family's PDF prints the hand-worked card: rows, summary line and comments", async () => {
    await useAs("parent");
    const card = (await fetchMyReportCards([faith.id]))[0]!;
    const pages = await pdfPageTexts(await renderReportCardsPdf([{ data: card.data, teacherComment: card.teacherComment, principalComment: card.principalComment }]));
    expect(pages).toHaveLength(1);
    const lines = pages[0]!.split("\n");
    const row = (subject: string) => { const i = lines.indexOf(subject); return lines.slice(i, i + 7); };
    expect(row(name1)).toEqual([name1, "90", "70", "80", "A", "12", "55"]);
    expect(row(name2)).toEqual([name2, "59", "60", "60", "B-", "8", "60"]);
    expect(lines).toContain("Subjects: 2 · Total: 140 · Mean: 70% · Mean grade: B+ · Points: 20 · Position: 3 of 6");
    expect(lines).toContain("Faith works hard and asks good questions.");
    expect(lines).toContain("Well done.");
  });

  it("withdrawing hides the card again and leaves a second audit entry; sending again is a third; sending twice adds none", async () => {
    await useAs("school_admin");
    await setReportCardsPublished([faithCard.id], false);
    await useAs("parent");
    expect(await fetchMyReportCards([faith.id, samuel.id])).toEqual([]);
    await useAs("school_admin");
    await setReportCardsPublished([faithCard.id], true);
    await setReportCardsPublished([faithCard.id], true);
    const who = faithCard.data.learner.name;
    expect(await auditFor(faithCard.id)).toEqual([`Report card published for ${who}`, `Report card withdrawn for ${who}`, `Report card published for ${who}`]);
  });

  it("preparing the class again leaves a card that has gone out exactly as it was issued", async () => {
    await useAs("school_admin");
    const before = (await storedFor(faith.classId, faith.id));
    await enter([mark(faith.id, exam1, subject1, 100)]); // the mark is corrected after the card went out
    const again = await prepareClassReportCards({ tenantId, school, termId, classId: faith.classId, examIds: [exam1, exam2], options: defaultReportCardOptions("kcse") });
    expect(cardFor(again, faith.id).subjects.find((s) => s.name === name1)!.scores, "a new preparation sees the corrected mark").toEqual([100, 70]);
    expect(await saveReportCards(tenantId, termId, faith.classId, again)).toMatchObject({ skippedPublished: 1 });
    const after = await storedFor(faith.classId, faith.id);
    expect(after.data, "the card the family holds").toEqual(before.data);
    await enter([mark(faith.id, exam1, subject1, 90)]);
  });

  it("once a card has gone out the class teacher can no longer change their comment; the office still can", async () => {
    await useAs("teacher");
    await expect(saveTeacherComment(faithCard.id, "Changed after sending")).rejects.toThrow("This report card has gone out to the family.");
    await useAs("school_admin");
    await saveReportCardComments(faithCard.id, { principal: "Well done, Faith." });
    expect((await storedFor(faith.classId, faith.id)).principalComment).toBe("Well done, Faith.");
  });

  // KNOWN: only the screen's saveReportCards() leaves a sent card alone. The API lets the office rewrite the stored card in place,
  // so the grade the family downloads changes with no withdrawal and no audit entry. (A signature would show it: see e_signatures.)
  it.fails("FIG-1389 (open): a card that has gone out cannot be rewritten without a trace", async () => {
    await useAs("school_admin");
    const before = (await auditFor(faithCard.id)).length;
    const changed = { ...faithCard.data, summary: { ...faithCard.data.summary, mean: 99, grade: "A" } };
    const edit = await admin.client.from("report_cards").update({ data: changed }).eq("id", faithCard.id);
    const traced = edit.error !== null || (await auditFor(faithCard.id)).length > before;
    await admin.client.from("report_cards").update({ data: faithCard.data }).eq("id", faithCard.id); // put it back
    expect(traced, "the change was refused, or it left an audit entry").toBe(true);
  });
});
