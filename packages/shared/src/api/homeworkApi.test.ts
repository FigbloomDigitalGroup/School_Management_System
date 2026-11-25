import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { NotOnApiError, canManageHomework, homeworkCapabilities } from "../capabilities";
import {
  createHomework, deleteHomework, fetchHomeworkSubjectsForClass, fetchMyHomework, updateHomework,
} from "../homework";
import { addAttachment, fetchAttachments, removeAttachment } from "../materials";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { clearTeachingLookups } from "./teachingLookups";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const YEAR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TERM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const C2 = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";
const S1 = "s1s1s1s1-s1s1-4s1s-8s1s-s1s1s1s1s1s1";
const S2 = "s2s2s2s2-s2s2-4s2s-8s2s-s2s2s2s2s2s2";
const ST1 = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
const ST2 = "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2";
const USER = "30000001-1111-4111-8111-111111111111";

const stamp = { created_at: "2026-05-01T08:00:00Z", updated_at: "2026-05-01T08:00:00Z" };
const yearRow = (o: Record<string, unknown> = {}) => ({
  id: YEAR, tenantId: T, label: "2026", starts_on: "2026-01-01", ends_on: "2026-12-31", is_current: true, ...stamp, ...o,
});
const termRow = (o: Record<string, unknown> = {}) => ({
  id: TERM, tenantId: T, academic_year_id: YEAR, name: "Term 2", starts_on: "2026-05-01", ends_on: "2026-08-01", is_current: true, ...stamp, ...o,
});
const clsRow = (id: string, name: string, o: Record<string, unknown> = {}) => ({
  id, tenantId: T, academic_year_id: YEAR, name, form_level: 2, stream: "East",
  education_level: "secondary", class_teacher_staff_id: null, active: true, ...stamp, ...o,
});
const subRow = (id: string, code: string, name: string) => ({
  id, tenantId: T, code, name, active: true, ...stamp,
});
const staffRow = (id: string, userId: string, full_name: string) => ({
  id, tenantId: T, userId, full_name, classification: "teacher", staff_title: "Teacher", phone: null, active: true, archived_at: null, ...stamp,
});
const assignRow = (class_id: string, subject_id: string, staff_member_id: string, active = true) => ({
  id: `${class_id}:${subject_id}:${staff_member_id}`, tenantId: T, class_id, subject_id, staff_member_id, active, ...stamp,
});
const hwRow = (id: string, class_id: string, subject_id: string, due_on: string, created_at: string, title: string, body = "Do exercises 1-5.") => ({
  id, tenantId: T, class_id, subject_id, term_id: TERM, title, due_on, body, created_at,
});

const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const list = (key: string, items: unknown[], next: string | null = null): FakeReply => ({ body: { [key]: items, page: page(next) } });
const refused = (code: string, status: number, message = "no") => ({ status, body: { error: { code, message } } });

const P = `/v1/tenants/${T}`;
let api: FakeApi;

function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  clearTeachingLookups();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: USER }));
  setApiActiveTenant(T);
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearTeachingLookups();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

describe("fetchMyHomework on API", () => {
  it("pages homework items, filters to the teacher's classes, resolves names, and sorts newest due first", async () => {
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [yearRow()]),
      [`GET ${P}/classes`]: list("classes", [
        clsRow(C1, "Form 2 East", { class_teacher_staff_id: ST1 }),
        clsRow(C2, "Form 3 West"),
      ]),
      [`GET ${P}/staff`]: list("staff", [staffRow(ST1, USER, "Wanjiku"), staffRow(ST2, "other", "Otieno")]),
      [`GET ${P}/teaching-assignments`]: list("assignments", [assignRow(C1, S1, ST1)]),
      [`GET ${P}/subjects`]: list("subjects", [subRow(S1, "MAT", "Mathematics"), subRow(S2, "ENG", "English")]),
      [`GET ${P}/homework-items`]: (req) => (
        req.query.get("cursor")
          ? list("homework", [
              hwRow("h2", C1, S2, "2026-05-12", "2026-05-02T09:00:00Z", "Composition", "Write 2 pages."),
              hwRow("h3", C1, S1, "2026-05-12", "2026-05-03T09:00:00Z", "Trigonometry", "Solve Q1-Q4."),
            ])
          : list("homework", [
              hwRow("h1", C1, S1, "2026-05-10", "2026-05-01T09:00:00Z", "Algebra sheet", "Questions 1-10."),
              hwRow("h-other", C2, S1, "2026-05-20", "2026-05-05T09:00:00Z", "Other teacher class", "Ignored."),
            ], "cur-1")
      ),
    });

    const rows = await fetchMyHomework(USER);
    expect(rows.map((r) => ({
      id: r.id,
      title: r.title,
      className: r.className,
      subjectName: r.subjectName,
      dueOn: r.dueOn,
      guide: r.guide,
      handedIn: r.handedIn,
    }))).toEqual([
      { id: "h3", title: "Trigonometry", className: "Form 2 East", subjectName: "Mathematics", dueOn: "2026-05-12", guide: null, handedIn: 0 },
      { id: "h2", title: "Composition", className: "Form 2 East", subjectName: "English", dueOn: "2026-05-12", guide: null, handedIn: 0 },
      { id: "h1", title: "Algebra sheet", className: "Form 2 East", subjectName: "Mathematics", dueOn: "2026-05-10", guide: null, handedIn: 0 },
    ]);
  });

  it("returns an empty list without calling homework-items when the teacher has no classes", async () => {
    const server = boot({
      [`GET ${P}/academic-years`]: list("academic_years", [yearRow()]),
      [`GET ${P}/classes`]: list("classes", [clsRow(C2, "Form 3 West")]),
      [`GET ${P}/staff`]: refused("forbidden", 403),
      [`GET /v1/rbac/permissions`]: list("items", ["resource.academics.read"]),
      [`GET ${P}/teaching-assignments`]: list("assignments", []),
    });

    expect(await fetchMyHomework(USER)).toEqual([]);
    expect(server.callsTo(`GET ${P}/homework-items`)).toEqual([]);
  });
});

describe("createHomework and fetchHomeworkSubjectsForClass on API", () => {
  it("resolves the current term and posts a strict homework-items body", async () => {
    const server = boot({
      [`GET ${P}/academic-years`]: list("academic_years", [yearRow()]),
      [`GET ${P}/academic-terms`]: list("terms", [termRow()]),
      [`POST ${P}/homework-items`]: {
        status: 201,
        body: { homework: hwRow("hw-new", C1, S1, "2026-05-18", "2026-05-10T08:00:00Z", "Fractions", "Page 42 numbers 1 to 6.") },
      },
    });

    const id = await createHomework(T, USER, {
      classId: C1,
      subjectId: S1,
      title: "  Fractions  ",
      body: "  Page 42 numbers 1 to 6.  ",
      dueOn: "2026-05-18",
      handIn: "upload",
      guide: { about: "Ignored", needs: [], help: "", avoid: "", minutes: 20 },
    });

    expect(id).toBe("hw-new");
    expect(server.calls.find((c) => c.method === "POST")?.body).toEqual({
      class_id: C1,
      subject_id: S1,
      term_id: TERM,
      title: "Fractions",
      due_on: "2026-05-18",
      body: "Page 42 numbers 1 to 6.",
    });
  });

  it("rejects empty instructions and rejects when no current term exists", async () => {
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [yearRow()]),
      [`GET ${P}/academic-terms`]: list("terms", [termRow({ is_current: false })]),
    });

    await expect(createHomework(T, USER, {
      classId: C1,
      subjectId: S1,
      title: "Exercise 1",
      body: "   ",
      dueOn: "2026-05-18",
      handIn: "paper",
    })).rejects.toThrow("Write instructions for the learners.");

    await expect(createHomework(T, USER, {
      classId: C1,
      subjectId: S1,
      title: "Exercise 1",
      body: "Read chapter 2",
      dueOn: "2026-05-18",
      handIn: "paper",
    })).rejects.toThrow("Start a term in School settings before setting homework.");
  });

  it("loads the teacher's subjects in a class via /staff/me without needing GET /staff", async () => {
    boot({
      [`GET ${P}/staff/me`]: { body: { staff: staffRow(ST1, USER, "Wanjiku") } },
      [`GET ${P}/staff`]: refused("forbidden", 403),
      [`GET ${P}/teaching-assignments`]: list("assignments", [
        assignRow(C1, S1, ST1, true),
        assignRow(C1, S2, ST2, true),
        assignRow(C2, S2, ST1, true),
      ]),
      [`GET ${P}/subjects`]: list("subjects", [subRow(S1, "MAT", "Mathematics"), subRow(S2, "ENG", "English")]),
    });

    const got = await fetchHomeworkSubjectsForClass(USER, C1);
    expect(got.map((s) => s.name)).toEqual(["Mathematics"]);
  });
});

describe("homeworkCapabilities, canManageHomework, and API guards", () => {
  it("reports Supabase vs API capabilities and guards unsupported homework & attachment calls", async () => {
    expect(homeworkCapabilities()).toEqual({
      editHomework: true,
      deleteHomework: true,
      handInMethod: true,
      parentGuide: true,
      submissions: true,
      attachments: true,
      optionalInstructions: true,
    });
    expect(canManageHomework([], "teacher")).toBe(true);

    initBackend({ kind: "api", apiUrl: BASE });
    expect(homeworkCapabilities()).toEqual({
      editHomework: false,
      deleteHomework: false,
      handInMethod: false,
      parentGuide: false,
      submissions: false,
      attachments: false,
      optionalInstructions: false,
    });
    expect(canManageHomework([], "teacher")).toBe(false);
    expect(canManageHomework(["academics"], "teacher")).toBe(true);
    expect(canManageHomework([], "school_admin")).toBe(true);

    await expect(updateHomework("h1", {
      classId: C1, subjectId: S1, title: "T", body: "B", dueOn: "2026-05-18", handIn: "paper",
    })).rejects.toThrow(NotOnApiError);
    await expect(deleteHomework("h1")).rejects.toThrow(NotOnApiError);
    await expect(addAttachment("homework", "h1", { kind: "link", title: "Link", url: "https://example.com" }))
      .rejects.toThrow(NotOnApiError);
    await expect(removeAttachment({ id: "a1", filePath: null })).rejects.toThrow(NotOnApiError);
    expect((await fetchAttachments("homework", ["h1"])).size).toBe(0);
  });
});
