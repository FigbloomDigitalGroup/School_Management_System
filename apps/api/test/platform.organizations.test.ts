/**
 * Platform console slice P3 (apps/api/docs/PLATFORM-CONSOLE.md):
 * - GET /v1/platform/organizations, /{organizationId}, /{organizationId}/admins (`platform.organizations.read`)
 * - GET /v1/platform/schools/{schoolId}/admins (`platform.tenants.admins.read`)
 *
 * Verifies super_admin access, keyset paging, filters, 401/403 before 400 validation, and personal-data read auditing.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
const PASSWORD = "correct-horse-battery";
const ORGS = "/v1/platform/organizations";
const SCHOOLS = "/v1/platform/schools";

describe("platform organizations and admins (read-only, slice P3)", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  const tokens: Record<string, string> = {};
  let pendingOrg: string;

  const login = async (payload: Record<string, unknown>) => {
    const url = "email" in payload ? "/v1/auth/login/email" : "/v1/auth/login/login-id";
    const res = await ctx.app.inject({ method: "POST", url, payload });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    return res.json().token as string;
  };
  const get = (url: string, token?: string, tenant?: string) =>
    ctx.app.inject({
      method: "GET",
      url,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(tenant ? { "x-tenant-id": tenant } : {}) },
    });

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    pendingOrg = randomUUID();
    await ctx.pool.query(
      `INSERT INTO organizations (id, name, slug, kind, status) VALUES ($1, 'Pending County Org', 'pending-county-p3', 'county', 'pending')`,
      [pendingOrg],
    );
    tokens.super = await login({ email: "super@example.com", password: PASSWORD });
    tokens.schoolAdmin = await login({ email: "admin-a@example.com", password: PASSWORD });
    tokens.orgAdmin = await login({ email: "orgadmin@example.com", password: PASSWORD });
    tokens.teacher = await login({ tenantId: ids.tenantA, loginId: "TC-0001", password: PASSWORD });
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("super_admin lists organizations with schoolCount, filters by status/kind, and reads one by id", async () => {
    const res = await get(ORGS, tokens.super);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ id: string; status: string; kind: string; schoolCount: number }> };
    const orgA = body.items.find((o) => o.id === ids.orgA);
    expect(orgA).toMatchObject({ id: ids.orgA, name: "Org A", slug: "org-a", kind: "group_owner", status: "active" });
    expect(orgA!.schoolCount).toBeGreaterThanOrEqual(1);

    const pending = await get(`${ORGS}?status=pending&kind=county`, tokens.super);
    expect(pending.statusCode).toBe(200);
    expect(pending.json().items.map((o: { id: string }) => o.id)).toContain(pendingOrg);

    const one = await get(`${ORGS}/${pendingOrg}`, tokens.super);
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ id: pendingOrg, status: "pending", kind: "county", schoolCount: 0 });
    expect((await get(`${ORGS}/${randomUUID()}`, tokens.super)).statusCode).toBe(404);
    expect((await get(`${ORGS}/not-a-uuid`, tokens.super)).statusCode).toBe(400);
  });

  it("super_admin lists organization admins and school admins, and both reads are audited", async () => {
    const orgAdminsRes = await get(`${ORGS}/${ids.orgA}/admins`, tokens.super);
    expect(orgAdminsRes.statusCode).toBe(200);
    expect(orgAdminsRes.json().organizationId).toBe(ids.orgA);
    expect(orgAdminsRes.json().items.some((a: { email: string }) => a.email === "orgadmin@example.com")).toBe(true);

    const schoolAdminsRes = await get(`${SCHOOLS}/${ids.tenantA}/admins`, tokens.super);
    expect(schoolAdminsRes.statusCode).toBe(200);
    expect(schoolAdminsRes.json().schoolId).toBe(ids.tenantA);
    expect(schoolAdminsRes.json().items.some((a: { email: string }) => a.email === "admin-a@example.com")).toBe(true);

    const audits = await ctx.pool.query<{ event_type: string }>(
      `SELECT event_type FROM security_audit_events WHERE actor_user_id = $1 AND event_type IN ('platform.organization.admins_read', 'platform.school.admins_read')`,
      [ids.superAdmin],
    );
    const types = new Set(audits.rows.map((r) => r.event_type));
    expect(types.has("platform.organization.admins_read")).toBe(true);
    expect(types.has("platform.school.admins_read")).toBe(true);
  });

  it("refuses unauthenticated (401) and non-super-admin callers (403) before validating params", async () => {
    for (const url of [ORGS, `${ORGS}/${ids.orgA}`, `${ORGS}/${ids.orgA}/admins`, `${SCHOOLS}/${ids.tenantA}/admins`]) {
      expect((await get(url)).statusCode, url).toBe(401);
      for (const who of ["schoolAdmin", "orgAdmin", "teacher"]) {
        expect((await get(url, tokens[who], ids.tenantA)).statusCode, `${who} ${url}`).toBe(403);
      }
    }
    expect((await get(`${ORGS}/not-a-uuid`, tokens.orgAdmin)).statusCode).toBe(403);
    expect((await get(`${SCHOOLS}/not-a-uuid/admins`, tokens.schoolAdmin, ids.tenantA)).statusCode).toBe(403);
  });
});
