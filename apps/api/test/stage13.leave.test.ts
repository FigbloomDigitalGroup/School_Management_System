import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

const PASSWORD = "correct-horse-battery";

describe("Stage 13 leave", () => {
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
    teacherToken = (
      await ctx.app.inject({
        method: "POST",
        url: "/v1/auth/login/login-id",
        payload: { tenantId: ids.tenantA, loginId: "TC-0001", password: PASSWORD },
      })
    ).json().token;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("teacher submits leave; admin reviews; self-approve is refused", async () => {
    const submitted = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/leave-requests`,
      headers: { authorization: `Bearer ${teacherToken}`, "x-tenant-id": ids.tenantA },
      payload: { start_on: "2026-12-01", end_on: "2026-12-03", reason: "Family event" },
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const leaveId = submitted.json().leave_request.id as string;

    const self = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/leave-requests/${leaveId}/review`,
      headers: { authorization: `Bearer ${teacherToken}`, "x-tenant-id": ids.tenantA },
      payload: { status: "approved" },
    });
    expect(self.statusCode).toBe(403);

    const approved = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/leave-requests/${leaveId}/review`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { status: "approved", review_note: "Cover arranged" },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().leave_request.status).toBe("approved");
  });
});
