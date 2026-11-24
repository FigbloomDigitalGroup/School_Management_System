import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { NotOnApiError, orgCapabilities } from "../capabilities";
import {
  fetchAllMyOrganizationTenantSummaries, fetchMyOrganizations, fetchOrganizationAccessLog, fetchOrganizationTenantSummaries,
  fetchOrgAdminsForOwnOrg, fetchTenantOrgAccessLog, logOrganizationAccess,
} from "../organizations";
import { loadMyWorkspaces, loadOrgSession } from "../session";
import { BASE, createFakeApi, type FakeApi, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiTokenStore } from "./client";
import {
  SCHOOL_ACCESS_CODES, apiFetchMySchoolAccess, apiGrantSchoolAccess, apiRemoveSchoolAccess, organizationFromApi, orgHomePath, orgSchoolFromApi,
} from "./orgApi";
import { forgetApiSchools } from "./sessionApi";
import { createMemoryTokenStore } from "./tokenStore";

const USER = "99999999-9999-4999-8999-999999999999";
const ORG_A = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const ORG_B = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const S1 = "51515151-5151-4515-8515-515151515151";
const S2 = "52525252-5252-4525-8525-525252525252";
const S3 = "53535353-5353-4535-8535-535353535353";
const CO = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";

const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const org = (id: string, slug: string, status = "active") => ({ id, name: `Org ${slug}`, slug, kind: "group_owner", status });
const school = (id: string, organizationId: string, name: string, status = "active") => ({ id, name, slug: name.toLowerCase().replace(/ /g, "-"), status, organizationId, organizationName: "x", organizationSlug: "x" });
const orgMe = { body: { user: { id: USER, full_name: "Grace Wambui", email: "grace@org.test", must_change_password: false, platform_role: null }, session: {}, memberships: [], membershipsComplete: true, authz: { role: "org_admin", tenantId: null, isSuperAdmin: false } } };
const schoolAdminMe = { body: { ...orgMe.body, memberships: [{ tenantId: S1, role: "school_admin", loginId: "AD-0001", tenantStatus: "active" }], authz: { role: "school_admin", tenantId: S1, isSuperAdmin: false } } };

let api: FakeApi;

function boot(routes: Record<string, FakeRoute>, signedIn = true) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  forgetApiSchools();
  setApiTokenStore(createMemoryTokenStore(signedIn ? { token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: USER } : null));
}

afterEach(() => { vi.unstubAllGlobals(); resetApiClient(); initBackend({ kind: "supabase" }); });

describe("mapping", () => {
  it("an organisation keeps what the API says; an unknown kind or status is never read as active", () => {
    expect(organizationFromApi(org(ORG_A, "north"))).toMatchObject({ id: ORG_A, slug: "north", kind: "group_owner", status: "active", county: null, contact_email: null });
    expect(organizationFromApi({ ...org(ORG_A, "north"), kind: "empire", status: "glowing" })).toMatchObject({ kind: "group_owner", status: "pending" });
    expect(organizationFromApi(org(ORG_A, "north", "suspended")).status).toBe("suspended");
  });

  it("a school carries its name, address and status, and no figures (all 0, hidden on screen)", () => {
    const s = orgSchoolFromApi(school(S1, ORG_A, "Riverside Primary", "onboarding"));
    expect(s).toMatchObject({ tenant_id: S1, organization_id: ORG_A, name: "Riverside Primary", slug: "riverside-primary", status: "onboarding" });
    expect([s.active_students, s.present_today, s.fees_billed_cents, s.fees_collected_cents]).toEqual([0, 0, 0, 0]);
    expect(orgSchoolFromApi({ ...school(S1, ORG_A, "X"), status: "weird" }).status).toBe("setup_stalled");
  });

  it("orgHomePath: none, one dashboard, or the picker", () => {
    const o = organizationFromApi(org(ORG_A, "north"));
    expect(orgHomePath([])).toBeNull();
    expect(orgHomePath([o])).toBe("/org/north/dashboard");
    expect(orgHomePath([o, { ...o, slug: "south" }])).toBe("/org-picker");
  });

  it("the school access list is the API's allowlist without school roles and without People", () => {
    expect(SCHOOL_ACCESS_CODES).toContain("tenant.read");
    expect(SCHOOL_ACCESS_CODES).toContain("area.fees");
    expect(SCHOOL_ACCESS_CODES).not.toContain("area.people");
    expect(SCHOOL_ACCESS_CODES).not.toContain("rbac.school_roles.manage");
    expect(SCHOOL_ACCESS_CODES.some((c) => c.startsWith("resource.guardian"))).toBe(false);
  });
});

describe("capabilities", () => {
  it("on the API: the reads and school access; figures, kinds, adding schools and admins hidden", () => {
    boot({});
    expect(orgCapabilities()).toEqual({
      schoolFigures: false, schoolKind: false, addSchool: false, openForSignIn: false, schoolAdmins: false, openSchoolConsole: false,
      inviteOrgAdmin: false, createOrganization: false, pageViewLog: false, schoolAccess: true,
    });
  });

  it("on Supabase: everything the console had, and no API school access", () => {
    initBackend({ kind: "supabase" });
    expect(orgCapabilities()).toMatchObject({ schoolFigures: true, addSchool: true, inviteOrgAdmin: true, pageViewLog: true, schoolAccess: false });
  });
});

describe("organizations.ts on the API", () => {
  it("fetchMyOrganizations follows every page, as an identity call (no school header)", async () => {
    boot({
      "GET /v1/org/organizations": (call) => ({
        body: call.query.get("cursor") ? { items: [org(ORG_B, "south", "suspended")], page: page() } : { items: [org(ORG_A, "north")], page: page("c1") },
      }),
    });
    const orgs = await fetchMyOrganizations("ignored");
    expect(orgs.map((o) => [o.slug, o.status])).toEqual([["north", "active"], ["south", "suspended"]]);
    const calls = api.callsTo("GET /v1/org/organizations");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.query.get("cursor")).toBe("c1");
    expect(calls[0]!.headers["x-tenant-id"]).toBeUndefined();
    expect(calls[0]!.headers.authorization).toBe("Bearer tok");
  });

  it("school summaries: one organisation's schools, or all of the person's", async () => {
    boot({ "GET /v1/org/schools": { body: { items: [school(S1, ORG_A, "Alpha"), school(S2, ORG_B, "Beta"), school(S3, ORG_A, "Gamma", "suspended")], page: page() } } });
    expect((await fetchOrganizationTenantSummaries(ORG_A)).map((s) => s.tenant_id)).toEqual([S1, S3]);
    expect((await fetchAllMyOrganizationTenantSummaries()).map((s) => s.tenant_id)).toEqual([S1, S2, S3]);
  });

  it("the organisation's admins, with the signed-in person marked", async () => {
    boot({
      [`GET /v1/org/organizations/${ORG_A}/admins`]: { body: { organizationId: ORG_A, items: [
        { userId: USER, fullName: "Grace Wambui", email: "grace@org.test", status: "active", since: "2026-11-01T08:00:00.000000Z", isYou: true },
        { userId: CO, fullName: "Otieno", email: null, status: "invited", since: "2026-11-02T08:00:00.000000Z", isYou: false },
      ], page: page() } },
    });
    expect(await fetchOrgAdminsForOwnOrg(ORG_A)).toEqual([
      { id: USER, full_name: "Grace Wambui", email: "grace@org.test", status: "active", since: "2026-11-01T08:00:00.000000Z", is_you: true },
      { id: CO, full_name: "Otieno", email: null, status: "invited", since: "2026-11-02T08:00:00.000000Z", is_you: false },
    ]);
  });

  it("another organisation's admins are refused by the server, and the refusal reaches the screen", async () => {
    boot({ [`GET /v1/org/organizations/${ORG_B}/admins`]: { status: 403, body: { error: { code: "forbidden", message: "Not an administrator of this organization" } } } });
    await expect(fetchOrgAdminsForOwnOrg(ORG_B)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("the audit log is the person's own recorded actions, newest first, with the school's name", async () => {
    boot({
      [`GET /v1/org/organizations/${ORG_A}/audit-events`]: { body: { organizationId: ORG_A, items: [
        { id: "e1", occurredAt: "2026-11-24T10:00:00.000000Z", eventType: "rbac.org_delegation.granted", schoolId: S1, schoolName: "Alpha", detail: { organizationId: ORG_A } },
        { id: "e2", occurredAt: "2026-11-23T10:00:00.000000Z", eventType: "rbac.org_delegation.revoked", schoolId: null, schoolName: null, detail: {} },
      ], page: page("more") } },
    });
    const log = await fetchOrganizationAccessLog(ORG_A);
    expect(log).toEqual([
      { id: "e1", organization_id: ORG_A, profile_id: USER, tenant_id: S1, school_name: "Alpha", action: "rbac.org_delegation.granted", accessed_at: "2026-11-24T10:00:00.000000Z" },
      { id: "e2", organization_id: ORG_A, profile_id: USER, tenant_id: null, school_name: null, action: "rbac.org_delegation.revoked", accessed_at: "2026-11-23T10:00:00.000000Z" },
    ]);
    // one page of 200, as the Supabase page shows its latest 200
    expect(api.callsTo(`GET /v1/org/organizations/${ORG_A}/audit-events`)).toHaveLength(1);
    expect(api.callsTo(`GET /v1/org/organizations/${ORG_A}/audit-events`)[0]!.query.get("limit")).toBe("200");
  });

  it("page-view logging and a school's view of its organisation's visits are not on the API", async () => {
    boot({});
    await expect(logOrganizationAccess(ORG_A, USER, "viewed_dashboard")).rejects.toBeInstanceOf(NotOnApiError);
    await expect(fetchTenantOrgAccessLog(S1)).rejects.toBeInstanceOf(NotOnApiError);
    expect(api.calls).toHaveLength(0);
  });
});

describe("the console's session on the API", () => {
  it("an org admin at their organisation's address", async () => {
    boot({ "GET /v1/auth/me": orgMe, "GET /v1/org/organizations": { body: { items: [org(ORG_A, "north"), org(ORG_B, "south")], page: page() } } });
    const s = await loadOrgSession("south");
    expect(s?.profile).toMatchObject({ id: USER, role: "org_admin", tenant_id: null, full_name: "Grace Wambui" });
    expect(s?.organization).toMatchObject({ id: ORG_B, slug: "south" });
  });

  it("an address that is not one of theirs gives no organisation", async () => {
    boot({ "GET /v1/auth/me": orgMe, "GET /v1/org/organizations": { body: { items: [org(ORG_A, "north")], page: page() } } });
    expect((await loadOrgSession("someone-elses"))?.organization).toBeNull();
  });

  it("a school admin gets their school role and no organisation, without asking for organisations", async () => {
    boot({ "GET /v1/auth/me": schoolAdminMe });
    const s = await loadOrgSession("north");
    expect(s).toMatchObject({ profile: { role: "school_admin" }, organization: null });
    expect(api.callsTo("GET /v1/org/organizations")).toHaveLength(0);
    expect(await loadMyWorkspaces()).toBeNull();
  });

  it("nobody signed in: null, with no call", async () => {
    boot({}, false);
    expect(await loadOrgSession("north")).toBeNull();
    expect(await loadMyWorkspaces()).toBeNull();
    expect(api.calls).toHaveLength(0);
  });

  it("the picker's data: the name, every organisation and every school", async () => {
    boot({
      "GET /v1/auth/me": orgMe,
      "GET /v1/org/organizations": { body: { items: [org(ORG_A, "north"), org(ORG_B, "south")], page: page() } },
      "GET /v1/org/schools": { body: { items: [school(S1, ORG_A, "Alpha")], page: page() } },
    });
    const w = await loadMyWorkspaces();
    expect(w?.name).toBe("Grace Wambui");
    expect(w?.orgs.map((o) => o.slug)).toEqual(["north", "south"]);
    expect(w?.schools.map((s) => s.tenant_id)).toEqual([S1]);
  });
});

describe("school access (delegations)", () => {
  it("my access in a school: the delegated codes, once each, sorted, asked in that school", async () => {
    boot({ "GET /v1/rbac/permissions": { body: { role: "org_admin", tenantId: S1, mayAdminister: false, isOrgAdminForTenant: true, isSuperAdmin: false, delegatedPermissions: ["area.fees", "tenant.read", "area.fees"], actingVia: "org_admin_delegation", items: [], page: page() } } });
    expect(await apiFetchMySchoolAccess(S1)).toEqual(["area.fees", "tenant.read"]);
    expect(api.callsTo("GET /v1/rbac/permissions")[0]!.headers["x-tenant-id"]).toBe(S1);
  });

  it("giving access sends the person and the codes to that school", async () => {
    boot({ "POST /v1/rbac/org-delegations": { body: { ok: true, tenantId: S1, delegateUserId: CO, granted: ["area.fees"] } } });
    expect(await apiGrantSchoolAccess(S1, CO, ["area.fees"])).toEqual(["area.fees"]);
    const call = api.callsTo("POST /v1/rbac/org-delegations")[0]!;
    expect(call.body).toEqual({ delegateUserId: CO, permissionCodes: ["area.fees"] });
    expect(call.headers["x-tenant-id"]).toBe(S1);
  });

  it("taking access away sends no codes (everything goes) and says how many went", async () => {
    boot({ "DELETE /v1/rbac/org-delegations": { body: { ok: true, tenantId: S1, delegateUserId: CO, revoked: ["area.fees", "tenant.read"] } } });
    expect(await apiRemoveSchoolAccess(S1, CO)).toBe(2);
    expect(api.callsTo("DELETE /v1/rbac/org-delegations")[0]!.body).toEqual({ delegateUserId: CO });
    boot({ "DELETE /v1/rbac/org-delegations": { body: { ok: true, tenantId: S1, delegateUserId: CO, revoked: [] } } });
    expect(await apiRemoveSchoolAccess(S1, CO)).toBe(0);
  });
});
