import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

const PASSWORD = "correct-horse-battery";

describe("Stage 13 activities", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let adminToken: string;
  let learnerId: string;

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
    const learner = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { full_name: "Club Learner", admission_no: "CL-001", date_of_birth: "2013-01-01", gender: "male" },
    });
    expect(learner.statusCode, learner.body).toBe(201);
    learnerId = learner.json().learner.id as string;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("creates an activity, adds a patron and a member", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/activities`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { name: "Chess Club", category: "club", meeting_schedule: "Wednesdays 4pm" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const activityId = created.json().activity.id as string;

    const patron = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/activities/${activityId}/patrons`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { teacher_user_id: ids.teacherA },
    });
    expect(patron.statusCode).toBe(204);

    const member = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/activities/${activityId}/members`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { learner_id: learnerId, role: "Captain" },
    });
    expect(member.statusCode).toBe(204);

    const list = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/activities/${activityId}/members`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().members).toEqual([{ learner_id: learnerId, role: "Captain", joined_on: expect.any(String) }]);
  });
});
