import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

const PASSWORD = "correct-horse-battery";

describe("Stage 12 visits and notification prefs", () => {
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

  it("returns default notification preferences and persists a patch", async () => {
    const get = await ctx.app.inject({ method: "GET", url: "/v1/me/notification-preferences", headers: { authorization: `Bearer ${adminToken}` } });
    expect(get.statusCode).toBe(200);
    expect(get.json().preferences.fee_reminders).toBe(true);
    expect(get.json().preferences.general_notices).toBe(false);

    const patch = await ctx.app.inject({
      method: "PATCH",
      url: "/v1/me/notification-preferences",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { general_notices: true, chat_messages: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().preferences.general_notices).toBe(true);
    expect(patch.json().preferences.chat_messages).toBe(false);
  });

  it("registers and deletes a device token for the signed-in user", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/v1/me/device-tokens",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { token: "fcm-token-abcdef0123456789", platform: "android" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().device_token.id as string;

    const list = await ctx.app.inject({
      method: "GET",
      url: "/v1/me/device-tokens",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list.json().device_tokens.some((t: { id: string }) => t.id === id)).toBe(true);

    const del = await ctx.app.inject({
      method: "DELETE",
      url: `/v1/me/device-tokens/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del.statusCode).toBe(204);
  });

  it("school admin records a visit; teacher without visitors area cannot write; host can see mine", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/gate-visits`,
      headers: headers(adminToken),
      payload: {
        visitor_name: "Jane Visitor",
        purpose: "Meeting class teacher",
        host_kind: "teacher",
        host_user_id: ids.teacherA,
        entry_point: "gate",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const visit = created.json().visit;
    expect(visit.status).toBe("expected");
    expect(visit.host_name).toBeTruthy();
    expect(visit.escalated).toBe(false);

    const denied = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/gate-visits`,
      headers: headers(teacherToken),
      payload: { visitor_name: "Nope", purpose: "x", host_kind: "office" },
    });
    expect(denied.statusCode).toBe(403);

    const mine = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/gate-visits?mine=1&open=1`,
      headers: headers(teacherToken),
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().visits.some((v: { id: string }) => v.id === visit.id)).toBe(true);

    const advanced = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/gate-visits/${visit.id}/advance`,
      headers: headers(adminToken),
      payload: { status: "at_reception" },
    });
    expect(advanced.statusCode, advanced.body).toBe(200);
    expect(advanced.json().visit.status).toBe("at_reception");
    expect(advanced.json().visit.reception_at).toBeTruthy();
  });

  it("principal host escalates on create; reception walk-in starts at_reception", async () => {
    const prin = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/gate-visits`,
      headers: headers(adminToken),
      payload: { visitor_name: "Inspector", purpose: "Office call", host_kind: "principal", entry_point: "gate" },
    });
    expect(prin.statusCode, prin.body).toBe(201);
    expect(prin.json().visit.escalated).toBe(true);

    const walkin = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/gate-visits`,
      headers: headers(adminToken),
      payload: { visitor_name: "Walk In", purpose: "Papers", host_kind: "office", entry_point: "reception" },
    });
    expect(walkin.statusCode).toBe(201);
    expect(walkin.json().visit.status).toBe("at_reception");
  });
});
