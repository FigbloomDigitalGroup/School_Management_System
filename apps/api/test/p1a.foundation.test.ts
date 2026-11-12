import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { createTestApp, type FixtureIds } from "./support.js";
import { hashPassword, verifyPassword } from "../src/modules/identity/password.js";
import { createSession, hashSessionToken, revokeSession } from "../src/modules/auth/session.js";
import { assertSameTenant } from "../src/modules/tenancy/context.js";
import { AppError } from "../src/http/errors.js";

describe("P1-A identity / tenancy / RBAC foundation", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ids: FixtureIds;
  let config: Awaited<ReturnType<typeof createTestApp>>["config"];

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    pool = ctx.pool;
    ids = ctx.ids;
    config = ctx.config;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  async function loginEmail(email: string, password = "correct-horse-battery") {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email, password },
    });
    return res;
  }

  async function loginId(tenantId: string, loginId: string, password = "correct-horse-battery") {
    return app.inject({
      method: "POST",
      url: "/v1/auth/login/login-id",
      payload: { tenantId, loginId, password },
    });
  }

  it("boots health against postgres", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", phase: "P1-A" });
  });

  it("never stores plaintext passwords", async () => {
    const hash = await hashPassword("secret-value");
    expect(hash).not.toContain("secret-value");
    expect(await verifyPassword("secret-value", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
    const row = await pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1`,
      [ids.adminA],
    );
    expect(row.rows[0]!.password_hash.startsWith("scrypt$")).toBe(true);
  });

  it("authenticates email login and rejects bad password", async () => {
    const bad = await loginEmail("admin-a@example.com", "nope");
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe("unauthorized");

    const ok = await loginEmail("admin-a@example.com");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().token).toBeTruthy();
    expect(ok.json().activeTenantId).toBe(ids.tenantA);
  });

  it("authenticates login_id within a school", async () => {
    const res = await loginId(ids.tenantA, "TC-0001");
    expect(res.statusCode).toBe(200);
    expect(res.json().user.full_name).toBe("Teacher A");
    expect(res.json().activeTenantId).toBe(ids.tenantA);
  });

  it("denies unauthenticated access", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/auth/me" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects expired and revoked sessions", async () => {
    const { token, session } = await createSession(pool, config, {
      userId: ids.adminA,
      activeTenantId: ids.tenantA,
    });
    await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      session.id,
    ]);
    const expired = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(expired.statusCode).toBe(401);

    const again = await createSession(pool, config, {
      userId: ids.adminA,
      activeTenantId: ids.tenantA,
    });
    await revokeSession(pool, again.session.id);
    const revoked = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${again.token}` },
    });
    expect(revoked.statusCode).toBe(401);
    // token hash only in DB
    const stored = await pool.query(`SELECT token_hash FROM sessions WHERE id = $1`, [
      again.session.id,
    ]);
    expect(stored.rows[0]!.token_hash).toBe(hashSessionToken(again.token));
    expect(stored.rows[0]!.token_hash).not.toBe(again.token);
  });

  it("requires tenant context and denies cross-tenant reads", async () => {
    expect(() => assertSameTenant(null, ids.tenantA)).toThrow(AppError);
    expect(() => assertSameTenant(ids.tenantA, ids.tenantB)).toThrow(AppError);

    const login = await loginId(ids.tenantA, "TC-0001");
    const token = login.json().token as string;

    const cross = await app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantB}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(cross.statusCode).toBe(403);
    expect(cross.json().error.code).toBe("forbidden");

    const own = await app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().slug).toBe("school-a");
  });

  it("rejects X-Tenant-Id spoofing without membership", async () => {
    const login = await loginId(ids.tenantA, "TC-0001");
    const token = login.json().token as string;
    const spoof = await app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantB}`,
      headers: {
        authorization: `Bearer ${token}`,
        "x-tenant-id": ids.tenantB,
      },
    });
    expect(spoof.statusCode).toBe(403);
  });

  it("rejects client-supplied permissions payload", async () => {
    const login = await loginEmail("admin-a@example.com");
    const token = login.json().token as string;
    const res = await app.inject({
      method: "PUT",
      url: "/v1/rbac/staff-areas",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userId: ids.teacherA,
        areas: ["fees"],
        permissions: ["rbac.staff_areas.manage"],
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("enforces RBAC: teacher lacks staff area manage; admin can grant; teacher gains area", async () => {
    const teacherLogin = await loginId(ids.tenantA, "TC-0001");
    const teacherToken = teacherLogin.json().token as string;

    const denied = await app.inject({
      method: "PUT",
      url: "/v1/rbac/staff-areas",
      headers: { authorization: `Bearer ${teacherToken}` },
      payload: { userId: ids.parentA, areas: ["fees"] },
    });
    expect(denied.statusCode).toBe(403);

    const before = await app.inject({
      method: "GET",
      url: "/v1/rbac/permissions",
      headers: { authorization: `Bearer ${teacherToken}` },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().permissions).not.toContain("area.fees");

    const adminLogin = await loginEmail("admin-a@example.com");
    const adminToken = adminLogin.json().token as string;
    const grant = await app.inject({
      method: "PUT",
      url: "/v1/rbac/staff-areas",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { userId: ids.teacherA, areas: ["fees"] },
    });
    expect(grant.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: "/v1/rbac/permissions",
      headers: { authorization: `Bearer ${teacherToken}` },
    });
    expect(after.json().permissions).toContain("area.fees");

    const audit = await pool.query(
      `SELECT event_type FROM security_audit_events
       WHERE event_type = 'rbac.staff_areas.changed' AND tenant_id = $1`,
      [ids.tenantA],
    );
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  it("denies privilege escalation via self area grant and parent area grant", async () => {
    const adminLogin = await loginEmail("admin-a@example.com");
    const adminToken = adminLogin.json().token as string;

    const self = await app.inject({
      method: "PUT",
      url: "/v1/rbac/staff-areas",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { userId: ids.adminA, areas: ["fees"] },
    });
    expect(self.statusCode).toBe(403);

    const parent = await app.inject({
      method: "PUT",
      url: "/v1/rbac/staff-areas",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { userId: ids.parentA, areas: ["people"] },
    });
    expect(parent.statusCode).toBe(403);
  });

  it("select-tenant refuses membership the user does not have", async () => {
    const login = await loginId(ids.tenantA, "TC-0001");
    const token = login.json().token as string;
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/select-tenant",
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantId: ids.tenantB },
    });
    expect(res.statusCode).toBe(403);
  });

  it("does not leak internal errors", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email: "not-an-email", password: "x" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(JSON.stringify(body).toLowerCase()).not.toContain("select ");
    expect(body.error.message).toBeTruthy();
  });

  it("enforces representative learner resource predicate", async () => {
    const teacherLogin = await loginId(ids.tenantA, "TC-0001");
    const teacherToken = teacherLogin.json().token as string;
    const denied = await app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/resources/learners`,
      headers: { authorization: `Bearer ${teacherToken}` },
    });
    expect(denied.statusCode).toBe(403);

    const adminLogin = await loginEmail("admin-a@example.com");
    const adminToken = adminLogin.json().token as string;
    const allowed = await app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/resources/learners`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().access).toBe("granted");
  });

  it("unique membership and login_id constraints hold", async () => {
    await expect(
      pool.query(
        `INSERT INTO school_memberships (user_id, tenant_id, role, login_id)
         VALUES ($1, $2, 'teacher', 'TC-0099')`,
        [ids.teacherA, ids.tenantA],
      ),
    ).rejects.toThrow();

    await expect(
      pool.query(
        `INSERT INTO school_memberships (user_id, tenant_id, role, login_id)
         VALUES ($1, $2, 'staff', 'TC-0001')`,
        [ids.parentA, ids.tenantA],
      ),
    ).rejects.toThrow();
  });
});
