import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

const PASSWORD = "correct-horse-battery";

describe("Stage 16 learner CSV import", () => {
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

  it("previews and applies a valid CSV", async () => {
    const headers = { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA };
    const csv = [
      "admission_no,full_name,gender,date_of_birth,boarding",
      "IM-001,Import One,female,2014-01-01,false",
      "IM-002,Import Two,male,2013-06-15,true",
    ].join("\n");

    const preview = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/preview`,
      headers,
      payload: { csv },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().preview.valid_count).toBe(2);
    expect(preview.json().preview.error_count).toBe(0);
    const importId = preview.json().preview.import_id as string;

    const apply = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/apply`,
      headers,
      payload: { import_id: importId },
    });
    expect(apply.statusCode, apply.body).toBe(200);
    expect(apply.json().result.created_count).toBe(2);

    const replay = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/apply`,
      headers,
      payload: { import_id: importId },
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().result).toMatchObject({
      created_count: 2,
      import_id: importId,
      replayed: true,
    });
  });

  it("rejects CSV rows with validation errors and blocks apply", async () => {
    const headers = { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA };
    const csv = ["admission_no,full_name,gender", "BAD,,other"].join("\n");
    const preview = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/preview`,
      headers,
      payload: { csv },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().preview.error_count).toBeGreaterThan(0);
    const importId = preview.json().preview.import_id as string;
    const apply = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/apply`,
      headers,
      payload: { import_id: importId },
    });
    expect(apply.statusCode).toBe(400);
  });
});
