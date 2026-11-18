import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";
import { hasPermission, type AuthzContext } from "../src/modules/rbac/authorize.js";

/**
 * FIG-1614 owner decision (Option D, nine requirements): suspension, school-wide scope and the
 * loader's own behaviour. The remaining requirements are covered in fig1614.guardianAccess.test.ts.
 * Real HTTP application, real figbloom_app runtime login.
 */
describe("FIG-1614 owner decision: suspension and school-wide scope", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const PASSWORD = "correct-horse-battery";
  const tokens: Record<string, string> = {};
  let learner1 = "";
  let learner2 = "";

  const A = () => ctx.ids.tenantA;
  const call = (method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH", who: string, url: string, body?: unknown, tenant = A()) =>
    ctx.app.inject({ method, url, headers: { authorization: `Bearer ${tokens[who]}`, "x-tenant-id": tenant }, payload: body as never });
  const grant = (who: string, userId: string, codes: string[]) =>
    call("POST", who, "/v1/rbac/guardian-access", { userId, permissionCodes: codes });
  const revoke = (who: string, userId: string, codes?: string[]) =>
    call("DELETE", who, "/v1/rbac/guardian-access", { userId, ...(codes ? { permissionCodes: codes } : {}) });
  const setStatus = (status: "active" | "suspended") =>
    ctx.pool.query(`UPDATE tenants SET status = $2 WHERE id = $1`, [A(), status]);
  const active = async (userId: string) =>
    (
      await ctx.pool.query<{ permission_code: string }>(
        `SELECT permission_code FROM staff_resource_grants WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL ORDER BY 1`,
        [A(), userId],
      )
    ).rows.map((r) => r.permission_code);

  beforeAll(async () => {
    ctx = await createTestApp();
    const login = async (path: string, payload: unknown) => {
      const r = await ctx.app.inject({ method: "POST", url: path, payload: payload as never });
      expect(r.statusCode).toBe(200);
      return r.json().token as string;
    };
    tokens.admin = await login("/v1/auth/login/email", { email: "admin-a@example.com", password: PASSWORD });
    tokens.super = await login("/v1/auth/login/email", { email: "super@example.com", password: PASSWORD });
    tokens.teacher = await login("/v1/auth/login/login-id", { tenantId: A(), loginId: "TC-0001", password: PASSWORD });

    const mk = async (adm: string, name: string, phone: string) => {
      const l = await call("POST", "admin", `/v1/tenants/${A()}/learners`, { admission_no: adm, full_name: name, gender: "male" });
      expect(l.statusCode).toBe(201);
      const lid = l.json().learner.id as string;
      const g = await call("POST", "admin", `/v1/tenants/${A()}/guardians`, {
        full_name: `Guardian of ${name}`,
        phone,
        email: `${adm.toLowerCase()}@example.com`,
        learners: [{ learner_id: lid, relationship: "mother" }],
      });
      expect(g.statusCode).toBe(201);
      return lid;
    };
    learner1 = await mk("OP-1", "Owner Policy One", "0711000501");
    learner2 = await mk("OP-2", "Owner Policy Two", "0711000502");
  }, 120_000);

  afterAll(async () => {
    await setStatus("active");
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("a grant is school-wide for the person: it is not tied to any one learner", async () => {
    await ctx.pool.query(`DELETE FROM staff_resource_grants`);
    expect((await call("GET", "teacher", `/v1/tenants/${A()}/guardians`)).statusCode).toBe(403);
    expect((await grant("admin", ctx.ids.teacherA, ["resource.guardian.read"])).statusCode).toBe(200);
    const list = await call("GET", "teacher", `/v1/tenants/${A()}/guardians`);
    expect(list.statusCode).toBe(200);
    const text = JSON.stringify(list.json());
    // Guardians of two unrelated learners are both visible; the API has no learner-scoped variant.
    expect(text).toContain("Guardian of Owner Policy One");
    expect(text).toContain("Guardian of Owner Policy Two");
    expect(learner1).not.toBe(learner2);
    // ... and nothing outside the school: the other school's data is out of reach.
    const other = await call("GET", "teacher", `/v1/tenants/${ctx.ids.tenantB}/guardians`, undefined, ctx.ids.tenantB);
    expect(other.statusCode).toBe(403);
  });

  it("a suspended school exercises no explicit grant, even on a session opened before suspension; restoration resumes an unrevoked grant", async () => {
    await ctx.pool.query(`DELETE FROM staff_resource_grants`);
    expect((await grant("admin", ctx.ids.teacherA, ["resource.guardian.read"])).statusCode).toBe(200);
    expect((await call("GET", "teacher", `/v1/tenants/${A()}/guardians`)).statusCode).toBe(200); // control
    await setStatus("suspended");
    try {
      const blocked = await call("GET", "teacher", `/v1/tenants/${A()}/guardians`);
      expect(blocked.statusCode).toBe(403);
      // The grant is untouched on record (suspension is not a revocation) ...
      expect(await active(ctx.ids.teacherA)).toEqual(["resource.guardian.read"]);
    } finally {
      await setStatus("active");
    }
    // ... so access resumes on the next request once the school is restored.
    expect((await call("GET", "teacher", `/v1/tenants/${A()}/guardians`)).statusCode).toBe(200);
  });

  it("the grant loader refuses a suspended school on its own (the upstream membership gate is not the only barrier)", async () => {
    await ctx.pool.query(`DELETE FROM staff_resource_grants`);
    expect((await grant("admin", ctx.ids.teacherA, ["resource.guardian.read"])).statusCode).toBe(200);
    // A context that claims the school is active, exactly what a gate bug would let through.
    const forged: AuthzContext = {
      userId: ctx.ids.teacherA,
      role: "teacher",
      tenantId: A(),
      membership: {
        id: randomUUID(),
        user_id: ctx.ids.teacherA,
        tenant_id: A(),
        role: "teacher",
        login_id: "TC-0001",
        tenant_status: "active",
        organization_id: ctx.ids.orgA,
      },
      isSuperAdmin: false,
      isOrgAdminForTenant: false,
    };
    const probe = async () => {
      const c = await ctx.runtimePool.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.ids.teacherA]);
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [A()]);
        return await hasPermission(c as never, forged, "resource.guardian.read");
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    };
    expect(await probe()).toBe(true); // control: active school
    await setStatus("suspended");
    try {
      expect(await probe()).toBe(false);
    } finally {
      await setStatus("active");
    }
    expect(await probe()).toBe(true);
  });

  it("a revocation made during suspension is permanent: restoration does not bring the grant back", async () => {
    await ctx.pool.query(`DELETE FROM staff_resource_grants`);
    expect((await grant("admin", ctx.ids.teacherA, ["resource.guardian.read"])).statusCode).toBe(200);
    await setStatus("suspended");
    try {
      // The school's own administrator is locked out by the general suspended-school gate.
      expect((await revoke("admin", ctx.ids.teacherA)).statusCode).toBe(403);
      // A platform super administrator may still revoke (revocation only reduces access).
      const r = await revoke("super", ctx.ids.teacherA);
      expect(r.statusCode).toBe(200);
      expect(r.json().revoked).toEqual(["resource.guardian.read"]);
    } finally {
      await setStatus("active");
    }
    expect(await active(ctx.ids.teacherA)).toEqual([]);
    expect((await call("GET", "teacher", `/v1/tenants/${A()}/guardians`)).statusCode).toBe(403);
    const ev = await ctx.pool.query(
      `SELECT detail FROM security_audit_events WHERE event_type = 'rbac.guardian_access.revoked' ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    );
    expect(ev.rows[0].detail).toMatchObject({ outcome: "revoked", targetUserId: ctx.ids.teacherA });
    expect(ev.rows[0].detail.originalGrantors).toEqual([
      { permissionCode: "resource.guardian.read", grantedBy: ctx.ids.adminA },
    ]);
  });

  it("no one may GRANT guardian access on a suspended school, a super administrator included; refusals are audited", async () => {
    await ctx.pool.query(`DELETE FROM staff_resource_grants`);
    // Positive control: an active school accepts the grant.
    expect((await grant("admin", ctx.ids.teacherA, ["resource.guardian.read"])).statusCode).toBe(200);
    await ctx.pool.query(`DELETE FROM staff_resource_grants`);
    await setStatus("suspended");
    try {
      const byAdmin = await grant("admin", ctx.ids.teacherA, ["resource.guardian.read"]);
      expect(byAdmin.statusCode).toBe(403); // locked out by the general suspended-school gate
      const bySuper = await grant("super", ctx.ids.teacherA, ["resource.guardian.write"]);
      expect(bySuper.statusCode).toBe(403);
      expect(bySuper.json().error.message).toMatch(/suspended/i);
    } finally {
      await setStatus("active");
    }
    expect(await active(ctx.ids.teacherA)).toEqual([]); // nothing was written
    const ev = await ctx.pool.query(
      `SELECT detail FROM security_audit_events WHERE event_type = 'rbac.guardian_access.denied' AND actor_user_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [ctx.ids.superAdmin],
    );
    expect(ev.rows[0].detail).toMatchObject({ operation: "grant", reason: "school_suspended", targetUserId: ctx.ids.teacherA });
    // After restoration a new grant is accepted (and audited as a new grant).
    expect((await grant("admin", ctx.ids.teacherA, ["resource.guardian.read"])).statusCode).toBe(200);
  });
});
