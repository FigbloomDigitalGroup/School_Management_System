import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";

describe("learning-material lifecycle", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    const login = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email: "admin-a@example.com", password: "correct-horse-battery" },
    });
    expect(login.statusCode).toBe(200);
    token = login.json().token as string;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("creates a draft, edits and publishes it, then archives without deleting", async () => {
    const tenantId = ctx.ids.tenantA;
    const headers = { authorization: `Bearer ${token}`, "x-tenant-id": tenantId };
    const created = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/learning-materials`,
      headers: { ...headers, "idempotency-key": "materials-create-001" },
      payload: { title: "Revision notes", url: "https://school.example/notes" },
    });
    expect(created.statusCode).toBe(201);
    const materialId = created.json().material.id as string;
    expect(created.json().material).toMatchObject({
      title: "Revision notes",
      url: "https://school.example/notes",
      published_at: null,
      archived_at: null,
    });

    const edited = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/tenants/${tenantId}/learning-materials/${materialId}`,
      headers,
      payload: { title: "Updated revision notes", url: null },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().material).toMatchObject({ title: "Updated revision notes", url: null, published_at: null });

    const published = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/learning-materials/${materialId}/publish`,
      headers: { ...headers, "idempotency-key": "materials-publish-001" },
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().material.published_at).toEqual(expect.any(String));

    const unpublished = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/learning-materials/${materialId}/unpublish`,
      headers: { ...headers, "idempotency-key": "materials-unpublish-001" },
    });
    expect(unpublished.statusCode).toBe(200);
    expect(unpublished.json().material.published_at).toBeNull();

    const republished = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/learning-materials/${materialId}/publish`,
      headers: { ...headers, "idempotency-key": "materials-publish-002" },
    });
    expect(republished.statusCode).toBe(200);

    const archived = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/learning-materials/${materialId}/archive`,
      headers: { ...headers, "idempotency-key": "materials-archive-001" },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().material.archived_at).toEqual(expect.any(String));

    const archivedAgain = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/learning-materials/${materialId}/archive`,
      headers: { ...headers, "idempotency-key": "materials-archive-002" },
    });
    expect(archivedAgain.statusCode).toBe(200);
    expect(archivedAgain.json().material.archived_at).toBe(archived.json().material.archived_at);

    const listed = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/learning-materials`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().materials.some((row: { id: string }) => row.id === materialId)).toBe(false);
    const stored = await ctx.pool.query<{ id: string }>("SELECT id FROM learning_materials WHERE tenant_id = $1 AND id = $2", [tenantId, materialId]);
    expect(stored.rows).toHaveLength(1);
  });
});
