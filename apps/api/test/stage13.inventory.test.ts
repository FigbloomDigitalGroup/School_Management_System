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
      payload: {
        name: "KLB Biology Form 2",
        category: "textbooks",
        tracking: "stock",
        quantity: 2,
        purchased_on: "2025-03-04",
        unit_cost_cents: 12500,
        notes: "Store in the library office",
        unit: "copy",
        consumable: false,
        reorder_level: 1,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const itemId = created.json().item.id as string;
    expect(created.json().item).toMatchObject({ purchased_on: "2025-03-04", unit_cost_cents: 12500, notes: "Store in the library office" });

    const updated = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/tenants/${ids.tenantA}/inventory/items/${itemId}`,
      headers: headers(),
      payload: { name: "KLB Biology Form 2, revised", notes: "Updated storage location", unit: "book", reorder_level: 2 },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().item).toMatchObject({ name: "KLB Biology Form 2, revised", notes: "Updated storage location", unit: "book", reorder_level: 2, quantity: 2 });
    const invalidQuantity = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/tenants/${ids.tenantA}/inventory/items/${itemId}`,
      headers: headers(),
      payload: { quantity: 99 },
    });
    expect(invalidQuantity.statusCode).toBe(400);

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

    const retired = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/inventory/items/${itemId}/retire`,
      headers: headers(),
    });
    expect(retired.statusCode, retired.body).toBe(200);
    const unretired = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/inventory/items/${itemId}/unretire`,
      headers: headers(),
    });
    expect(unretired.statusCode, unretired.body).toBe(200);
    expect(unretired.json().item.retired_at).toBeNull();
  });
});
