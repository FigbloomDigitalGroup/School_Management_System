import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

const PASSWORD = "correct-horse-battery";

describe("Stage 12 chat text", () => {
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

  function headers(token: string) {
    return { authorization: `Bearer ${token}`, "x-tenant-id": ids.tenantA };
  }

  it("staff can start a conversation, exchange messages, and mark read", async () => {
    const started = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/chat/conversations`,
      headers: headers(adminToken),
      payload: { peer_user_id: ids.teacherA },
    });
    expect(started.statusCode, started.body).toBe(201);
    const conversationId = started.json().conversation.id as string;

    const again = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/chat/conversations`,
      headers: headers(teacherToken),
      payload: { peer_user_id: ids.adminA },
    });
    expect(again.statusCode).toBe(201);
    expect(again.json().conversation.id).toBe(conversationId);

    const sent = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/chat/conversations/${conversationId}/messages`,
      headers: headers(adminToken),
      payload: { body: "Please cover assembly tomorrow." },
    });
    expect(sent.statusCode, sent.body).toBe(201);

    const list = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/chat/conversations/${conversationId}/messages`,
      headers: headers(teacherToken),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().messages[0].body).toBe("Please cover assembly tomorrow.");

    const read = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/chat/conversations/${conversationId}/read`,
      headers: headers(teacherToken),
    });
    expect(read.statusCode).toBe(204);
  });

  it("refuses a conversation with a user in another school", async () => {
    const denied = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/chat/conversations`,
      headers: headers(adminToken),
      payload: { peer_user_id: ids.teacherB },
    });
    expect(denied.statusCode).toBe(403);
  });
});
