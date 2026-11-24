import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLearnerActivities } from "../activities";
import { initBackend } from "../backend";
import { loadPublishedCbeResults } from "../cbeData";
import { NotOnApiError, parentCapabilities } from "../capabilities";
import { fetchChildrenEarlySignOuts } from "../earlySignOut";
import { fetchExamSubjects } from "../examResults";
import { loadParentHomework, setHomeworkDone } from "../homework";
import { fetchLearnerInventory } from "../inventory";
import { fetchChildMedical } from "../medical";
import { payWithMpesa } from "../mpesaPay";
import { loadParentData } from "../parentData";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import {
  apiFetchChildMaterials, apiFetchChildReportCards, apiFetchChildren, groupExams, levelOfChildClass, receiptsFromInvoices, subjectFromMark,
} from "./parentApi";
import { apiAnswerMedicationConsent, dayAndTime } from "./parentHealthApi";
import { apiFetchFamilyRides, ridesFromTransport, rideStatusText } from "./parentBusApi";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const K1 = "a1111111-1111-4111-8111-111111111111";
const K2 = "a2222222-2222-4222-8222-222222222222";
const CLS1 = "c1111111-1111-4111-8111-111111111111";
const CLS2 = "c2222222-2222-4222-8222-222222222222";
const INV1 = "b1111111-1111-4111-8111-111111111111";
const INV_OLD = "b2222222-2222-4222-8222-222222222222";
const TERM1 = "d1111111-1111-4111-8111-111111111111";
const TERM2 = "d2222222-2222-4222-8222-222222222222";
const SUBJ_MATH = "e1111111-1111-4111-8111-111111111111";
const SUBJ_ENG = "e2222222-2222-4222-8222-222222222222";
const PAY1 = "f1111111-1111-4111-8111-111111111111";
const PAY2 = "f2222222-2222-4222-8222-222222222222";

const P = `/v1/tenants/${T}`;
const kid = (learner = K1, name = "Amina Ochieng", adm = "ADM-1001", cls: unknown = { id: CLS1, name: "Form 2 West", form_level: 2, stream: "West", academic_year_id: "y" }) => ({
  learner_id: learner, full_name: name, admission_no: adm, boarding: false, relationship: "mother", is_primary_payer: true, class: cls,
});
const term = (id = TERM1, label = "Term 1, 2026") => ({ id, label });
const mark = (o: Record<string, unknown> = {}) => ({
  assessment_id: "as-1", title: "Mid-term", kind: "exam", status: "published", published_at: "2026-11-10T08:00:00Z", max_score: "100", score: "72",
  grade: "B", class_mean: "60.50", subject: { id: SUBJ_MATH, name: "Mathematics" }, term: term(), ...o,
});
const invoice = (o: Record<string, unknown> = {}) => ({
  id: INV1, term: term(), currency: "KES", due_on: "2026-12-15", status: "part_paid", lines_minor: 4_500_000, charges_minor: 50_000, adjustments_minor: 0,
  total_minor: 4_550_000, paid_minor: 1_000_000, balance_minor: 3_550_000, created_at: "2026-11-01T08:00:00Z", voided_at: null,
  lines: [{ name: "Tuition", amount_minor: 4_000_000 }, { name: "Boarding", amount_minor: 500_000 }],
  charges: [{ amount_minor: 50_000, reason: "Lost textbook", created_at: "2026-11-05T08:00:00Z" }],
  payments: [
    { id: PAY1, amount_minor: 1_000_000, method: "mpesa", status: "success", mpesa_receipt: "SKX1234", reference: null, failure_reason: null, created_at: "2026-11-02T08:00:00Z", completed_at: "2026-11-02T08:01:00Z" },
    { id: PAY2, amount_minor: 500_000, method: "mpesa", status: "failed", mpesa_receipt: null, reference: null, failure_reason: "cancelled", created_at: "2026-11-03T08:00:00Z", completed_at: null },
  ],
  proofs: [{ id: "pr-1", status: "rejected", txn_code: "QAB1", txn_amount_minor: 500_000, note: null, file_name: null, rejection_reason: "Wrong amount", created_at: "2026-11-04T08:00:00Z" }],
  ...o,
});
const attendance = (o: Record<string, unknown> = {}) => ({
  from: "2026-09-01", to: "2026-11-24",
  marks: [
    { date: "2026-11-02", session: "morning", mark: "present" },
    { date: "2026-11-03", session: "morning", mark: "absent" },
    { date: "2026-11-04", session: "morning", mark: "late" },
    { date: "2026-11-05", session: "morning", mark: "present" },
  ],
  counts: { morning: {}, afternoon: {} }, early_sign_outs: [], ...o,
});
const emptyResults = { marks: [], cbe_results: [] };

let api: FakeApi;
function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: "u-parent" }));
  setApiActiveTenant(T);
  return api;
}
const ok = (body: unknown): FakeReply => ({ body });
const refused = (status: number, code: string): FakeReply => ({ status, body: { error: { code, message: "no" } } });
const per = (learner: string, tail: string) => `GET ${P}/me/children/${learner}/${tail}`;

afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

describe("the class level of a child", () => {
  it("reads the class name first, then an unambiguous year, then what the child has results in", () => {
    expect(levelOfChildClass({ name: "Form 2 West", form_level: 2 })).toBe("secondary");
    expect(levelOfChildClass({ name: "PP1 Blue", form_level: 1 })).toBe("pre_primary");
    expect(levelOfChildClass({ name: "Grade 4 East", form_level: 4 })).toBe("primary");
    expect(levelOfChildClass({ name: "East", form_level: 8 })).toBe("junior_secondary");
    expect(levelOfChildClass({ name: "East", form_level: 11 })).toBe("senior_school");
    expect(levelOfChildClass({ name: "East", form_level: 5 })).toBe("primary");
    expect(levelOfChildClass({ name: "2 East", form_level: 2 }, { cbe: true, marks: false })).toBe("primary");
    expect(levelOfChildClass({ name: "2 East", form_level: 2 }, { cbe: true, marks: true })).toBe("secondary");
    expect(levelOfChildClass({ name: "2 East", form_level: 2 })).toBe("secondary");
    expect(levelOfChildClass(null)).toBe("secondary");
  });
});

describe("marks and exams", () => {
  it("turns a mark into a percentage and keeps what the teacher wrote and the school's own grade", () => {
    expect(subjectFromMark(mark({ max_score: "50", score: "40", class_mean: "30", grade: "A" }) as never)).toEqual({
      name: "Mathematics", score: 80, classMean: 60, grade: "A", rawScore: 40, maxScore: 50,
    });
    expect(subjectFromMark(mark({ class_mean: null }) as never)).toMatchObject({ score: 72, classMean: null });
  });

  it("groups assessments of one title and term into an exam, newest first, and names two terms apart", () => {
    const marks = [
      mark({ subject: { id: SUBJ_MATH, name: "Mathematics" } }),
      mark({ assessment_id: "as-2", subject: { id: SUBJ_ENG, name: "English" }, published_at: "2026-11-11T08:00:00Z" }),
      mark({ assessment_id: "as-3", title: "Opener", term: term(TERM2, "Term 2, 2026"), published_at: "2026-05-01T08:00:00Z" }),
    ];
    const groups = groupExams(marks as never);
    expect(groups.map((g) => [g.exam.name, g.exam.subjectCount])).toEqual([["Mid-term, Term 1, 2026", 2], ["Opener, Term 2, 2026", 1]]);
    expect(groups[0]!.subjects.map((s) => s.name)).toEqual(["English", "Mathematics"]);
    expect(groupExams([mark()] as never)[0]!.exam.name).toBe("Mid-term");
  });

  it("lists the receipts that succeeded, newest first, never a voided invoice's", () => {
    const rows = receiptsFromInvoices([invoice(), invoice({ id: INV_OLD, voided_at: "2026-10-01T00:00:00Z" })] as never);
    expect(rows).toEqual([{ id: PAY1, amount: 1_000_000, when: "2 Nov", ref: "SKX1234" }]);
  });
});

describe("loadParentData on the API", () => {
  it("builds each child from the family reads only, with money in cents", async () => {
    boot({
      [`GET ${P}/me/children`]: ok({ children: [kid(K2, "Zawadi Ochieng", "ADM-1002"), kid()] }),
      [per(K1, "fees")]: ok({ invoices: [invoice({ id: INV_OLD, voided_at: "2026-11-30T00:00:00Z", status: "voided" }), invoice(), invoice({ id: "older", term: term(TERM2, "Term 3, 2025"), payments: [] })] }),
      [per(K1, "attendance")]: ok({ attendance: attendance() }),
      [per(K1, "results")]: ok({ marks: [mark(), mark({ assessment_id: "as-2", subject: { id: SUBJ_ENG, name: "English" }, score: "80", class_mean: null, grade: "A" })], cbe_results: [] }),
      [per(K2, "fees")]: ok({ invoices: [] }),
      [per(K2, "attendance")]: ok({ attendance: attendance({ marks: [] }) }),
      [per(K2, "results")]: ok(emptyResults),
    });
    const data = await loadParentData("profile-id");
    expect(api.calls.every((c) => c.path.startsWith(`${P}/me/children`))).toBe(true);
    expect(data.children.map((c) => c.adm)).toEqual(["ADM-1001", "ADM-1002"]);
    expect(data.termLabel).toBe("Term 1, 2026");
    const [amina, zawadi] = data.children;
    expect(amina).toMatchObject({
      id: K1, first: "Amina", cls: "Form 2 West", classId: CLS1, classLevel: "secondary", formLevel: 2, invoiceId: INV1, balance: 3_550_000, billed: 4_550_000,
      dueOn: "2026-12-15", attendancePct: 75, absentDates: ["2026-11-03"], mean: 76, examName: "Mid-term",
    });
    expect(amina!.feeLines).toEqual([{ id: `${INV1}:line:0`, name: "Tuition", amountCents: 4_000_000 }, { id: `${INV1}:line:1`, name: "Boarding", amountCents: 500_000 }]);
    expect(amina!.charges).toMatchObject([{ invoiceId: INV1, studentId: K1, amountCents: 50_000, reason: "Lost textbook", voidedAt: null }]);
    expect(amina!.receipts).toHaveLength(1);
    expect(amina!.proofs).toMatchObject([{ id: "pr-1", invoice_id: INV1, status: "rejected", rejection_reason: "Wrong amount", file_path: null, txn_amount_cents: 500_000 }]);
    expect(amina!.subjects.map((s) => [s.name, s.score, s.classMean, s.grade])).toEqual([["English", 80, null, "A"], ["Mathematics", 72, 60.5, "B"]]);
    expect(zawadi).toMatchObject({ invoiceId: null, balance: 0, billed: 0, attendancePct: null, mean: null, examId: null, exams: [], receipts: [], feeLines: [] });
    expect(data.messages).toEqual([]);
    expect(data.feeItems).toEqual([]);
  });

  it("leaves an afternoon absence after an early sign-out out of the figures", async () => {
    boot({
      [`GET ${P}/me/children`]: ok({ children: [kid()] }),
      [per(K1, "fees")]: ok({ invoices: [] }),
      [per(K1, "attendance")]: ok({
        attendance: attendance({
          marks: [
            { date: "2026-11-02", session: "morning", mark: "present" },
            { date: "2026-11-02", session: "afternoon", mark: "absent" },
            { date: "2026-11-03", session: "morning", mark: "present" },
            { date: "2026-11-03", session: "afternoon", mark: "present" },
          ],
          early_sign_outs: [{ id: "so-1", date: "2026-11-02", signed_out_at: "2026-11-02T10:00:00Z", reason: "Clinic", collected_by_name: "Mary", collected_by_relationship: "mother" }],
        }),
      }),
      [per(K1, "results")]: ok(emptyResults),
    });
    const [child] = (await loadParentData("p")).children;
    expect(child).toMatchObject({ attendancePct: 100, absentDates: [] });
  });

  it("answers no children, and makes no per-child call, when the link has been revoked", async () => {
    boot({ [`GET ${P}/me/children`]: ok({ children: [] }) });
    expect((await loadParentData("p")).children).toEqual([]);
    expect(api.calls).toHaveLength(1);
  });

  it("reads a child with no class as having none", async () => {
    boot({
      [`GET ${P}/me/children`]: ok({ children: [kid(K1, "Amina Ochieng", "ADM-1001", null)] }),
      [per(K1, "fees")]: ok({ invoices: [] }),
      [per(K1, "attendance")]: ok({ attendance: attendance({ marks: [] }) }),
      [per(K1, "results")]: ok(emptyResults),
    });
    expect((await loadParentData("p")).children[0]).toMatchObject({ cls: "", classId: "", formLevel: 1, classLevel: "secondary" });
  });

  it("fails the load when one of a child's reads is refused", async () => {
    boot({
      [`GET ${P}/me/children`]: ok({ children: [kid()] }),
      [per(K1, "fees")]: refused(404, "not_found"),
      [per(K1, "attendance")]: ok({ attendance: attendance() }),
      [per(K1, "results")]: ok(emptyResults),
    });
    await expect(loadParentData("p")).rejects.toMatchObject({ status: 404 });
  });

  it("reads one exam's subjects again for the exam switcher", async () => {
    boot({ [per(K1, "results")]: ok({ marks: [mark(), mark({ title: "Opener", assessment_id: "as-9", term: term(TERM2, "Term 2, 2026"), score: "50" })], cbe_results: [] }) });
    const exam = groupExams([mark(), mark({ title: "Opener", term: term(TERM2, "Term 2, 2026") })] as never).find((g) => g.exam.name.startsWith("Opener"))!;
    expect(await fetchExamSubjects(K1, CLS1, exam.exam.id)).toEqual([{ name: "Mathematics", score: 50, classMean: 60.5 }]);
    expect(await fetchExamSubjects(K1, CLS1, "no-such-exam")).toEqual([]);
  });
});

describe("CBE results on the API", () => {
  const strand = (id: string, name: string) => ({ id, name });
  const cbe = (o: Record<string, unknown>) => ({
    cbe_assessment_id: "cb-1", title: "Number work", status: "published", published_at: "2026-11-01T08:00:00Z", assessment_date: "2026-10-30",
    learning_area: { id: "la-1", name: "Mathematics" }, strand: strand("s-1", "Numbers"), level_code: "ME", points: "3", teacher_feedback: null, term: term(), ...o,
  });

  it("keeps the latest assessment of each learning area, with its strands and the teacher's words", async () => {
    boot({
      [`GET ${P}/me/children`]: ok({ children: [kid(K1, "Amina Ochieng", "ADM-1001", { id: CLS1, name: "Grade 4 East", form_level: 4, stream: null, academic_year_id: "y" })] }),
      [per(K1, "results")]: ok({
        marks: [],
        cbe_results: [
          cbe({ cbe_assessment_id: "cb-old", assessment_date: "2026-05-01", level_code: "BE" }),
          cbe({}),
          cbe({ strand: strand("s-2", "Geometry"), level_code: "EE", teacher_feedback: "Keep going" }),
          cbe({ cbe_assessment_id: "cb-2", title: "Reading", learning_area: { id: "la-2", name: "English" }, strand: null, level_code: "AE" }),
        ],
      }),
    });
    const out = (await loadPublishedCbeResults([K1], "KE")).get(K1)!;
    expect(out.map((a) => [a.subjectName, a.assessmentTitle, a.assessedOn, a.comment])).toEqual([["English", "Reading", "2026-10-30", null], ["Mathematics", "Number work", "2026-10-30", "Keep going"]]);
    expect(out[1]!.strands.map((s) => [s.name, s.code])).toEqual([["Geometry", "EE"], ["Numbers", "ME"]]);
    expect(out[1]!.overall?.code).toBe("EE");
    expect(out[1]!.strands[0]!.label).toBe("Exceeding expectations");
    expect(out[0]!.strands[0]!.name).toBe("Overall");
  });

  it("answers nothing for a learner who is not the caller's child", async () => {
    boot({ [`GET ${P}/me/children`]: ok({ children: [] }) });
    expect((await loadPublishedCbeResults([K1], "KE")).size).toBe(0);
    expect(api.callsTo(`GET ${P}/me/children/${K1}/results`)).toHaveLength(0);
  });
});

describe("homework, materials, activities, items", () => {
  it("lists homework with no done state, and refuses to mark it done", async () => {
    boot({
      [per(K1, "homework")]: ok({ from: "2026-11-03", homework: [{ id: "hw-1", title: "Fractions", body: "Page 20", due_on: "2026-11-30", term_id: TERM1, subject: { id: SUBJ_MATH, name: "Mathematics" }, created_at: "2026-11-20T08:00:00Z" }] }),
    });
    const out = await loadParentHomework("p", [K1]);
    expect(out[K1]).toMatchObject({ parentMarksDone: false, items: [{ id: "hw-1", subject: "Mathematics", teacher: "", handIn: null, done: false, doneBy: null, hasFile: false, dueOn: "2026-11-30" }] });
    await expect(setHomeworkDone("hw-1", K1, true)).rejects.toBeInstanceOf(NotOnApiError);
  });

  it("lists a child's materials by subject, with files unavailable", async () => {
    boot({
      [per(K1, "materials")]: ok({ materials: [
        { id: "m-1", title: "Notes", description: null, subject: { id: SUBJ_MATH, name: "Mathematics" }, storage_status: "metadata_only", created_at: "2026-11-01T00:00:00Z" },
        { id: "m-2", title: "Revision", description: "Read it", subject: null, storage_status: "available", created_at: "2026-11-02T00:00:00Z" },
      ] }),
    });
    expect(await apiFetchChildMaterials(K1)).toEqual([
      { id: "m-1", title: "Notes", description: null, subject: "Mathematics", createdAt: "2026-11-01T00:00:00Z", fileAvailable: false },
      { id: "m-2", title: "Revision", description: "Read it", subject: "General", createdAt: "2026-11-02T00:00:00Z", fileAvailable: true },
    ]);
  });

  it("lists clubs and teams only", async () => {
    boot({
      [per(K1, "activities")]: ok({ activities: [
        { activity_id: "ac-2", name: "Chess", category: "mystery", description: "", meeting_schedule: "Thursdays", active: true, role: "Captain", joined_on: "2026-02-01", patrons: ["Mr Kamau"] },
        { activity_id: "ac-1", name: "Athletics", category: "sport", description: "", meeting_schedule: "", active: false, role: null, joined_on: "2026-01-20", patrons: [] },
      ] }),
    });
    const out = await loadLearnerActivities(T, K1);
    expect(out.clubs.map((c) => [c.activity.name, c.activity.category, c.activity.active, c.role])).toEqual([["Athletics", "sport", false, null], ["Chess", "other", true, "Captain"]]);
    expect(out.clubs[1]!.activity.patrons).toEqual([{ id: "Mr Kamau", name: "Mr Kamau" }]);
    expect(out.upcoming).toEqual([]);
    expect(out.achievements).toEqual([]);
  });

  it("lists issued items of the caller's own children, newest first, and none for another child", async () => {
    boot({
      [`GET ${P}/me/children`]: ok({ children: [kid()] }),
      [per(K1, "items")]: ok({ items: [
        { id: "i-1", item: { name: "Biology Form 2", category: "textbooks", asset_tag: "BIO-1" }, quantity: 1, issued_at: "2026-02-01T08:00:00Z", due_on: "2026-12-01", status: "out", condition_out: "good", returned_condition: null, closed_at: null },
        { id: "i-2", item: { name: "Atlas", category: "unheard-of", asset_tag: null }, quantity: 1, issued_at: "2026-03-01T08:00:00Z", due_on: null, status: "returned", condition_out: "good", returned_condition: "fair", closed_at: "2026-06-01T00:00:00Z" },
      ] }),
    });
    const rows = await fetchLearnerInventory([K1, K2]);
    expect(rows.map((r) => [r.itemName, r.itemCategory, r.status, r.returned_condition, r.holderName, r.holderDetail])).toEqual([
      ["Atlas", "other", "returned", "fair", "Amina Ochieng", "ADM ADM-1001"],
      ["Biology Form 2", "textbooks", "out", null, "Amina Ochieng", "ADM ADM-1001"],
    ]);
    expect(api.callsTo(`GET ${P}/me/children/${K2}/items`)).toHaveLength(0);
  });
});

describe("early sign-outs and report cards", () => {
  it("shows today's sign-outs of the children, with no collector ID or phone", async () => {
    boot({
      [`GET ${P}/me/children`]: ok({ children: [kid()] }),
      [per(K1, "attendance")]: (call) => ok({
        attendance: attendance({
          marks: [], from: call.query.get("from"), to: call.query.get("to"),
          early_sign_outs: [
            { id: "so-1", date: "2026-11-24", signed_out_at: "2026-11-24T09:30:00Z", reason: "Clinic", collected_by_name: "Mary Ochieng", collected_by_relationship: "mother" },
            { id: "so-0", date: "2026-11-23", signed_out_at: "2026-11-23T09:30:00Z", reason: "Dentist", collected_by_name: "Mary Ochieng", collected_by_relationship: "mother" },
          ],
        }),
      }),
    });
    const rows = await fetchChildrenEarlySignOuts([K1], "2026-11-24");
    expect(api.callsTo(per(K1, "attendance").replace("GET ", "GET "))[0]!.query.get("from")).toBe("2026-11-24");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "so-1", student_id: K1, student_name: "Amina Ochieng", reason: "Clinic", collected_by_name: "Mary Ochieng", voided_at: null });
    expect(JSON.stringify(rows[0])).not.toMatch(/phone|id_number/);
    expect(await fetchChildrenEarlySignOuts([], "2026-11-24")).toEqual([]);
  });

  it("maps report cards to the child's own summary, newest first", async () => {
    boot({
      [per(K1, "report-cards")]: ok({ report_cards: [
        { id: "rc-1", published_at: "2026-04-01T00:00:00Z", term: term(), class: { id: CLS1, name: "Form 2 West" }, method: "mean", grading_scheme_name: "KCSE", summary: { sum: "450", count: 6, average: "75", grade: "B+" }, cbe_results: [], competencies: [] },
        { id: "rc-2", published_at: "2026-08-01T00:00:00Z", term: term(TERM2, "Term 2, 2026"), class: { id: CLS1, name: "Form 2 West" }, method: null, grading_scheme_name: null, summary: null,
          cbe_results: [{ cbe_assessment_id: "c", title: "Number work", level_code: "ME1", points: "6", teacher_feedback: "Good" }], competencies: [{ kind: "value", item: "Respect", level_code: "ME" }] },
      ] }),
    });
    const cards = await apiFetchChildReportCards(K1);
    expect(cards.map((c) => c.id)).toEqual(["rc-2", "rc-1"]);
    expect(cards[1]).toMatchObject({ termLabel: "Term 1, 2026", className: "Form 2 West", summary: { sum: 450, count: 6, average: 75, grade: "B+" } });
    expect(cards[0]).toMatchObject({ summary: null, cbe: [{ title: "Number work", levelCode: "ME1", points: 6, feedback: "Good" }], competencies: [{ kind: "value", item: "Respect", levelCode: "ME" }] });
  });
});

describe("health on the API", () => {
  const health = {
    profile: { blood_group: "O+", allergies: ["Peanuts"], chronic_conditions: [], dietary_notes: null, emergency_notes: "Call mum", updated_at: "2026-11-01T00:00:00Z" },
    medication_authorizations: [
      { id: "au-1", medication_name: "Amoxicillin", dosage_instruction: "250mg", frequency_instruction: "Twice a day", route: "oral", start_date: "2026-11-10", end_date: "2026-11-20", status: "approved", guardian_consent_status: "granted", guardian_consent_at: "2026-11-09T08:00:00Z", rejection_reason: null, created_at: "2026-11-08T08:00:00Z" },
      { id: "au-2", medication_name: "Ibuprofen", dosage_instruction: "200mg", frequency_instruction: "If needed", route: "oral", start_date: "2026-11-24", end_date: "2026-11-30", status: "pending_consent", guardian_consent_status: "pending", guardian_consent_at: null, rejection_reason: null, created_at: "2026-11-23T08:00:00Z" },
    ],
    medication_schedules: [{ id: "sc-1", authorization_id: "au-1", schedule_times: ["08:00", "16:00"], window_minutes: 30 }],
    medication_administrations: [
      { id: "ma-1", authorization_id: "au-1", scheduled_for: "2026-11-11T05:00:00Z", administered_at: "2026-11-11T05:02:00Z", outcome: "administered", exception_reason: null },
      { id: "ma-2", authorization_id: "au-1", scheduled_for: "2026-11-12T05:00:00Z", administered_at: null, outcome: "held", exception_reason: "Child unwell" },
    ],
    sick_bay_visits: [{ id: "v-1", time_in: "2026-11-12T07:00:00Z", time_out: null, complaint: "Headache", temperature_c: "37.8", pulse_bpm: 80, observations: null, assessment: "Mild", treatment: "Rest", outcome: "rest", referred_to: null, follow_up: null }],
  };

  it("maps visits, schedules and doses onto the Health page's types and keeps the profile and consent requests", async () => {
    boot({ [per(K1, "health")]: ok({ health }) });
    const m = await fetchChildMedical(K1);
    expect(m.visits).toMatchObject([{ id: "v-1", complaint: "Headache", temperature_c: 37.8, outcome: "rest", student_id: K1, tenant_id: T }]);
    expect(m.schedules).toMatchObject([{ id: "sc-1", drug: "Amoxicillin", dose: "250mg", times: ["08:00", "16:00"], starts_on: "2026-11-10", ends_on: "2026-11-20", stopped_at: null }]);
    expect(m.doses.map((d) => [d.due_on, d.due_time, d.status, d.label, d.note])).toEqual([
      ["2026-11-12", "08:00", "missed", "Held", "Child unwell"],
      ["2026-11-11", "08:00", "given", "Given", null],
    ]);
    expect(m.notices).toEqual([]);
    expect(m.requests).toEqual([]);
    expect(m.family?.profile).toMatchObject({ bloodGroup: "O+", allergies: ["Peanuts"], emergencyNotes: "Call mum" });
    expect(m.family?.authorizations.map((a) => [a.id, a.consent, a.status])).toEqual([["au-1", "granted", "approved"], ["au-2", "pending", "pending_consent"]]);
  });

  it("gives the school's time of day, not the browser's", () => {
    expect(dayAndTime("2026-11-11T21:30:00Z")).toEqual({ day: "2026-11-12", time: "00:30" });
  });

  it("answers a medicine's consent request with the existing consent endpoint", async () => {
    boot({ [`POST ${P}/health/medications/authorizations/au-2/consent`]: ok({}) });
    await apiAnswerMedicationConsent("au-2", "granted");
    await apiAnswerMedicationConsent("au-2", "declined", "Not now");
    const calls = api.callsTo(`POST ${P}/health/medications/authorizations/au-2/consent`);
    expect(calls.map((c) => c.body)).toEqual([{ decision: "granted" }, { decision: "declined", note: "Not now" }]);
  });
});

describe("buses on the API", () => {
  const row = (o: Record<string, unknown> = {}) => ({
    learner_id: K1, learner_name: "Amina Ochieng", assigned: true, route: { id: "r-1", name: "Route A" }, stop: { id: "st-1", name: "Gate 3" }, vehicle_plate: "KDA 123A",
    driver_first_name: "Peter", active_trip: { id: "t-1", direction: "to_school", started_at: "2026-11-24T04:30:00Z", learner_status: "boarded", learner_status_at: "2026-11-24T04:50:00Z" },
    location: { status: "live", lat: -1.28, lng: 36.82, recorded_at: "2026-11-24T05:00:00Z", age_seconds: 12 }, ...o,
  });

  it("reads the transport answer defensively", () => {
    const rides = ridesFromTransport({ children: [row(), { nothing: true }, row({ learner_id: K2, assigned: false, route: null, stop: null, vehicle_plate: null, driver_first_name: null, active_trip: null, location: null })] });
    expect(rides).toHaveLength(2);
    expect(rides[0]).toMatchObject({ learnerId: K1, route: { name: "Route A" }, stop: { name: "Gate 3" }, vehiclePlate: "KDA 123A", driverFirstName: "Peter", trip: { status: "boarded" }, location: { status: "live", lat: -1.28 } });
    expect(rides[1]).toMatchObject({ assigned: false, route: null, trip: null, location: null });
    expect(ridesFromTransport(null)).toEqual([]);
    expect(ridesFromTransport({ children: [row({ active_trip: { id: "t", learner_status: "odd" }, location: { status: "elsewhere" } })] })[0]).toMatchObject({ trip: { status: "waiting" }, location: { status: "unavailable", lat: null } });
  });

  it("says in words where the child is", async () => {
    boot({ [`GET ${P}/me/transport`]: ok({ children: [row(), row({ learner_id: K2, active_trip: null, location: null })] }) });
    const rides = await apiFetchFamilyRides();
    expect(rideStatusText(rides[0]!)).toMatch(/^On the bus \(got on at/);
    expect(rideStatusText(rides[1]!)).toBe("The bus is not on a trip right now.");
  });
});

describe("paying by M-Pesa from a parent's account", () => {
  const started = (o: Record<string, unknown> = {}) => ({ payment: { id: PAY1, status: "pending", ...o }, reused: false });
  const feesWith = (status: string, extra: Record<string, unknown> = {}) => ok({ invoices: [invoice({ payments: [{ ...invoice().payments[0], id: PAY1, status, ...extra }] })] });
  const input = { invoiceId: INV1, amountCents: 100_000, msisdn: "254712345678", learnerId: K1 };
  const fast = { intervalMs: 1, timeoutMs: 500 };

  it("asks for the prompt in cents and reads the result back from the child's fees", async () => {
    let reads = 0;
    boot({
      [`POST ${P}/finance/mpesa/prompts`]: { status: 201, body: started() },
      [per(K1, "fees")]: () => (++reads < 3 ? { body: { invoices: [invoice({ payments: [{ ...invoice().payments[0], id: PAY1, status: "pending", mpesa_receipt: null }] })] } } : { body: { invoices: [invoice({ payments: [{ ...invoice().payments[0], id: PAY1, status: "success", mpesa_receipt: "SKX9999" }] })] } }),
    });
    const prompted = vi.fn();
    expect(await payWithMpesa(input, { ...fast, onPrompted: prompted })).toEqual({ kind: "success", receipt: "SKX9999" });
    expect(prompted).toHaveBeenCalledOnce();
    expect(api.callsTo(`POST ${P}/finance/mpesa/prompts`)[0]!.body).toEqual({ invoice_id: INV1, amount_minor: 100_000, msisdn: "254712345678" });
    expect(api.callsTo(`GET ${P}/finance/payments/${PAY1}`)).toHaveLength(0);
  });

  it("reports a failed prompt with its reason, and no money moved", async () => {
    boot({ [`POST ${P}/finance/mpesa/prompts`]: { status: 201, body: started() }, [per(K1, "fees")]: feesWith("failed", { failure_reason: "insufficient" }) });
    expect(await payWithMpesa(input, fast)).toEqual({ kind: "failed", reason: "insufficient" });
  });

  it("says unconfirmed, not failed, when no answer comes in time", async () => {
    boot({ [`POST ${P}/finance/mpesa/prompts`]: { status: 201, body: started() }, [per(K1, "fees")]: feesWith("pending", { mpesa_receipt: null }) });
    expect(await payWithMpesa(input, { intervalMs: 1, timeoutMs: 20 })).toEqual({ kind: "unconfirmed" });
  });

  it("finds the child by the invoice when the caller did not say", async () => {
    boot({
      [`GET ${P}/me/children`]: ok({ children: [kid(K2, "Zawadi", "ADM-1002"), kid()] }),
      [`POST ${P}/finance/mpesa/prompts`]: { status: 201, body: started() },
      [per(K2, "fees")]: ok({ invoices: [] }),
      [per(K1, "fees")]: feesWith("success"),
    });
    expect(await payWithMpesa({ ...input, learnerId: undefined }, fast)).toMatchObject({ kind: "success" });
  });

  it("is unavailable when M-Pesa is not set up, a refusal when the server says no, a failure when the provider refuses", async () => {
    boot({ [`POST ${P}/finance/mpesa/prompts`]: refused(503, "service_unavailable") });
    expect(await payWithMpesa(input, fast)).toEqual({ kind: "unavailable" });
    api.on(`POST ${P}/finance/mpesa/prompts`, refused(409, "conflict"));
    expect(await payWithMpesa(input, fast)).toMatchObject({ kind: "rejected" });
    api.on(`POST ${P}/finance/mpesa/prompts`, refused(403, "forbidden"));
    expect(await payWithMpesa(input, fast)).toMatchObject({ kind: "rejected" });
    api.on(`POST ${P}/finance/mpesa/prompts`, { status: 502, body: { payment: { id: PAY1, status: "failed" }, reused: false } });
    expect(await payWithMpesa(input, fast)).toEqual({ kind: "failed", reason: "unreachable" });
  });

  it("stops watching when the screen is closed, and the payment carries on", async () => {
    boot({ [`POST ${P}/finance/mpesa/prompts`]: { status: 201, body: started() }, [per(K1, "fees")]: feesWith("pending", { mpesa_receipt: null }) });
    const controller = new AbortController();
    const pending = payWithMpesa(input, { intervalMs: 5, timeoutMs: 5_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 15);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("what a parent can do on each backend", () => {
  it("hides on the API what its family reads do not carry", () => {
    initBackend({ kind: "supabase" });
    const sb = parentCapabilities();
    expect(sb).toMatchObject({ homeworkDone: true, paymentProofSubmit: true, signatures: true, calls: true, familyReportCards: false, medicationConsent: false });
    initBackend({ kind: "api", apiUrl: BASE });
    const on = parentCapabilities();
    expect(on).toMatchObject({ homeworkDone: false, paymentProofSubmit: false, signatures: false, calls: false, childProfile: false, examPapers: false, reportCardPdf: false, familyReportCards: true, medicationConsent: true });
    // Every flag the API turns on is one of the two the API alone has.
    expect(Object.entries(on).filter(([, v]) => v).map(([k]) => k).sort()).toEqual(["familyReportCards", "medicationConsent"]);
  });

  it("does not call the family endpoints off the API build", async () => {
    initBackend({ kind: "api", apiUrl: BASE });
    boot({ [`GET ${P}/me/children`]: ok({ children: [] }) });
    expect(await apiFetchChildren()).toEqual([]);
  });
});
