import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { isNotOnApiError } from "../capabilities";
import { addClassPeriod, fetchClassPeriods, saveClassTimetable } from "../timetable";
import { fetchTeacherClassTimetable } from "../teacherData";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { isApiError } from "./errors";
import { clearTeachingLookups } from "./teachingLookups";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const P = `/v1/tenants/${T}`;
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const MATH = "40000001-1111-4111-8111-111111111111";
const ENG = "40000002-1111-4111-8111-111111111111";
const ST_ME = "30000001-1111-4111-8111-111111111111";
const ST_OTHER = "30000002-1111-4111-8111-111111111111";
const stamp = { created_at: "2026-05-01T08:00:00Z", updated_at: "2026-05-01T08:00:00Z" };

const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const list = (key: string, items: unknown[]): FakeReply => ({ body: { [key]: items, page: page() } });
const refused = (code: string, status: number, message = "no"): FakeReply => ({ status, body: { error: { code, message } } });
const slot = (id: string, subjectId: string, day: number, from: string, to: string, extra: Record<string, unknown> = {}) => ({
  id, tenantId: T, class_id: C1, subject_id: subjectId, teaching_assignment_id: null, day_of_week: day,
  starts_at: from, ends_at: to, room: null, active: true, archived_at: null, ...stamp, ...extra,
});
const assignment = (id: string, staffId: string, subjectId: string) => ({
  id, tenantId: T, staff_member_id: staffId, class_id: C1, subject_id: subjectId, active: true, archived_at: null, ...stamp,
});
const classRecord = (teacherStaffId: string | null) => ({
  school_class: {
    id: C1, tenantId: T, academic_year_id: "y1", name: "Form 1 East", education_level: "secondary", form_level: 1, pathway: null,
    stream: "East", class_teacher_staff_id: teacherStaffId, active: true, archived_at: null, ...stamp,
  },
});
const subject = (id: string, name: string) => ({ id, tenantId: T, code: name.slice(0, 3).toUpperCase(), name, active: true, archived_at: null, ...stamp });
const staffRow = (id: string, name: string) => ({
  id, tenantId: T, full_name: name, staff_title: null, classification: "teacher", phone: null, email: null, userId: null, active: true, archived_at: null, ...stamp,
});

// Monday: maths 08:00 (linked to my assignment), English 09:00 (no link: found by subject). Tuesday: maths. Saturday and Sunday are left out.
const SLOTS = [
  slot("s2", ENG, 1, "09:00:00", "09:40:00", { room: "Room 4" }),
  slot("s1", MATH, 1, "08:00:00", "08:40:00", { teaching_assignment_id: "a-me", room: "Lab 1" }),
  slot("s3", MATH, 2, "08:00:00", "08:40:00"),
  slot("s6", MATH, 6, "08:00:00", "08:40:00"),
  slot("s7", ENG, 7, "08:00:00", "08:40:00"),
];
const ASSIGNMENTS = [assignment("a-me", ST_ME, MATH), assignment("a-other", ST_OTHER, ENG)];

let api: FakeApi;
function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  clearTeachingLookups();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: "u1" }));
  setApiActiveTenant(T);
  return api;
}

/** A school where the teacher may read everything the page asks for. */
function fullRoutes(classTeacherStaffId: string | null): Record<string, FakeRoute> {
  return {
    [`GET ${P}/timetable-slots`]: list("slots", SLOTS),
    [`GET ${P}/classes/${C1}`]: { body: classRecord(classTeacherStaffId) },
    [`GET ${P}/teaching-assignments`]: list("assignments", ASSIGNMENTS),
    [`GET ${P}/subjects`]: list("subjects", [subject(MATH, "Mathematics"), subject(ENG, "English")]),
    [`GET ${P}/staff`]: list("staff", [staffRow(ST_ME, "David Kamau"), staffRow(ST_OTHER, "Mercy Wanjiru")]),
    [`GET ${P}/staff/me`]: { body: { staff: staffRow(ST_ME, "David Kamau") } },
  };
}

beforeEach(() => clearTeachingLookups());
afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

describe("a teacher's class timetable on the API", () => {
  it("shows a subject teacher only their own periods, Monday to Friday, in time order, named from the subject list", async () => {
    boot(fullRoutes(ST_OTHER));
    const t = await fetchTeacherClassTimetable(C1, "u1");

    expect(t.isClassTeacher).toBe(false);
    expect(t.byDay.Mon).toEqual([
      { time: "08:00", label: "Mathematics", room: "Lab 1", subjectId: MATH, teacherId: ST_ME, teacherName: "David Kamau", mine: true },
    ]);
    expect(t.byDay.Tue.map((r) => [r.time, r.label])).toEqual([["08:00", "Mathematics"]]);
    expect(t.byDay.Wed).toEqual([]);
    // English is Mercy's, and Saturday and Sunday are not part of the week.
    expect(JSON.stringify(t.byDay)).not.toContain("English");
    expect(api.callsTo(`GET ${P}/timetable-slots`)[0]?.query.get("classId")).toBe(C1);
    expect(api.callsTo(`GET ${P}/timetable-slots`)[0]?.query.get("active")).toBe("true");
  });

  it("shows the class teacher the whole week, each period saying whose it is (a period with no link is found by its subject)", async () => {
    boot(fullRoutes(ST_ME));
    const t = await fetchTeacherClassTimetable(C1, "u1");

    expect(t.isClassTeacher).toBe(true);
    expect(t.byDay.Mon.map((r) => [r.time, r.label, r.mine, r.teacherName])).toEqual([
      ["08:00", "Mathematics", true, "David Kamau"],
      ["09:00", "English", false, "Mercy Wanjiru"],
    ]);
  });

  it("works for a plain teacher: their own periods, with the lesson unnamed and no colleague's name when those lists are refused", async () => {
    boot({
      ...fullRoutes(null),
      [`GET ${P}/subjects`]: refused("forbidden", 403),
      [`GET ${P}/staff`]: refused("forbidden", 403),
    });
    const t = await fetchTeacherClassTimetable(C1, "u1");

    expect(t.byDay.Mon).toEqual([
      { time: "08:00", label: "Lesson", room: "Lab 1", subjectId: MATH, teacherId: ST_ME, teacherName: null, mine: true },
    ]);
  });

  it("gives a person with no staff record no periods of their own, and no class-teacher view", async () => {
    boot({ ...fullRoutes(ST_ME), [`GET ${P}/staff/me`]: refused("not_found", 404) });
    const t = await fetchTeacherClassTimetable(C1, "u1");

    expect(t.isClassTeacher).toBe(false);
    expect(Object.values(t.byDay).flat()).toEqual([]);
  });

  it("never calls a period with nobody teaching it 'mine' for a person with no staff record", async () => {
    const GAMES = "40000009-1111-4111-8111-111111111111";
    boot({
      ...fullRoutes(null),
      [`GET ${P}/timetable-slots`]: list("slots", [slot("g1", GAMES, 1, "10:00:00", "10:40:00")]),
      [`GET ${P}/staff/me`]: refused("not_found", 404),
    });
    const t = await fetchTeacherClassTimetable(C1, "u1");
    expect(Object.values(t.byDay).flat()).toEqual([]);
  });

  it("follows the slot's own assignment link before looking the subject up (two teachers of one subject in a class)", async () => {
    boot({
      ...fullRoutes(ST_ME),
      // David teaches Mathematics here too, but this Monday period is linked to Mercy's Mathematics assignment.
      [`GET ${P}/teaching-assignments`]: list("assignments", [assignment("a-me", ST_ME, MATH), assignment("a-mercy-math", ST_OTHER, MATH)]),
      [`GET ${P}/timetable-slots`]: list("slots", [slot("s1", MATH, 1, "08:00:00", "08:40:00", { teaching_assignment_id: "a-mercy-math" })]),
    });
    const t = await fetchTeacherClassTimetable(C1, "u1");
    expect(t.byDay.Mon.map((r) => [r.teacherId, r.mine])).toEqual([[ST_OTHER, false]]);
  });

  it("asks for the school-wide lookups once for a page of classes, and again after they are cleared", async () => {
    boot(fullRoutes(null));
    await Promise.all([fetchTeacherClassTimetable(C1, "u1"), fetchTeacherClassTimetable(C1, "u1")]);
    expect(api.callsTo(`GET ${P}/staff/me`)).toHaveLength(1);
    expect(api.callsTo(`GET ${P}/subjects`)).toHaveLength(1);
    expect(api.callsTo(`GET ${P}/staff`)).toHaveLength(1);

    clearTeachingLookups();
    await fetchTeacherClassTimetable(C1, "u1");
    expect(api.callsTo(`GET ${P}/staff/me`)).toHaveLength(2);
  });

  it("passes on a failure that is not a refusal", async () => {
    boot({ ...fullRoutes(null), [`GET ${P}/timetable-slots`]: refused("internal_error", 500, "boom") });
    await expect(fetchTeacherClassTimetable(C1, "u1")).rejects.toThrow();
  });
});

describe("a class's periods for the administrator", () => {
  it("lists the periods Monday to Friday by time, with subject, room, end time and the subject's teacher", async () => {
    boot(fullRoutes(null));
    const periods = await fetchClassPeriods(C1);

    expect(periods.map((p) => [p.day, p.startsAt, p.endsAt, p.subjectName, p.room, p.teacherName])).toEqual([
      ["Mon", "08:00", "08:40", "Mathematics", "Lab 1", "David Kamau"],
      ["Mon", "09:00", "09:40", "English", "Room 4", "Mercy Wanjiru"],
      ["Tue", "08:00", "08:40", "Mathematics", null, "David Kamau"],
    ]);
  });

  it("adds a period: Tuesday is day 2, the subject's teaching assignment is linked, an empty room is null", async () => {
    boot({ ...fullRoutes(null), [`POST ${P}/timetable-slots`]: { status: 201, body: { slot: slot("new", MATH, 2, "10:00:00", "10:40:00") } } });
    await addClassPeriod({ classId: C1, day: "Tue", startsAt: "10:00", endsAt: "10:40", subjectId: MATH, room: "  " });

    expect(api.callsTo(`POST ${P}/timetable-slots`)[0]?.body).toEqual({
      class_id: C1, subject_id: MATH, teaching_assignment_id: "a-me", day_of_week: 2, starts_at: "10:00", ends_at: "10:40", room: null,
    });
  });

  it("links no assignment when nobody teaches the subject in that class, and trims the room", async () => {
    const GAMES = "40000009-1111-4111-8111-111111111111";
    boot({ ...fullRoutes(null), [`POST ${P}/timetable-slots`]: { status: 201, body: { slot: slot("new", GAMES, 5, "14:00:00", "15:00:00") } } });
    await addClassPeriod({ classId: C1, day: "Fri", startsAt: "14:00", endsAt: "15:00", subjectId: GAMES, room: " Field " });

    expect(api.callsTo(`POST ${P}/timetable-slots`)[0]?.body).toMatchObject({ teaching_assignment_id: null, day_of_week: 5, room: "Field" });
  });

  it("passes on the API's refusal of an overlapping period", async () => {
    boot({ ...fullRoutes(null), [`POST ${P}/timetable-slots`]: refused("conflict", 409, "Timetable slot overlaps another slot") });
    const err = await addClassPeriod({ classId: C1, day: "Mon", startsAt: "08:20", endsAt: "09:00", subjectId: MATH, room: null }).catch((e) => e);
    expect(isApiError(err) && err.code === "conflict").toBe(true);
  });
});

describe("what the API cannot do", () => {
  it("refuses to save a whole week (the API makes one period at a time and cannot change or remove one)", async () => {
    boot({});
    const err = await saveClassTimetable(T, C1, []).catch((e) => e);
    expect(isNotOnApiError(err)).toBe(true);
    expect(api.calls).toHaveLength(0);
  });

  it("lists and adds single periods on the API build only", async () => {
    initBackend({ kind: "supabase" });
    await expect(fetchClassPeriods(C1)).rejects.toThrow(/new system only/);
    await expect(addClassPeriod({ classId: C1, day: "Mon", startsAt: "08:00", endsAt: "08:40", subjectId: MATH, room: null })).rejects.toThrow(/new system only/);
  });
});
