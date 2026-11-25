import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { loadPublishedCbeResults } from "../cbeData";
import { NotOnApiError, parentCapabilities, studentCapabilities } from "../capabilities";
import { fetchStudentSchedule } from "../courses";
import { fetchStudentCourseResults } from "../courseGrades";
import { fetchOwnLearnerInventory } from "../inventory";
import { loadStudentData, markAssignmentHandedIn, markStudentNoticeRead } from "../studentData";
import { currentPeriodIndex, fetchClassTimetable } from "../timetable";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { apiActiveRole, apiFetchOwnLearner, forgetOwnLearner, setApiActiveRole } from "./ownLearner";
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
