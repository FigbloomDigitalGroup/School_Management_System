import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestApp, type FixtureIds } from "./support.js";
import { PEOPLE_AREA_IMPLIED } from "../src/modules/rbac/authorize.js";

/**
 * Phase 3 remediation: F-01 (guardian exposure through documents), F-02 (school settings
 * privilege), F-04 (document storage contract).
 */

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

describe("Phase 3 remediation: F-01 / F-02 / F-04", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let adminToken: string;
  let teacherToken: string; // area.people only
  let parentToken: string;
  let orgToken: string;
  let learnerId: string;
  let guardianId: string;
  let staffId: string;
  let guardianDocId: string;
  let learnerDocId: string;

  const A = () => ids.tenantA;

  async function post(token: string, url: string, payload?: unknown, tenant = A()) {
    return ctx.app.inject({ method: "POST", url, headers: bearer(token, tenant), payload: payload as never });
  }
  async function get(token: string, url: string, tenant = A()) {
    return ctx.app.inject({ method: "GET", url, headers: bearer(token, tenant) });
  }
  async function patch(token: string, url: string, payload: unknown, tenant = A()) {
    return ctx.app.inject({ method: "PATCH", url, headers: bearer(token, tenant), payload: payload as never });
  }
  async function delegate(method: "POST" | "DELETE", codes: string[]) {
    const res = await ctx.app.inject({
      method,
      url: "/v1/rbac/org-delegations",
      headers: bearer(adminToken, A()),
      payload: { delegateUserId: ids.orgAdmin, permissionCodes: codes },
    });
    expect(res.statusCode).toBe(200);
  }
  // area.people can no longer be GRANTED by delegation (owner decision 2026-11-17, migration 026),
  // but existing grants keep working. These tests pin what such an existing grant can and cannot do,
  // so the row is created the way it existed before: directly, with the grant guard bypassed.
  async function seedExistingPeopleDelegation() {
    await ctx.pool.query(`ALTER TABLE org_admin_school_delegations DISABLE TRIGGER org_admin_school_delegations_guard`);
    try {
      await ctx.pool.query(
        `INSERT INTO org_admin_school_delegations (organization_id, tenant_id, delegate_user_id, permission_code, granted_by)
         VALUES ($1, $2, $3, 'area.people', $4) ON CONFLICT DO NOTHING`,
        [ctx.ids.orgA, A(), ids.orgAdmin, ctx.ids.adminA],
      );
    } finally {
      await ctx.pool.query(`ALTER TABLE org_admin_school_delegations ENABLE TRIGGER org_admin_school_delegations_guard`);
    }
  }
  async function deniedCount(userId: string): Promise<number> {
    const r = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM security_audit_events
       WHERE event_type = 'rbac.permission.denied' AND actor_user_id = $1`,
      [userId],
    );
    return r.rows[0]?.n ?? 0;
  }
  function docBody(subject_type: string, subject_id: string, extra: Record<string, unknown> = {}) {
    return { subject_type, subject_id, doc_type: "id_copy", file_name: "scan.pdf", ...extra };
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    adminToken = await loginEmail(ctx.app, "admin-a@example.com");
    teacherToken = await loginLoginId(ctx.app, A(), "TC-0001");
    parentToken = await loginLoginId(ctx.app, A(), "PT-0001");
    orgToken = await loginEmail(ctx.app, "orgadmin@example.com");

    const grant = await ctx.app.inject({
      method: "PUT",
      url: "/v1/rbac/staff-areas",
      headers: bearer(adminToken, A()),
      payload: { userId: ids.teacherA, areas: ["people"] },
    });
    expect(grant.statusCode).toBe(200);

    const learner = await post(adminToken, `/v1/tenants/${A()}/learners`, {
      admission_no: "REM-1",
      full_name: "Remediation Learner",
      gender: "female",
    });
    expect(learner.statusCode).toBe(201);
    learnerId = learner.json().learner.id;

    const guardian = await post(adminToken, `/v1/tenants/${A()}/guardians`, {
      full_name: "Secret Guardian",
      phone: "0711000111",
      email: "secret.guardian@example.com",
      learners: [{ learner_id: learnerId, relationship: "mother" }],
    });
    expect(guardian.statusCode).toBe(201);
    guardianId = guardian.json().guardian.id;

    const staff = await post(adminToken, `/v1/tenants/${A()}/staff`, {
      full_name: "Doc Staff",
      classification: "staff",
    });
    expect(staff.statusCode).toBe(201);
    staffId = staff.json().staff.id;

    const gd = await post(adminToken, `/v1/tenants/${A()}/documents`, docBody("guardian", guardianId));
    expect(gd.statusCode).toBe(201);
    guardianDocId = gd.json().document.id;
    const ld = await post(adminToken, `/v1/tenants/${A()}/documents`, docBody("learner", learnerId));
    expect(ld.statusCode).toBe(201);
    learnerDocId = ld.json().document.id;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  // ------------------------------------------------------------------ F-01
  describe("F-01 guardian information does not leak through documents", () => {
    it("the People area implies no guardian permission and no school-profile write", () => {
      expect(PEOPLE_AREA_IMPLIED.filter((c) => c.startsWith("resource.guardian."))).toEqual([]);
      expect(PEOPLE_AREA_IMPLIED).not.toContain("resource.school_profile.write");
    });

    it("an area.people user cannot register a document for a guardian, and cannot probe guardian ids", async () => {
      const real = await post(teacherToken, `/v1/tenants/${A()}/documents`, docBody("guardian", guardianId));
      const ghost = await post(teacherToken, `/v1/tenants/${A()}/documents`, docBody("guardian", randomUUID()));
      expect(real.statusCode).toBe(403);
      expect(ghost.statusCode).toBe(403);
      expect(real.json().error.code).toBe(ghost.json().error.code);
      const count = await ctx.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM directory_documents WHERE subject_type = 'guardian'`,
      );
      expect(count.rows[0]?.n).toBe(1); // only the admin's
    });

    it("learner and staff documents stay available to the People area", async () => {
      const learnerDoc = await post(teacherToken, `/v1/tenants/${A()}/documents`, docBody("learner", learnerId));
      expect(learnerDoc.statusCode).toBe(201);
      const staffDoc = await post(teacherToken, `/v1/tenants/${A()}/documents`, docBody("staff", staffId));
      expect(staffDoc.statusCode).toBe(201);
    });

    it("listing omits guardian documents without the grant (unfiltered and by subject_id) and refuses subject_type=guardian", async () => {
      const unfiltered = await get(teacherToken, `/v1/tenants/${A()}/documents?limit=200`);
      expect(unfiltered.statusCode).toBe(200);
      const docs = unfiltered.json().documents as Array<{ id: string; subject_type: string }>;
      expect(docs.some((d) => d.id === learnerDocId)).toBe(true);
      expect(docs.some((d) => d.id === guardianDocId)).toBe(false);
      expect(docs.every((d) => d.subject_type !== "guardian")).toBe(true);

      const bySubject = await get(teacherToken, `/v1/tenants/${A()}/documents?subject_id=${guardianId}`);
      expect(bySubject.statusCode).toBe(200);
      expect(bySubject.json().documents).toEqual([]);

      const before = await deniedCount(ids.teacherA);
      const byType = await get(teacherToken, `/v1/tenants/${A()}/documents?subject_type=guardian`);
      expect(byType.statusCode).toBe(403);
      expect(await deniedCount(ids.teacherA)).toBe(before + 1);

      // The admin still sees it.
      const adminList = await get(adminToken, `/v1/tenants/${A()}/documents?subject_type=guardian`);
      expect(adminList.statusCode).toBe(200);
      expect(adminList.json().documents.some((d: { id: string }) => d.id === guardianDocId)).toBe(true);
    });

    it("get/archive of a guardian document answers 404 indistinguishable from a missing id, audited, and changes nothing", async () => {
      const hidden = await get(teacherToken, `/v1/tenants/${A()}/documents/${guardianDocId}`);
      const missing = await get(teacherToken, `/v1/tenants/${A()}/documents/${randomUUID()}`);
      expect(hidden.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      const shape = (r: { json: () => { error: { code: string; message: string } } }) => ({
        code: r.json().error.code,
        message: r.json().error.message,
      });
      expect(shape(hidden)).toEqual(shape(missing));

      const before = await deniedCount(ids.teacherA);
      const archive = await post(teacherToken, `/v1/tenants/${A()}/documents/${guardianDocId}/archive`);
      expect(archive.statusCode).toBe(404);
      expect(await deniedCount(ids.teacherA)).toBe(before + 1);
      const still = await get(adminToken, `/v1/tenants/${A()}/documents/${guardianDocId}`);
      expect(still.json().document.archived_at).toBeNull();
    });

    it("no other API path gives an area.people user guardian contact details", async () => {
      const guardianRoutes = [
        `/v1/tenants/${A()}/guardians`,
        `/v1/tenants/${A()}/guardians/${guardianId}`,
        `/v1/tenants/${A()}/learners/${learnerId}/guardians`,
      ];
      for (const url of guardianRoutes) {
        expect((await get(teacherToken, url)).statusCode).toBe(403);
      }
      expect(
        (await post(teacherToken, `/v1/tenants/${A()}/guardians/${guardianId}/archive`)).statusCode,
      ).toBe(403);
      // Everything an area.people user CAN read must be free of the guardian's contact data.
      const readable = [
        `/v1/tenants/${A()}/learners/${learnerId}`,
        `/v1/tenants/${A()}/learners?limit=200`,
        `/v1/tenants/${A()}/staff?limit=200`,
        `/v1/tenants/${A()}/documents?limit=200`,
        `/v1/tenants/${A()}/school-profile`,
      ];
      for (const url of readable) {
        const res = await get(teacherToken, url);
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toMatch(/0711000111|secret\.guardian|Secret Guardian/);
      }
    });

    it("a parent cannot use the documents API at all", async () => {
      expect((await get(parentToken, `/v1/tenants/${A()}/documents`)).statusCode).toBe(403);
      expect((await get(parentToken, `/v1/tenants/${A()}/documents/${guardianDocId}`)).statusCode).toBe(403);
    });

    it("an org admin cannot be delegated document or guardian codes; an existing area.people grant never reaches guardian documents", async () => {
      await seedExistingPeopleDelegation();
      const list = await get(orgToken, `/v1/tenants/${A()}/documents?limit=200`);
      expect(list.statusCode).toBe(200);
      expect(list.json().documents.some((d: { id: string }) => d.id === guardianDocId)).toBe(false);
      expect((await get(orgToken, `/v1/tenants/${A()}/documents/${guardianDocId}`)).statusCode).toBe(404);
      expect(
        (await post(orgToken, `/v1/tenants/${A()}/documents`, docBody("guardian", guardianId))).statusCode,
      ).toBe(403);
      // Owner decision: none of these may be delegated (guardian access is explicit per-person only).
      for (const codes of [
        ["resource.document.read"],
        ["resource.document.write"],
        ["resource.guardian.read"],
        ["resource.guardian.write"],
        ["area.people", "resource.guardian.read"],
      ]) {
        const res = await ctx.app.inject({
          method: "POST",
          url: "/v1/rbac/org-delegations",
          headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": A() },
          payload: { delegateUserId: ids.orgAdmin, permissionCodes: codes },
        });
        expect(res.statusCode, codes.join()).toBe(400);
      }
      // Still hidden and refused after the attempts.
      expect((await get(orgToken, `/v1/tenants/${A()}/documents/${guardianDocId}`)).statusCode).toBe(404);
      expect(
        (await post(orgToken, `/v1/tenants/${A()}/documents`, docBody("guardian", guardianId))).statusCode,
      ).toBe(403);
      await delegate("DELETE", ["area.people"]);
    });
  });

  // ------------------------------------------------------------------ F-02
  describe("F-02 school configuration stays a full-administrator power", () => {
    it("area.people can read the profile but cannot change name, timezone or any profile field", async () => {
      expect((await get(teacherToken, `/v1/tenants/${A()}/school-profile`)).statusCode).toBe(200);
      const before = await ctx.pool.query<{ name: string; timezone: string }>(
        `SELECT name, timezone FROM tenants WHERE id = $1`,
        [A()],
      );
      const denied = await deniedCount(ids.teacherA);
      for (const payload of [
        { name: "Hijacked School" },
        { timezone: "Pacific/Auckland" },
        { county: "Mombasa" },
        { contact_email: "evil@example.com" },
        { name: "Hijacked School", timezone: "Pacific/Auckland", county: "Mombasa" },
      ]) {
        const res = await patch(teacherToken, `/v1/tenants/${A()}/school-profile`, payload);
        expect(res.statusCode).toBe(403);
      }
      expect(await deniedCount(ids.teacherA)).toBe(denied + 5);
      const after = await ctx.pool.query<{ name: string; timezone: string }>(
        `SELECT name, timezone FROM tenants WHERE id = $1`,
        [A()],
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
      const profileRows = await ctx.pool.query(
        `SELECT 1 FROM school_profiles WHERE tenant_id = $1 AND (county = 'Mombasa' OR contact_email = 'evil@example.com')`,
        [A()],
      );
      expect(profileRows.rowCount).toBe(0);
    });

    it("a school administrator can still update the profile", async () => {
      const res = await patch(adminToken, `/v1/tenants/${A()}/school-profile`, {
        name: "School A Admin Rename",
        timezone: "Africa/Nairobi",
        county: "Nairobi",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().schoolProfile.name).toBe("School A Admin Rename");
    });

    it("an org admin with an existing area.people delegation cannot write; a school_profile.write delegation is refused", async () => {
      await seedExistingPeopleDelegation();
      expect((await get(orgToken, `/v1/tenants/${A()}/school-profile`)).statusCode).toBe(200);
      expect((await patch(orgToken, `/v1/tenants/${A()}/school-profile`, { county: "Kiambu" })).statusCode).toBe(403);
      const refused = await ctx.app.inject({
        method: "POST",
        url: "/v1/rbac/org-delegations",
        headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": A() },
        payload: { delegateUserId: ids.orgAdmin, permissionCodes: ["resource.school_profile.write"] },
      });
      expect(refused.statusCode).toBe(400);
      expect((await patch(orgToken, `/v1/tenants/${A()}/school-profile`, { county: "Kiambu" })).statusCode).toBe(403);
      await delegate("DELETE", ["area.people"]);
      expect((await patch(orgToken, `/v1/tenants/${A()}/school-profile`, { county: "Nakuru" })).statusCode).toBe(403);
    });

    it("a parent and a cross-tenant admin cannot write", async () => {
      expect((await patch(parentToken, `/v1/tenants/${A()}/school-profile`, { county: "X" })).statusCode).toBe(403);
      expect(
        (await patch(adminToken, `/v1/tenants/${ids.tenantB}/school-profile`, { county: "X" }, ids.tenantB)).statusCode,
      ).toBe(403);
    });
  });

  // ------------------------------------------------------------------ S-01 (self-identified)
  describe("S-01 staff identity link cannot cross tenants", () => {
    it("rejects a user who is not an active member of this school, identically for foreign and unknown ids", async () => {
      const foreign = await post(teacherToken, `/v1/tenants/${A()}/staff`, {
        full_name: "Linked Foreign",
        classification: "staff",
        userId: ids.teacherB, // member of tenant B only
      });
      const platform = await post(teacherToken, `/v1/tenants/${A()}/staff`, {
        full_name: "Linked Platform",
        classification: "staff",
        userId: ids.superAdmin, // no membership in A
      });
      const unknown = await post(teacherToken, `/v1/tenants/${A()}/staff`, {
        full_name: "Linked Unknown",
        classification: "staff",
        userId: randomUUID(),
      });
      for (const res of [foreign, platform, unknown]) expect(res.statusCode).toBe(400);
      expect(foreign.json().error.message).toBe(unknown.json().error.message);
      expect(platform.json().error.message).toBe(unknown.json().error.message);
      const rows = await ctx.pool.query(`SELECT 1 FROM staff_members WHERE full_name LIKE 'Linked %'`);
      expect(rows.rowCount).toBe(0);
    });

    it("accepts a member of this school and rejects re-pointing an existing record at a foreign user", async () => {
      const ok = await post(teacherToken, `/v1/tenants/${A()}/staff`, {
        full_name: "Linked Member",
        classification: "teacher",
        userId: ids.teacherA,
      });
      expect(ok.statusCode).toBe(201);
      expect(ok.json().staff.userId).toBe(ids.teacherA);
      const repoint = await patch(teacherToken, `/v1/tenants/${A()}/staff/${ok.json().staff.id}`, {
        userId: ids.teacherB,
      });
      expect(repoint.statusCode).toBe(400);
      const still = await get(teacherToken, `/v1/tenants/${A()}/staff/${ok.json().staff.id}`);
      expect(still.json().staff.userId).toBe(ids.teacherA);
    });
  });

  // ------------------------------------------------------------------ F-04
  describe("F-04 document storage contract", () => {
    it("rejects every client-supplied storage key, whatever it looks like", async () => {
      const keys = [
        "https://evil.example/secret",
        "s3://bucket/key",
        "../../etc/passwd",
        `${ids.tenantB}/learners/${learnerId}/stolen.pdf`,
        `${A()}/learners/${learnerId}/bc.pdf`,
        "plain-key",
      ];
      for (const storage_key of keys) {
        const res = await post(adminToken, `/v1/tenants/${A()}/documents`, docBody("learner", learnerId, { storage_key }));
        expect(res.statusCode).toBe(400);
      }
    });

    it("never returns a storage key and states plainly that no object exists", async () => {
      const created = await post(adminToken, `/v1/tenants/${A()}/documents`, docBody("learner", learnerId));
      expect(created.statusCode).toBe(201);
      const doc = created.json().document;
      expect(doc.storage_status).toBe("metadata_only");
      expect(doc.object_available).toBe(false);
      const all = [
        created.body,
        (await get(adminToken, `/v1/tenants/${A()}/documents?limit=200`)).body,
        (await get(adminToken, `/v1/tenants/${A()}/documents/${doc.id}`)).body,
        (await post(adminToken, `/v1/tenants/${A()}/documents/${doc.id}/archive`)).body,
      ];
      for (const body of all) {
        expect(body).not.toMatch(/storage_key|obj\/|"key"/);
      }
    });

    it("stores a server-generated, opaque, tenant-prefixed, unique key with no subject or file information", async () => {
      const keys = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const res = await post(
          adminToken,
          `/v1/tenants/${A()}/documents`,
          docBody("learner", learnerId, { file_name: "same-name.pdf" }),
        );
        expect(res.statusCode).toBe(201);
        const row = await ctx.pool.query<{ storage_key: string; storage_status: string }>(
          `SELECT storage_key, storage_status FROM directory_documents WHERE id = $1`,
          [res.json().document.id],
        );
        const key = row.rows[0]!.storage_key;
        expect(key).toMatch(new RegExp(`^obj/${A()}/[0-9a-f]{64}$`));
        expect(key).not.toContain(learnerId);
        expect(key).not.toContain("same-name");
        expect(key).not.toMatch(/\.|\.\./);
        expect(row.rows[0]!.storage_status).toBe("metadata_only");
        keys.add(key);
      }
      expect(keys.size).toBe(3);
    });

    it("the database overrides a key chosen by anything that bypasses the API, and refuses foreign subjects", async () => {
      const client = await ctx.runtimePool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [A()]);
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.adminA]);
        const inserted = await client.query<{ id: string; storage_key: string }>(
          `INSERT INTO directory_documents (tenant_id, subject_type, subject_id, doc_type, file_name, storage_key)
           VALUES ($1, 'learner', $2, 'x', 'x.pdf', 'chosen/by/client') RETURNING id, storage_key`,
          [A(), learnerId],
        );
        expect(inserted.rows[0]!.storage_key).not.toBe("chosen/by/client");
        expect(inserted.rows[0]!.storage_key).toMatch(new RegExp(`^obj/${A()}/[0-9a-f]{64}$`));
        await client.query("ROLLBACK");

        // A subject that exists only in another tenant is refused by the database (23503).
        const other = await ctx.pool.query<{ id: string }>(
          `INSERT INTO learners (tenant_id, admission_no, full_name, gender)
           VALUES ($1, 'REM-B', 'Other Tenant', 'male') RETURNING id`,
          [ids.tenantB],
        );
        await client.query("BEGIN");
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [A()]);
        await expect(
          client.query(
            `INSERT INTO directory_documents (tenant_id, subject_type, subject_id, doc_type, file_name)
             VALUES ($1, 'learner', $2, 'x', 'x.pdf')`,
            [A(), other.rows[0]!.id],
          ),
        ).rejects.toMatchObject({ code: "23503" });
        await client.query("ROLLBACK");
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
      // And through the API, a subject in another tenant is simply not found.
      const other = await ctx.pool.query<{ id: string }>(
        `SELECT id FROM learners WHERE tenant_id = $1 AND admission_no = 'REM-B'`,
        [ids.tenantB],
      );
      const res = await post(adminToken, `/v1/tenants/${A()}/documents`, docBody("learner", other.rows[0]!.id));
      expect(res.statusCode).toBe(404);
    });

    it("identity and storage fields are immutable and archiving is one way", async () => {
      const created = await post(adminToken, `/v1/tenants/${A()}/documents`, docBody("learner", learnerId));
      const id = created.json().document.id as string;
      const attempts: Array<[string, unknown[]]> = [
        [`UPDATE directory_documents SET storage_key = 'x' WHERE id = $1`, []],
        [`UPDATE directory_documents SET file_name = 'renamed.pdf' WHERE id = $1`, []],
        [`UPDATE directory_documents SET subject_id = gen_random_uuid() WHERE id = $1`, []],
        [`UPDATE directory_documents SET uploaded_by = NULL WHERE id = $1`, []],
        [`UPDATE directory_documents SET storage_status = 'metadata_only', byte_size = 1 WHERE id = $1`, []],
      ];
      // Two independent layers must each refuse these. As the runtime role, migration 027's
      // column grants refuse them before any trigger runs (42501). As the table owner, which has
      // every column privilege, the migration-021 trigger is the only thing left and refuses them
      // (23514) — so neither layer is silently carrying the other.
      for (const [sql] of attempts) {
        const client = await ctx.runtimePool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [A()]);
          await expect(client.query(sql, [id]), sql).rejects.toMatchObject({ code: "42501" });
          await client.query("ROLLBACK");
        } finally {
          await client.query("ROLLBACK").catch(() => undefined);
          client.release();
        }
      }
      for (const [sql] of attempts) {
        const owner = await ctx.pool.connect();
        try {
          await owner.query("BEGIN");
          await expect(owner.query(sql, [id]), sql).rejects.toMatchObject({ code: "23514" });
          await owner.query("ROLLBACK");
        } finally {
          await owner.query("ROLLBACK").catch(() => undefined);
          owner.release();
        }
      }
      expect((await post(adminToken, `/v1/tenants/${A()}/documents/${id}/archive`)).statusCode).toBe(200);
      expect((await post(adminToken, `/v1/tenants/${A()}/documents/${id}/archive`)).statusCode).toBe(400);
      const client = await ctx.runtimePool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [A()]);
        await expect(
          client.query(`UPDATE directory_documents SET archived_at = NULL WHERE id = $1`, [id]),
        ).rejects.toMatchObject({ code: "23514" });
        await client.query("ROLLBACK");
        // Migration 027 (P3-AUDIT-014): 021 only refused a CHANGE to archived_at, so an archived
        // row's updated_at could still be bumped and the row was not actually frozen. Now no
        // UPDATE at all is accepted on an archived document.
        await client.query("BEGIN");
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [A()]);
        await expect(
          client.query(`UPDATE directory_documents SET updated_at = now() WHERE id = $1`, [id]),
        ).rejects.toMatchObject({ code: "23514" });
        await client.query("ROLLBACK");
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    });

    it("validates file names and content types", async () => {
      for (const file_name of ["../x.pdf", "a/b.pdf", "a\\b.pdf", "..", ".", "bad\u0000name.pdf", "tab\tname.pdf"]) {
        const res = await post(adminToken, `/v1/tenants/${A()}/documents`, docBody("learner", learnerId, { file_name }));
        expect(res.statusCode, JSON.stringify(file_name)).toBe(400);
      }
      for (const content_type of ["not a type", "application/", "/pdf", "text/html; charset=utf-8"]) {
        const res = await post(
          adminToken,
          `/v1/tenants/${A()}/documents`,
          docBody("learner", learnerId, { content_type }),
        );
        expect(res.statusCode, content_type).toBe(400);
      }
      const ok = await post(
        adminToken,
        `/v1/tenants/${A()}/documents`,
        docBody("learner", learnerId, { content_type: "application/pdf", file_name: "Birth Certificate (copy).pdf" }),
      );
      expect(ok.statusCode).toBe(201);
    });

    it("the audit trail records document events without any storage key", async () => {
      const rows = await ctx.pool.query<{ detail: unknown }>(
        `SELECT detail FROM security_audit_events WHERE event_type LIKE 'directory.document.%'`,
      );
      expect(rows.rowCount).toBeGreaterThan(0);
      expect(JSON.stringify(rows.rows)).not.toMatch(/storage_key|obj\//);
    });
  });
});
