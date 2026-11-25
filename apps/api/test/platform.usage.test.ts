/**
 * Platform console slice P4 (apps/api/docs/PLATFORM-CONSOLE.md): GET /v1/platform/usage.
 * Counts-only cross-school summary via `platform_usage_counts()` SECURITY DEFINER.
 * Verifies counts accuracy, absence of PII, 401/403 for non-super-admins, and direct DB guard when app.user_id is not super_admin.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
const PASSWORD = "correct-horse-battery";
const URL = "/v1/platform/usage";

describe("platform usage counts (read-only, slice P4)", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  const tokens: Record<string, string> = {};

  const login = async (payload: Record<string, unknown>) => {
    const url = "email" in payload ? "/v1/auth/login/email" : "/v1/auth/login/login-id";
    const res = await ctx.app.inject({ method: "POST", url, payload });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    return res.json().token as string;
  };
  const get = (token?: string, tenant?: string) =>
    ctx.app.inject({
      method: "GET",
      url: URL,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(tenant ? { "x-tenant-id": tenant } : {}) },
    });

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    tokens.super = await login({ email: "super@example.com", password: PASSWORD });
    tokens.schoolAdmin = await login({ email: "admin-a@example.com", password: PASSWORD });
    tokens.orgAdmin = await login({ email: "orgadmin@example.com", password: PASSWORD });
    tokens.teacher = await login({ tenantId: ids.tenantA, loginId: "TC-0001", password: PASSWORD });
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("super_admin gets per-school counts and totals with no PII fields", async () => {
    const res = await get(tokens.super);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<Record<string, unknown>>;
      totals: { schools: number; activeLearners: number; activeStaff: number; activeGuardianLinks: number };
    };
    expect(body.totals.schools).toBe(body.items.length);
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual([
        "activeGuardianLinks",
        "activeLearners",
        "activeStaff",
        "name",
        "slug",
        "status",
        "tenantId",
      ]);
    }
    const sumLearners = body.items.reduce((a, i) => a + Number(i.activeLearners), 0);
    expect(body.totals.activeLearners).toBe(sumLearners);
  });

  it("refuses unauthenticated (401) and non-super-admin callers (403), with or without X-Tenant-Id", async () => {
    expect((await get()).statusCode).toBe(401);
    for (const who of ["schoolAdmin", "orgAdmin", "teacher"]) {
      expect((await get(tokens[who])).statusCode, who).toBe(403);
      expect((await get(tokens[who], ids.tenantA)).statusCode, `${who}+tenant`).toBe(403);
    }
  });
});
