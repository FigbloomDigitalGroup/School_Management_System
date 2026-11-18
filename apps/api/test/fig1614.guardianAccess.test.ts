import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";
import { hashPassword } from "../src/modules/identity/password.js";

/**
 * FIG-1614 Option D (owner-approved): explicit per-person guardian read/write grants.
 * Real HTTP application, real figbloom_app runtime login, real triggers.
 */
describe("FIG-1614 explicit per-person guardian access", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const PASSWORD = "correct-horse-battery";
  const tokens: Record<string, string> = {};
  let staffUser = "";
  let learnerId = "";
  let guardianId = "";

  beforeAll(async () => {
    ctx = await createTestApp();
    const hash = await hashPassword(PASSWORD);
    staffUser = randomUUID();
    await ctx.pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, status) VALUES ($1, 'staff-g@example.com', $2, 'Staff G', 'active')`,
      [staffUser, hash],
    );
    await ctx.pool.query(
      `INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'staff', 'SF-0042')`,
      [staffUser, ctx.ids.tenantA],
    );
    const loginEmail = async (email: string) => {
      const r = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email, password: PASSWORD } });
      expect(r.statusCode, email).toBe(200);
      return r.json().token as string;
    };
    const loginId = async (tenantId: string, id: string) => {
      const r = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId, loginId: id, password: PASSWORD } });
      expect(r.statusCode, id).toBe(200);
      return r.json().token as string;
    };
    tokens.admin = await loginEmail("admin-a@example.com");
    tokens.super = await loginEmail("super@example.com");
    tokens.org = await loginEmail("orgadmin@example.com");
    tokens.teacher = await loginId(ctx.ids.tenantA, "TC-0001");
    tokens.teacherB = await loginId(ctx.ids.tenantB, "TC-0001");
    tokens.parent = await loginId(ctx.ids.tenantA, "PT-0001");
    tokens.staff = await loginEmail("staff-g@example.com");

    const l = await call("POST", "admin", `/v1/tenants/${A()}/learners`, { admission_no: "GA-1", full_name: "Guardian Access One", gender: "female" });
    expect(l.statusCode).toBe(201);
    learnerId = l.json().learner.id;
    const g = await call("POST", "admin", `/v1/tenants/${A()}/guardians`, {
      full_name: "Mama Access",
      phone: "0711000222",
      email: "mama.access@example.com",
      learners: [{ learner_id: learnerId, relationship: "mother" }],
    });
    expect(g.statusCode).toBe(201);
    guardianId = g.json().guardian.id;
    // Both staff hold the People area (which must imply no guardian access).
    for (const u of [ctx.ids.teacherA, staffUser]) {
      const r = await call("PUT", "admin", "/v1/rbac/staff-areas", { userId: u, areas: ["people"] });
      expect(r.statusCode).toBe(200);
    }
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  const A = () => ctx.ids.tenantA;
  const call = (method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH", who: string, url: string, body?: unknown, tenant = A()) =>
    ctx.app.inject({ method, url, headers: { authorization: `Bearer ${tokens[who]}`, "x-tenant-id": tenant }, payload: body as never });
  const grant = (who: string, userId: string, codes: string[], tenant = A()) =>
    call("POST", who, "/v1/rbac/guardian-access", { userId, permissionCodes: codes }, tenant);
  const revoke = (who: string, userId: string, codes?: string[], tenant = A()) =>
    call("DELETE", who, "/v1/rbac/guardian-access", { userId, ...(codes ? { permissionCodes: codes } : {}) }, tenant);
  const listGuardians = (who: string) => call("GET", who, `/v1/tenants/${A()}/guardians`);
  const makeGuardian = (who: string, name: string) =>
    call("POST", who, `/v1/tenants/${A()}/guardians`, {
      full_name: name,
      phone: "0711000333",
      email: `${name.replace(/\s+/g, ".").toLowerCase()}@example.com`,
      learners: [{ learner_id: learnerId, relationship: "father" }],
    });

  async function active(userId: string): Promise<string[]> {
    const r = await ctx.pool.query<{ permission_code: string }>(
      `SELECT permission_code FROM staff_resource_grants WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL ORDER BY 1`,
      [A(), userId],
    );
    return r.rows.map((x) => x.permission_code);
  }
  async function clear() {
    await ctx.pool.query(`DELETE FROM staff_resource_grants`);
  }
  async function lastEvent(type: string, actor: string) {
    const r = await ctx.pool.query<{ detail: Record<string, any> }>(
      `SELECT detail FROM security_audit_events WHERE event_type = $1 AND actor_user_id = $2 ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [type, actor],
    );
    return r.rows[0]?.detail;
  }

  it("baseline: the People area alone gives no guardian access", async () => {
    await clear();
    expect((await listGuardians("teacher")).statusCode).toBe(403);
    expect((await makeGuardian("staff", "No Access One")).statusCode).toBe(403);
  });

  it("read-only grant: can read guardians, cannot write; write is independent", async () => {
    await clear();
    const g = await grant("admin", ctx.ids.teacherA, ["resource.guardian.read"]);
    expect(g.statusCode).toBe(200);
    expect(g.json().granted).toEqual(["resource.guardian.read"]);
    const list = await listGuardians("teacher");
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).toContain("Mama Access");
    expect((await makeGuardian("teacher", "Read Only Try")).statusCode).toBe(403);
    expect((await call("PATCH", "teacher", `/v1/tenants/${A()}/guardians/${guardianId}`, { full_name: "Changed" })).statusCode).toBe(403);
    // The other person is unaffected: grants are per person.
    expect((await listGuardians("staff")).statusCode).toBe(403);
    const perms = await call("GET", "teacher", "/v1/rbac/permissions?limit=200");
    expect(perms.json().items).toContain("resource.guardian.read");
    expect(perms.json().items).not.toContain("resource.guardian.write");
  });

  it("write grant: can write; without read the response carries no contact details", async () => {
    await clear();
    expect((await grant("admin", staffUser, ["resource.guardian.write"])).statusCode).toBe(200);
    const created = await makeGuardian("staff", "Write Only Guardian");
    expect(created.statusCode).toBe(201);
    expect((await listGuardians("staff")).statusCode).toBe(403); // write does not imply read
    const patched = await call("PATCH", "staff", `/v1/tenants/${A()}/guardians/${guardianId}`, { full_name: "Mama Access" });
    expect(patched.statusCode).toBe(200);
    expect(JSON.stringify(patched.json())).not.toContain("0711000222");
  });

  it("duplicate grants are idempotent and audited as already active", async () => {
    await clear();
    expect((await grant("admin", ctx.ids.teacherA, ["resource.guardian.read"])).statusCode).toBe(200);
    expect((await grant("admin", ctx.ids.teacherA, ["resource.guardian.read", "resource.guardian.write"])).statusCode).toBe(200);
    expect(await active(ctx.ids.teacherA)).toEqual(["resource.guardian.read", "resource.guardian.write"]);
    const ev = await lastEvent("rbac.guardian_access.granted", ctx.ids.adminA);
    expect(ev).toMatchObject({ operation: "grant", outcome: "granted", targetUserId: ctx.ids.teacherA, grantedBy: ctx.ids.adminA });
    expect(ev!.newlyGranted).toEqual(["resource.guardian.write"]);
    expect(ev!.alreadyActive).toEqual(["resource.guardian.read"]);
  });

  it("revocation is per code, immediate, audited with the original grantor; revoking nothing is 404", async () => {
    await clear();
    await grant("admin", ctx.ids.teacherA, ["resource.guardian.read", "resource.guardian.write"]);
    expect((await revoke("admin", ctx.ids.teacherA, ["resource.guardian.write"])).statusCode).toBe(200);
    expect((await makeGuardian("teacher", "After Revoke")).statusCode).toBe(403);
    expect((await listGuardians("teacher")).statusCode).toBe(200);
    const all = await revoke("admin", ctx.ids.teacherA);
    expect(all.statusCode).toBe(200);
    expect(all.json().revoked).toEqual(["resource.guardian.read"]);
    expect((await listGuardians("teacher")).statusCode).toBe(403);
    const ev = await lastEvent("rbac.guardian_access.revoked", ctx.ids.adminA);
    expect(ev).toMatchObject({ outcome: "revoked", revokedBy: ctx.ids.adminA, targetUserId: ctx.ids.teacherA });
    expect(ev!.originalGrantors).toEqual([{ permissionCode: "resource.guardian.read", grantedBy: ctx.ids.adminA }]);
    const none = await revoke("admin", ctx.ids.teacherA);
    expect(none.statusCode).toBe(404);
    expect((await lastEvent("rbac.guardian_access.denied", ctx.ids.adminA))?.reason).toBe("no_active_grant");
  });

  it("only a school administrator (or super admin) may grant or revoke; org admins and staff cannot, even with delegations", async () => {
    await clear();
    expect((await grant("teacher", staffUser, ["resource.guardian.read"])).statusCode).toBe(403);
    expect((await grant("parent", staffUser, ["resource.guardian.read"])).statusCode).toBe(403);
    expect((await grant("org", staffUser, ["resource.guardian.read"])).statusCode).toBe(403);
    // A delegated rbac.staff_areas.manage does not reach this permission.
    // (area.people can no longer be granted by delegation, owner decision 2026-11-17; an existing one is seeded.)
    const deleg = await call("POST", "admin", "/v1/rbac/org-delegations", { delegateUserId: ctx.ids.orgAdmin, permissionCodes: ["rbac.staff_areas.manage"] });
    expect(deleg.statusCode).toBe(200);
    await ctx.pool.query(`ALTER TABLE org_admin_school_delegations DISABLE TRIGGER org_admin_school_delegations_guard`);
    try {
      await ctx.pool.query(
        `INSERT INTO org_admin_school_delegations (organization_id, tenant_id, delegate_user_id, permission_code, granted_by)
         VALUES ($1, $2, $3, 'area.people', $4) ON CONFLICT DO NOTHING`,
        [ctx.ids.orgA, ctx.ids.tenantA, ctx.ids.orgAdmin, ctx.ids.adminA],
      );
    } finally {
      await ctx.pool.query(`ALTER TABLE org_admin_school_delegations ENABLE TRIGGER org_admin_school_delegations_guard`);
    }
    expect((await grant("org", staffUser, ["resource.guardian.read"])).statusCode).toBe(403);
    expect((await call("GET", "teacher", `/v1/rbac/guardian-access?userId=${staffUser}`)).statusCode).toBe(403);
    expect(await active(staffUser)).toEqual([]);
    expect((await grant("super", staffUser, ["resource.guardian.read"])).statusCode).toBe(200);
    await clear();
    await ctx.pool.query(`DELETE FROM org_admin_school_delegations`);
  });

  it("the grant request itself is validated (codes, shape, extra fields)", async () => {
    expect((await grant("admin", staffUser, ["resource.guardian.delete"])).statusCode).toBe(400);
    expect((await grant("admin", staffUser, [])).statusCode).toBe(400);
    expect((await grant("admin", staffUser, ["resource.learner.read"])).statusCode).toBe(400);
    expect((await call("POST", "admin", "/v1/rbac/guardian-access", { userId: "nope", permissionCodes: ["resource.guardian.read"] })).statusCode).toBe(400);
    expect((await call("POST", "admin", "/v1/rbac/guardian-access", { userId: staffUser, permissionCodes: ["resource.guardian.read"], extra: 1 })).statusCode).toBe(400);
  });

  it("ineligible grantees are refused and audited: parent, other school, disabled user, unknown user", async () => {
    await clear();
    const parent = await ctx.pool.query<{ user_id: string }>(`SELECT user_id FROM school_memberships WHERE tenant_id = $1 AND role = 'parent' LIMIT 1`, [A()]);
    const r1 = await grant("admin", parent.rows[0]!.user_id, ["resource.guardian.read"]);
    expect(r1.statusCode).toBe(400);
    expect((await lastEvent("rbac.guardian_access.denied", ctx.ids.adminA))?.reason).toBe("grantee_not_eligible");
    expect((await grant("admin", ctx.ids.teacherB, ["resource.guardian.read"])).statusCode).toBe(400);
    expect((await grant("admin", randomUUID(), ["resource.guardian.read"])).statusCode).toBe(400);
    await ctx.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [staffUser]);
    try {
      const r2 = await grant("admin", staffUser, ["resource.guardian.read"]);
      expect(r2.statusCode).toBe(400);
      expect((await lastEvent("rbac.guardian_access.denied", ctx.ids.adminA))?.reason).toBe("grantee_not_active");
      // A disabled user's own session stops working, grants or not.
      expect((await call("GET", "staff", "/v1/auth/me")).statusCode).toBe(401);
    } finally {
      await ctx.pool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [staffUser]);
    }
    expect(await active(staffUser)).toEqual([]);
  });

  it("school and tenant isolation: a grant never crosses schools", async () => {
    await clear();
    await grant("admin", ctx.ids.teacherA, ["resource.guardian.read", "resource.guardian.write"]);
    // The administrator of school A has no authority in school B.
    expect((await grant("admin", ctx.ids.teacherB, ["resource.guardian.read"], ctx.ids.tenantB)).statusCode).toBe(403);
    // The grantee holds nothing in school B (no membership there) and cannot name it.
    const asB = await call("GET", "teacher", `/v1/tenants/${ctx.ids.tenantB}/guardians`, undefined, ctx.ids.tenantB);
    expect(asB.statusCode).toBe(403);
    // A school B teacher with no grant gets nothing in B either.
    expect((await call("GET", "teacherB", `/v1/tenants/${ctx.ids.tenantB}/guardians`, undefined, ctx.ids.tenantB)).statusCode).toBe(403);
    // Reading school B's guardian through school A's path is refused.
    const bLearner = await call("POST", "super", `/v1/tenants/${ctx.ids.tenantB}/learners`, { admission_no: "GB-1", full_name: "Other School Learner", gender: "male" }, ctx.ids.tenantB);
    expect(bLearner.statusCode, JSON.stringify(bLearner.json())).toBe(201);
    const bGuardian = await call(
      "POST",
      "super",
      `/v1/tenants/${ctx.ids.tenantB}/guardians`,
      { full_name: "Mama Other School", phone: "0711000444", learners: [{ learner_id: bLearner.json().learner.id, relationship: "mother" }] },
      ctx.ids.tenantB,
    );
    expect(bGuardian.statusCode, JSON.stringify(bGuardian.json())).toBe(201);
    const cross = await call("GET", "teacher", `/v1/tenants/${A()}/guardians/${bGuardian.json().guardian.id}`);
    expect([403, 404]).toContain(cross.statusCode);
    const rows = await ctx.pool.query(`SELECT DISTINCT tenant_id FROM staff_resource_grants`);
    expect(rows.rows.map((r) => r.tenant_id)).toEqual([A()]);
  });

  it("archiving the membership revokes the grants; restoring it does not revive them", async () => {
    await clear();
    await grant("admin", staffUser, ["resource.guardian.read", "resource.guardian.write"]);
    expect((await listGuardians("staff")).statusCode).toBe(200);
    await ctx.pool.query(`UPDATE school_memberships SET archived_at = now() WHERE user_id = $1 AND tenant_id = $2`, [staffUser, A()]);
    expect(await active(staffUser)).toEqual([]);
    // The archive was done out of band (no app.user_id), so the actor is NULL and the person is in detail.
    const evRow = await ctx.pool.query<{ actor_user_id: string | null; detail: Record<string, any> }>(
      `SELECT actor_user_id, detail FROM security_audit_events
        WHERE event_type = 'rbac.guardian_access.revoked' AND detail->>'targetUserId' = $1
        ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [staffUser],
    );
    expect(evRow.rows[0]!.actor_user_id).toBeNull();
    expect(evRow.rows[0]!.detail).toMatchObject({ reason: "membership_archived", targetUserId: staffUser });
    await ctx.pool.query(`UPDATE school_memberships SET archived_at = NULL WHERE user_id = $1 AND tenant_id = $2`, [staffUser, A()]);
    expect(await active(staffUser)).toEqual([]);
    expect((await listGuardians("staff")).statusCode).toBe(403);
    // Archived members cannot be granted while archived.
    await ctx.pool.query(`UPDATE school_memberships SET archived_at = now() WHERE user_id = $1 AND tenant_id = $2`, [staffUser, A()]);
    expect((await grant("admin", staffUser, ["resource.guardian.read"])).statusCode).toBe(400);
    await ctx.pool.query(`UPDATE school_memberships SET archived_at = NULL WHERE user_id = $1 AND tenant_id = $2`, [staffUser, A()]);
  });

  it("a role change or a deleted membership also revokes the grants, so recreating cannot revive them", async () => {
    await clear();
    await grant("admin", staffUser, ["resource.guardian.read"]);
    await ctx.pool.query(`UPDATE school_memberships SET role = 'parent' WHERE user_id = $1 AND tenant_id = $2`, [staffUser, A()]);
    await ctx.pool.query(`UPDATE school_memberships SET role = 'staff' WHERE user_id = $1 AND tenant_id = $2`, [staffUser, A()]);
    expect(await active(staffUser)).toEqual([]);
    expect((await listGuardians("staff")).statusCode).toBe(403);
    await grant("admin", staffUser, ["resource.guardian.write"]);
    const m = await ctx.pool.query(`DELETE FROM school_memberships WHERE user_id = $1 AND tenant_id = $2 RETURNING login_id`, [staffUser, A()]);
    expect(await active(staffUser)).toEqual([]);
    await ctx.pool.query(
      `INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'staff', $3)`,
      [staffUser, A(), m.rows[0].login_id],
    );
    expect(await active(staffUser)).toEqual([]);
  });

  it("the runtime role cannot rewrite a grant: only the revocation columns are updatable, and revocation is final", async () => {
    await clear();
    await grant("admin", staffUser, ["resource.guardian.read"]);
    await revoke("admin", staffUser);
    const c = await ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.user_id', $1, true), set_config('app.tenant_id', $2, true)`, [ctx.ids.adminA, A()]);
      await expect(c.query(`UPDATE staff_resource_grants SET user_id = $1`, [ctx.ids.parentA])).rejects.toThrow(/permission denied/i);
      await c.query("ROLLBACK");
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.user_id', $1, true), set_config('app.tenant_id', $2, true)`, [ctx.ids.adminA, A()]);
      await expect(c.query(`UPDATE staff_resource_grants SET revoked_at = NULL`)).rejects.toThrow(/revocation_is_final/);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
    await expect(ctx.pool.query(`UPDATE staff_resource_grants SET permission_code = 'resource.guardian.write'`)).rejects.toThrow(/grant_immutable/);
    expect(await active(staffUser)).toEqual([]);
  });

  it("the list endpoint shows exactly one person's active grants", async () => {
    await clear();
    await grant("admin", staffUser, ["resource.guardian.write"]);
    const res = await call("GET", "admin", `/v1/rbac/guardian-access?userId=${staffUser}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { permissionCode: string }) => i.permissionCode)).toEqual(["resource.guardian.write"]);
    expect((await call("GET", "admin", "/v1/rbac/guardian-access")).statusCode).toBe(400);
    expect((await call("GET", "admin", `/v1/rbac/guardian-access?userId=${ctx.ids.teacherA}`)).json().items).toEqual([]);
  });

  it("concurrent grants and revokes never 500 and leave at most one active row per code", async () => {
    await clear();
    const results = await Promise.all(
      Array.from({ length: 14 }, (_, i) =>
        i % 3 === 2 ? revoke("admin", staffUser) : grant("admin", staffUser, ["resource.guardian.read", "resource.guardian.write"]),
      ),
    );
    for (const r of results) expect([200, 404], JSON.stringify(r.json())).toContain(r.statusCode);
    const dup = await ctx.pool.query(
      `SELECT permission_code FROM staff_resource_grants WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL GROUP BY 1 HAVING count(*) > 1`,
      [A(), staffUser],
    );
    expect(dup.rowCount).toBe(0);
  });

  it("the database refuses what the API would: ineligible grantee and a code outside the two", async () => {
    await expect(
      ctx.pool.query(
        `INSERT INTO staff_resource_grants (tenant_id, user_id, permission_code, granted_by) VALUES ($1, $2, 'resource.guardian.read', $3)`,
        [A(), ctx.ids.parentA, ctx.ids.adminA],
      ),
    ).rejects.toThrow(/grantee_not_eligible/);
    await expect(
      ctx.pool.query(
        `INSERT INTO staff_resource_grants (tenant_id, user_id, permission_code, granted_by) VALUES ($1, $2, 'resource.learner.write', $3)`,
        [A(), staffUser, ctx.ids.adminA],
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
