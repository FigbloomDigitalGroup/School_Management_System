import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import {
  addDefaultBehaviourCategories, fetchBehaviourCategories, fetchBehaviourClasses, fetchBehaviourEntriesPage, fetchBehaviourPoints,
  fetchBehaviourRecorders, fetchBehaviourSettings, fetchClassLearners, fetchFamilyBehaviour, fetchLearnerBehaviour, fetchSchoolLearners,
  recordBehaviour, saveBehaviourCategory, saveBehaviourSettings, setBehaviourCategoryArchived, setBehaviourIncident, voidBehaviourEntry,
} from "../behaviour";
import { peopleCapabilities } from "../capabilities";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { behaviourEntryFromApi, behaviourSettingsFromApi, forgetBehaviourReads, learnerPointsFromApi } from "./behaviourApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const U = "44444444-4444-4444-8444-444444444444";
const L1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const L2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const E1 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
const E2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2";
const E3 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3";
const P = `/v1/tenants/${T}`;

const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const list = (key: string, items: unknown[], next: string | null = null): FakeReply => ({ body: { [key]: items, page: page(next) } });

const apiSettings = (o: Record<string, unknown> = {}) => ({
  points_enabled: true, mode: "both", starting_points: 100, reset: "term", max_points_per_entry: 10,
  thresholds: [{ points: -15, label: "Parent meeting" }], parents_see_demerits: false, parents_see_incidents: false, ...o,
});
const apiEntry = (o: Record<string, unknown> = {}) => ({
  id: E1, learner_id: L1, learner_name: "Alice", admission_no: "A-1", category_id: C1, category_name: "Leadership", kind: "merit", points: 3, severity: null,
  note: null, occurred_on: "2026-11-20", class_id: null, class_name: "Form 1", subject_id: null, recorded_by: U, recorder_name: "Teacher A",
  created_at: "2026-11-20T08:00:00.000Z", voided_at: null, void_reason: null, action_taken: null, follow_up_status: null, resolved_at: null,
  parent_notified_at: null, staff_note: null, ...o,
});
const apiPoints = (o: Record<string, unknown> = {}) => ({
  learner_id: L1, full_name: "Alice", admission_no: "A-1", class_id: C1, class_name: "Form 1", period_start: "2026-09-01", period_end: null,
  merit_points: 5, demerit_points: -2, balance: 3, ...o,
});

let api: FakeApi;
function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: U }));
  setApiActiveTenant(T);
  return api;
}

beforeEach(() => forgetBehaviourReads());
afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

describe("mappers and capabilities", () => {
  it("the learner's behaviour tab on the People page is on the API build", () => {
    initBackend({ kind: "api", apiUrl: BASE });
    expect(peopleCapabilities().learnerBehaviour).toBe(true);
    initBackend({ kind: "supabase" });
    expect(peopleCapabilities().learnerBehaviour).toBe(true);
  });

  it("maps settings, an entry and a learner's points to the shared shapes", () => {
    expect(behaviourSettingsFromApi(T, apiSettings() as never)).toEqual({ tenant_id: T, ...apiSettings() });
    const row = behaviourEntryFromApi(T, apiEntry({ staff_note: "private", kind: "demerit", points: -2, severity: "major" }) as never);
    expect(row).toMatchObject({
      id: E1, tenant_id: T, student_id: L1, kind: "demerit", points: -2, severity: "major", studentName: "Alice", admissionNo: "A-1", categoryName: "Leadership",
      className: "Form 1", recorderName: "Teacher A", staffNote: "private", voided_at: null, follow_up_status: null,
    });
    expect(learnerPointsFromApi(apiPoints() as never)).toEqual({ student_id: L1, period_start: "2026-09-01", period_end: null, merit_points: 5, demerit_points: -2, balance: 3 });
  });
});

describe("settings and categories", () => {
  it("reads and saves the settings, refusing a bad one before any request", async () => {
    boot({ [`GET ${P}/behaviour/settings`]: { body: { settings: apiSettings({ mode: "demerits_only" }) } }, [`PUT ${P}/behaviour/settings`]: { body: { settings: apiSettings() } } });
    const s = await fetchBehaviourSettings(T);
    expect(s).toMatchObject({ tenant_id: T, mode: "demerits_only", reset: "term" });
    await saveBehaviourSettings({ ...s, thresholds: [{ points: -20, label: "  Meeting " }] });
    expect(api.callsTo(`PUT ${P}/behaviour/settings`)[0]!.body).toEqual({
      points_enabled: true, mode: "demerits_only", starting_points: 100, reset: "term", max_points_per_entry: 10,
      thresholds: [{ points: -20, label: "Meeting" }], parents_see_demerits: false, parents_see_incidents: false,
    });
    await expect(saveBehaviourSettings({ ...s, starting_points: -1 })).rejects.toThrow(/starting balance/);
    expect(api.callsTo(`PUT ${P}/behaviour/settings`)).toHaveLength(1);
  });

  it("lists every category, archived ones included; creates, edits, archives and adds the defaults", async () => {
    boot({
      [`GET ${P}/behaviour/categories`]: { body: { categories: [{ id: C1, kind: "merit", name: "Leadership", points: 3, severity: null, sort_order: 2, archived_at: "2026-11-01T00:00:00Z" }] } },
      [`POST ${P}/behaviour/categories`]: { status: 201, body: { category: {} } },
      [`PATCH ${P}/behaviour/categories/${C1}`]: { body: { category: {} } },
      [`POST ${P}/behaviour/categories/defaults`]: { body: { added: 4 } },
    });
    const cats = await fetchBehaviourCategories(T);
    expect(api.calls[0]!.query.get("include_archived")).toBe("true");
    expect(cats[0]).toMatchObject({ id: C1, tenant_id: T, archived_at: "2026-11-01T00:00:00Z", severity: null });
    await saveBehaviourCategory(T, { kind: "merit", name: " Kindness ", points: 2, severity: "major" });
    expect(api.callsTo(`POST ${P}/behaviour/categories`)[0]!.body).toEqual({ kind: "merit", name: "Kindness", points: 2 });
    await saveBehaviourCategory(T, { kind: "demerit", name: "Late", points: 1, severity: "minor" });
    expect(api.callsTo(`POST ${P}/behaviour/categories`)[1]!.body).toEqual({ kind: "demerit", name: "Late", points: 1, severity: "minor" });
    await saveBehaviourCategory(T, { kind: "demerit", name: "Late", points: 2, severity: "major" }, C1);
    expect(api.callsTo(`PATCH ${P}/behaviour/categories/${C1}`)[0]!.body).toEqual({ name: "Late", points: 2, severity: "major" });
    await setBehaviourCategoryArchived(C1, true);
    expect(api.callsTo(`PATCH ${P}/behaviour/categories/${C1}`)[1]!.body).toEqual({ archived: true });
    expect(await addDefaultBehaviourCategories(T)).toBe(4);
    await expect(saveBehaviourCategory(T, { kind: "merit", name: "x", points: 2, severity: null })).rejects.toThrow(/2 to 60/);
    await expect(saveBehaviourCategory(T, { kind: "merit", name: "Okay", points: 0, severity: null })).rejects.toThrow(/whole number/);
  });
});

describe("recording, voiding and incidents", () => {
  it("sends the learners, the kind and the notes; a severity only for an incident; and forgets what it read", async () => {
    let reads = 0;
    boot({
      [`GET ${P}/behaviour/entries`]: () => { reads++; return list("entries", [apiEntry()]); },
      [`POST ${P}/behaviour/entries`]: { status: 201, body: { count: 2, entry_ids: [E1, E2] } },
      [`POST ${P}/behaviour/entries/${E1}/void`]: { body: { entry: apiEntry() } },
      [`PUT ${P}/behaviour/entries/${E1}/incident`]: { body: { entry: apiEntry() } },
    });
    await fetchBehaviourEntriesPage(T, {}, 0, 10);
    await fetchBehaviourEntriesPage(T, {}, 0, 10);
    expect(reads, "the second read is kept").toBe(1);
    expect(await recordBehaviour({ studentIds: [L1, L2], kind: "merit", categoryId: C1, points: null, note: " Well done ", staffNote: "", occurredOn: "2026-11-20", severity: "serious" })).toBe(2);
    expect(api.callsTo(`POST ${P}/behaviour/entries`)[0]!.body).toEqual({ learner_ids: [L1, L2], kind: "merit", category_id: C1, points: null, note: "Well done", staff_note: null, occurred_on: "2026-11-20" });
    await recordBehaviour({ studentIds: [L1], kind: "incident", categoryId: null, points: null, note: "Left the compound", staffNote: "Seen", occurredOn: "2026-11-20" });
    expect(api.callsTo(`POST ${P}/behaviour/entries`)[1]!.body).toMatchObject({ kind: "incident", severity: "serious", staff_note: "Seen", category_id: null });
    await fetchBehaviourEntriesPage(T, {}, 0, 10);
    expect(reads, "a write forgets the kept read").toBe(2);
    await voidBehaviourEntry(E1, "Recorded in error");
    expect(api.callsTo(`POST ${P}/behaviour/entries/${E1}/void`)[0]!.body).toEqual({ reason: "Recorded in error" });
    await fetchBehaviourEntriesPage(T, {}, 0, 10);
    expect(reads).toBe(3);
    await setBehaviourIncident(E1, "parent_meeting", "resolved", true);
    expect(api.callsTo(`PUT ${P}/behaviour/entries/${E1}/incident`)[0]!.body).toEqual({ action_taken: "parent_meeting", follow_up_status: "resolved", parent_notified: true });
    await setBehaviourIncident(E1, null, "open", false);
    expect(api.callsTo(`PUT ${P}/behaviour/entries/${E1}/incident`)[1]!.body).toEqual({ action_taken: null, follow_up_status: "open", parent_notified: false });
  });
});

describe("the log and the learner lists", () => {
  it("reads the log once, newest first as the API sends it, and pages it here with the total", async () => {
    let n = 0;
    boot({
      [`GET ${P}/behaviour/entries`]: () => {
        n++;
        return n === 1 ? list("entries", [apiEntry({ id: E1 }), apiEntry({ id: E2 })], "next-1") : list("entries", [apiEntry({ id: E3 })]);
      },
    });
    const p1 = await fetchBehaviourEntriesPage(T, { classId: C1, kind: "demerit", from: "2026-11-01", to: "2026-11-30", openOnly: true, includeVoided: true }, 0, 2);
    expect(p1.total).toBe(3);
    expect(p1.rows.map((r) => r.id)).toEqual([E1, E2]);
    expect((await fetchBehaviourEntriesPage(T, { classId: C1, kind: "demerit", from: "2026-11-01", to: "2026-11-30", openOnly: true, includeVoided: true }, 2, 2)).rows.map((r) => r.id)).toEqual([E3]);
    expect(api.calls, "two API pages, once").toHaveLength(2);
    const q = api.calls[0]!.query;
    expect(Object.fromEntries(q)).toEqual({ class_id: C1, kind: "demerit", from: "2026-11-01", to: "2026-11-30", open_only: "true", include_voided: "true", limit: "200" });
    expect(api.calls[1]!.query.get("cursor")).toBe("next-1");
  });

  it("a learner's own log asks for that learner and the voided ones when staff want them", async () => {
    boot({ [`GET ${P}/behaviour/entries`]: list("entries", [apiEntry({ voided_at: "2026-11-21T00:00:00Z", void_reason: "Wrong child" })]) });
    const rows = await fetchLearnerBehaviour(L1, true);
    expect(rows[0]).toMatchObject({ voided_at: "2026-11-21T00:00:00Z", void_reason: "Wrong child" });
    expect(Object.fromEntries(api.calls[0]!.query)).toMatchObject({ learner_id: L1, include_voided: "true" });
  });

  it("the office's learner list and its points are one API read; a teacher's class is one call too", async () => {
    boot({ [`GET ${P}/behaviour/points`]: list("learners", [apiPoints({ learner_id: L1 }), apiPoints({ learner_id: L2, full_name: "Brian", class_id: null, class_name: null })]) });
    const [learners, points] = await Promise.all([fetchSchoolLearners(T), fetchBehaviourPoints(null)]);
    expect(api.callsTo(`GET ${P}/behaviour/points`)).toHaveLength(1);
    expect(learners).toEqual([
      { id: L1, full_name: "Alice", admission_no: "A-1", class_id: C1, className: "Form 1" },
      { id: L2, full_name: "Brian", admission_no: "A-1", class_id: null, className: null },
    ]);
    expect(points.get(L1)).toMatchObject({ merit_points: 5, demerit_points: -2, balance: 3 });
    expect((await fetchClassLearners(C1)).map((l) => l.id)).toEqual([L1, L2]);
    expect(api.callsTo(`GET ${P}/behaviour/points`)[1]!.query.get("class_id")).toBe(C1);
  });

  it("points for named learners go 100 at a time, and none at all asks nothing", async () => {
    boot({ [`GET ${P}/behaviour/points`]: list("learners", [apiPoints()]) });
    expect((await fetchBehaviourPoints([])).size).toBe(0);
    expect(api.calls).toHaveLength(0);
    const many = Array.from({ length: 150 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    await fetchBehaviourPoints(many);
    expect(api.calls).toHaveLength(2);
    expect(api.calls[0]!.query.get("learner_ids")!.split(",")).toHaveLength(100);
    expect(api.calls[1]!.query.get("learner_ids")!.split(",")).toHaveLength(50);
    await fetchBehaviourPoints([L1], "2026-10-01");
    expect(api.calls[2]!.query.get("on")).toBe("2026-10-01");
  });

  it("classes and recorders keep the ids the screens use", async () => {
    boot({
      [`GET ${P}/behaviour/classes`]: { body: { classes: [{ id: C1, name: "Form 1", form_level: 1, stream: null }] } },
      [`GET ${P}/behaviour/recorders`]: { body: { recorders: [{ user_id: U, full_name: "Teacher A" }] } },
    });
    expect(await fetchBehaviourClasses(T)).toEqual([{ id: C1, name: "Form 1" }]);
    expect(await fetchBehaviourRecorders(T)).toEqual([{ id: U, full_name: "Teacher A" }]);
  });

  it("a failed read is not kept", async () => {
    let n = 0;
    boot({ [`GET ${P}/behaviour/classes`]: () => (++n === 1 ? { status: 500, body: { error: { code: "internal_error", message: "boom" } } } : { body: { classes: [] } }) });
    await expect(fetchBehaviourClasses(T)).rejects.toThrow();
    expect(await fetchBehaviourClasses(T)).toEqual([]);
  });
});

describe("what a family reads", () => {
  it("is one call, never the school's settings route, with the points and the entries mapped", async () => {
    boot({
      [`GET ${P}/me/children/${L1}/behaviour`]: {
        body: {
          behaviour: {
            settings: { points_enabled: true, mode: "both", starting_points: 100, reset: "term", thresholds: [{ points: 30, label: "Certificate" }], parents_see_demerits: true, parents_see_incidents: false },
            points: { period_start: "2026-09-01", period_end: null, merit_points: 5, demerit_points: -2, balance: 3 },
            entries: [{ id: E1, kind: "merit", points: 3, severity: null, note: "Led", occurred_on: "2026-11-20", category_name: "Leadership", action_taken: null, follow_up_status: null, resolved_at: null, parent_notified_at: null }],
          },
        },
      },
    });
    const v = await fetchFamilyBehaviour(L1, T);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${P}/me/children/${L1}/behaviour`]);
    expect(v.settings).toMatchObject({ tenant_id: T, parents_see_demerits: true, thresholds: [{ points: 30, label: "Certificate" }] });
    expect(v.points).toEqual({ student_id: L1, period_start: "2026-09-01", period_end: null, merit_points: 5, demerit_points: -2, balance: 3 });
    expect(v.entries[0]).toMatchObject({ id: E1, student_id: L1, kind: "merit", points: 3, categoryName: "Leadership", note: "Led", staffNote: null, recorderName: null, voided_at: null });
  });
});
