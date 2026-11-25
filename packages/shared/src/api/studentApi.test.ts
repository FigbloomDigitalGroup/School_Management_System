import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { loadPublishedCbeResults } from "../cbeData";
import { NotOnApiError, parentCapabilities, studentCapabilities } from "../capabilities";
import { fetchStudentSchedule } from "../courses";
import { fetchStudentCourseResults } from "../courseGrades";
import { fetchOwnLearnerInventory } from "../inventory";
import { askTutor } from "../ai";
import { fetchChatContacts, fetchMyConversations } from "../chat";
import { payWithMpesa } from "../mpesaPay";
import { loadStudentData, loadStudentFeeData, markAssignmentHandedIn, markStudentNoticeRead } from "../studentData";
import { currentPeriodIndex, fetchClassTimetable } from "../timetable";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { apiActiveRole, apiFetchOwnLearner, forgetOwnLearner, setApiActiveRole } from "./ownLearner";
import { resetDirectory } from "./directoryApi";
import { apiFetchChildren } from "./parentApi";
import { workItemFromFamily, weekFromFamilyTimetable } from "./studentApi";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const L = "a1111111-1111-4111-8111-111111111111";
const CLS = "c1111111-1111-4111-8111-111111111111";
const TERM = "d1111111-1111-4111-8111-111111111111";
const SUBJ_MATH = "e1111111-1111-4111-8111-111111111111";
const SUBJ_ENG = "e2222222-2222-4222-8222-222222222222";
const P = `/v1/tenants/${T}`;

const learner = (over: Record<string, unknown> = {}) => ({
  learner_id: L, full_name: "Amina Ochieng", admission_no: "ADM-1001", boarding: false, login_id: "ST-0001",
  class: { id: CLS, name: "Form 2 West", form_level: 2, stream: "West", academic_year_id: "y" }, ...over,
});
const term = { id: TERM, label: "Term 1, 2026" };
const mark = (o: Record<string, unknown> = {}) => ({
  assessment_id: "as-1", title: "Mid-term", kind: "exam", status: "published", published_at: "2026-11-10T08:00:00Z", max_score: "100", score: "72",
  grade: "B", class_mean: "60.50", subject: { id: SUBJ_MATH, name: "Mathematics" }, term, ...o,
});
const homework = (id: string, due: string, o: Record<string, unknown> = {}) => ({
  id, title: `Work ${id}`, body: "Do it.", due_on: due, term_id: TERM, subject: { id: SUBJ_MATH, name: "Mathematics" }, created_at: "2026-11-01T08:00:00Z", ...o,
});
const inboxItem = (id: string, kind: string, at: string) => ({
  id, tenant_id: T, author_id: "staff-1", subject: `Notice ${id}`, body: "Body", audience: { kind }, status: "published", published_at: at, created_at: at,
});

let api: FakeApi;
function boot(routes: Record<string, FakeRoute>, role: string | null = "student") {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: "u-student" }));
  setApiActiveTenant(T);
  setApiActiveRole(role);
  forgetOwnLearner();
  return api;
}
const ok = (body: unknown): FakeReply => ({ body });
const refused = (status: number, code: string): FakeReply => ({ status, body: { error: { code, message: "no" } } });
const per = (tail: string) => `GET ${P}/me/children/${L}/${tail}`;

afterEach(() => {
  vi.unstubAllGlobals();
  setApiActiveRole(null);
  forgetOwnLearner();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

describe("the learner's own record", () => {
  it("reads GET /me/learner once and keeps it, until asked fresh or the role leaves student", async () => {
    boot({ [`GET ${P}/me/learner`]: ok({ learner: learner() }) });
    expect((await apiFetchOwnLearner()).learner_id).toBe(L);
    await apiFetchOwnLearner();
    expect(api.callsTo(`GET ${P}/me/learner`)).toHaveLength(1);
    await apiFetchOwnLearner(true);
    expect(api.callsTo(`GET ${P}/me/learner`)).toHaveLength(2);
    setApiActiveRole("parent");
    expect(apiActiveRole()).toBe("parent");
    await apiFetchOwnLearner();
    expect(api.callsTo(`GET ${P}/me/learner`)).toHaveLength(3);
  });

  it("does not keep a failure: a login with no live learner is a 404 each time it is asked", async () => {
    boot({ [`GET ${P}/me/learner`]: refused(404, "not_found") });
    await expect(apiFetchOwnLearner()).rejects.toMatchObject({ code: "not_found" });
    await expect(apiFetchOwnLearner()).rejects.toMatchObject({ code: "not_found" });
    expect(api.callsTo(`GET ${P}/me/learner`)).toHaveLength(2);
  });
});

describe("a learner in the shared child reads", () => {
  it("looks the one child up as the learner's own record, never from the parent's list (a 403 for a learner)", async () => {
    boot({ [`GET ${P}/me/learner`]: ok({ learner: learner() }), [`GET ${P}/me/children`]: refused(403, "forbidden") });
    const kids = await apiFetchChildren();
    expect(kids).toHaveLength(1);
    expect(kids[0]).toMatchObject({ learner_id: L, full_name: "Amina Ochieng", admission_no: "ADM-1001", class: { id: CLS, name: "Form 2 West" } });
    expect(api.callsTo(`GET ${P}/me/children`)).toHaveLength(0);
  });

  it("still lists a parent's children from /me/children", async () => {
    boot({ [`GET ${P}/me/children`]: ok({ children: [{ ...learner(), relationship: "mother", is_primary_payer: true }] }) }, "parent");
    expect(await apiFetchChildren()).toHaveLength(1);
    expect(api.callsTo(`GET ${P}/me/learner`)).toHaveLength(0);
  });

  it("gives CBE results through the learner's own id", async () => {
    boot({
      [`GET ${P}/me/learner`]: ok({ learner: learner({ class: { id: CLS, name: "Grade 4 East", form_level: 4, stream: null, academic_year_id: "y" } }) }),
      [per("results")]: ok({
        marks: [],
        cbe_results: [{
          cbe_assessment_id: "cbe-1", title: "Reading", status: "published", published_at: "2026-11-10T08:00:00Z", assessment_date: "2026-11-09",
          learning_area: { id: SUBJ_ENG, name: "English" }, strand: { id: "st-1", name: "Reading" }, level_code: "ME1", points: "5", teacher_feedback: "Good", term,
        }],
      }),
    });
    const out = await loadPublishedCbeResults([L], "KE");
    expect(out.get(L)?.[0]).toMatchObject({ subjectName: "English", assessmentTitle: "Reading" });
  });

  it("gives the issued items through the learner's own id", async () => {
    boot({
      [`GET ${P}/me/learner`]: ok({ learner: learner() }),
      [per("items")]: ok({ items: [{
        id: "iss-1", quantity: 1, issued_at: "2026-11-02T08:00:00Z", due_on: "2026-12-01", condition_out: "good", status: "out", returned_condition: null, closed_at: null,
        item: { name: "Maths textbook", category: "textbooks", asset_tag: "TB-1" },
      }] }),
    });
    const rows = await fetchOwnLearnerInventory("profile-ignored");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemName: "Maths textbook", student_id: L, holderName: "Amina Ochieng", status: "out" });
  });
});

describe("loadStudentData on the API", () => {
  it("builds the learner's picture from the family reads on their own id, in order of due date, with nothing marked done or late", async () => {
    boot({
      [`GET ${P}/me/learner`]: ok({ learner: learner() }),
      [per("homework")]: ok({ homework: [homework("b", "2026-12-20"), homework("a", "2026-12-10")] }),
      [per("results")]: ok({
        marks: [mark(), mark({ assessment_id: "as-2", subject: { id: SUBJ_ENG, name: "English" }, score: "40", max_score: "50", published_at: "2026-11-11T08:00:00Z" })],
        cbe_results: [],
      }),
      [`GET ${P}/communications/announcements/inbox`]: ok({
        announcements: [inboxItem("n1", "class", "2026-11-12T08:00:00Z"), inboxItem("n2", "whole_school", "2026-11-13T08:00:00Z")],
        page: { limit: 200, next_cursor: null },
      }),
    });
    const data = await loadStudentData("profile-ignored");
    expect(data).toMatchObject({ studentId: L, classId: CLS, className: "Form 2 West", classLevel: "secondary", examName: "Mid-term" });
    expect(data!.work.map((w) => [w.id, w.state, w.teacher])).toEqual([["a", "open", ""], ["b", "open", ""]]);
    expect(data!.subjects.map((s) => [s.name, s.score, s.rawScore, s.maxScore])).toEqual([["English", 80, 40, 50], ["Mathematics", 72, 72, 100]]);
    expect(data!.exams).toHaveLength(1);
    // The newest notice first; a class notice is the class teacher's, any other the school office's.
    expect(data!.notices.map((n) => [n.id, n.from])).toEqual([["n2", "School office"], ["n1", "Class teacher"]]);
    // Everything was asked as the learner's own: the parent's list is never touched.
    expect(api.callsTo(`GET ${P}/me/children`)).toHaveLength(0);
  });

  it("is null for a login with no live learner (revoked, or the learner is archived), and a failure is thrown", async () => {
    boot({ [`GET ${P}/me/learner`]: refused(404, "not_found") });
    expect(await loadStudentData("p")).toBeNull();
    boot({ [`GET ${P}/me/learner`]: refused(503, "service_unavailable") });
    await expect(loadStudentData("p")).rejects.toMatchObject({ code: "service_unavailable" });
  });

  it("reads a learner with no class: no class, no level, and the pages say so", async () => {
    boot({
      [`GET ${P}/me/learner`]: ok({ learner: learner({ class: null }) }),
      [per("homework")]: ok({ homework: [] }),
      [per("results")]: ok({ marks: [], cbe_results: [] }),
      [`GET ${P}/communications/announcements/inbox`]: ok({ announcements: [], page: { limit: 200, next_cursor: null } }),
    });
    expect(await loadStudentData("p")).toMatchObject({ classId: null, classLevel: null, className: "", work: [], notices: [], exams: [] });
  });
});

describe("the timetable", () => {
  const slot = (day: number, start: string, name: string | null, room: string | null = "R1", teacher: string | null = "Mr Kamau") => ({
    day_of_week: day, starts_at: start, ends_at: "09:00", room, subject: { id: SUBJ_MATH, name }, teacher_name: teacher,
  });

  it("makes the week the screens read: Monday to Friday only, in time order, each period named by its subject", () => {
    const week = weekFromFamilyTimetable({
      publication_id: "p", version: 1, published_at: "2026-11-01T00:00:00Z", term_id: TERM, class: { id: CLS, name: "Form 2 West" },
      slots: [slot(1, "10:00", "English"), slot(1, "08:00", "Mathematics"), slot(6, "08:00", "Saturday club"), slot(5, "08:00", null, null, null)],
    });
    expect(week.Mon).toEqual([["08:00", "Mathematics", "R1", "Mr Kamau"], ["10:00", "English", "R1", "Mr Kamau"]]);
    expect(week.Fri).toEqual([["08:00", "Lesson", "", null]]);
    expect(week.Tue).toEqual([]);
    expect(Object.keys(week)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri"]);
    // The rows keep the shape currentPeriodIndex reads ("08:00" is before 08:00:30).
    expect(currentPeriodIndex(week.Mon, new Date(2026, 10, 2, 8, 0, 30))).toBe(0);
  });

  it("is an empty week for a class with no published timetable", async () => {
    expect(weekFromFamilyTimetable(null).Mon).toEqual([]);
    boot({ [`GET ${P}/me/learner`]: ok({ learner: learner() }), [per("timetable")]: ok({ timetable: null }) });
    expect((await fetchClassTimetable("ignored")).Wed).toEqual([]);
    expect(api.callsTo(per("timetable"))).toHaveLength(1);
  });
});

describe("what a learner cannot do on the API", () => {
  it("turns off the controls the API has no endpoint for", () => {
    initBackend({ kind: "api", apiUrl: BASE });
    expect(studentCapabilities()).toMatchObject({ homeworkDone: false, homeworkFiles: false, materialFiles: false, liveClasses: false, higherEdPages: false, progressOverTime: false, reportCardPdf: false, familyReportCards: true });
    initBackend({ kind: "supabase" });
    expect(Object.values(studentCapabilities()).filter((v) => v === false)).toEqual([false]);
    expect(studentCapabilities().familyReportCards).toBe(false);
    // The student flags mirror the parent's for the same reads.
    initBackend({ kind: "api", apiUrl: BASE });
    expect(studentCapabilities().homeworkDone).toBe(parentCapabilities().homeworkDone);
    expect(studentCapabilities().materialFiles).toBe(parentCapabilities().materialFiles);
  });

  it("fails loudly, without asking, when something calls for what is not there", async () => {
    boot({});
    await expect(markAssignmentHandedIn("w", "s")).rejects.toBeInstanceOf(NotOnApiError);
    await expect(fetchStudentSchedule("s")).rejects.toBeInstanceOf(NotOnApiError);
    await expect(fetchStudentCourseResults("s")).rejects.toBeInstanceOf(NotOnApiError);
    expect(api.calls).toHaveLength(0);
  });

  it("tells the server a notice was opened (the inbox does not say what was read)", async () => {
    boot({ [`POST ${P}/communications/announcements/n1/read`]: ok({ ok: true }) });
    await markStudentNoticeRead("p", "n1");
    expect(api.callsTo(`POST ${P}/communications/announcements/n1/read`)).toHaveLength(1);
  });
});

describe("a piece of work from the family read", () => {
  it("has no teacher, hand-in method, guide or file: the API gives none", () => {
    expect(workItemFromFamily(homework("w1", "2026-12-01") as never)).toEqual({
      id: "w1", title: "Work w1", subject: "Mathematics", teacher: "", dueOn: "2026-12-01", state: "open", how: "", body: "Do it.", needs: [], minutes: null, hasFile: false,
    });
  });
});

// ---------------------------------------------------------------- fees

const invoice = (o: Record<string, unknown> = {}) => ({
  id: "b1111111-1111-4111-8111-111111111111", term, currency: "KES", due_on: "2026-12-15", status: "part_paid", lines_minor: 4_500_000, charges_minor: 50_000, adjustments_minor: 0,
  total_minor: 4_550_000, paid_minor: 1_000_000, balance_minor: 3_550_000, created_at: "2026-11-01T08:00:00Z", voided_at: null,
  lines: [{ name: "Tuition", amount_minor: 4_000_000 }, { name: "Boarding", amount_minor: 500_000 }],
  charges: [{ amount_minor: 50_000, reason: "Lost textbook", created_at: "2026-11-05T08:00:00Z" }],
  payments: [
    { id: "pay-1", amount_minor: 1_000_000, method: "mpesa", status: "success", mpesa_receipt: "SKX1234", reference: null, failure_reason: null, created_at: "2026-11-02T08:00:00Z", completed_at: "2026-11-02T08:01:00Z" },
    { id: "pay-2", amount_minor: 500_000, method: "mpesa", status: "failed", mpesa_receipt: null, reference: null, failure_reason: "cancelled", created_at: "2026-11-03T08:00:00Z", completed_at: null },
  ],
  proofs: [{ id: "pr-1", status: "rejected", txn_code: "QAB1", txn_amount_minor: 500_000, note: null, file_name: null, rejection_reason: "Wrong amount", created_at: "2026-11-04T08:00:00Z" }],
  ...o,
});

describe("the learner's own fees", () => {
  it("is the balance of the newest invoice that is not voided, with its lines, charges, receipts and proofs, in cents", async () => {
    boot({
      [`GET ${P}/me/learner`]: ok({ learner: learner() }),
      [per("fees")]: ok({ invoices: [invoice({ id: "voided", voided_at: "2026-11-06T00:00:00Z", status: "voided" }), invoice(), invoice({ id: "old", term: { id: "t0", label: "Term 3, 2025" }, payments: [] })] }),
    });
    const fees = await loadStudentFeeData("ignored");
    expect(fees).toMatchObject({
      studentId: L, invoiceId: "b1111111-1111-4111-8111-111111111111", name: "Amina Ochieng", admissionNo: "ADM-1001", className: "Form 2 West", formLevel: 2, classLevel: "secondary",
      balance: 3_550_000, billed: 4_550_000, dueOn: "2026-12-15", termLabel: "Term 1, 2026",
    });
    expect(fees!.feeItems.map((i) => [i.name, i.amount_cents, i.applies_to])).toEqual([["Tuition", 4_000_000, "all"], ["Boarding", 500_000, "all"]]);
    expect(fees!.charges.map((c) => [c.reason, c.amountCents])).toEqual([["Lost textbook", 50_000]]);
    expect(fees!.receipts.map((r) => [r.amount, r.ref])).toEqual([[1_000_000, "SKX1234"]]);
    expect(fees!.proofs).toEqual([expect.objectContaining({ id: "pr-1", status: "rejected", rejection_reason: "Wrong amount", txn_amount_cents: 500_000, file_path: null })]);
    // No phone number is anywhere in it.
    expect(JSON.stringify(fees)).not.toMatch(/msisdn|phone/i);
  });

  it("is a zero balance and no invoice for a learner not billed yet, and null for a login with no live learner", async () => {
    boot({ [`GET ${P}/me/learner`]: ok({ learner: learner() }), [per("fees")]: ok({ invoices: [] }) });
    expect(await loadStudentFeeData("p")).toMatchObject({ invoiceId: null, balance: 0, billed: 0, receipts: [], proofs: [], feeItems: [] });
    boot({ [`GET ${P}/me/learner`]: refused(404, "not_found") });
    expect(await loadStudentFeeData("p")).toBeNull();
  });

  it("asks for an M-Pesa prompt for their own invoice and reads the payment back from their own fees; where M-Pesa is not set up it says so", async () => {
    const inv = "b1111111-1111-4111-8111-111111111111";
    boot({
      [`POST ${P}/finance/mpesa/prompts`]: { status: 201, body: { payment: { id: "pay-9" } } },
      [per("fees")]: ok({ invoices: [invoice({ payments: [{ id: "pay-9", amount_minor: 100_000, method: "mpesa", status: "success", mpesa_receipt: "SKY9", reference: null, failure_reason: null, created_at: "2026-11-25T08:00:00Z", completed_at: "2026-11-25T08:00:30Z" }] })] }),
    });
    const out = await payWithMpesa({ invoiceId: inv, amountCents: 100_000, msisdn: "254712345678", learnerId: L }, { intervalMs: 1 });
    expect(out).toEqual({ kind: "success", receipt: "SKY9" });
    expect(api.callsTo(`POST ${P}/finance/mpesa/prompts`)[0]!.body).toEqual({ invoice_id: inv, amount_minor: 100_000, msisdn: "254712345678" });
    // M-Pesa not set up for the school (or down): the dialog says so, nothing was sent.
    boot({ [`POST ${P}/finance/mpesa/prompts`]: refused(503, "service_unavailable") });
    expect(await payWithMpesa({ invoiceId: inv, amountCents: 100_000, msisdn: "254712345678", learnerId: L })).toEqual({ kind: "unavailable" });
    // Without the learner id the invoice is found among the learner's own (the parent's list is a 403 for a learner and is never asked).
    boot({
      [`GET ${P}/me/learner`]: ok({ learner: learner() }),
      [`POST ${P}/finance/mpesa/prompts`]: { status: 201, body: { payment: { id: "pay-9" } } },
      [per("fees")]: ok({ invoices: [invoice({ payments: [{ id: "pay-9", amount_minor: 100_000, method: "mpesa", status: "failed", mpesa_receipt: null, reference: null, failure_reason: "cancelled", created_at: "2026-11-25T08:00:00Z", completed_at: null }] })] }),
    });
    expect(await payWithMpesa({ invoiceId: inv, amountCents: 100_000, msisdn: "254712345678" }, { intervalMs: 1 })).toMatchObject({ kind: "failed" });
    expect(api.callsTo(`GET ${P}/me/children`)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- chat

describe("a learner's chats", () => {
  const CT = "c9999999-9999-4999-8999-999999999999";
  const AD = "c8888888-8888-4888-8888-888888888888";

  it("lists the people from /me/chat-contacts (the office and their own class teachers), never the staff list", async () => {
    resetDirectory();
    boot({
      [`GET ${P}/me/chat-contacts`]: ok({ contacts: [
        { user_id: CT, full_name: "David Kamau", role: "teacher", teaches: [{ learner_id: L, class_name: "Form 2 West", subject: null }, { learner_id: L, class_name: "Form 2 West", subject: "Mathematics" }] },
        { user_id: AD, full_name: "Grace Wanjiku", role: "school_admin", teaches: [] },
      ] }),
      [`GET ${P}/chat/conversations`]: ok({ conversations: [{ id: "cv-1", peer_user_id: CT, last_message_at: null, created_at: "2026-11-25T08:00:00Z" }], page: { limit: 50, next_cursor: null } }),
    });
    const contacts = await fetchChatContacts("student");
    expect(contacts.map((c) => [c.name, c.role, c.detail])).toEqual([
      ["David Kamau", "teacher", "Class teacher · Form 2 West, Mathematics · Form 2 West"],
      ["Grace Wanjiku", "school_admin", "School office"],
    ]);
    const chats = await fetchMyConversations("student");
    expect(chats.map((c) => [c.otherName, c.otherRole])).toEqual([["David Kamau", "teacher"]]);
    expect(api.callsTo(`GET ${P}/staff`)).toHaveLength(0);
    resetDirectory();
  });
});

// ---------------------------------------------------------------- the study helper

describe("a learner's study helper", () => {
  it("asks /ai/query with the public scope only, the chat packed into one prompt, and reads the answer", async () => {
    boot({ [`POST ${P}/ai/query`]: ok({ status: "ok", scope: "public", answer: "A fraction is part of a whole.", provider: "figbloom_ai", citations: [] }) });
    const text = await askTutor([
      { role: "user", content: "What is a fraction?" },
      { role: "assistant", content: "Part of a whole. Want an example?" },
      { role: "user", content: "Yes" },
    ]);
    expect(text).toBe("A fraction is part of a whole.");
    const body = api.callsTo(`POST ${P}/ai/query`)[0]!.body as { scope: string; prompt: string };
    expect(body.scope).toBe("public");
    expect(body.prompt).toBe("User: What is a fraction?\n\nBloom: Part of a whole. Want an example?\n\nUser: Yes");
  });

  it("says why when Bloom does not answer: the school has no helper (403), or it is busy (503 with Retry-After)", async () => {
    boot({ [`POST ${P}/ai/query`]: refused(403, "forbidden", "AI is not enabled for this school") });
    await expect(askTutor([{ role: "user", content: "Hi" }])).rejects.toMatchObject({ name: "EdgeError", status: 403 });
    boot({ [`POST ${P}/ai/query`]: { status: 503, headers: { "retry-after": "15" }, body: { status: "unavailable", reason: "circuit_open" } } });
    await expect(askTutor([{ role: "user", content: "Hi" }])).rejects.toMatchObject({ status: 503, message: "Bloom is not answering right now. Try again in 15 seconds." });
  });
});
