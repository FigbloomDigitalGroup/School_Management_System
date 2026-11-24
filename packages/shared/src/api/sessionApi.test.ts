import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import {
  currentUserId, fetchHomeDestination, fetchSignInProfile, hasSession, loadMyWorkspaces, loadOrgSession, loadSchoolSession, onSessionChange,
  signInWithEmail, signOutHere, storedSessionUserId, type SessionChange,
} from "../session";
import { BASE, createFakeApi, type FakeApi, type FakeRoute } from "../testing/fakeApi";
import { apiClient, resetApiClient, setApiTokenStore } from "./client";
import { adminAreasFromPermissions, accentFromApi, forgetApiSchools, profileFromApi, roleOutsideSchools, tenantFromApi, viewOfMe, type MeView } from "./sessionApi";
import { createMemoryTokenStore, type TokenStore } from "./tokenStore";

const SCHOOL = "11111111-1111-4111-8111-111111111111";
const OTHER_SCHOOL = "22222222-2222-4222-8222-222222222222";
const USER = "99999999-9999-4999-8999-999999999999";
const SESSION = { token: "tok-1", expiresAt: "2099-01-01T00:00:00.000Z", userId: USER };

const user = (over: Record<string, unknown> = {}) => ({ id: USER, full_name: "Wanjiru Kamau", email: "w@school.test", must_change_password: false, platform_role: null, ...over });
const membership = (over: Record<string, unknown> = {}) => ({ tenantId: SCHOOL, role: "school_admin", loginId: null, tenantStatus: "active", ...over });
const me = (over: Record<string, unknown> = {}) => ({
  user: user(), session: { id: "s1", activeTenantId: null, expiresAt: SESSION.expiresAt }, memberships: [membership()], membershipsComplete: true,
  authz: { role: "school_admin", tenantId: SCHOOL, isSuperAdmin: false }, ...over,
});
const tenant = (over: Record<string, unknown> = {}) => ({ id: SCHOOL, name: "Alliance High", slug: "alliance", status: "active", timezone: "Africa/Nairobi", organizationId: "33333333-3333-4333-8333-333333333333", ...over });
const profile = (over: Record<string, unknown> = {}) => ({
  schoolProfile: { tenantId: SCHOOL, name: "Alliance High", slug: "alliance", status: "active", timezone: "Africa/Nairobi", organizationId: "33333333-3333-4333-8333-333333333333",
    county: "Kiambu", country: "ke", level: "secondary", institution_type: "k12", moe_registration: "MOE-1", accent: "#112233", ...over },
});
const permissions = (items: string[], next: string | null = null) => ({ body: { role: "teacher", tenantId: SCHOOL, mayAdminister: false, isOrgAdminForTenant: false, isSuperAdmin: false, delegatedPermissions: [], actingVia: "membership", items, page: { limit: 200, next_cursor: next } } });

let api: FakeApi;
let store: TokenStore;

function boot(routes: Record<string, FakeRoute>, session: typeof SESSION | null = SESSION) {
  api = createFakeApi(routes);
  store = createMemoryTokenStore(session);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  forgetApiSchools(); // what one test learnt about a school must not answer the next
  setApiTokenStore(store);
}

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

describe("mapping", () => {
  it("reads admin areas out of permission codes and ignores the rest", () => {
    expect(adminAreasFromPermissions(["resource.learner.read", "area.people", "area.fees", "area.nonsense", "area.people", "areas.leave", "perm.academics"])).toEqual(["people", "fees"]);
    expect(adminAreasFromPermissions([])).toEqual([]);
  });

  it("takes a #RRGGBB accent and nothing else", () => {
    expect(accentFromApi("#112233")).toBe("#112233");
    for (const v of ["red", "#123", "112233", "#11223", "#1122334", null, undefined, ""]) expect(accentFromApi(v)).toBe("#1B4D2E");
  });

  it("builds the school from the record and the profile", () => {
    const t = tenantFromApi(tenant(), profile().schoolProfile as never);
    expect(t).toMatchObject({ id: SCHOOL, name: "Alliance High", slug: "alliance", county: "Kiambu", country: "KE", level: "secondary", institution_type: "k12", accent: "#112233", moe_registration: "MOE-1", status: "active", timezone: "Africa/Nairobi" });
  });

  it("fills a school the person may not read the profile of with plain defaults", () => {
    const t = tenantFromApi(tenant({ status: "weird" }), null);
    expect(t).toMatchObject({ county: "", country: "KE", level: "secondary", institution_type: "k12", accent: "#1B4D2E", moe_registration: null, status: "active", licensed_seats: 0, logo_url: null });
  });

  it("does not take a level or country it cannot place", () => {
    const t = tenantFromApi(tenant(), { ...profile().schoolProfile, level: "Mixed day", country: "Kenya" } as never);
    expect(t).toMatchObject({ level: "secondary", country: "KE" });
    expect(tenantFromApi(tenant(), { ...profile().schoolProfile, level: "combined", institution_type: "higher_ed" } as never)).toMatchObject({ level: "combined", institution_type: "higher_ed" });
  });

  it("builds the profile from who is signed in", () => {
    const v = viewOfMe(me({ memberships: [membership({ loginId: "TC-0001", role: "teacher" })] }) as never);
    expect(profileFromApi(v, v.memberships[0]!, "teacher")).toMatchObject({ id: USER, tenant_id: SCHOOL, role: "teacher", full_name: "Wanjiru Kamau", login_id: "TC-0001", must_change_password: false });
    expect(profileFromApi(v, null, "org_admin")).toMatchObject({ tenant_id: null, login_id: null, role: "org_admin" });
  });

  it("drops memberships it cannot act on, and refuses an answer with no user", () => {
    const v = viewOfMe(me({ memberships: [membership(), { role: "teacher" }, { tenantId: OTHER_SCHOOL }] }) as never);
    expect(v.memberships).toHaveLength(1);
    expect(() => viewOfMe({} as never)).toThrow(/not understood/);
  });

  it("recognises a person outside any school", () => {
    const v = (over: Record<string, unknown>): MeView => viewOfMe(me(over) as never);
    expect(roleOutsideSchools(v({ user: user({ platform_role: "super_admin" }) }))).toBe("super_admin");
    expect(roleOutsideSchools(v({ authz: { role: "super_admin", isSuperAdmin: true } }))).toBe("super_admin");
    expect(roleOutsideSchools(v({ authz: { role: "org_admin", tenantId: null, isSuperAdmin: false } }))).toBe("org_admin");
    expect(roleOutsideSchools(v({}))).toBeNull();
    expect(roleOutsideSchools(v({ authz: null }))).toBeNull();
  });
});

describe("loadSchoolSession on the API", () => {
  const school = (extra: Record<string, FakeRoute> = {}) => ({
    "GET /v1/auth/me": { body: me() },
    [`GET /v1/tenants/${SCHOOL}`]: { body: tenant() },
    [`GET /v1/tenants/${SCHOOL}/school-profile`]: { body: profile() },
    ...extra,
  });

  it("is null when nobody is signed in, without a call", async () => {
    boot(school(), null);
    expect(await loadSchoolSession("alliance")).toBeNull();
    expect(api.calls).toHaveLength(0);
  });

  it("is null, and the session is gone, when the server no longer honours it", async () => {
    boot({ "GET /v1/auth/me": { status: 401, body: { error: { code: "unauthorized", message: "no" } } } });
    expect(await loadSchoolSession("alliance")).toBeNull();
    expect(store.get()).toBeNull();
  });

  it("finds a school administrator's school by its address", async () => {
    boot(school());
    const s = await loadSchoolSession("alliance");
    expect(s?.profile).toMatchObject({ role: "school_admin", tenant_id: SCHOOL, full_name: "Wanjiru Kamau" });
    expect(s?.tenant).toMatchObject({ id: SCHOOL, name: "Alliance High", slug: "alliance", accent: "#112233" });
    expect(s).toMatchObject({ actingForTenant: false, actingOrganization: null, schoolSuspended: false, adminAreas: [] });
    // A school administrator holds every area already: nothing is asked of the permission list.
    expect(api.callsTo("GET /v1/rbac/permissions")).toHaveLength(0);
  });

  it("sends the school it found with every later call of this tab", async () => {
    boot(school());
    await loadSchoolSession("alliance");
    expect(apiClient().activeTenant()).toBe(SCHOOL);
  });

  it("gives a teacher the admin areas the school holds for them, across pages", async () => {
    boot(school({
      "GET /v1/auth/me": { body: me({ memberships: [membership({ role: "teacher" })] }) },
      "GET /v1/rbac/permissions": (c) => (c.query.get("cursor") ? permissions(["area.fees", "resource.x"]) : permissions(["area.people"], "next-1")),
    }));
    const s = await loadSchoolSession("alliance");
    expect(s?.profile?.role).toBe("teacher");
    expect(s?.adminAreas).toEqual(["people", "fees"]);
    const calls = api.callsTo("GET /v1/rbac/permissions");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.query.get("limit")).toBe("200");
    expect(calls[1]?.query.get("cursor")).toBe("next-1");
    expect(calls[0]?.headers["x-tenant-id"]).toBe(SCHOOL);
  });

  it("does not ask a parent for admin areas", async () => {
    boot(school({ "GET /v1/auth/me": { body: me({ memberships: [membership({ role: "parent" })] }) } }));
    const s = await loadSchoolSession("alliance");
    expect(s?.profile?.role).toBe("parent");
    expect(api.callsTo("GET /v1/rbac/permissions")).toHaveLength(0);
  });

  it("shows the school without its profile when the person may not read it", async () => {
    boot(school({ [`GET /v1/tenants/${SCHOOL}/school-profile`]: { status: 403, body: { error: { code: "forbidden", message: "no" } } } }));
    const s = await loadSchoolSession("alliance");
    expect(s?.tenant).toMatchObject({ name: "Alliance High", county: "", accent: "#1B4D2E" });
  });

  it("returns a null school for an address that is not theirs", async () => {
    boot(school());
    const s = await loadSchoolSession("somewhere-else");
    expect(s?.tenant).toBeNull();
    expect(s?.profile).toBeNull();
    expect(apiClient().activeTenant()).toBeNull();
  });

  it("finds the right school among several", async () => {
    boot(school({
      "GET /v1/auth/me": { body: me({ memberships: [membership({ tenantId: OTHER_SCHOOL, role: "parent" }), membership()] }) },
      [`GET /v1/tenants/${OTHER_SCHOOL}`]: { body: tenant({ id: OTHER_SCHOOL, slug: "other", name: "Other" }) },
    }));
    const s = await loadSchoolSession("alliance");
    expect(s?.profile).toMatchObject({ tenant_id: SCHOOL, role: "school_admin" });
  });

  it("reports a suspended school without asking it anything", async () => {
    boot(school({ "GET /v1/auth/me": { body: me({ memberships: [membership({ tenantStatus: "suspended" })] }) } }));
    const s = await loadSchoolSession("alliance");
    expect(s).toMatchObject({ schoolSuspended: true, tenant: null });
    expect(s?.profile?.role).toBe("school_admin");
    expect(api.callsTo(`GET /v1/tenants/${SCHOOL}/school-profile`)).toHaveLength(0);
  });

  it("gives a platform super admin a profile and no school", async () => {
    boot({ "GET /v1/auth/me": { body: me({ user: user({ platform_role: "super_admin" }), memberships: [], authz: { role: "super_admin", tenantId: null, isSuperAdmin: true } }) } });
    const s = await loadSchoolSession("alliance");
    expect(s?.profile).toMatchObject({ role: "super_admin", tenant_id: null });
    expect(s?.tenant).toBeNull();
  });

  it("refuses a role this app does not know instead of guessing", async () => {
    boot(school({ "GET /v1/auth/me": { body: me({ memberships: [membership({ role: "janitor" })] }) } }));
    await expect(loadSchoolSession("alliance")).rejects.toThrow(/janitor/);
  });

  it("with no address, answers who the person is and no school", async () => {
    boot(school());
    const s = await loadSchoolSession(null);
    expect(s?.profile).toMatchObject({ role: "school_admin" });
    expect(s?.tenant).toBeNull();
    expect(api.callsTo(`GET /v1/tenants/${SCHOOL}`)).toHaveLength(0);
  });

  it("does not let a server fault pass as 'not signed in'", async () => {
    boot({ "GET /v1/auth/me": { status: 500, body: { error: { code: "internal_error", message: "x" } } } });
    await expect(loadSchoolSession("alliance")).rejects.toMatchObject({ code: "internal_error" });
    expect(store.get()).not.toBeNull();
  });
});

describe("the rest of session.ts on the API", () => {
  it("org console (S11): a session the server no longer honours answers null (the rest is in orgApi.test.ts)", async () => {
    boot({ "GET /v1/auth/me": { status: 401, body: { error: { code: "unauthorized", message: "Session expired" } } } });
    expect(await loadOrgSession("any")).toBeNull();
    boot({ "GET /v1/auth/me": { status: 401, body: { error: { code: "unauthorized", message: "Session expired" } } } });
    expect(await loadMyWorkspaces()).toBeNull();
  });

  it("signs in with an email, keeps the session, and answers the person's id", async () => {
    boot({ "POST /v1/auth/login/email": { body: { token: "new-tok", expiresAt: "2099-01-01T00:00:00.000Z", user: user(), activeTenantId: SCHOOL } } }, null);
    expect(await signInWithEmail("w@school.test", "pw")).toBe(USER);
    expect(store.get()).toEqual({ token: "new-tok", expiresAt: "2099-01-01T00:00:00.000Z", userId: USER });
    expect(api.calls[0]?.headers.authorization).toBeUndefined();
    expect(api.calls[0]?.body).toEqual({ email: "w@school.test", password: "pw" });
  });

  it("throws a wrong password as an ApiError and keeps no session", async () => {
    boot({ "POST /v1/auth/login/email": { status: 401, body: { error: { code: "unauthorized", message: "Invalid credentials" } } } }, null);
    await expect(signInWithEmail("w@school.test", "bad")).rejects.toMatchObject({ code: "unauthorized", message: "Invalid credentials" });
    expect(store.get()).toBeNull();
  });

  it("knows who is signed in from the stored session, and from the server", async () => {
    boot({ "GET /v1/auth/me": { body: me() } });
    expect(await storedSessionUserId()).toBe(USER);
    expect(await hasSession()).toBe(true);
    expect(await currentUserId()).toBe(USER);
    expect(api.callsTo("GET /v1/auth/me")).toHaveLength(1);
    store.clear();
    expect(await storedSessionUserId()).toBeNull();
    expect(await hasSession()).toBe(false);
    expect(await currentUserId()).toBeNull();
  });

  it("asks the server who it is when the stored session does not say", async () => {
    boot({ "GET /v1/auth/me": { body: me() } }, { token: "t", expiresAt: SESSION.expiresAt } as never);
    expect(await storedSessionUserId()).toBe(USER);
  });

  it("forgets the school it had found when the person signs out", async () => {
    boot({
      "GET /v1/auth/me": { body: me() }, [`GET /v1/tenants/${SCHOOL}`]: { body: tenant() },
      [`GET /v1/tenants/${SCHOOL}/school-profile`]: { body: profile() }, "POST /v1/auth/logout": { body: { ok: true } },
    });
    await loadSchoolSession("alliance");
    expect(apiClient().activeTenant()).toBe(SCHOOL);
    await signOutHere();
    expect(apiClient().activeTenant()).toBeNull();
    // Signed in again as someone else, the school is asked about afresh rather than remembered.
    store.set(SESSION);
    await loadSchoolSession("alliance");
    expect(api.callsTo(`GET /v1/tenants/${SCHOOL}`)).toHaveLength(2);
  });

  it("signs out: the server is told, the session is forgotten, even if the server fails", async () => {
    boot({ "POST /v1/auth/logout": { body: { ok: true } } });
    await signOutHere();
    expect(api.callsTo("POST /v1/auth/logout")).toHaveLength(1);
    expect(store.get()).toBeNull();

    boot({ "POST /v1/auth/logout": { networkError: true } });
    await signOutHere();
    expect(store.get()).toBeNull();
  });

  it("tells what role and school to open after sign-in", async () => {
    boot({ "GET /v1/auth/me": { body: me({ memberships: [membership({ role: "teacher" })] }) } });
    expect(await fetchSignInProfile(USER)).toEqual({ role: "teacher", tenant_id: SCHOOL });
    boot({ "GET /v1/auth/me": { body: me({ user: user({ platform_role: "super_admin" }), memberships: [] }) } });
    expect(await fetchSignInProfile(USER)).toEqual({ role: "super_admin", tenant_id: null });
    boot({ "GET /v1/auth/me": { body: me({ memberships: [], authz: null }) } });
    expect(await fetchSignInProfile(USER)).toBeNull();
  });

  it("finds the address of the school to open", async () => {
    boot({ [`GET /v1/tenants/${SCHOOL}`]: { body: tenant() }, [`GET /v1/tenants/${SCHOOL}/school-profile`]: { body: profile({ institution_type: "higher_ed" }) } });
    expect(await fetchHomeDestination(USER, { role: "teacher", tenant_id: SCHOOL })).toEqual({ slug: "alliance", institutionType: "higher_ed", pickOrganization: false });
    expect(await fetchHomeDestination(USER, { role: "org_admin", tenant_id: null })).toEqual({ slug: null, pickOrganization: false });
  });
});

describe("onSessionChange on the API", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("reports how things stand first, then a sign-in and a sign-out", async () => {
    boot({}, null);
    const seen: SessionChange[] = [];
    const stop = onSessionChange((c) => seen.push(c));
    await tick();
    expect(seen).toEqual([{ event: "initial", userId: null }]);
    store.set(SESSION);
    store.clear();
    expect(seen.slice(1)).toEqual([{ event: "signed-in", userId: USER }, { event: "signed-out", userId: null }]);
    stop();
    store.set(SESSION);
    expect(seen).toHaveLength(3);
  });

  it("says nothing when the stored session is written again unchanged", async () => {
    boot({}, null);
    const seen: SessionChange[] = [];
    const stop = onSessionChange((c) => seen.push(c));
    await tick();
    store.set(SESSION);
    store.set({ ...SESSION });
    expect(seen.filter((c) => c.event === "signed-in")).toHaveLength(1);
    stop();
  });

  it("starts with the person already signed in", async () => {
    boot({});
    const seen: SessionChange[] = [];
    const stop = onSessionChange((c) => seen.push(c));
    await tick();
    expect(seen).toEqual([{ event: "initial", userId: USER }]);
    stop();
  });

  it("reports a sign-out when the token's own time runs out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-11-23T10:00:00Z"));
    boot({}, { token: "t", expiresAt: "2026-11-23T10:00:05Z", userId: USER });
    const seen: SessionChange[] = [];
    const stop = onSessionChange((c) => seen.push(c));
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual([{ event: "initial", userId: USER }]);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(seen.at(-1)).toEqual({ event: "signed-out", userId: null });
    expect(store.get()).toBeNull();
    stop();
  });

  it("reports a sign-out when a call finds the session gone", async () => {
    boot({ "GET /v1/auth/me": { status: 401, body: { error: { code: "unauthorized", message: "no" } } } });
    const seen: SessionChange[] = [];
    const stop = onSessionChange((c) => seen.push(c));
    await loadSchoolSession("alliance");
    expect(seen.some((c) => c.event === "signed-out")).toBe(true);
    stop();
  });
});
