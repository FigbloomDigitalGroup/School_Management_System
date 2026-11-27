import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLearnerActivities, loadLearnerActivitiesForOffice, mayReadLearnerActivities } from "../activities";
import { initBackend } from "../backend";
import { fetchLearnerSignOutHistory, maySeeLearnerSignOuts } from "../earlySignOut";
import { BASE, createFakeApi, type FakeApi, type FakeCall, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { LEARNER_CARD_ACTIVITY_LIMIT } from "./activitiesApi";
import { SIGN_OUT_SEARCH_PAGES, apiFetchLearnerSignOutHistory, apiFetchStudentEarlySignOuts } from "./attendanceApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { createMemoryTokenStore } from "./tokenStore";

// The learner card's early sign-outs and activities on the API build (slice W0.3): what is read, how much, and what the person is told.

const T = "11111111-1111-4111-8111-111111111111";
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const L1 = "10000001-1111-4111-8111-111111111111";
const L2 = "10000002-1111-4111-8111-111111111111";
const P = `/v1/tenants/${T}`;

const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const list = (key: string, items: unknown[], next: string | null = null): FakeReply => ({ body: { [key]: items, page: page(next) } });
const refused = (code: string, status: number, message = "no"): FakeReply => ({ status, body: { error: { code, message } } });

let api: FakeApi;

function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: "u1" }));
  setApiActiveTenant(T);
  return api;
}

afterEach(() => { vi.unstubAllGlobals(); resetApiClient(); initBackend({ kind: "supabase" }); });

// ---------------------------------------------------------------- early sign-outs

const signOut = (n: number, learner = L1, o: Record<string, unknown> = {}) => ({
  id: `so-${n}`, tenantId: T, learner_id: learner, class_id: C1, learner_name: "Amina Otieno", class_name: "Form 2 East",
  taken_on: "2026-05-10", signed_out_at: `2026-05-10T${String(10 + (n % 10)).padStart(2, "0")}:45:00Z`, signed_out_local: "13:45:00",
  reason: `Reason ${n}`, collected_by_name: "Grace Otieno", collected_by_relationship: "Mother", recorded_by: "u1", voided_at: null, ...o,
});
const collector = (o: Record<string, unknown> = {}) => ({ id_number: "12345678", phone: "+254712345678", authorised_by: "Deputy", note: null, void_reason: null, ...o });
const record = (n: number, learner = L1, withCollector = true, o: Record<string, unknown> = {}) => ({ sign_out: signOut(n, learner, o), collector: withCollector ? collector() : null });

describe("a learner's early sign-outs (the card)", () => {
  it("picks the learner's sign-outs from the school's list, newest first, with the collector details the list already carries", async () => {
    const voided = { sign_out: signOut(1, L1, { voided_at: "2026-05-10T12:00:00Z" }), collector: collector({ void_reason: "Wrong learner" }) };
    boot({ [`GET ${P}/early-sign-outs`]: list("sign_outs", [record(3, L1), record(2, L2), voided]) });
    const h = await apiFetchLearnerSignOutHistory(L1);
    expect(h.rows.map((r) => r.id)).toEqual(["so-3", "so-1"]);
    expect(h.rows[1]!.voided_at).toBe("2026-05-10T12:00:00Z");
    expect(h.details.get("so-3")).toMatchObject({ sign_out_id: "so-3", id_number: "12345678", authorised_by: "Deputy" });
    expect(h.details.get("so-1")?.void_reason).toBe("Wrong learner");
    expect(h.details.has("so-2")).toBe(false);
    expect(h.partial).toBe(false);
    // one read for the list, none for each sign-out (the old card made one read per row)
    expect(api.calls.map((c) => `${c.method} ${c.path.replace(P, "")}`)).toEqual(["GET /early-sign-outs"]);
    expect(api.calls[0]!.query.get("limit")).toBe("200");
  });

  it("has no collector details for a person who may not read them (the list sends none), and says so with an empty map", async () => {
    boot({ [`GET ${P}/early-sign-outs`]: list("sign_outs", [record(1, L1, false)]) });
    const h = await apiFetchLearnerSignOutHistory(L1);
    expect(h.rows).toHaveLength(1);
    expect(h.details.size).toBe(0);
  });

  it("stops reading as soon as it has the learner's newest rows", async () => {
    // the API answers newest first
    boot({ [`GET ${P}/early-sign-outs`]: (c: FakeCall) => (c.query.get("cursor") ? list("sign_outs", [record(0)]) : list("sign_outs", [record(3), record(2), record(1)], "p2")) });
    const h = await apiFetchLearnerSignOutHistory(L1, 2);
    expect(h.rows.map((r) => r.id)).toEqual(["so-3", "so-2"]);
    expect(h.partial).toBe(false);
    expect(api.callsTo(`GET ${P}/early-sign-outs`)).toHaveLength(1);
  });

  it("follows the pages of a long list to the end when it has not found enough", async () => {
    boot({ [`GET ${P}/early-sign-outs`]: (c: FakeCall) => (c.query.get("cursor") === "p2" ? list("sign_outs", [record(5)]) : list("sign_outs", [record(4, L2)], "p2")) });
    const h = await apiFetchLearnerSignOutHistory(L1);
    expect(h.rows.map((r) => r.id)).toEqual(["so-5"]);
    expect(h.partial).toBe(false);
    expect(h.searched).toBe(2);
    expect(api.callsTo(`GET ${P}/early-sign-outs`)[1]!.query.get("cursor")).toBe("p2");
  });

  it("gives up after a fixed number of pages and says the search was cut, instead of reading a whole school's history", async () => {
    boot({ [`GET ${P}/early-sign-outs`]: (c: FakeCall) => list("sign_outs", [record(Number(c.query.get("cursor")?.slice(1) ?? 0), L2)], `p${Number(c.query.get("cursor")?.slice(1) ?? 0) + 1}`) });
    const h = await apiFetchLearnerSignOutHistory(L1);
    expect(h.rows).toEqual([]);
    expect(h.partial).toBe(true);
    expect(api.callsTo(`GET ${P}/early-sign-outs`)).toHaveLength(SIGN_OUT_SEARCH_PAGES);
    expect(h.searched).toBe(SIGN_OUT_SEARCH_PAGES);
  });

  it("does not call the search cut when the list ended exactly at the cap", async () => {
    let n = 0;
    boot({ [`GET ${P}/early-sign-outs`]: () => { n++; return list("sign_outs", [record(n, L2)], n < 3 ? `p${n}` : null); } });
    const h = await apiFetchLearnerSignOutHistory(L1, 50, undefined, 3);
    expect(h.partial).toBe(false);
  });

  it("keeps the older function's answer: the learner's rows only", async () => {
    boot({ [`GET ${P}/early-sign-outs`]: list("sign_outs", [record(2, L1), record(1, L2)]) });
    expect((await apiFetchStudentEarlySignOuts(L1, 10)).map((r) => r.id)).toEqual(["so-2"]);
  });

  it("passes on a refusal in the API's words (the card shows it), and the shared function answers the same on this build", async () => {
    boot({ [`GET ${P}/early-sign-outs`]: refused("forbidden", 403, "Insufficient permissions") });
    await expect(fetchLearnerSignOutHistory(L1)).rejects.toMatchObject({ code: "forbidden", message: "Insufficient permissions" });
  });

  it("is reached through the shared function on the API build", async () => {
    boot({ [`GET ${P}/early-sign-outs`]: list("sign_outs", [record(1)]) });
    const h = await fetchLearnerSignOutHistory(L1);
    expect(h.rows).toHaveLength(1);
    expect(h.partial).toBe(false);
  });
});

describe("who sees a learner's early sign-outs on the card", () => {
  it("on the API build: full administrators and the Attendance area (the Visitors area holds no early sign-out right there)", () => {
    initBackend({ kind: "api", apiUrl: BASE });
    expect(maySeeLearnerSignOuts("all")).toBe(true);
    expect(maySeeLearnerSignOuts(["people", "attendance"])).toBe(true);
    expect(maySeeLearnerSignOuts(["people", "visitors"])).toBe(false);
    expect(maySeeLearnerSignOuts(["people", "fees"])).toBe(false);
    expect(maySeeLearnerSignOuts(["people"])).toBe(false);
  });

  it("on the Supabase build: as before, the Visitors area too", () => {
    initBackend({ kind: "supabase" });
    expect(maySeeLearnerSignOuts("all")).toBe(true);
    expect(maySeeLearnerSignOuts(["visitors"])).toBe(true);
    expect(maySeeLearnerSignOuts(["attendance"])).toBe(true);
    expect(maySeeLearnerSignOuts(["people"])).toBe(false);
  });
});

// ---------------------------------------------------------------- activities

const activity = (n: number, o: Record<string, unknown> = {}) => ({
  id: `ac-${String(n).padStart(2, "0")}`, tenant_id: T, name: `Club ${String(n).padStart(2, "0")}`, category: "sport", description: "", meeting_schedule: "Tue 4pm",
  active: true, created_at: "2026-11-20T08:00:00Z", ...o,
});
const member = (learner: string, o: Record<string, unknown> = {}) => ({ learner_id: learner, role: null, joined_on: "2026-11-21", ...o });
const members = (map: Record<string, unknown[]>): Record<string, FakeRoute> =>
  Object.fromEntries(Object.entries(map).map(([id, ms]) => [`GET ${P}/activities/${id}/members`, list("members", ms)]));

describe("a learner's activities (the card, for the office)", () => {
  it("composes the activity list and each activity's members, and gives the clubs the learner is in, by name, with their role", async () => {
    boot({
      [`GET ${P}/activities`]: list("activities", [activity(2, { name: "Chess" }), activity(1, { name: "Athletics", category: "sport" }), activity(3, { name: "Drama", category: "arts" })]),
      ...members({ "ac-01": [member(L1, { role: "Captain", joined_on: "2026-02-01" }), member(L2)], "ac-02": [member(L2)], "ac-03": [member(L1)] }),
    });
    const out = await loadLearnerActivitiesForOffice(T, L1);
    expect(out.clubs.map((c) => [c.activity.name, c.activity.category, c.role, c.joinedOn])).toEqual([
      ["Athletics", "sport", "Captain", "2026-02-01"], ["Drama", "arts", null, "2026-11-21"],
    ]);
    expect(out.upcoming).toEqual([]);
    expect(out.achievements).toEqual([]);
    expect(out.partial).toBeUndefined();
    // the learner's own (family) read is not called: the office holds no guardian link
    expect(api.calls.filter((c) => c.path.includes("/me/children"))).toHaveLength(0);
    expect(api.calls.filter((c) => c.path.endsWith("/members"))).toHaveLength(3);
  });

  it("is a learner who is in no club: an empty list, not an error", async () => {
    boot({ [`GET ${P}/activities`]: list("activities", [activity(1)]), ...members({ "ac-01": [member(L2)] }) });
    const out = await loadLearnerActivitiesForOffice(T, L1);
    expect(out.clubs).toEqual([]);
  });

  it("is a school with no activities: one read", async () => {
    boot({ [`GET ${P}/activities`]: list("activities", []) });
    expect((await loadLearnerActivitiesForOffice(T, L1)).clubs).toEqual([]);
    expect(api.calls).toHaveLength(1);
  });

  it("follows the pages of a long member list", async () => {
    boot({
      [`GET ${P}/activities`]: list("activities", [activity(1)]),
      [`GET ${P}/activities/ac-01/members`]: (c: FakeCall) => (c.query.get("cursor") ? list("members", [member(L1, { role: "Member" })]) : list("members", [member(L2)], "p2")),
    });
    const out = await loadLearnerActivitiesForOffice(T, L1);
    expect(out.clubs.map((c) => c.role)).toEqual(["Member"]);
  });

  it("never has more than four reads of members at once", async () => {
    let live = 0;
    let most = 0;
    const slow: FakeRoute = async () => { live++; most = Math.max(most, live); await new Promise((r) => setTimeout(r, 5)); live--; return list("members", [member(L2)]); };
    const acts = Array.from({ length: 12 }, (_, i) => activity(i + 1));
    boot({ [`GET ${P}/activities`]: list("activities", acts), ...Object.fromEntries(acts.map((a) => [`GET ${P}/activities/${a.id}/members`, slow])) });
    await loadLearnerActivitiesForOffice(T, L1);
    expect(most).toBeLessThanOrEqual(4);
    expect(most).toBeGreaterThan(1);
  });

  it("reads the members of the first activities only when a school has a great many, and says how many were searched", async () => {
    const total = LEARNER_CARD_ACTIVITY_LIMIT + 5;
    const acts = Array.from({ length: total }, (_, i) => activity(i + 1));
    boot({ [`GET ${P}/activities`]: list("activities", acts), ...Object.fromEntries(acts.map((a) => [`GET ${P}/activities/${a.id}/members`, list("members", [member(L2)])])) });
    const out = await loadLearnerActivitiesForOffice(T, L1);
    expect(out.partial).toEqual({ searched: LEARNER_CARD_ACTIVITY_LIMIT, total });
    expect(api.calls.filter((c) => c.path.endsWith("/members"))).toHaveLength(LEARNER_CARD_ACTIVITY_LIMIT);
  });

  it("passes on a refusal in the API's words (a person without the Activities area), and fails when a member list cannot be read", async () => {
    boot({ [`GET ${P}/activities`]: refused("forbidden", 403, "Insufficient permissions") });
    await expect(loadLearnerActivitiesForOffice(T, L1)).rejects.toMatchObject({ code: "forbidden", message: "Insufficient permissions" });
    boot({ [`GET ${P}/activities`]: list("activities", [activity(1)]), [`GET ${P}/activities/ac-01/members`]: refused("internal_error", 500, "boom") });
    await expect(loadLearnerActivitiesForOffice(T, L1)).rejects.toMatchObject({ code: "internal_error" });
  });

  it("is a different read from the family's: the family function still calls the guardian's endpoint", async () => {
    boot({ [`GET ${P}/me/children/${L1}/activities`]: { body: { activities: [] } } });
    await loadLearnerActivities(T, L1);
    expect(api.callsTo(`GET ${P}/me/children/${L1}/activities`)).toHaveLength(1);
    expect(api.callsTo(`GET ${P}/activities`)).toHaveLength(0);
  });
});

describe("who sees a learner's activities on the card", () => {
  it("on the API build: full administrators and the Activities area", () => {
    initBackend({ kind: "api", apiUrl: BASE });
    expect(mayReadLearnerActivities("all")).toBe(true);
    expect(mayReadLearnerActivities(["people", "activities"])).toBe(true);
    expect(mayReadLearnerActivities(["people"])).toBe(false);
    expect(mayReadLearnerActivities(["people", "attendance"])).toBe(false);
  });

  it("on the Supabase build: everyone who has the card, as before", () => {
    initBackend({ kind: "supabase" });
    expect(mayReadLearnerActivities(["people"])).toBe(true);
    expect(mayReadLearnerActivities("all")).toBe(true);
  });
});
