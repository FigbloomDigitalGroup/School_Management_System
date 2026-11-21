import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

const PASSWORD = "correct-horse-battery";

describe("Stage 12 sick bay core", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let adminToken: string;
  let teacherToken: string;
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
    teacherToken = (
      await ctx.app.inject({
        method: "POST",
        url: "/v1/auth/login/login-id",
        payload: { tenantId: ids.tenantA, loginId: "TC-0001", password: PASSWORD },
      })
    ).json().token;
    const learner = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { full_name: "Sick Bay Learner", admission_no: "SB-001", date_of_birth: "2014-05-01", gender: "female" },
    });
    expect(learner.statusCode, learner.body).toBe(201);
    learnerId = learner.json().learner.id as string;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  function headers(token: string) {
    return { authorization: `Bearer ${token}`, "x-tenant-id": ids.tenantA };
  }

  it("medical area holder creates a board visit and updates outcome", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/health/sick-bay/visits`,
      headers: headers(adminToken),
      payload: { learner_id: learnerId, complaint: "Headache", temperature_c: 37.2 },
    });
    expect(created.statusCode, created.body).toBe(201);
    const visitId = created.json().visit.id as string;

    const board = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/health/sick-bay/board`,
      headers: headers(adminToken),
    });
    expect(board.statusCode).toBe(200);
    expect(board.json().visits.some((v: { id: string }) => v.id === visitId)).toBe(true);

    const patched = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/tenants/${ids.tenantA}/health/sick-bay/visits/${visitId}`,
      headers: headers(adminToken),
      payload: { outcome: "class", time_out: new Date().toISOString(), treatment: "Rest and water" },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().visit.outcome).toBe("class");
    expect(patched.json().visit.time_out).toBeTruthy();
  });

  it("teacher without medical area cannot read clinical board", async () => {
    const denied = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/health/sick-bay/board`,
      headers: headers(teacherToken),
    });
    expect(denied.statusCode).toBe(403);
  });

  it("medical settings default to serious and can be updated", async () => {
    const get = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/health/medical-settings`,
      headers: headers(adminToken),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().settings.notify_guardians).toBe("serious");

    const put = await ctx.app.inject({
      method: "PUT",
      url: `/v1/tenants/${ids.tenantA}/health/medical-settings`,
      headers: headers(adminToken),
      payload: { notify_guardians: "all" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().settings.notify_guardians).toBe("all");
  });
});
