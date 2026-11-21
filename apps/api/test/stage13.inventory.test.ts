import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

const PASSWORD = "correct-horse-battery";

describe("Stage 13 inventory", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let adminToken: string;

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
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  function headers() {
    return { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA };
  }

  it("creates stock, issues to staff, refuses over-issue, and closes the issue", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/inventory/items`,
      headers: headers(),
      payload: { name: "KLB Biology Form 2", category: "textbooks", tracking: "stock", quantity: 2 },
    });
    expect(created.statusCode, created.body).toBe(201);
    const itemId = created.json().item.id as string;

    const issue1 = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/inventory/issues`,
      headers: headers(),
      payload: { item_id: itemId, holder_user_id: ids.teacherA, quantity: 2 },
    });
    expect(issue1.statusCode, issue1.body).toBe(201);

    const over = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/inventory/issues`,
      headers: headers(),
      payload: { item_id: itemId, holder_user_id: ids.adminA, quantity: 1 },
    });
    expect(over.statusCode).toBe(400);

    const closed = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/inventory/issues/${issue1.json().issue.id}/close`,
      headers: headers(),
      payload: { status: "returned", returned_condition: "good" },
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().issue.status).toBe("returned");
  });
});
