import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { NotOnApiError, visitorsCapabilities } from "../capabilities";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import {
  escalateVisit, fetchVisitHosts, findVisitLearners, listVisits, pushVisit, recordVisit, setVisitStatus, subscribeVisits,
  type Visit,
} from "../visitors";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { POLL_VISITS_LIMIT, visitFromApi } from "./visitorsApi";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const YEAR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const L1 = "10000001-1111-4111-8111-111111111111";
const L2 = "10000002-1111-4111-8111-111111111111";
const ST1 = "20000001-1111-4111-8111-111111111111";
const ST2 = "20000002-1111-4111-8111-111111111111";
const U1 = "30000001-1111-4111-8111-111111111111";
const V1 = "40000001-1111-4111-8111-111111111111";
const V2 = "40000002-1111-4111-8111-111111111111";

const stamp = { created_at: "2026-05-01T08:00:00Z", updated_at: "2026-05-01T08:00:00Z" };
const gateVisit = (o: Record<string, unknown> = {}) => ({
  id: V1, tenant_id: T, visitor_name: "John Doe", visitor_phone: "+254712345678", id_number: "12345678",
  vehicle_plate: "KAA 123A", purpose: "Parent meeting", host_kind: "teacher" as const,
  host_user_id: U1, learner_id: null, host_name: "Grace Mwangi", learner_name: null,
  entry_point: "gate" as const, status: "expected" as const, escalated: false, escalated_at: null,
  note: null, recorded_by: U1, arrived_at: "2026-05-10T09:00:00Z",
  reception_at: null, with_host_at: null, left_at: null, updated_at: "2026-05-10T09:00:00Z",
  ...o,
});
const year = { id: YEAR, tenantId: T, label: "2026", starts_on: "2026-01-01", ends_on: "2026-12-31", is_current: true, ...stamp };
const clsRow = {
  id: C1, tenantId: T, academic_year_id: YEAR, name: "Form 2 East", form_level: 2, stream: "East",
  education_level: "secondary", class_teacher_staff_id: ST1, active: true, ...stamp,
};
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
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: U1 }));
  setApiActiveTenant(T);
  return api;
}

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

describe("visitFromApi", () => {
  it("maps host_user_id, learner_id, learner_name, and nullable fields", () => {
    const mapped = visitFromApi(gateVisit({ host_kind: "learner", host_user_id: null, learner_id: L1, learner_name: "Amina Otieno", visitor_phone: undefined }));
    expect(mapped.host_id).toBeNull();
    expect(mapped.student_id).toBe(L1);
    expect(mapped.student_name).toBe("Amina Otieno");
    expect(mapped.visitor_phone).toBeNull();
  });
});

describe("listVisits, recordVisit, setVisitStatus on API", () => {
  it("pages gate-visits, filters by date range, and stops when reaching older visits", async () => {
    const server = boot({
      [`GET ${P}/gate-visits`]: (req) => {
        if (req.query.get("cursor") === "c1") {
          return list("visits", [
            gateVisit({ id: V2, arrived_at: "2026-05-10T07:00:00Z" }),
            gateVisit({ id: "old", arrived_at: "2026-05-09T20:00:00Z" }),
          ], "c2");
        }
        return list("visits", [
          gateVisit({ id: "future", arrived_at: "2026-05-11T08:00:00Z" }),
          gateVisit({ id: V1, arrived_at: "2026-05-10T10:00:00Z" }),
        ], "c1");
      },
    });

    const rows = await listVisits(T, new Date("2026-05-10T00:00:00Z"), new Date("2026-05-11T00:00:00Z"));
    expect(rows.map((r) => r.id)).toEqual([V1, V2]);
    // Stopped at cursor c1 because the last row was older than since; never fetched c2.
    expect(server.calls).toHaveLength(2);
    expect(server.calls[0]!.query.get("mine")).toBeNull();
  });

  it("passes mine=true to listVisits and subscribeVisits when requested", async () => {
    const server = boot({ [`GET ${P}/gate-visits`]: () => list("visits", [gateVisit()]) });
    await listVisits(T, new Date("2026-05-10T00:00:00Z"), new Date("2026-05-11T00:00:00Z"), { mine: true });
    expect(server.calls[0]!.query.get("mine")).toBe("true");

    vi.useFakeTimers();
    const stop = subscribeVisits(T, () => {}, { mine: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.calls[1]!.query.get("mine")).toBe("true");
    stop();
  });

  it("posts strict create and advance bodies", async () => {
    const server = boot({
      [`POST ${P}/gate-visits`]: { status: 201, body: { visit: gateVisit() } },
      [`POST ${P}/gate-visits/${V1}/advance`]: { body: { visit: gateVisit({ status: "at_reception", reception_at: "2026-05-10T09:05:00Z" }) } },
    });

    const created = await recordVisit(T, {
      visitor_name: "  John Doe ",
      visitor_phone: " ",
      vehicle_plate: " kaa 123a ",
      purpose: "  Parent meeting ",
      host_kind: "teacher",
      host_id: U1,
    }, "gate");
    expect(created.id).toBe(V1);
    expect(server.calls[0]!.body).toEqual({
      visitor_name: "John Doe",
      visitor_phone: null,
      id_number: null,
      vehicle_plate: "KAA 123A",
      purpose: "Parent meeting",
      host_kind: "teacher",
      host_user_id: U1,
      learner_id: null,
      entry_point: "gate",
    });

    const advanced = await setVisitStatus(V1, "at_reception");
    expect(advanced).toMatchObject({ id: V1, status: "at_reception" });
    expect(server.calls[1]!.body).toEqual({ status: "at_reception" });
  });
});

describe("fetchVisitHosts and findVisitLearners on API", () => {
  it("lists staff with user accounts and searches learners with class names", async () => {
    boot({
      [`GET ${P}/staff`]: list("staff", [
        { id: ST1, tenantId: T, full_name: "Grace Mwangi", staff_title: "Teacher", classification: "teacher", phone: null, email: null, userId: U1, active: true, archived_at: null, ...stamp },
        { id: ST2, tenantId: T, full_name: "Unlinked Clerk", staff_title: "Clerk", classification: "staff", phone: null, email: null, userId: null, active: true, archived_at: null, ...stamp },
      ]),
      [`GET ${P}/academic-years`]: list("academic_years", [year]),
      [`GET ${P}/classes`]: list("classes", [clsRow]),
      [`GET ${P}/class-memberships`]: list("memberships", [
        { id: "m1", tenantId: T, learner_id: L1, class_id: C1, academic_year_id: YEAR, active: true, ...stamp },
      ]),
      [`GET ${P}/learners`]: list("learners", [
        { id: L1, tenantId: T, admission_no: "ADM001", full_name: "Amina Otieno", gender: "female", date_of_birth: null, boarding: false, active: true, archived_at: null, ...stamp },
        { id: L2, tenantId: T, admission_no: "ADM002", full_name: "Brian Kamau", gender: "male", date_of_birth: null, boarding: false, active: true, archived_at: null, ...stamp },
      ]),
    });

    expect(await fetchVisitHosts(T)).toEqual([
      { id: U1, full_name: "Grace Mwangi", role: "teacher", staff_title: "Teacher" },
    ]);
    expect(await findVisitLearners(T, "a")).toEqual([]);
    expect(await findVisitLearners(T, "amina")).toEqual([
      { id: L1, full_name: "Amina Otieno", admission_no: "ADM001", class_name: "Form 2 East" },
    ]);

    boot({ [`GET ${P}/staff`]: refused("forbidden", 403) });
    expect(await fetchVisitHosts(T)).toEqual([]);
  });
});

describe("subscribeVisits on API polls", () => {
  it("seeds on first poll and emits new and updated visits afterwards", async () => {
    let rows = [gateVisit({ id: V1, status: "expected", updated_at: "2026-05-10T09:00:00Z" })];
    boot({ [`GET ${P}/gate-visits`]: () => list("visits", rows) });

    vi.useFakeTimers();
    const events: Array<{ id: string; status: string; isNew: boolean }> = [];
    const stop = subscribeVisits(T, (v: Visit, isNew: boolean) => events.push({ id: v.id, status: v.status, isNew }));

    // First poll seeds without emitting.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toEqual([]);
    expect(api.calls[0]!.query.get("limit")).toBe(String(POLL_VISITS_LIMIT));

    // Second poll sees an updated status on V1 and a new V2.
    rows = [
      gateVisit({ id: V2, visitor_name: "Jane Roe", status: "expected", updated_at: "2026-05-10T09:01:00Z" }),
      gateVisit({ id: V1, status: "at_reception", updated_at: "2026-05-10T09:01:00Z" }),
    ];
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toEqual([
      { id: V1, status: "at_reception", isNew: false },
      { id: V2, status: "expected", isNew: true },
    ]);
    stop();
  });
});

describe("visitorsCapabilities and deferred API features", () => {
  it("hides post-arrival escalation on API and guards escalateVisit", async () => {
    expect(visitorsCapabilities()).toEqual({ escalateAfterArrival: true });

    initBackend({ kind: "api", apiUrl: BASE });
    expect(visitorsCapabilities()).toEqual({ escalateAfterArrival: false });

    await pushVisit(V1);
    await expect(escalateVisit(V1)).rejects.toThrow(NotOnApiError);
  });
});
