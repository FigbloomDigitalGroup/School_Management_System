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

    const patrons = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/activities/${activityId}/patrons`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(patrons.statusCode).toBe(200);
    expect(patrons.json().patrons).toEqual([{ teacher_user_id: ids.teacherA, full_name: "Teacher A" }]);

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

    const role = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/tenants/${ids.tenantA}/activities/${activityId}/members/${learnerId}`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { role: "Secretary" },
    });
    expect(role.statusCode, role.body).toBe(204);

    const details = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/tenants/${ids.tenantA}/activities/${activityId}`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { name: "Chess Society", meeting_schedule: "Thursdays 4pm" },
    });
    expect(details.statusCode, details.body).toBe(200);
    expect(details.json().activity).toMatchObject({ name: "Chess Society", meeting_schedule: "Thursdays 4pm", active: true, archived_at: null });

    const close = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/tenants/${ids.tenantA}/activities/${activityId}`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { active: false },
    });
    expect(close.statusCode).toBe(200);
    expect(close.json().activity.active).toBe(false);
    const reopen = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/tenants/${ids.tenantA}/activities/${activityId}`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { active: true },
    });
    expect(reopen.statusCode).toBe(200);

    const removePatron = await ctx.app.inject({
      method: "DELETE",
      url: `/v1/tenants/${ids.tenantA}/activities/${activityId}/patrons/${ids.teacherA}`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(removePatron.statusCode, removePatron.body).toBe(204);
    const removeMember = await ctx.app.inject({
      method: "DELETE",
      url: `/v1/tenants/${ids.tenantA}/activities/${activityId}/members/${learnerId}`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(removeMember.statusCode).toBe(204);

    const archive = await ctx.app.inject({
      method: "DELETE",
      url: `/v1/tenants/${ids.tenantA}/activities/${activityId}`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(archive.statusCode).toBe(204);
    const retained = await ctx.pool.query<{ archived_at: Date | null; active: boolean }>(
      "SELECT archived_at, active FROM activities WHERE tenant_id = $1 AND id = $2",
      [ids.tenantA, activityId],
    );
    expect(retained.rows).toHaveLength(1);
    expect(retained.rows[0]).toMatchObject({ active: false, archived_at: expect.any(Date) });
    const archivedList = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/activities`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(archivedList.json().activities.map((a: { id: string }) => a.id)).not.toContain(activityId);
    const archivedMembers = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/activities/${activityId}/members`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(archivedMembers.statusCode).toBe(404);
  });
});
