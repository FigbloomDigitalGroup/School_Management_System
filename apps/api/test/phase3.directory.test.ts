import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

async function loginEmail(app: Ctx["app"], email: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login/email",
    payload: { email, password: "correct-horse-battery" },
  });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

async function loginLoginId(app: Ctx["app"], tenantId: string, loginId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login/login-id",
    payload: { tenantId, loginId, password: "correct-horse-battery" },
  });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

function bearer(token: string, tenantId?: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (tenantId) headers["x-tenant-id"] = tenantId;
  return headers;
}

describe("Phase 3 school directory", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let adminToken: string;
  let teacherToken: string;
  let parentToken: string;
  let teacherBToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    adminToken = await loginEmail(ctx.app, "admin-a@example.com");
    teacherToken = await loginLoginId(ctx.app, ids.tenantA, "TC-0001");
    parentToken = await loginLoginId(ctx.app, ids.tenantA, "PT-0001");
    teacherBToken = await loginLoginId(ctx.app, ids.tenantB, "TC-0001");
    const grant = await ctx.app.inject({
      method: "PUT",
      url: "/v1/rbac/staff-areas",
      headers: bearer(adminToken, ids.tenantA),
      payload: { userId: ids.teacherA, areas: ["people"] },
    });
    expect(grant.statusCode).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("school profile get/patch is tenant-scoped and auditable", async () => {
    const get0 = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/school-profile`,
      headers: bearer(adminToken, ids.tenantA),
    });
    expect(get0.statusCode).toBe(200);
    expect(get0.json().schoolProfile.tenantId).toBe(ids.tenantA);

    const patch = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/tenants/${ids.tenantA}/school-profile`,
      headers: bearer(adminToken, ids.tenantA),
      payload: {
        name: "School A Renamed",
        timezone: "Africa/Nairobi",
        county: "Nairobi",
        institution_type: "k12",
      },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().schoolProfile.name).toBe("School A Renamed");
    expect(patch.json().schoolProfile.county).toBe("Nairobi");

    const cross = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantB}/school-profile`,
      headers: bearer(adminToken, ids.tenantA),
    });
    expect(cross.statusCode).toBe(403);

    const denied = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/tenants/${ids.tenantA}/school-profile`,
      headers: bearer(parentToken, ids.tenantA),
      payload: { county: "Kiambu" },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("learner list/update/archive/restore and cross-tenant isolation", async () => {
    const a = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: bearer(adminToken, ids.tenantA),
      payload: { admission_no: "P3-100", full_name: "Phase Three Learner", gender: "male" },
    });
    expect(a.statusCode).toBe(201);
    const learnerId = a.json().learner.id as string;

    const list = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/learners?q=phase&active=true&limit=10`,
      headers: bearer(adminToken, ids.tenantA),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().learners.some((l: { id: string }) => l.id === learnerId)).toBe(true);
    expect(list.json().page).toBeTruthy();

    const upd = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/tenants/${ids.tenantA}/learners/${learnerId}`,
      headers: bearer(adminToken, ids.tenantA),
      payload: { full_name: "Phase Three Updated" },
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().learner.full_name).toBe("Phase Three Updated");

    const arch = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners/${learnerId}/archive`,
      headers: bearer(adminToken, ids.tenantA),
    });
    expect(arch.statusCode).toBe(200);
    expect(arch.json().learner.active).toBe(false);

    const cross = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/learners/${learnerId}`,
      headers: bearer(teacherBToken, ids.tenantB),
    });
    expect(cross.statusCode).toBe(403);

    const rest = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners/${learnerId}/restore`,
      headers: bearer(adminToken, ids.tenantA),
    });
    expect(rest.statusCode).toBe(200);
    expect(rest.json().learner.active).toBe(true);
  });

  it("staff directory CRUD with area.people implication and no auth grant", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/staff`,
      headers: bearer(teacherToken, ids.tenantA),
      payload: { full_name: "Office Secretary", classification: "staff", staff_title: "Secretary" },
    });
    expect(created.statusCode).toBe(201);
    const staffId = created.json().staff.id as string;
    expect(created.json().staff.userId).toBeNull();

    const listed = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/staff?q=secretary`,
      headers: bearer(teacherToken, ids.tenantA),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().staff.some((s: { id: string }) => s.id === staffId)).toBe(true);

    const parentDenied = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/staff`,
      headers: bearer(parentToken, ids.tenantA),
    });
    expect(parentDenied.statusCode).toBe(403);
  });

  it("FIG-1614: area.people does not grant guardian read/write", async () => {
    const learner = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: bearer(adminToken, ids.tenantA),
      payload: { admission_no: "P3-G1", full_name: "Guardian Child", gender: "female" },
    });
    const learnerId = learner.json().learner.id as string;

    const denied = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/guardians`,
      headers: bearer(teacherToken, ids.tenantA),
      payload: {
        full_name: "Parent Denied",
        learners: [{ learner_id: learnerId, relationship: "mother" }],
      },
    });
    expect(denied.statusCode).toBe(403);

    const created = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/guardians`,
      headers: bearer(adminToken, ids.tenantA),
      payload: {
        full_name: "Parent Allowed",
        phone: "0712345678",
        learners: [{ learner_id: learnerId, relationship: "father" }],
      },
    });
    expect(created.statusCode).toBe(201);
    const guardianId = created.json().guardian.id as string;
    const linkId = created.json().guardian.links[0].id as string;

    const patch = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/tenants/${ids.tenantA}/guardians/${guardianId}`,
      headers: bearer(adminToken, ids.tenantA),
      payload: { phone: "0798765432" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().guardian.phone).toBe("0798765432");

    const unlink = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/guardians/${guardianId}/links/${linkId}/archive`,
      headers: bearer(adminToken, ids.tenantA),
    });
    expect(unlink.statusCode).toBe(200);
  });

  it("document metadata register/list/archive without storing URLs as keys", async () => {
    const learner = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: bearer(adminToken, ids.tenantA),
      payload: { admission_no: "P3-D1", full_name: "Doc Learner", gender: "male" },
    });
    const learnerId = learner.json().learner.id as string;

    const bad = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/documents`,
      headers: bearer(adminToken, ids.tenantA),
      payload: {
        subject_type: "learner",
        subject_id: learnerId,
        doc_type: "birth_certificate",
        file_name: "bc.pdf",
        // F-04: clients cannot choose a key at all (strict body), whatever it looks like.
        storage_key: "https://evil.example/secret",
      },
    });
    expect(bad.statusCode).toBe(400);

    const ok = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/documents`,
      headers: bearer(adminToken, ids.tenantA),
      payload: {
        subject_type: "learner",
        subject_id: learnerId,
        doc_type: "birth_certificate",
        file_name: "bc.pdf",
        content_type: "application/pdf",
        byte_size: 1200,
      },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().document.storage_status).toBe("metadata_only");
    expect(ok.json().document.storage_key).toBeUndefined();
    const documentId = ok.json().document.id as string;

    const list = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/documents?subject_type=learner&subject_id=${learnerId}`,
      headers: bearer(adminToken, ids.tenantA),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().documents.some((d: { id: string }) => d.id === documentId)).toBe(true);

    const arch = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/documents/${documentId}/archive`,
      headers: bearer(adminToken, ids.tenantA),
    });
    expect(arch.statusCode).toBe(200);
    expect(arch.json().document.archived_at).toBeTruthy();
  });
});
