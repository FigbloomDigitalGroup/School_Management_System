import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addActivityMembers, createActivity, deleteActivity, deleteActivityEvent, fetchActiveLearners, fetchActivities, fetchActivityEvents,
  fetchActivityMembers, fetchEventParticipants, fetchMemberCounts, fetchMyPatronActivityIds, fetchTeachers, loadLearnerActivities,
  loadTermActivities, removeActivityMember, saveActivityEvent, saveParticipantResult, setActivityPatrons, setEventParticipants,
  setMemberRole, updateActivity, type EventInput,
} from "../activities";
import { initBackend } from "../backend";
import { activitiesCapabilities, NotOnApiError } from "../capabilities";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { activityFromApi, HIDDEN_MEMBER_NAME } from "./activitiesApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { isApiError } from "./errors";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const YEAR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const A1 = "a1111111-1111-4111-8111-111111111111";
const A2 = "a2222222-2222-4222-8222-222222222222";
const L1 = "51111111-1111-4111-8111-111111111111";
const L2 = "52222222-2222-4222-8222-222222222222";
const L3 = "53333333-3333-4333-8333-333333333333";
const U1 = "61111111-1111-4111-8111-111111111111";
const U2 = "62222222-2222-4222-8222-222222222222";

const stamp = { created_at: "2026-11-20T08:00:00Z", updated_at: "2026-11-20T08:00:00Z" };
const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const list = (key: string, items: unknown[], next: string | null = null): FakeReply => ({ body: { [key]: items, page: page(next) } });
const refused = (code: string, status: number, message = "no"): FakeReply => ({ status, body: { error: { code, message } } });

const apiActivity = (o: Record<string, unknown> = {}) => ({
  id: A1, tenant_id: T, name: "Football (boys)", category: "sport", description: "Training twice a week", meeting_schedule: "Tue 4pm",
  active: true, created_at: "2026-11-20T08:00:00Z", ...o,
});
const apiMember = (o: Record<string, unknown> = {}) => ({ learner_id: L1, role: null, joined_on: "2026-11-21", ...o });
const apiLearner = (o: Record<string, unknown> = {}) => ({
  id: L1, tenantId: T, admission_no: "ADM-1001", full_name: "Amina Ochieng", gender: "female", date_of_birth: "2011-03-14",
  boarding: false, active: true, archived_at: null, ...stamp, ...o,
});
const apiStaff = (o: Record<string, unknown> = {}) => ({
  id: "81111111-1111-4111-8111-111111111111", tenantId: T, full_name: "David Kamau", staff_title: "Teacher", classification: "teacher",
  phone: null, email: null, userId: U1, active: true, archived_at: null, ...stamp, ...o,
});
const apiYear = { id: YEAR, tenantId: T, label: "2026", starts_on: "2026-01-01", ends_on: "2026-12-31", is_current: true, ...stamp };
const apiClass = { id: C1, tenantId: T, academic_year_id: YEAR, name: "Form 1 East", form_level: 1, education_level: "secondary", pathway: null, stream: "East", class_teacher_staff_id: null, active: true, archived_at: null, ...stamp };
const apiMembership = (learnerId: string) => ({ id: `m-${learnerId}`, tenantId: T, learner_id: learnerId, class_id: C1, academic_year_id: YEAR, active: true, archived_at: null, ...stamp });

const P = `/v1/tenants/${T}`;
let api: FakeApi;

function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: U1 }));
  setApiActiveTenant(T);
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

describe("what the activities screen offers", () => {
  it("offers everything on Supabase and hides what the API has no endpoint for", () => {
    initBackend({ kind: "supabase" });
    expect(activitiesCapabilities()).toEqual({ editActivity: true, deleteActivity: true, listPatrons: true, editMemberRole: true, removeMember: true, events: true });
    initBackend({ kind: "api", apiUrl: BASE });
    expect(activitiesCapabilities()).toEqual({ editActivity: false, deleteActivity: false, listPatrons: false, editMemberRole: false, removeMember: false, events: false });
  });

  it("maps an API activity to the screen's row, with no patrons (the API does not say)", () => {
    expect(activityFromApi(apiActivity() as never)).toEqual({
      id: A1, tenantId: T, name: "Football (boys)", category: "sport", description: "Training twice a week", meetingSchedule: "Tue 4pm", active: true, patrons: [],
    });
  });
});

describe("reading activities", () => {
  it("lists every page of open activities, by name", async () => {
    boot({
      [`GET ${P}/activities`]: (call) => (call.query.get("cursor") === "p2"
        ? list("activities", [apiActivity({ id: A2, name: "Choir", category: "arts" })])
        : list("activities", [apiActivity()], "p2")),
    });
    const rows = await fetchActivities(T);
    expect(rows.map((r) => [r.name, r.category])).toEqual([["Choir", "arts"], ["Football (boys)", "sport"]]);
    expect(api.callsTo(`GET ${P}/activities`)).toHaveLength(2);
    expect(api.callsTo(`GET ${P}/activities`)[0]!.query.get("limit")).toBe("200");
  });

  it("passes a refusal on, so a person who may not read activities is told and not shown an empty list", async () => {
    boot({ [`GET ${P}/activities`]: refused("forbidden", 403, "Missing permission") });
    const err = await fetchActivities(T).catch((e: unknown) => e);
    expect(isApiError(err) && err.code).toBe("forbidden");
  });

  it("counts the members of each activity, across pages", async () => {
    boot({
      [`GET ${P}/activities`]: list("activities", [apiActivity(), apiActivity({ id: A2, name: "Choir" })]),
      [`GET ${P}/activities/${A1}/members`]: (call) => (call.query.get("cursor") === "p2"
        ? list("members", [apiMember({ learner_id: L3 })])
        : list("members", [apiMember(), apiMember({ learner_id: L2 })], "p2")),
      [`GET ${P}/activities/${A2}/members`]: list("members", []),
    });
    const counts = await fetchMemberCounts(T);
    expect(counts.get(A1)).toBe(3);
    expect(counts.get(A2)).toBe(0);
  });

  it("fails the counts when one activity's members cannot be read", async () => {
    boot({
      [`GET ${P}/activities`]: list("activities", [apiActivity()]),
      [`GET ${P}/activities/${A1}/members`]: refused("forbidden", 403),
    });
    await expect(fetchMemberCounts(T)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("names the members from the learner list and their classes, newest role kept, sorted by name", async () => {
    boot({
      [`GET ${P}/activities/${A1}/members`]: list("members", [
        apiMember({ learner_id: L2, role: "Captain", joined_on: "2026-11-22" }),
        apiMember({ learner_id: L1 }),
      ]),
      [`GET ${P}/learners`]: list("learners", [apiLearner(), apiLearner({ id: L2, admission_no: "ADM-1002", full_name: "Brian Mwangi" })]),
      [`GET ${P}/academic-years`]: list("academic_years", [apiYear]),
      [`GET ${P}/classes`]: list("classes", [apiClass]),
      [`GET ${P}/class-memberships`]: list("memberships", [apiMembership(L1)]),
    });
    expect(await fetchActivityMembers(A1)).toEqual([
      { studentId: L1, name: "Amina Ochieng", className: "Form 1 East", role: null, joinedOn: "2026-11-21" },
      { studentId: L2, name: "Brian Mwangi", className: "", role: "Captain", joinedOn: "2026-11-22" },
    ]);
  });

  it("reads a member who has since been archived one by one", async () => {
    boot({
      [`GET ${P}/activities/${A1}/members`]: list("members", [apiMember(), apiMember({ learner_id: L3 })]),
      [`GET ${P}/learners`]: list("learners", [apiLearner()]),
      [`GET ${P}/learners/${L3}`]: { body: { learner: apiLearner({ id: L3, full_name: "Carol Wanjiru", active: false, archived_at: "2026-11-01T00:00:00Z" }) } },
      [`GET ${P}/academic-years`]: list("academic_years", []),
    });
    const rows = await fetchActivityMembers(A1);
    expect(rows.map((r) => r.name)).toEqual(["Amina Ochieng", "Carol Wanjiru"]);
    expect(api.callsTo(`GET ${P}/learners/${L3}`)).toHaveLength(1);
  });

  it("shows members without names, and says so, to someone who may not read learners", async () => {
    boot({
      [`GET ${P}/activities/${A1}/members`]: list("members", [apiMember({ role: "Goalkeeper" })]),
      [`GET ${P}/learners`]: refused("forbidden", 403),
      [`GET ${P}/academic-years`]: refused("forbidden", 403),
    });
    expect(await fetchActivityMembers(A1)).toEqual([
      { studentId: L1, name: HIDDEN_MEMBER_NAME, className: "", role: "Goalkeeper", joinedOn: "2026-11-21" },
    ]);
    expect(api.callsTo(`GET ${P}/learners/${L1}`)).toHaveLength(0);
  });

  it("fails when the members themselves cannot be read", async () => {
    boot({ [`GET ${P}/activities/${A1}/members`]: refused("not_found", 404, "Activity not found") });
    await expect(fetchActivityMembers(A1)).rejects.toMatchObject({ code: "not_found" });
  });

  it("lists the active learners for the picker with their classes, and does without classes when they cannot be read", async () => {
    boot({
      [`GET ${P}/learners`]: list("learners", [apiLearner({ id: L2, admission_no: "ADM-1002", full_name: "Brian Mwangi" }), apiLearner()]),
      [`GET ${P}/academic-years`]: list("academic_years", [apiYear]),
      [`GET ${P}/classes`]: list("classes", [apiClass]),
      [`GET ${P}/class-memberships`]: list("memberships", [apiMembership(L1), apiMembership(L2)]),
    });
    expect(await fetchActiveLearners(T)).toEqual([
      { id: L1, name: "Amina Ochieng", className: "Form 1 East", admissionNo: "ADM-1001" },
      { id: L2, name: "Brian Mwangi", className: "Form 1 East", admissionNo: "ADM-1002" },
    ]);
    expect(api.callsTo(`GET ${P}/learners`)[0]!.query.get("active")).toBe("true");

    api.on(`GET ${P}/class-memberships`, refused("forbidden", 403));
    expect((await fetchActiveLearners(T)).map((l) => l.className)).toEqual(["", ""]);
  });

  it("refuses the picker's learners to someone who may not read them", async () => {
    boot({ [`GET ${P}/learners`]: refused("forbidden", 403) });
    await expect(fetchActiveLearners(T)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("offers only teachers who have a sign-in, by that sign-in's id", async () => {
    boot({
      [`GET ${P}/staff`]: list("staff", [
        apiStaff({ full_name: "Zed Odhiambo", userId: U2 }),
        apiStaff({ id: "82222222-2222-4222-8222-222222222222", full_name: "No Login", userId: null }),
        apiStaff({ id: "83333333-3333-4333-8333-333333333333", full_name: "A Driver", classification: "driver", userId: "63333333-3333-4333-8333-333333333333" }),
        apiStaff(),
      ]),
    });
    expect(await fetchTeachers(T)).toEqual([{ id: U1, name: "David Kamau" }, { id: U2, name: "Zed Odhiambo" }]);
  });

  it("offers no teachers to someone who may not read the staff list", async () => {
    boot({ [`GET ${P}/staff`]: refused("forbidden", 403) });
    expect(await fetchTeachers(T)).toEqual([]);
  });
});

describe("writing activities", () => {
  it("creates an activity and returns its id", async () => {
    boot({ [`POST ${P}/activities`]: { status: 201, body: { activity: apiActivity({ id: A2 }) } } });
    const id = await createActivity(T, { name: "Choir", category: "arts", description: "Sundays", meetingSchedule: "Sun 2pm" });
    expect(id).toBe(A2);
    expect(api.callsTo(`POST ${P}/activities`)[0]!.body).toEqual({ name: "Choir", category: "arts", description: "Sundays", meeting_schedule: "Sun 2pm" });
  });

  it("says plainly when the name is taken", async () => {
    boot({ [`POST ${P}/activities`]: refused("conflict", 409, "An activity with this name already exists") });
    await expect(createActivity(T, { name: "Choir", category: "arts", description: "", meetingSchedule: "" })).rejects.toThrow("There's already an activity with that name.");
  });

  it("passes any other refusal on, as it is", async () => {
    boot({ [`POST ${P}/activities`]: refused("forbidden", 403, "Missing permission") });
    const err = await createActivity(T, { name: "Choir", category: "arts", description: "", meetingSchedule: "" }).catch((e: unknown) => e);
    expect(isApiError(err) && err.code).toBe("forbidden");
  });

  it("adds each new patron with a call of its own", async () => {
    boot({ [`POST ${P}/activities/${A1}/patrons`]: { status: 204 } });
    await setActivityPatrons(T, A1, [], [U1, U2]);
    expect(api.callsTo(`POST ${P}/activities/${A1}/patrons`).map((c) => c.body)).toEqual([{ teacher_user_id: U1 }, { teacher_user_id: U2 }]);
  });

  it("sends nothing when no patron is new", async () => {
    boot({});
    await setActivityPatrons(T, A1, [U1], [U1]);
    expect(api.calls).toHaveLength(0);
  });

  it("refuses to take a patron away, before it sends anything", async () => {
    boot({ [`POST ${P}/activities/${A1}/patrons`]: { status: 204 } });
    await expect(setActivityPatrons(T, A1, [U1], [U2])).rejects.toBeInstanceOf(NotOnApiError);
    expect(api.calls).toHaveLength(0);
  });

  it("says how many patrons went in when one is refused", async () => {
    boot({
      [`POST ${P}/activities/${A1}/patrons`]: (call) => ((call.body as { teacher_user_id: string }).teacher_user_id === U2
        ? refused("validation_error", 400, "teacher_user_id must be an active teacher or school admin")
        : { status: 204 }),
    });
    await expect(setActivityPatrons(T, A1, [], [U1, U2])).rejects.toThrow("Added 1 of 2 patrons before one failed: teacher_user_id must be an active teacher or school admin");
  });

  it("gives the reason alone when no patron went in", async () => {
    boot({ [`POST ${P}/activities/${A1}/patrons`]: refused("not_found", 404, "Activity not found") });
    await expect(setActivityPatrons(T, A1, [], [U1])).rejects.toThrow("Activity not found");
  });

  it("adds each learner as a member with a call of its own, and none for an empty list", async () => {
    boot({ [`POST ${P}/activities/${A1}/members`]: { status: 204 } });
    await addActivityMembers(T, A1, []);
    expect(api.calls).toHaveLength(0);
    await addActivityMembers(T, A1, [L1, L2, L3]);
    expect(api.callsTo(`POST ${P}/activities/${A1}/members`).map((c) => c.body)).toEqual([{ learner_id: L1 }, { learner_id: L2 }, { learner_id: L3 }]);
  });

  it("says how many members went in when one is refused", async () => {
    boot({
      [`POST ${P}/activities/${A1}/members`]: (call) => ((call.body as { learner_id: string }).learner_id === L2
        ? refused("validation_error", 400, "learner_id must be an active learner")
        : { status: 204 }),
    });
    await expect(addActivityMembers(T, A1, [L1, L2, L3])).rejects.toThrow("Added 2 of 3 members before one failed: learner_id must be an active learner");
  });
});

describe("what the API cannot do, which throws before any call", () => {
  const event: EventInput = {
    activityId: A1, title: "Final", kind: "fixture", level: null, startsAt: "2026-12-01T10:00:00Z", endsAt: null, venue: "", opponent: "",
    status: "scheduled", score: "", outcome: null, position: null, notes: "",
  };

  it.each([
    ["editing an activity", () => updateActivity(A1, { name: "New" })],
    ["deleting an activity", () => deleteActivity(A1)],
    ["taking a member out", () => removeActivityMember(A1, L1)],
    ["changing a member's role", () => setMemberRole(A1, L1, "Captain")],
    ["the list of activities a teacher is patron of", () => fetchMyPatronActivityIds(U1)],
    ["reading events", () => fetchActivityEvents(T)],
    ["saving an event", () => saveActivityEvent(T, event)],
    ["deleting an event", () => deleteActivityEvent("e1")],
    ["reading participants", () => fetchEventParticipants("e1")],
    ["setting participants", () => setEventParticipants(T, "e1", [], [L1])],
    ["saving a result", () => saveParticipantResult("e1", L1, { award: null, position: 1, achievement: "" })],
    ["a learner's activities", () => loadLearnerActivities(T, L1)],
    ["a term's activities", () => loadTermActivities(T, [L1], { startsOn: "2026-01-01", endsOn: "2026-04-01" })],
  ])("%s", async (_what, run) => {
    boot({});
    await expect(run()).rejects.toBeInstanceOf(NotOnApiError);
    expect(api.calls).toHaveLength(0);
  });
});
