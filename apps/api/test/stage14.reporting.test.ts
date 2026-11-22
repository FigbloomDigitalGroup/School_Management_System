import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

const PASSWORD = "correct-horse-battery";

describe("Stage 14 reporting aggregates", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let adminToken: string;
  let teacherToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    adminToken = (
      await ctx.app.inject({
        method: "POST",
        url: "/v1/auth/login/email",
        payload: { email: "admin-a@example.com", password: PASSWORD },
      })
    ).json().token;

    // Ensure teacher can authenticate via login_id path used elsewhere; use email if available.
    // Fixtures give teacher no email — create a session via pool is not needed; inject with admin for
    // positive path and prove teacher is denied by using a teacher login_id login if supported.
    const teacherLogin = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/login-id",
      payload: { tenantId: ids.tenantA, loginId: "TC-0001", password: PASSWORD },
    });
    expect(teacherLogin.statusCode, teacherLogin.body).toBe(200);
    teacherToken = teacherLogin.json().token as string;

    await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { full_name: "Report Learner", admission_no: "RP-001", date_of_birth: "2012-05-05", gender: "male" },
    });
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("returns school overview counts for school_admin", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/reports/overview`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().overview.learners_active).toBeGreaterThanOrEqual(1);
    expect(res.json().overview.staff_active).toBeGreaterThanOrEqual(1);
  });

  it("returns empty attendance-daily and finance-summary without inventing rows", async () => {
    const day = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/reports/attendance-daily?date=2026-01-15`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(day.statusCode, day.body).toBe(200);
    expect(day.json().report).toMatchObject({
      date: "2026-01-15",
      morning_present: 0,
      afternoon_present: 0,
      early_sign_outs: 0,
    });

    const fin = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/reports/finance-summary`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(fin.statusCode, fin.body).toBe(200);
    expect(fin.json().summary).toMatchObject({
      invoices_live: 0,
      amount_due_minor: 0,
      payments_success: 0,
    });
  });

  it("denies teachers without report permission", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/reports/overview`,
      headers: { authorization: `Bearer ${teacherToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns academics-summary counts for school_admin and teachers with academics.read", async () => {
    const admin = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/reports/academics-summary`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(admin.statusCode, admin.body).toBe(200);
    expect(admin.json().summary).toMatchObject({
      term_id: null,
      classes_active: expect.any(Number),
      assessments_draft: expect.any(Number),
      assessments_published: expect.any(Number),
      assessments_closed: expect.any(Number),
      cbe_assessments_draft: expect.any(Number),
      cbe_assessments_published: expect.any(Number),
      cbe_assessments_closed: expect.any(Number),
      report_cards_published: expect.any(Number),
      competency_ratings: expect.any(Number),
      learning_areas: expect.any(Number),
    });
    expect(admin.json().summary.classes_active).toBeGreaterThanOrEqual(0);

    const teacher = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/reports/academics-summary`,
      headers: { authorization: `Bearer ${teacherToken}`, "x-tenant-id": ids.tenantA },
    });
    // Fixture teacher lacks resource.academics.read (OD-2 scopes class lists, not this aggregate).
    expect(teacher.statusCode).toBe(403);
  });

  it("refuses academics-summary for unknown termId", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/reports/academics-summary?termId=00000000-0000-4000-8000-000000000099`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(res.statusCode).toBe(404);
  });
});
