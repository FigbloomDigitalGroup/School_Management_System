import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { isNotOnApiError, platformCapabilities } from "../capabilities";
import {
  activateTenant,
  fetchAllTenants,
  fetchImpersonationLog,
  fetchOrganizationAdminProfiles,
  fetchOrganizations,
  fetchPlatformAudit,
  fetchPlatformIncidents,
  fetchPlatformInvoices,
  fetchPlatformNavCounts,
  fetchPlatformSubscriptions,
  fetchPlatformUsage,
  fetchSchoolAdmins,
  fetchServiceHistory,
} from "../platform";
import { BASE, createFakeApi, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiTokenStore } from "./client";
import {
  apiFetchPlatformOpsStatus,
  apiFetchPlatformOrganization,
  apiFetchPlatformOrganizationAdmins,
  apiFetchPlatformOrganizations,
  apiFetchPlatformSchool,
  apiFetchPlatformSchoolAdmins,
  apiFetchPlatformSchools,
  apiLoadPlatformSession,
  apiProvisionSchool,
  parsePlatformOpsStatus,
  platformOrganizationFromApi,
  platformSchoolFromApi,
  platformSchoolToTenant,
} from "./platformApi";
import { createMemoryTokenStore } from "./tokenStore";

const USER = "99999999-9999-4999-8999-999999999999";
const SCHOOL_A = "11111111-1111-4111-8111-111111111111";
const SCHOOL_B = "22222222-2222-4222-8222-222222222222";
const ORG_1 = "33333333-3333-4333-8333-333333333333";
const SESSION = { token: "tok-plat", expiresAt: "2099-01-01T00:00:00.000Z", userId: USER };

function boot(routes: Record<string, FakeRoute>, signedIn = true) {
  const api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(createMemoryTokenStore(signedIn ? SESSION : null));
  return api;
}

const rawSchool = (id: string, name: string, slug: string, status = "active") => ({
  id,
  name,
  slug,
  status,
  timezone: "Africa/Nairobi",
  createdAt: "2026-11-20T08:00:00.000Z",
  organization: {
    id: ORG_1,
    name: "Rift Group",
    slug: "rift-group",
    kind: "group_owner",
    status: "active",
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

describe("platformApi mapping", () => {
  it("normalizes school directory rows and falls back safely on unknown statuses", () => {
    const mapped = platformSchoolFromApi({
      ...rawSchool(SCHOOL_A, "Kijani Ridge", "kijani-ridge", "unknown_status"),
      organization: { id: ORG_1, name: "Org", slug: "org", kind: "weird", status: "weird" },
    });
    expect(mapped.status).toBe("setup_stalled");
    expect(mapped.organization.kind).toBe("group_owner");
    expect(mapped.organization.status).toBe("pending");

    const tenant = platformSchoolToTenant(mapped);
    expect(tenant.id).toBe(SCHOOL_A);
    expect(tenant.slug).toBe("kijani-ridge");
    expect(tenant.organization_id).toBe(ORG_1);
    expect(tenant.licensed_seats).toBe(0);
  });

  it("parses finance_ops_snapshot cleanly even with missing optional sections", () => {
    const parsed = parsePlatformOpsStatus({
      generated_at: "2026-11-25T10:00:00.000Z",
      workers: [{ worker: "main-worker", last_seen_age_seconds: 12, last_sweep_age_seconds: 40, last_cycle_outcome: "ok" }],
      queue: { queued_due: 2, queued_future: 5, leased: 1, dead: 0, oldest_due_lag_seconds: 8, retrying: 1 },
      reconciliation: { open_cases: 3, escalated_open: 1, unassigned_open: 2, oldest_open_age_seconds: 600 },
      unmatched_callbacks: 4,
      unmatched_cases: { open: 2, escalated_open: 1, unassigned_open: 1, oldest_open_age_seconds: 300 },
    });
    expect(parsed.workers).toHaveLength(1);
    expect(parsed.workers[0]!.worker).toBe("main-worker");
    expect(parsed.queue.queuedDue).toBe(2);
    expect(parsed.reconciliation.escalatedOpen).toBe(1);
    expect(parsed.unmatchedCases?.open).toBe(2);

    const minimal = parsePlatformOpsStatus({});
    expect(minimal.workers).toEqual([]);
    expect(minimal.queue.dead).toBe(0);
    expect(minimal.unmatchedCases).toBeNull();
  });
});

describe("platformApi HTTP calls", () => {
  it("lists schools across pages without sending X-Tenant-Id", async () => {
    let pageCalls = 0;
    const api = boot({
      "GET /v1/platform/schools": (req) => {
        expect(req.headers["x-tenant-id"]).toBeUndefined();
        pageCalls += 1;
        if (pageCalls === 1) {
          return { body: { items: [rawSchool(SCHOOL_A, "Alpha", "alpha")], page: { limit: 200, next_cursor: "cur-2" } } };
        }
        expect(req.query.get("cursor")).toBe("cur-2");
        return { body: { items: [rawSchool(SCHOOL_B, "Beta", "beta", "onboarding")], page: { limit: 200, next_cursor: null } } };
      },
    });
    const schools = await apiFetchPlatformSchools();
    expect(schools.map((s) => s.slug)).toEqual(["alpha", "beta"]);
    expect(api.callsTo("GET /v1/platform/schools")).toHaveLength(2);
  });

  it("reads one school by id", async () => {
    boot({ [`GET /v1/platform/schools/${SCHOOL_A}`]: { body: rawSchool(SCHOOL_A, "Alpha", "alpha") } });
    const school = await apiFetchPlatformSchool(SCHOOL_A);
    expect(school.name).toBe("Alpha");
    expect(school.organization.name).toBe("Rift Group");
  });

  it("provisions a school and returns one-time invitation token when email is not configured", async () => {
    const api = boot({
      "POST /v1/platform/schools": (req) => {
        expect(req.headers["x-tenant-id"]).toBeUndefined();
        expect(req.body).toEqual({
          school_name: "Kijani Ridge",
          slug: "kijani-ridge",
          admin_email: "head@kijani.ac.ke",
          admin_name: "Grace Wanjiru",
        });
        return {
          status: 201,
          body: {
            school: { tenant_id: SCHOOL_A, organization_id: ORG_1 },
            invitation: {
              id: "inv-1",
              role: "school_admin",
              expires_at: "2026-12-02T00:00:00.000Z",
              delivery: "not_configured",
              token: "secret-invite-token-1234567890",
            },
          },
        };
      },
    });

    const out = await apiProvisionSchool({
      schoolName: " Kijani Ridge ",
      slug: "KIJANI-RIDGE",
      adminEmail: "head@kijani.ac.ke",
      adminName: "Grace Wanjiru",
    });
    expect(out.school.tenantId).toBe(SCHOOL_A);
    expect(out.invitation.delivery).toBe("not_configured");
    expect(out.invitation.token).toBe("secret-invite-token-1234567890");
    expect(api.callsTo("POST /v1/platform/schools")).toHaveLength(1);
  });

  it("fetches ops status without X-Tenant-Id", async () => {
    boot({
      "GET /v1/platform/ops/status": (req) => {
        expect(req.headers["x-tenant-id"]).toBeUndefined();
        return {
          body: {
            status: {
              generated_at: "2026-11-25T10:00:00.000Z",
              workers: [],
              queue: { queued_due: 0, queued_future: 1, leased: 0, dead: 0, oldest_due_lag_seconds: null, retrying: 0 },
              reconciliation: { open_cases: 0, escalated_open: 0, unassigned_open: 0, oldest_open_age_seconds: null },
              unmatched_callbacks: 0,
            },
          },
        };
      },
    });
    const status = await apiFetchPlatformOpsStatus();
    expect(status.queue.queuedFuture).toBe(1);
    expect(status.workers).toEqual([]);
  });

  it("loads the platform session for super_admin, school users, and signed-out callers", async () => {
    boot({}, false);
    expect(await apiLoadPlatformSession()).toBeNull();

    boot({
      "GET /v1/auth/me": {
        body: {
          user: { id: USER, full_name: "Platform Op", email: "op@figbloom.org", must_change_password: false, platform_role: "super_admin" },
          memberships: [],
          authz: { role: "super_admin", isSuperAdmin: true },
        },
      },
    });
    const superSnap = await apiLoadPlatformSession();
    expect(superSnap?.profile?.role).toBe("super_admin");
    expect(superSnap?.profile?.full_name).toBe("Platform Op");

    boot({
      "GET /v1/auth/me": {
        body: {
          user: { id: USER, full_name: "Teacher", email: "t@school.test", must_change_password: false, platform_role: null },
          memberships: [{ tenantId: SCHOOL_A, role: "teacher", loginId: null, tenantStatus: "active" }],
          authz: { role: "teacher", isSuperAdmin: false },
        },
      },
    });
    const teacherSnap = await apiLoadPlatformSession();
    expect(teacherSnap?.profile?.role).toBe("teacher");
  });
});

describe("platform.ts on API backend & platformCapabilities", () => {
  it("routes P2 + P3 platform reads through the API and fails loudly on unbacked pages", async () => {
    boot({
      "GET /v1/platform/schools": {
        body: { items: [rawSchool(SCHOOL_A, "Alpha", "alpha")], page: { limit: 200, next_cursor: null } },
      },
      "GET /v1/platform/organizations": {
        body: {
          items: [{ id: ORG_1, name: "Rift Group", slug: "rift-group", kind: "group_owner", status: "active", createdAt: "2026-11-20T08:00:00.000Z", schoolCount: 2 }],
          page: { limit: 200, next_cursor: null },
        },
      },
      [`GET /v1/platform/organizations/${ORG_1}`]: {
        body: { id: ORG_1, name: "Rift Group", slug: "rift-group", kind: "group_owner", status: "active", createdAt: "2026-11-20T08:00:00.000Z", schoolCount: 2 },
      },
      [`GET /v1/platform/organizations/${ORG_1}/admins`]: {
        body: {
          organizationId: ORG_1,
          items: [{ userId: USER, fullName: "Org Lead", email: "lead@rift.org", status: "active", since: "2026-11-20T08:00:00.000Z" }],
          page: { limit: 200, next_cursor: null },
        },
      },
      [`GET /v1/platform/schools/${SCHOOL_A}/admins`]: {
        body: {
          schoolId: SCHOOL_A,
          items: [{ userId: USER, fullName: "Principal", email: "head@alpha.ac.ke", status: "active", since: "2026-11-20T08:00:00.000Z" }],
          page: { limit: 200, next_cursor: null },
        },
      },
    });

    const tenants = await fetchAllTenants();
    expect(tenants).toHaveLength(1);
    expect(tenants[0]!.slug).toBe("alpha");

    const orgs = await fetchOrganizations();
    expect(orgs).toHaveLength(1);
    expect(orgs[0]!.slug).toBe("rift-group");

    const orgOne = await apiFetchPlatformOrganization(ORG_1);
    expect(orgOne.schoolCount).toBe(2);
    expect((await apiFetchPlatformOrganizations()).length).toBe(1);
    expect((await apiFetchPlatformOrganizationAdmins(ORG_1))[0]!.email).toBe("lead@rift.org");
    expect((await fetchOrganizationAdminProfiles(ORG_1))[0]!.full_name).toBe("Org Lead");
    expect((await apiFetchPlatformSchoolAdmins(SCHOOL_A))[0]!.fullName).toBe("Principal");
    expect((await fetchSchoolAdmins(SCHOOL_A))[0]!.email).toBe("head@alpha.ac.ke");
    expect(platformOrganizationFromApi({ id: ORG_1, name: "X", slug: "x", kind: "bad", status: "bad", createdAt: "2026-01-01T00:00:00.000Z", schoolCount: -1 }).status).toBe("pending");

    const nav = await fetchPlatformNavCounts();
    expect(nav).toEqual({ tenants: 1, openIncidents: 0, dueInvoices: 0 });

    const unbacked = [
      () => activateTenant(SCHOOL_A),
      () => fetchServiceHistory(),
      () => fetchPlatformUsage(),
      () => fetchPlatformIncidents(),
      () => fetchPlatformSubscriptions(),
      () => fetchPlatformInvoices(),
      () => fetchImpersonationLog(),
      () => fetchPlatformAudit(),
    ];
    for (const fn of unbacked) {
      await expect(fn()).rejects.toSatisfy(isNotOnApiError);
    }

    const apiCaps = platformCapabilities();
    expect(apiCaps.organizationsPage).toBe(true);
    expect(apiCaps.tenantAdminsPanel).toBe(true);
    expect(apiCaps.tenantIllustrativeCharts).toBe(false);
    expect(apiCaps.liveProviderChecks).toBe(false);

    initBackend({ kind: "supabase" });
    const sbCaps = platformCapabilities();
    expect(sbCaps.organizationsPage).toBe(true);
    expect(sbCaps.liveProviderChecks).toBe(true);
  });
});
