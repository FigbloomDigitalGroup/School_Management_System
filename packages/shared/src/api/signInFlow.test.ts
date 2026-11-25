import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { BASE, createFakeApi, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiTokenStore } from "./client";
import { forgetApiSchools } from "./sessionApi";
import { consoleOnApi, continueSignIn, stepAfterSignIn } from "./signInFlow";
import { createMemoryTokenStore, type TokenStore } from "./tokenStore";

const SCHOOL = "11111111-1111-4111-8111-111111111111";
const USER = "99999999-9999-4999-8999-999999999999";
const SESSION = { token: "tok-1", expiresAt: "2099-01-01T00:00:00.000Z", userId: USER };

describe("stepAfterSignIn", () => {
  const mfa = (next: "none" | "enroll" | "challenge") => ({ next });
  it("changes a handed-out password first, even before two-step", () => {
    expect(stepAfterSignIn({ mustChangePassword: true, mfa: mfa("enroll") })).toBe("change-password");
    expect(stepAfterSignIn({ mustChangePassword: true, mfa: mfa("none") })).toBe("change-password");
  });
  it("then enrols or answers two-step", () => {
    expect(stepAfterSignIn({ mustChangePassword: false, mfa: mfa("enroll") })).toBe("mfa-enroll");
    expect(stepAfterSignIn({ mustChangePassword: false, mfa: mfa("challenge") })).toBe("mfa-challenge");
  });
  it("is done when nothing is pending", () => {
    expect(stepAfterSignIn({ mustChangePassword: false, mfa: mfa("none") })).toBe("done");
  });
});

describe("consoleOnApi", () => {
  it("has every school role, the organization console, and the platform console", () => {
    for (const r of ["school_admin", "teacher", "parent", "student", "driver", "staff", "org_admin", "super_admin"] as const) {
      expect(consoleOnApi(r)).toBe(true);
    }
  });
});

let store: TokenStore;

function boot(routes: Record<string, FakeRoute>) {
  const api = createFakeApi(routes);
  store = createMemoryTokenStore(SESSION);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  forgetApiSchools();
  setApiTokenStore(store);
  return api;
}

afterEach(() => { vi.unstubAllGlobals(); resetApiClient(); initBackend({ kind: "supabase" }); });

const user = (over: Record<string, unknown> = {}) => ({ id: USER, full_name: "Wanjiru", email: "w@school.test", must_change_password: false, platform_role: null, ...over });
const me = (over: Record<string, unknown> = {}) => ({ body: { user: user(), session: {}, memberships: [{ tenantId: SCHOOL, role: "school_admin", loginId: null, tenantStatus: "active" }], membershipsComplete: true, authz: { role: "school_admin", tenantId: SCHOOL, isSuperAdmin: false }, ...over } });
const mfa = (next: string) => ({ body: { required: next !== "none", assured: next === "none", enrolled: next === "challenge", enforcement: "enforce", next } });
const school = { [`GET /v1/tenants/${SCHOOL}`]: { body: { id: SCHOOL, name: "Alliance", slug: "alliance", status: "active", timezone: "Africa/Nairobi" } }, [`GET /v1/tenants/${SCHOOL}/school-profile`]: { body: { schoolProfile: { tenantId: SCHOOL, institution_type: "k12" } } } };

describe("continueSignIn", () => {
  it("opens the school's page when everything is settled", async () => {
    boot({ "GET /v1/auth/me": me(), "GET /v1/auth/mfa/status": mfa("none"), ...school });
    expect(await continueSignIn()).toEqual({ kind: "open", path: "/s/alliance" });
    expect(store.get()).not.toBeNull();
  });

  it("asks for the password change before anything else, without asking about two-step", async () => {
    const api = boot({ "GET /v1/auth/me": me({ user: user({ must_change_password: true }) }), "GET /v1/auth/mfa/status": mfa("enroll") });
    expect(await continueSignIn()).toEqual({ kind: "step", step: "change-password" });
    expect(api.callsTo(`GET /v1/tenants/${SCHOOL}`)).toHaveLength(0);
  });

  it("asks to enrol, or to answer the challenge", async () => {
    boot({ "GET /v1/auth/me": me(), "GET /v1/auth/mfa/status": mfa("enroll") });
    expect(await continueSignIn()).toEqual({ kind: "step", step: "mfa-enroll" });
    boot({ "GET /v1/auth/me": me(), "GET /v1/auth/mfa/status": mfa("challenge") });
    expect(await continueSignIn()).toEqual({ kind: "step", step: "mfa-challenge" });
  });

  it("opens an org admin's organization: its dashboard for one, the picker for several", async () => {
    const orgMe = me({ memberships: [], authz: { role: "org_admin", tenantId: null, isSuperAdmin: false } });
    const org = (slug: string) => ({ id: `id-${slug}`, name: slug, slug, kind: "group_owner", status: "active" });
    const orgs = (...slugs: string[]) => ({ body: { items: slugs.map(org), page: { limit: 200, next_cursor: null } } });
    boot({ "GET /v1/auth/me": orgMe, "GET /v1/auth/mfa/status": mfa("none"), "GET /v1/org/organizations": orgs("north-org") });
    expect(await continueSignIn()).toEqual({ kind: "open", path: "/org/north-org/dashboard" });
    boot({ "GET /v1/auth/me": orgMe, "GET /v1/auth/mfa/status": mfa("none"), "GET /v1/org/organizations": orgs("north-org", "south-org") });
    expect(await continueSignIn()).toEqual({ kind: "open", path: "/org-picker" });
    // org admins answer two-step before anything opens
    boot({ "GET /v1/auth/me": orgMe, "GET /v1/auth/mfa/status": mfa("enroll") });
    expect(await continueSignIn()).toEqual({ kind: "step", step: "mfa-enroll" });
  });

  it("opens the platform console for a super admin after two-step verification", async () => {
    const superMe = me({ user: user({ platform_role: "super_admin" }), memberships: [], authz: { role: "super_admin", tenantId: null, isSuperAdmin: true } });
    boot({ "GET /v1/auth/me": superMe, "GET /v1/auth/mfa/status": mfa("challenge") });
    expect(await continueSignIn()).toEqual({ kind: "step", step: "mfa-challenge" });

    boot({ "GET /v1/auth/me": superMe, "GET /v1/auth/mfa/status": mfa("none") });
    expect(await continueSignIn()).toEqual({ kind: "open", path: "/platform/tenants" });
    expect(store.get()).not.toBeNull();
  });

  it("refuses an org admin with no organization left, and ends the session", async () => {
    const api = boot({
      "GET /v1/auth/me": me({ memberships: [], authz: { role: "org_admin", tenantId: null, isSuperAdmin: false } }),
      "GET /v1/auth/mfa/status": mfa("none"), "POST /v1/auth/logout": { body: { ok: true } },
      "GET /v1/org/organizations": { body: { items: [], page: { limit: 200, next_cursor: null } } },
    });
    expect(await continueSignIn()).toEqual({ kind: "refused", message: "Your account is not linked to an organization any more. Contact Figbloom support." });
    expect(store.get()).toBeNull();
    expect(api.callsTo("POST /v1/auth/logout")).toHaveLength(1);
  });

  it("refuses an account with no school and no role", async () => {
    boot({ "GET /v1/auth/me": me({ memberships: [], authz: null }), "GET /v1/auth/mfa/status": mfa("none"), "POST /v1/auth/logout": { body: { ok: true } } });
    const out = await continueSignIn();
    expect(out).toMatchObject({ kind: "refused" });
    expect(store.get()).toBeNull();
  });

  it("refuses when the school cannot be read", async () => {
    boot({
      "GET /v1/auth/me": me(), "GET /v1/auth/mfa/status": mfa("none"), "POST /v1/auth/logout": { body: { ok: true } },
      [`GET /v1/tenants/${SCHOOL}`]: { status: 403, body: { error: { code: "forbidden", message: "School is suspended" } } },
    });
    expect(await continueSignIn()).toMatchObject({ kind: "refused", message: expect.stringMatching(/school/i) });
  });

  it("throws a failure to ask, and keeps the session", async () => {
    boot({ "GET /v1/auth/me": me(), "GET /v1/auth/mfa/status": { status: 503, body: { error: { code: "service_unavailable", message: "x" } } } });
    await expect(continueSignIn()).rejects.toMatchObject({ code: "service_unavailable" });
    expect(store.get()).not.toBeNull();
  });

  it("throws 401 for a session the server dropped, and has forgotten it", async () => {
    boot({ "GET /v1/auth/me": { status: 401, body: { error: { code: "unauthorized", message: "no" } } } });
    await expect(continueSignIn()).rejects.toMatchObject({ code: "unauthorized" });
    expect(store.get()).toBeNull();
  });
});
