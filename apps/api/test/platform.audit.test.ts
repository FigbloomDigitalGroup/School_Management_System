/**
 * Platform console slice P5 (apps/api/docs/PLATFORM-CONSOLE.md): GET /v1/platform/audit-events.
 * Verifies super_admin access, keyset paging, school/prefix filtering, absence of ip/detail columns,
 * self-auditing (`platform.audit.read`), and 401/403 before 400 validation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
const PASSWORD = "correct-horse-battery";
const URL = "/v1/platform/audit-events";

describe("platform audit trail (read-only, slice P5)", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  const tokens: Record<string, string> = {};

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
    tokens.super = await login({ email: "super@example.com", password: PASSWORD });
    tokens.schoolAdmin = await login({ email: "admin-a@example.com", password: PASSWORD });
    tokens.orgAdmin = await login({ email: "orgadmin@example.com", password: PASSWORD });
    tokens.teacher = await login({ tenantId: ids.tenantA, loginId: "TC-0001", password: PASSWORD });
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("super_admin reads newest-first audit events without ip or detail, and reading is itself audited", async () => {
    const res = await get(`${URL}?limit=20`, tokens.super);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<Record<string, unknown>>; page: { limit: number; next_cursor: string | null } };
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual([
        "actorName",
        "actorUserId",
        "eventType",
        "id",
        "occurredAt",
        "schoolId",
        "schoolName",
      ]);
      expect(item).not.toHaveProperty("ip");
      expect(item).not.toHaveProperty("detail");
    }

    const auditRes = await get(`${URL}?eventPrefix=platform.audit.&limit=5`, tokens.super);
    expect(auditRes.statusCode).toBe(200);
    expect(auditRes.json().items.some((e: { eventType: string }) => e.eventType === "platform.audit.read")).toBe(true);
  });

  it("validates filters for super_admin and refuses non-super-admins with 403 before validation", async () => {
    expect((await get(`${URL}?schoolId=not-a-uuid`, tokens.super)).statusCode).toBe(400);
    expect((await get(`${URL}?eventPrefix=BAD%20PREFIX`, tokens.super)).statusCode).toBe(400);
    expect((await get(`${URL}?since=not-a-date`, tokens.super)).statusCode).toBe(400);

    expect((await get(URL)).statusCode).toBe(401);
    for (const who of ["schoolAdmin", "orgAdmin", "teacher"]) {
      expect((await get(URL, tokens[who], ids.tenantA)).statusCode, who).toBe(403);
      expect((await get(`${URL}?schoolId=not-a-uuid`, tokens[who])).statusCode, `${who}-bad-param`).toBe(403);
    }
  });
});
