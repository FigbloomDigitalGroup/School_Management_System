import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";

const PASSWORD = "correct-horse-battery";

describe("reporting permissions are independent (overview vs attendance-daily)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let teacher: string;
  let admin: string;
  beforeAll(async () => {
    ctx = await createTestApp();
    const l = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId: ctx.ids.tenantA, loginId: "TC-0001", password: PASSWORD } });
    teacher = l.json().token;
    const a = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "admin-a@example.com", password: PASSWORD } });
    admin = a.json().token;
  }, 120_000);
  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  const get = (token: string, path: string) =>
    ctx.app.inject({ method: "GET", url: `/v1/tenants/${ctx.ids.tenantA}/reports/${path}`, headers: { authorization: `Bearer ${token}`, "x-tenant-id": ctx.ids.tenantA } });
  const grant = (code: string) => ctx.pool.query(`INSERT INTO role_permissions (role, permission_code) VALUES ('teacher', $1) ON CONFLICT DO NOTHING`, [code]);
  const revokeAll = () => ctx.pool.query(`DELETE FROM role_permissions WHERE role = 'teacher' AND permission_code LIKE 'resource.report.%'`);
  const OV = "overview";
  const AT = "attendance-daily?date=2026-03-10";

  it("no report permission: both denied", async () => {
    await revokeAll();
    expect((await get(teacher, OV)).statusCode).toBe(403);
    expect((await get(teacher, AT)).statusCode).toBe(403);
  });

  it("overview permission alone opens only the overview", async () => {
    await revokeAll();
    await grant("resource.report.overview.read");
    try {
      expect((await get(teacher, OV)).statusCode).toBe(200);
      expect((await get(teacher, AT)).statusCode).toBe(403);
    } finally {
      await revokeAll();
    }
  });

  it("attendance permission alone opens only the daily attendance report", async () => {
    await revokeAll();
    await grant("resource.report.attendance.read");
    try {
      expect((await get(teacher, AT)).statusCode).toBe(200);
      expect((await get(teacher, OV)).statusCode).toBe(403);
    } finally {
      await revokeAll();
    }
  });

  it("the legacy resource.report.read no longer opens either report, and an unknown permission fails closed", async () => {
    await revokeAll();
    await grant("resource.report.read");
    try {
      expect((await get(teacher, OV)).statusCode).toBe(403);
      expect((await get(teacher, AT)).statusCode).toBe(403);
    } finally {
      await revokeAll();
    }
  });

  it("the school administrator keeps both; the migration copied pre-existing grants without widening them", async () => {
    expect((await get(admin, OV)).statusCode).toBe(200);
    expect((await get(admin, AT)).statusCode).toBe(200);
    const rows = await ctx.pool.query<{ role: string; permission_code: string }>(
      `SELECT role::text AS role, permission_code FROM role_permissions WHERE permission_code LIKE 'resource.report.%' ORDER BY 1, 2`,
    );
    expect(rows.rows).toEqual([
      { role: "school_admin", permission_code: "resource.report.attendance.read" },
      { role: "school_admin", permission_code: "resource.report.overview.read" },
      { role: "school_admin", permission_code: "resource.report.read" },
    ]);
  });

  it("a parent cannot read either report", async () => {
    const p = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId: ctx.ids.tenantA, loginId: "PT-0001", password: PASSWORD } });
    expect((await get(p.json().token, OV)).statusCode).toBe(403);
    expect((await get(p.json().token, AT)).statusCode).toBe(403);
  });
});
