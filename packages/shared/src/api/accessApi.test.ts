import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteSchoolRole, fetchSchoolAdminAreas, fetchSchoolRoles, fetchSchoolStaffNames, saveSchoolRole, setStaffAreas, setStaffRoles } from "../adminAreas";
import { initBackend } from "../backend";
import { accessCapabilities, isNotOnApiError } from "../capabilities";
import { BASE, createFakeApi, type FakeApi, type FakeRoute } from "../testing/fakeApi";
import {
  accessLockedReason, apiFetchAccessPeople, apiFetchGuardianAccess, apiFetchOrgDelegations, apiFetchStaffAreas, apiRevokeOrgDelegations,
  apiSetGuardianAccess, apiSetStaffAreas, describeDelegatedCode, guardianAccessFromCodes, type AccessPerson,
} from "./accessApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const ME = "99999999-9999-4999-8999-999999999999";
const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const U3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const refused = (status: number, code: string, message = "no") => ({ status, body: { error: { code, message } } });

let api: FakeApi;

function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: ME }));
  setApiActiveTenant(T);
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

const staff = (o: Record<string, unknown>) => ({
  id: "s-" + String(o.full_name), tenantId: T, full_name: "X", staff_title: null, classification: "teacher", phone: null, email: null, userId: null,
  active: true, archived_at: null, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", ...o,
});

describe("access capabilities", () => {
  it("has school roles on Supabase and per-person areas on the API", () => {
    initBackend({ kind: "supabase" });
    expect(accessCapabilities()).toEqual({ schoolRoles: true, perPersonAreas: false });
    initBackend({ kind: "api", apiUrl: BASE });
    expect(accessCapabilities()).toEqual({ schoolRoles: false, perPersonAreas: true });
  });
});

describe("admin areas, one person at a time", () => {
  it("reads every page of who holds areas, in the catalogue's order, one entry per person", async () => {
    boot({
      "GET /v1/rbac/staff-areas": (call) => call.query.get("cursor") === "c2"
        ? { body: { tenantId: T, items: [{ userId: U2, areas: ["audit"] }], page: page() } }
        : { body: { tenantId: T, items: [{ userId: U1, areas: ["attendance", "fees"] }], page: page("c2") } },
    });
    const areas = await apiFetchStaffAreas();
    expect([...areas]).toEqual([[U1, ["fees", "attendance"]], [U2, ["audit"]]]);
    expect(api.callsTo("GET /v1/rbac/staff-areas")).toHaveLength(2);
    expect(api.callsTo("GET /v1/rbac/staff-areas")[0]!.query.get("limit")).toBe("200");
  });

  it("replaces a person's areas, sending them in the catalogue's order, and answers what the server says they hold", async () => {
    boot({ "PUT /v1/rbac/staff-areas": { body: { ok: true, userId: U1, areas: ["leave", "people"] } } });
    expect(await apiSetStaffAreas(U1, ["leave", "people"])).toEqual(["people", "leave"]);
    expect(api.callsTo("PUT /v1/rbac/staff-areas")[0]!.body).toEqual({ userId: U1, areas: ["people", "leave"] });
  });

  it("clears everything with an empty list, never with a missing one", async () => {
    boot({ "PUT /v1/rbac/staff-areas": { body: { ok: true, userId: U1, areas: [] } } });
    expect(await apiSetStaffAreas(U1, [])).toEqual([]);
    expect(api.callsTo("PUT /v1/rbac/staff-areas")[0]!.body).toEqual({ userId: U1, areas: [] });
  });

  it("passes the server's refusals on (your own areas, a person who cannot hold areas)", async () => {
    boot({ "PUT /v1/rbac/staff-areas": refused(403, "forbidden", "Cannot change your own admin areas") });
    await expect(apiSetStaffAreas(ME, ["fees"])).rejects.toMatchObject({ code: "forbidden", message: "Cannot change your own admin areas" });
  });

  it("lists the active staff with the sign-in each has, if any", async () => {
    boot({
      "GET /v1/tenants/11111111-1111-4111-8111-111111111111/staff": {
        body: { staff: [staff({ full_name: "Amina", userId: U1, staff_title: "Deputy" }), staff({ full_name: "Brian", classification: "driver" })], page: page() },
      },
    });
    expect(await apiFetchAccessPeople(T)).toEqual([
      { staffId: "s-Amina", userId: U1, name: "Amina", title: "Deputy", classification: "teacher" },
      { staffId: "s-Brian", userId: null, name: "Brian", title: null, classification: "driver" },
    ]);
    expect(api.callsTo(`GET /v1/tenants/${T}/staff`)[0]!.query.get("active")).toBe("true");
  });

  it("says why someone's areas cannot be changed, and lets everyone else be", () => {
    const p = (o: Partial<AccessPerson>): AccessPerson => ({ staffId: "s", userId: U1, name: "N", title: null, classification: "teacher", ...o });
    expect(accessLockedReason(p({ classification: "school_admin" }), ME)).toMatch(/full admin/);
    expect(accessLockedReason(p({ classification: "driver" }), ME)).toMatch(/Drivers/);
    expect(accessLockedReason(p({ userId: null }), ME)).toMatch(/No sign-in/);
    expect(accessLockedReason(p({ userId: ME }), ME)).toMatch(/your own/);
    expect(accessLockedReason(p({}), ME)).toBeNull();
    expect(accessLockedReason(p({ classification: "staff" }), ME)).toBeNull();
  });
});

describe("the same shared functions the Supabase screens call", () => {
  it("land on the API on an API build: areas read and written, no school roles, names of people with a sign-in only", async () => {
    boot({
      "GET /v1/rbac/staff-areas": { body: { tenantId: T, items: [{ userId: U1, areas: ["fees"] }], page: page() } },
      "PUT /v1/rbac/staff-areas": { body: { ok: true, userId: U1, areas: ["fees"] } },
      [`GET /v1/tenants/${T}/staff`]: { body: { staff: [staff({ full_name: "Amina", userId: U1 }), staff({ full_name: "Brian" })], page: page() } },
    });
    expect(await fetchSchoolAdminAreas(T)).toEqual(new Map([[U1, ["fees"]]]));
    expect(await setStaffAreas(U1, ["fees"])).toEqual(["fees"]);
    expect(await fetchSchoolRoles(T)).toEqual([]);
    expect(await fetchSchoolStaffNames(T)).toEqual(new Map([[U1, "Amina"]]));
    await expect(saveSchoolRole(T, null, "Exams officer", ["academics"])).rejects.toSatisfy(isNotOnApiError);
    await expect(deleteSchoolRole("r1")).rejects.toSatisfy(isNotOnApiError);
    await expect(setStaffRoles(U1, ["r1"])).rejects.toSatisfy(isNotOnApiError);
  });
});

describe("guardian records", () => {
  it("reads which of the two a person has, from the codes the server lists", async () => {
    expect(guardianAccessFromCodes([])).toEqual({ read: false, write: false });
    expect(guardianAccessFromCodes(["resource.guardian.write"])).toEqual({ read: false, write: true });
    boot({ "GET /v1/rbac/guardian-access": { body: { tenantId: T, userId: U1, items: [{ permissionCode: "resource.guardian.read", grantedBy: ME, createdAt: "2026-11-24T00:00:00Z" }] } } });
    expect(await apiFetchGuardianAccess(U1)).toEqual({ read: true, write: false });
    expect(api.callsTo("GET /v1/rbac/guardian-access")[0]!.query.get("userId")).toBe(U1);
  });

  it("gives and takes away only what differs", async () => {
    boot({
      "POST /v1/rbac/guardian-access": { body: { ok: true, granted: ["resource.guardian.write"] } },
      "DELETE /v1/rbac/guardian-access": { body: { ok: true, revoked: ["resource.guardian.read"] } },
    });
    // read -> write: one grant and one revoke
    expect(await apiSetGuardianAccess(U1, { read: true, write: false }, { read: false, write: true })).toBe(true);
    expect(api.callsTo("POST /v1/rbac/guardian-access")[0]!.body).toEqual({ userId: U1, permissionCodes: ["resource.guardian.write"] });
    expect(api.callsTo("DELETE /v1/rbac/guardian-access")[0]!.body).toEqual({ userId: U1, permissionCodes: ["resource.guardian.read"] });
    // unchanged: no call at all
    api.calls.length = 0;
    expect(await apiSetGuardianAccess(U1, { read: true, write: true }, { read: true, write: true })).toBe(false);
    expect(api.calls).toHaveLength(0);
    // only a grant
    expect(await apiSetGuardianAccess(U2, { read: false, write: false }, { read: true, write: false })).toBe(true);
    expect(api.calls.map((c) => c.method)).toEqual(["POST"]);
  });
});

describe("organization administrators", () => {
  const row = (o: Record<string, unknown>) => ({ id: "d", delegateUserId: U1, permissionCode: "tenant.read", grantedBy: ME, createdAt: "2026-11-20T10:00:00.000000Z", revokedAt: null, ...o });

  it("groups the active rows by person, earliest date first, codes sorted", async () => {
    boot({
      "GET /v1/rbac/org-delegations": (call) => call.query.get("cursor") === "n"
        ? { body: { tenantId: T, items: [row({ delegateUserId: U1, permissionCode: "area.fees", createdAt: "2026-11-18T10:00:00.000000Z" })], page: page() } }
        : { body: { tenantId: T, items: [row({ delegateUserId: U1 }), row({ delegateUserId: U2, permissionCode: "area.leave" })], page: page("n") } },
    });
    const list = await apiFetchOrgDelegations();
    expect(list).toEqual([
      { delegateUserId: U1, codes: ["area.fees", "tenant.read"], since: "2026-11-18T10:00:00.000000Z" },
      { delegateUserId: U2, codes: ["area.leave"], since: "2026-11-20T10:00:00.000000Z" },
    ]);
    expect(api.callsTo("GET /v1/rbac/org-delegations")[0]!.query.get("status")).toBe("active");
  });

  it("shows none to someone who may not read them, and fails on anything else", async () => {
    boot({ "GET /v1/rbac/org-delegations": refused(403, "forbidden") });
    expect(await apiFetchOrgDelegations()).toEqual([]);
    api.on("GET /v1/rbac/org-delegations", refused(503, "service_unavailable"));
    await expect(apiFetchOrgDelegations()).rejects.toMatchObject({ code: "service_unavailable" });
  });

  it("takes back everything a person was given, naming only the person", async () => {
    boot({ "DELETE /v1/rbac/org-delegations": { body: { ok: true, revoked: ["tenant.read"] } } });
    await apiRevokeOrgDelegations(U3);
    expect(api.callsTo("DELETE /v1/rbac/org-delegations")[0]!.body).toEqual({ delegateUserId: U3 });
  });

  it("says what a code means in plain words, and leaves an unknown one as it is", () => {
    expect(describeDelegatedCode("area.fees")).toBe("Fees area");
    expect(describeDelegatedCode("rbac.staff_areas.manage")).toBe("Give staff admin areas");
    expect(describeDelegatedCode("something.new")).toBe("something.new");
    expect(describeDelegatedCode("area.nonsense")).toBe("area.nonsense");
  });
});
