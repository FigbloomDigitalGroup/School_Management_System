/**
 * WP-A1 final remediation: auth_set_session_tenant enforces tenant eligibility inside the
 * database (migration 015), with the real runtime role and valid HMAC proofs, so the checks
 * hold even if the application were to pass a tenant it should not.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestApp, type FixtureIds } from "./support.js";
import { AppError } from "../src/http/errors.js";
import { createSession, setSessionTenant } from "../src/modules/auth/session.js";
import {
  LOCAL_SESSION_MINT_HMAC_KEY,
  buildSetTenantPayload,
  newProofNonce,
  proofTimestampUtc,
  signSessionProof,
} from "../src/modules/auth/sessionProof.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

describe("tenant eligibility inside auth_set_session_tenant (migration 015)", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let suspendedTenant: string; // in orgA
  let inactiveOrg: string;
  let inactiveOrgTenant: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    suspendedTenant = randomUUID();
    inactiveOrg = randomUUID();
    inactiveOrgTenant = randomUUID();
    await ctx.pool.query(
      `INSERT INTO tenants (id, organization_id, name, slug, status) VALUES ($1, $2, 'Suspended School', 'suspended-school', 'suspended')`,
      [suspendedTenant, ids.orgA],
    );
    await ctx.pool.query(
      `INSERT INTO organizations (id, name, slug, kind, status) VALUES ($1, 'Dormant Org', 'dormant-org', 'group_owner', 'suspended')`,
      [inactiveOrg],
    );
    await ctx.pool.query(
      `INSERT INTO tenants (id, organization_id, name, slug, status) VALUES ($1, $2, 'Dormant School', 'dormant-school', 'active')`,
      [inactiveOrgTenant, inactiveOrg],
    );
    // adminA is also a school member of the suspended school and of the dormant org's school.
    await ctx.pool.query(
      `INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'school_admin', 'AD-0002'), ($1, $3, 'school_admin', 'AD-0003')`,
      [ids.adminA, suspendedTenant, inactiveOrgTenant],
    );
    // orgAdmin also administers the dormant (non-active) organisation.
    await ctx.pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role) VALUES ($1, $2, 'org_admin')`,
      [ids.orgAdmin, inactiveOrg],
    );
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.runtimePool.end();
    await ctx.pool.end();
  });

  type Outcome = { ok: true; tenant: string | null; org: string | null } | { ok: false; code: string | null; rows: number };

  async function trySet(
    sessionId: string,
    actor: string,
    tenantId: string,
    orgId: string,
    key = LOCAL_SESSION_MINT_HMAC_KEY,
  ): Promise<Outcome> {
    const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const nonce = newProofNonce();
    const payload = buildSetTenantPayload({ sessionId, tenantId, organizationId: orgId, issuedAt, nonce, actorUserId: actor });
    try {
      const res = await ctx.runtimePool.query(
        `SELECT active_tenant_id, active_organization_id FROM public.auth_set_session_tenant($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::timestamptz,$6::text,$7::text)`,
        [sessionId, tenantId, orgId, actor, proofTimestampUtc(issuedAt), nonce, signSessionProof(key, payload)],
      );
      if (res.rowCount === 0) return { ok: false, code: null, rows: 0 };
      return { ok: true, tenant: res.rows[0].active_tenant_id, org: res.rows[0].active_organization_id };
    } catch (err) {
      return { ok: false, code: (err as { code?: string }).code ?? "unknown", rows: -1 };
    }
  }

  const activeTenantOf = async (sessionId: string) =>
    (await ctx.pool.query(`SELECT active_tenant_id FROM sessions WHERE id = $1`, [sessionId])).rows[0].active_tenant_id as string | null;

  it("an eligible school member can select their school; the organisation is derived from the tenant", async () => {
    const { session } = await createSession(ctx.runtimePool, ctx.config, { userId: ids.adminA });
    const r = await trySet(session.id, ids.adminA, ids.tenantA, ids.orgA);
    expect(r).toEqual({ ok: true, tenant: ids.tenantA, org: ids.orgA });
  });

  it("refuses a school the user has no membership in (cross-tenant), leaving the session unchanged", async () => {
    const { session } = await createSession(ctx.runtimePool, ctx.config, { userId: ids.adminA });
    const r = await trySet(session.id, ids.adminA, ids.tenantB, ids.orgB);
    expect(r).toMatchObject({ ok: false, code: "42501" });
    expect(await activeTenantOf(session.id)).toBeNull();
  });

  it("refuses a nonexistent tenant and a proof whose organisation does not own the tenant", async () => {
    const { session } = await createSession(ctx.runtimePool, ctx.config, { userId: ids.adminA });
    expect(await trySet(session.id, ids.adminA, randomUUID(), ids.orgA)).toMatchObject({ ok: false, code: "42501" });
    // Eligible tenant, but the (validly signed) proof names a different organisation.
    expect(await trySet(session.id, ids.adminA, ids.tenantA, ids.orgB)).toMatchObject({ ok: false, code: "42501" });
    expect(await activeTenantOf(session.id)).toBeNull();
  });

  it("refuses an archived membership", async () => {
    const user = randomUUID();
    await ctx.pool.query(`INSERT INTO users (id, email, password_hash, full_name, status) SELECT $1, 'arch@example.com', password_hash, 'Archived', 'active' FROM users WHERE id = $2`, [user, ids.adminA]);
    await ctx.pool.query(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'teacher', 'TC-0099')`, [user, ids.tenantA]);
    const { session } = await createSession(ctx.runtimePool, ctx.config, { userId: user, activeTenantId: ids.tenantA, activeOrganizationId: ids.orgA });
    expect(await trySet(session.id, user, ids.tenantA, ids.orgA)).toMatchObject({ ok: true });
    await ctx.pool.query(`UPDATE school_memberships SET archived_at = now() WHERE user_id = $1`, [user]);
    expect(await trySet(session.id, user, ids.tenantA, ids.orgA)).toMatchObject({ ok: false, code: "42501" });
  });

  it("a suspended school is refused for members and org admins, allowed only for a platform super admin", async () => {
    const member = await createSession(ctx.runtimePool, ctx.config, { userId: ids.adminA });
    expect(await trySet(member.session.id, ids.adminA, suspendedTenant, ids.orgA)).toMatchObject({ ok: false, code: "42501" });
    const orgAdmin = await createSession(ctx.runtimePool, ctx.config, { userId: ids.orgAdmin });
    expect(await trySet(orgAdmin.session.id, ids.orgAdmin, suspendedTenant, ids.orgA)).toMatchObject({ ok: false, code: "42501" });
    const sup = await createSession(ctx.runtimePool, ctx.config, { userId: ids.superAdmin });
    expect(await trySet(sup.session.id, ids.superAdmin, suspendedTenant, ids.orgA)).toMatchObject({ ok: true, tenant: suspendedTenant });
  });

  it("an org admin may select schools of an ACTIVE organisation only; another organisation's school is refused", async () => {
    const { session } = await createSession(ctx.runtimePool, ctx.config, { userId: ids.orgAdmin });
    expect(await trySet(session.id, ids.orgAdmin, ids.tenantA, ids.orgA)).toMatchObject({ ok: true, tenant: ids.tenantA });
    expect(await trySet(session.id, ids.orgAdmin, ids.tenantB, ids.orgB)).toMatchObject({ ok: false, code: "42501" });
    // Org membership on a non-active organisation grants nothing.
    expect(await trySet(session.id, ids.orgAdmin, inactiveOrgTenant, inactiveOrg)).toMatchObject({ ok: false, code: "42501" });
  });

  it("a school member keeps access when their organisation is not active (matches the application rule)", async () => {
    const { session } = await createSession(ctx.runtimePool, ctx.config, { userId: ids.adminA });
    expect(await trySet(session.id, ids.adminA, inactiveOrgTenant, inactiveOrg)).toMatchObject({ ok: true, tenant: inactiveOrgTenant });
  });

  it("a user who is no longer active cannot switch tenant", async () => {
    const { session } = await createSession(ctx.runtimePool, ctx.config, { userId: ids.teacherA });
    await ctx.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [ids.teacherA]);
    try {
      expect(await trySet(session.id, ids.teacherA, ids.tenantA, ids.orgA)).toMatchObject({ ok: false, code: "42501" });
    } finally {
      await ctx.pool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [ids.teacherA]);
    }
  });

  it("eligibility is not revealed without a valid proof (forged proofs get no rows, not an error)", async () => {
    const { session } = await createSession(ctx.runtimePool, ctx.config, { userId: ids.adminA });
    const forged = await trySet(session.id, ids.adminA, ids.tenantB, ids.orgB, "f".repeat(40));
    expect(forged).toEqual({ ok: false, code: null, rows: 0 });
    // Same for an ineligible tenant and an eligible one: indistinguishable without the key.
    expect(await trySet(session.id, ids.adminA, ids.tenantA, ids.orgA, "f".repeat(40))).toEqual({ ok: false, code: null, rows: 0 });
    expect(await activeTenantOf(session.id)).toBeNull();
  });

  it("revoked and expired sessions cannot switch tenant", async () => {
    const rev = await createSession(ctx.runtimePool, ctx.config, { userId: ids.adminA });
    await ctx.pool.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [rev.session.id]);
    expect(await trySet(rev.session.id, ids.adminA, ids.tenantA, ids.orgA)).toEqual({ ok: false, code: null, rows: 0 });
    const exp = await createSession(ctx.runtimePool, ctx.config, { userId: ids.adminA });
    await ctx.pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, [exp.session.id]);
    expect(await trySet(exp.session.id, ids.adminA, ids.tenantA, ids.orgA)).toEqual({ ok: false, code: null, rows: 0 });
  });

  it("another user's session cannot be switched even with a valid proof for the right tenant", async () => {
    const victim = await createSession(ctx.runtimePool, ctx.config, { userId: ids.adminA });
    expect(await trySet(victim.session.id, ids.superAdmin, ids.tenantA, ids.orgA)).toEqual({ ok: false, code: null, rows: 0 });
    expect(await activeTenantOf(victim.session.id)).toBeNull();
  });

  it("temporary-table shadowing of the eligibility tables cannot grant access", async () => {
    const attacker = await createSession(ctx.runtimePool, ctx.config, { userId: ids.teacherB }); // member of tenantB only
    const c = await ctx.pool.connect();
    try {
      await c.query("BEGIN");
      // Shadows that would make teacherB look eligible for tenantA if they were consulted.
      await c.query(`CREATE TEMP TABLE users (id uuid, status text)`);
      await c.query(`INSERT INTO users VALUES ('${ids.teacherB}', 'active')`);
      await c.query(`CREATE TEMP TABLE tenants (id uuid, organization_id uuid, status text)`);
      await c.query(`INSERT INTO tenants VALUES ('${ids.tenantA}', '${ids.orgA}', 'active')`);
      await c.query(`CREATE TEMP TABLE school_memberships (user_id uuid, tenant_id uuid, archived_at timestamptz)`);
      await c.query(`INSERT INTO school_memberships VALUES ('${ids.teacherB}', '${ids.tenantA}', NULL)`);
      await c.query(`CREATE TEMP TABLE platform_roles (user_id uuid, role text)`);
      await c.query(`INSERT INTO platform_roles VALUES ('${ids.teacherB}', 'super_admin')`);
      await c.query(`CREATE TEMP TABLE organization_memberships (user_id uuid, organization_id uuid, role text)`);
      await c.query(`CREATE TEMP TABLE organizations (id uuid, status text)`);
      await c.query(`CREATE TEMP TABLE sessions (id uuid, user_id uuid, revoked_at timestamptz, expires_at timestamptz, active_tenant_id uuid, active_organization_id uuid, last_seen_at timestamptz)`);
      await c.query(`SET LOCAL ROLE figbloom_app`);
      const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
      const nonce = newProofNonce();
      const payload = buildSetTenantPayload({ sessionId: attacker.session.id, tenantId: ids.tenantA, organizationId: ids.orgA, issuedAt, nonce, actorUserId: ids.teacherB });
      let code: string | undefined;
      try {
        await c.query(
          `SELECT * FROM public.auth_set_session_tenant($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::timestamptz,$6::text,$7::text)`,
          [attacker.session.id, ids.tenantA, ids.orgA, ids.teacherB, proofTimestampUtc(issuedAt), nonce, signSessionProof(LOCAL_SESSION_MINT_HMAC_KEY, payload)],
        );
      } catch (err) {
        code = (err as { code?: string }).code;
      }
      await c.query("ROLLBACK");
      expect(code).toBe("42501");
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
    expect(await activeTenantOf(attacker.session.id)).toBeNull();
  });

  it("the application surfaces the database refusal as 403, and the select-tenant route agrees for every case above", async () => {
    const { session } = await createSession(ctx.runtimePool, ctx.config, { userId: ids.adminA });
    await expect(
      setSessionTenant(ctx.runtimePool, ctx.config, { sessionId: session.id, tenantId: ids.tenantB, organizationId: ids.orgB, actorUserId: ids.adminA }),
    ).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.statusCode === 403 && e.code === "forbidden");

    const login = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "admin-a@example.com", password: "correct-horse-battery" } });
    const token = login.json().token as string;
    const sel = (tenantId: string) =>
      ctx.app.inject({ method: "POST", url: "/v1/auth/select-tenant", headers: { authorization: `Bearer ${token}` }, payload: { tenantId } });
    expect((await sel(ids.tenantA)).statusCode).toBe(200);
    expect((await sel(ids.tenantB)).statusCode).toBe(403);
    expect((await sel(suspendedTenant)).statusCode).toBe(403);
    expect((await sel(randomUUID())).statusCode).toBe(404);
  });
});
