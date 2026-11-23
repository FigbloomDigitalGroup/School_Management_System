import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";
import { hashPassword } from "../src/modules/identity/password.js";

/**
 * Owner decision 2026-11-17, delegation lifecycle (FIG-1609 / FIG-1614, migration 026):
 * a material change to the authorization relationship INVALIDATES the grants (final, audited);
 * restoring the user, the membership or the organization never revives them; school SUSPENSION
 * stays temporary. Also: area.people is no longer grantable by delegation.
 * Real HTTP application, real triggers, real figbloom_app runtime login.
 */
describe("delegation lifecycle: invalidation, no resurrection, school suspension unchanged", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const PASSWORD = "correct-horse-battery";
  const tokens: Record<string, string> = {};
  let oa2 = ""; // org admin of org A (delegate)
  let dual = ""; // org admin of org A AND a staff member of school A
  let staffOnly = ""; // staff member of school A, holds a guardian grant
  let spare = ""; // an unused user (membership transfer target)

  const A = () => ctx.ids.tenantA;
  const login = async (path: string, payload: unknown) => {
    const r = await ctx.app.inject({ method: "POST", url: path, payload: payload as never });
    expect(r.statusCode).toBe(200);
    return r.json().token as string;
  };
  const call = (method: "GET" | "POST" | "DELETE", who: string, url: string, body?: unknown) =>
    ctx.app.inject({ method, url, headers: { authorization: `Bearer ${tokens[who]}`, "x-tenant-id": A() }, payload: body as never });
  const grantDeleg = (userId: string, codes: string[]) =>
    call("POST", "admin", "/v1/rbac/org-delegations", { delegateUserId: userId, permissionCodes: codes });
  const grantGuardian = (userId: string, codes: string[]) =>
    call("POST", "admin", "/v1/rbac/guardian-access", { userId, permissionCodes: codes });
  const reads = (who: string) => call("GET", who, `/v1/tenants/${A()}`);

  const delegations = async (userId: string) =>
    (
      await ctx.pool.query<{ permission_code: string; revoked_at: Date | null; revoke_reason: string | null; revoked_by: string | null }>(
        `SELECT permission_code, revoked_at, revoke_reason, revoked_by FROM org_admin_school_delegations
          WHERE tenant_id = $1 AND delegate_user_id = $2 ORDER BY permission_code`,
        [A(), userId],
      )
    ).rows;
  const activeDeleg = async (userId: string) => (await delegations(userId)).filter((r) => !r.revoked_at).map((r) => r.permission_code);
  const activeGuardian = async (userId: string) =>
    (
      await ctx.pool.query<{ permission_code: string }>(
        `SELECT permission_code FROM staff_resource_grants WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL ORDER BY 1`,
        [A(), userId],
      )
    ).rows.map((r) => r.permission_code);
  const events = async (type: string, since: string, filter: string, arg: string) =>
    (
      await ctx.pool.query<{ detail: Record<string, any>; tenant_id: string | null }>(
        `SELECT detail, tenant_id FROM security_audit_events
          WHERE event_type = $1 AND occurred_at >= $2::timestamptz AND detail->>'${filter}' = $3 ORDER BY occurred_at, id`,
        [type, since, arg],
      )
    ).rows;
  const now = async () => (await ctx.pool.query<{ t: string }>(`SELECT clock_timestamp()::text AS t`)).rows[0]!.t;
  const resetGrants = async () => {
    await ctx.pool.query(`DELETE FROM org_admin_school_delegations WHERE tenant_id = $1`, [A()]);
    await ctx.pool.query(`DELETE FROM staff_resource_grants WHERE tenant_id = $1`, [A()]);
  };
  const ensureOrgMembership = (user: string, org = ctx.ids.orgA) =>
    ctx.pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role) VALUES ($1, $2, 'org_admin') ON CONFLICT DO NOTHING`,
      [user, org],
    );

  beforeAll(async () => {
    ctx = await createTestApp();
    const hash = await hashPassword(PASSWORD);
    const mk = async (email: string | null, name: string) => {
      const id = randomUUID();
      await ctx.pool.query(
        `INSERT INTO users (id, email, password_hash, full_name, status) VALUES ($1, $2, $3, $4, 'active')`,
        [id, email, hash, name],
      );
      return id;
    };
    oa2 = await mk("lifecycle-oa2@example.com", "Lifecycle OA2");
    dual = await mk("lifecycle-dual@example.com", "Lifecycle Dual");
    staffOnly = await mk(null, "Lifecycle Staff");
    spare = await mk("lifecycle-spare@example.com", "Lifecycle Spare");
    await ensureOrgMembership(oa2);
    await ensureOrgMembership(dual);
    await ensureOrgMembership(spare);
    await ctx.pool.query(
      `INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $3, 'staff', 'SF-0077'), ($2, $3, 'staff', 'SF-0078')`,
      [dual, staffOnly, A()],
    );
    tokens.admin = await login("/v1/auth/login/email", { email: "admin-a@example.com", password: PASSWORD });
    tokens.super = await login("/v1/auth/login/email", { email: "super@example.com", password: PASSWORD });
    tokens.oa2 = await login("/v1/auth/login/email", { email: "lifecycle-oa2@example.com", password: PASSWORD });
    tokens.staff = await login("/v1/auth/login/login-id", { tenantId: A(), loginId: "SF-0078", password: PASSWORD });
  }, 120_000);

  afterAll(async () => {
    await ctx.pool.query(`UPDATE organizations SET status = 'active' WHERE id = $1`, [ctx.ids.orgA]);
    await ctx.pool.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [A()]);
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("removing the organization membership revokes the delegations; re-creating it does not revive them; a fresh grant works", async () => {
    await resetGrants();
    expect((await grantDeleg(oa2, ["tenant.read", "area.fees"])).statusCode).toBe(200);
    expect((await reads("oa2")).statusCode).toBe(200);
    const t0 = await now();
    await ctx.pool.query(`DELETE FROM organization_memberships WHERE user_id = $1 AND organization_id = $2`, [oa2, ctx.ids.orgA]);

    expect(await activeDeleg(oa2)).toEqual([]);
    const rows = await delegations(oa2);
    expect(rows).toHaveLength(2); // kept on record, never deleted
    for (const r of rows) expect(r.revoke_reason).toBe("org_membership_removed");
    // Exactly one event for the school (not one per code, not one per trigger), fully attributed.
    const ev = await events("rbac.org_delegation.revoked", t0, "delegateUserId", oa2);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.tenant_id).toBe(A());
    expect(ev[0]!.detail).toMatchObject({
      operation: "revoke",
      outcome: "invalidated",
      reason: "org_membership_removed",
      actingVia: "system",
      organizationId: ctx.ids.orgA,
      permissionCodes: ["area.fees", "tenant.read"],
    });
    expect(ev[0]!.detail.originalGrantors).toEqual([
      { permissionCode: "area.fees", grantedBy: ctx.ids.adminA },
      { permissionCode: "tenant.read", grantedBy: ctx.ids.adminA },
    ]);

    // Restoration does not revive anything.
    await ensureOrgMembership(oa2);
    expect(await activeDeleg(oa2)).toEqual([]);
    expect((await reads("oa2")).statusCode).toBe(403);
    // A fresh authorization is required, and works.
    expect((await grantDeleg(oa2, ["tenant.read"])).statusCode).toBe(200);
    expect((await reads("oa2")).statusCode).toBe(200);
    // No new event from the restoration itself.
    expect(await events("rbac.org_delegation.revoked", t0, "delegateUserId", oa2)).toHaveLength(1);
  });

  it("moving the organization membership to another organization revokes the delegations", async () => {
    await resetGrants();
    await ensureOrgMembership(oa2);
    expect((await grantDeleg(oa2, ["tenant.read"])).statusCode).toBe(200);
    const t0 = await now();
    await ctx.pool.query(`UPDATE organization_memberships SET organization_id = $2 WHERE user_id = $1 AND organization_id = $3`, [
      oa2,
      ctx.ids.orgB,
      ctx.ids.orgA,
    ]);
    try {
      expect(await activeDeleg(oa2)).toEqual([]);
      expect((await delegations(oa2))[0]!.revoke_reason).toBe("org_membership_transferred");
      expect((await reads("oa2")).statusCode).toBe(403);
      expect(await events("rbac.org_delegation.revoked", t0, "delegateUserId", oa2)).toHaveLength(1);
    } finally {
      await ctx.pool.query(`UPDATE organization_memberships SET organization_id = $2 WHERE user_id = $1 AND organization_id = $3`, [
        oa2,
        ctx.ids.orgA,
        ctx.ids.orgB,
      ]);
    }
    expect(await activeDeleg(oa2)).toEqual([]); // moving back does not revive it
  });

  it("transferring the membership record to another user revokes the first user's delegations", async () => {
    await resetGrants();
    await ensureOrgMembership(spare);
    expect((await grantDeleg(spare, ["tenant.read"])).statusCode).toBe(200);
    const mover = randomUUID();
    await ctx.pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, status) VALUES ($1, 'lifecycle-mover@example.com', 'x', 'Mover', 'active')
       ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name RETURNING id`,
      [mover],
    );
    const moverId = (await ctx.pool.query<{ id: string }>(`SELECT id FROM users WHERE email = 'lifecycle-mover@example.com'`)).rows[0]!.id;
    const t0 = await now();
    await ctx.pool.query(`UPDATE organization_memberships SET user_id = $2 WHERE user_id = $1 AND organization_id = $3`, [
      spare,
      moverId,
      ctx.ids.orgA,
    ]);
    expect(await activeDeleg(spare)).toEqual([]);
    expect((await delegations(spare))[0]!.revoke_reason).toBe("org_membership_transferred");
    expect(await events("rbac.org_delegation.revoked", t0, "delegateUserId", spare)).toHaveLength(1);
    // Restore the fixture: the membership goes back to `spare`; the delegation stays revoked.
    await ctx.pool.query(`UPDATE organization_memberships SET user_id = $1 WHERE user_id = $2 AND organization_id = $3`, [
      spare,
      moverId,
      ctx.ids.orgA,
    ]);
    expect(await activeDeleg(spare)).toEqual([]);
  });

  it("disabling a user revokes their delegations AND guardian grants; re-enabling restores neither", async () => {
    await resetGrants();
    await ensureOrgMembership(dual);
    expect((await grantDeleg(dual, ["tenant.read"])).statusCode).toBe(200);
    expect((await grantGuardian(dual, ["resource.guardian.read"])).statusCode).toBe(200);
    const t0 = await now();

    await ctx.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [dual]);
    try {
      expect(await activeDeleg(dual)).toEqual([]);
      expect(await activeGuardian(dual)).toEqual([]);
      const d = await events("rbac.org_delegation.revoked", t0, "delegateUserId", dual);
      const g = await events("rbac.guardian_access.revoked", t0, "targetUserId", dual);
      expect(d).toHaveLength(1);
      expect(g).toHaveLength(1);
      expect(d[0]!.detail).toMatchObject({ outcome: "invalidated", reason: "user_disabled", actingVia: "system" });
      expect(g[0]!.detail).toMatchObject({ outcome: "invalidated", reason: "user_disabled", permissionCodes: ["resource.guardian.read"] });
      expect(g[0]!.detail.originalGrantors).toEqual([{ permissionCode: "resource.guardian.read", grantedBy: ctx.ids.adminA }]);
      // Disabling again (no transition) adds nothing.
      await ctx.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [dual]);
      expect(await events("rbac.org_delegation.revoked", t0, "delegateUserId", dual)).toHaveLength(1);
    } finally {
      await ctx.pool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [dual]);
    }
    expect(await activeDeleg(dual)).toEqual([]);
    expect(await activeGuardian(dual)).toEqual([]);
    const dualToken = await login("/v1/auth/login/email", { email: "lifecycle-dual@example.com", password: PASSWORD });
    tokens.dual = dualToken;
    // (dual is also a school staff member, so reading the school itself proves nothing; the database state
    // above and the guardian list below do.)
    expect((await call("GET", "dual", `/v1/tenants/${A()}/guardians`)).statusCode).toBe(403);
    // Fresh authorization works.
    expect((await grantGuardian(dual, ["resource.guardian.read"])).statusCode).toBe(200);
    expect((await call("GET", "dual", `/v1/tenants/${A()}/guardians`)).statusCode).toBe(200);
  });

  it("an organization that leaves 'active' revokes every delegation in it; restoring it revives nothing; guardian grants are untouched", async () => {
    await resetGrants();
    await ensureOrgMembership(oa2);
    expect((await grantDeleg(oa2, ["tenant.read"])).statusCode).toBe(200);
    expect((await grantDeleg(dual, ["resource.learner.read"])).statusCode).toBe(200);
    expect((await grantGuardian(staffOnly, ["resource.guardian.write"])).statusCode).toBe(200);
    const t0 = await now();

    await ctx.pool.query(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [ctx.ids.orgA]);
    try {
      expect(await activeDeleg(oa2)).toEqual([]);
      expect(await activeDeleg(dual)).toEqual([]);
      for (const u of [oa2, dual]) {
        const ev = await events("rbac.org_delegation.revoked", t0, "delegateUserId", u);
        expect(ev, u).toHaveLength(1);
        expect(ev[0]!.detail).toMatchObject({ outcome: "invalidated", reason: "organization_inactive", organizationId: ctx.ids.orgA });
      }
      // Guardian grants hang on the school membership, not on the organization's status.
      expect(await activeGuardian(staffOnly)).toEqual(["resource.guardian.write"]);
    } finally {
      await ctx.pool.query(`UPDATE organizations SET status = 'active' WHERE id = $1`, [ctx.ids.orgA]);
    }
    expect(await activeDeleg(oa2)).toEqual([]);
    expect(await activeDeleg(dual)).toEqual([]);
    expect((await reads("oa2")).statusCode).toBe(403);
    expect((await grantDeleg(oa2, ["tenant.read"])).statusCode).toBe(200); // a fresh grant is accepted
    expect((await reads("oa2")).statusCode).toBe(200);
  });

  it("moving a school membership to another school revokes the guardian grants it carried", async () => {
    await resetGrants();
    expect((await grantGuardian(staffOnly, ["resource.guardian.read"])).statusCode).toBe(200);
    const t0 = await now();
    await ctx.pool.query(`UPDATE school_memberships SET tenant_id = $2, login_id = 'SF-0090' WHERE user_id = $1 AND tenant_id = $3`, [
      staffOnly,
      ctx.ids.tenantB,
      A(),
    ]);
    try {
      expect(await activeGuardian(staffOnly)).toEqual([]);
      const ev = await events("rbac.guardian_access.revoked", t0, "targetUserId", staffOnly);
      expect(ev).toHaveLength(1);
      expect(ev[0]!.tenant_id).toBe(A()); // scoped to the school the grant belonged to
      expect(ev[0]!.detail).toMatchObject({ reason: "membership_transferred" });
    } finally {
      await ctx.pool.query(`UPDATE school_memberships SET tenant_id = $3, login_id = 'SF-0078' WHERE user_id = $1 AND tenant_id = $2`, [
        staffOnly,
        ctx.ids.tenantB,
        A(),
      ]);
    }
    expect(await activeGuardian(staffOnly)).toEqual([]); // moving back does not revive it
  });

  it("school SUSPENSION stays temporary: nothing is revoked, nothing is exercised, restoration resumes the unrevoked grants", async () => {
    await resetGrants();
    await ensureOrgMembership(oa2);
    expect((await grantDeleg(oa2, ["tenant.read"])).statusCode).toBe(200);
    expect((await grantGuardian(staffOnly, ["resource.guardian.read"])).statusCode).toBe(200);
    expect((await reads("oa2")).statusCode).toBe(200);
    await ctx.pool.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [A()]);
    try {
      expect((await reads("oa2")).statusCode).toBe(403);
      expect((await call("GET", "staff", `/v1/tenants/${A()}/guardians`)).statusCode).toBe(403);
      // Still on record, still active: suspension is not an invalidation.
      expect(await activeDeleg(oa2)).toEqual(["tenant.read"]);
      expect(await activeGuardian(staffOnly)).toEqual(["resource.guardian.read"]);
      expect((await delegations(oa2))[0]!.revoke_reason).toBeNull();
    } finally {
      await ctx.pool.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [A()]);
    }
    expect((await reads("oa2")).statusCode).toBe(200);
    expect((await call("GET", "staff", `/v1/tenants/${A()}/guardians`)).statusCode).toBe(200);
  });

  it("dormant grants already present are revoked once by the migration sweep, audited, and the migration is repeatable", async () => {
    await resetGrants();
    await ensureOrgMembership(spare);
    expect((await grantDeleg(spare, ["tenant.read"])).statusCode).toBe(200);
    expect((await grantGuardian(staffOnly, ["resource.guardian.read"])).statusCode).toBe(200);
    // Manufacture the pre-026 state: dormant grants (user disabled, membership gone) with the
    // lifecycle triggers out of the way, exactly as such rows existed before this migration.
    await ctx.pool.query(`ALTER TABLE users DISABLE TRIGGER users_status_invalidates_grants`);
    await ctx.pool.query(`ALTER TABLE organization_memberships DISABLE TRIGGER org_membership_delete_invalidates_delegations`);
    try {
      await ctx.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [staffOnly]);
      await ctx.pool.query(`DELETE FROM organization_memberships WHERE user_id = $1 AND organization_id = $2`, [spare, ctx.ids.orgA]);
    } finally {
      await ctx.pool.query(`ALTER TABLE users ENABLE TRIGGER users_status_invalidates_grants`);
      await ctx.pool.query(`ALTER TABLE organization_memberships ENABLE TRIGGER org_membership_delete_invalidates_delegations`);
    }
    expect(await activeDeleg(spare)).toEqual(["tenant.read"]); // dormant, not yet revoked
    expect(await activeGuardian(staffOnly)).toEqual(["resource.guardian.read"]);

    const sql = readFileSync(join(process.cwd(), "migrations", "026_delegation_lifecycle.sql"), "utf8");
    const t0 = await now();
    await ctx.pool.query(sql); // re-run the whole migration file: it must be repeatable
    expect(await activeDeleg(spare)).toEqual([]);
    expect(await activeGuardian(staffOnly)).toEqual([]);
    expect((await delegations(spare))[0]!.revoke_reason).toBe("invalidated_at_migration");
    expect(await events("rbac.org_delegation.revoked", t0, "delegateUserId", spare)).toHaveLength(1);
    expect(await events("rbac.guardian_access.revoked", t0, "targetUserId", staffOnly)).toHaveLength(1);

    const t1 = await now();
    await ctx.pool.query(sql); // second re-run: nothing more to do, nothing more recorded
    expect(await events("rbac.org_delegation.revoked", t1, "delegateUserId", spare)).toHaveLength(0);
    expect(await events("rbac.guardian_access.revoked", t1, "targetUserId", staffOnly)).toHaveLength(0);

    await ctx.pool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [staffOnly]);
    await ensureOrgMembership(spare);
    expect(await activeDeleg(spare)).toEqual([]); // restoration revives nothing
    expect(await activeGuardian(staffOnly)).toEqual([]);
  });

  it("the runtime role cannot record an unattributed revocation or write the system reason", async () => {
    await resetGrants();
    await ensureOrgMembership(oa2);
    expect((await grantDeleg(oa2, ["tenant.read"])).statusCode).toBe(200);
    const attempt = async (sql: string) => {
      const c = await ctx.runtimePool.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.ids.adminA]);
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [A()]);
        await c.query(sql, [oa2, A()]);
        return "accepted";
      } catch (e) {
        return (e as Error).message;
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    };
    // A revocation with a date but no acting administrator and no reason is refused...
    expect(await attempt(`UPDATE org_admin_school_delegations SET revoked_at = now() WHERE delegate_user_id = $1 AND tenant_id = $2`)).toMatch(
      /revocation_incomplete/,
    );
    // ... and the application role has no privilege to supply the system reason itself.
    expect(
      await attempt(`UPDATE org_admin_school_delegations SET revoked_at = now(), revoke_reason = 'user_disabled' WHERE delegate_user_id = $1 AND tenant_id = $2`),
    ).toMatch(/permission denied/i);
    expect(await activeDeleg(oa2)).toEqual(["tenant.read"]);
  });

  describe("area.people is not grantable by delegation (owner decision 2026-11-17)", () => {
    it("a new area.people delegation is refused by the API (400) and by the database; other areas still work", async () => {
      await resetGrants();
      await ensureOrgMembership(oa2);
      const res = await grantDeleg(oa2, ["area.people"]);
      expect(res.statusCode).toBe(400);
      expect(await activeDeleg(oa2)).toEqual([]);
      await expect(
        ctx.pool.query(
          `INSERT INTO org_admin_school_delegations (organization_id, tenant_id, delegate_user_id, permission_code, granted_by) VALUES ($1, $2, $3, 'area.people', $4)`,
          [ctx.ids.orgA, A(), oa2, ctx.ids.adminA],
        ),
      ).rejects.toThrow(/permission_not_delegable/);
      expect((await grantDeleg(oa2, ["area.fees", "area.attendance"])).statusCode).toBe(200);
    });

    it("an EXISTING area.people delegation is not silently revoked: it keeps its effect, stays revocable, and is recorded once for review", async () => {
      await resetGrants();
      await ensureOrgMembership(oa2);
      await ctx.pool.query(`ALTER TABLE org_admin_school_delegations DISABLE TRIGGER org_admin_school_delegations_guard`);
      try {
        await ctx.pool.query(
          `INSERT INTO org_admin_school_delegations (organization_id, tenant_id, delegate_user_id, permission_code, granted_by) VALUES ($1, $2, $3, 'area.people', $4)`,
          [ctx.ids.orgA, A(), oa2, ctx.ids.adminA],
        );
      } finally {
        await ctx.pool.query(`ALTER TABLE org_admin_school_delegations ENABLE TRIGGER org_admin_school_delegations_guard`);
      }
      // Its effect today: the People set, which is the very reach the owner does not approve for NEW grants.
      const perms = await call("GET", "oa2", "/v1/rbac/permissions?limit=200");
      expect(perms.json().items).toContain("resource.learner.write");
      expect(perms.json().items).not.toContain("resource.guardian.read");

      const sql = readFileSync(join(process.cwd(), "migrations", "026_delegation_lifecycle.sql"), "utf8");
      const t0 = await now();
      await ctx.pool.query(sql);
      await ctx.pool.query(sql);
      expect(await activeDeleg(oa2)).toEqual(["area.people"]); // not revoked by the migration
      const review = await events("rbac.org_delegation.review_required", t0, "delegateUserId", oa2);
      expect(review).toHaveLength(1); // recorded once, however many times the migration runs
      expect(review[0]!.detail.permissionCode).toBe("area.people");

      const revoked = await call("DELETE", "admin", "/v1/rbac/org-delegations", { delegateUserId: oa2, permissionCodes: ["area.people"] });
      expect(revoked.statusCode).toBe(200);
      expect(await activeDeleg(oa2)).toEqual([]);
      expect((await grantDeleg(oa2, ["area.people"])).statusCode).toBe(400); // and it cannot be re-granted
    });
  });
});
