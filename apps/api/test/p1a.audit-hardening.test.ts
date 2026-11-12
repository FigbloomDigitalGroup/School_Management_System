import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { parse } from "yaml";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { consumeAuthToken } from "../src/modules/auth/rateLimit.js";
import { hashPassword } from "../src/modules/identity/password.js";
import { createTestApp, assertIsolatedTestDatabase, type FixtureIds } from "./support.js";

/**
 * Independent audit + remediation regression tests for FIG-1573 (P1-A).
 * Each describe block names the audit finding it pins (AUD-nn, see
 * AUDITS/FIG-1573-CLAUDE-AUDIT-AND-REMEDIATION.md).
 */
describe("FIG-1573 audit regression suite", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ids: FixtureIds;
  let config: AppConfig;

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

  const PASSWORD = "correct-horse-battery";

  async function post(a: FastifyInstance, url: string, payload: unknown, headers: Record<string, string> = {}) {
    return a.inject({ method: "POST", url, payload: payload as object, headers });
  }
  const postFrom = (a: FastifyInstance, remoteAddress: string, url: string, payload: unknown, headers: Record<string, string> = {}) =>
    a.inject({ method: "POST", url, payload: payload as object, headers, remoteAddress });
  const loginEmail = (email: string, a: FastifyInstance = app, headers: Record<string, string> = {}) =>
    post(a, "/v1/auth/login/email", { email, password: PASSWORD }, headers);
  const loginId = (tenantId: string, id: string, a: FastifyInstance = app) =>
    post(a, "/v1/auth/login/login-id", { tenantId, loginId: id, password: PASSWORD });
  const bearer = (token: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${token}`,
    ...extra,
  });

  /** App built on the same pool with the programme's real limiter values. */
  async function limitedApp(over: Partial<AppConfig> = {}): Promise<FastifyInstance> {
    const a = await buildApp(
      {
        ...config,
        authRateCapacity: 5,
        authRateRefill: 2,
        authRateIntervalMs: 5000,
        ...over,
      },
      pool,
    );
    await a.ready();
    return a;
  }

  async function addUser(email: string | null, status = "active"): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, status) VALUES ($1,$2,$3,'Audit User',$4)`,
      [id, email, await hashPassword(PASSWORD), status],
    );
    return id;
  }

  // ------------------------------------------------------------------ AUD-03
  describe("AUD-03 rate limiter (PG token bucket)", () => {
    it("ships the programme defaults: capacity 5, +2 per 5s", async () => {
      const { loadConfig } = await import("../src/config.js");
      const c = loadConfig({
        DATABASE_URL: "postgresql://x@127.0.0.1/figbloom_api",
      } as NodeJS.ProcessEnv);
      expect(c.authRateCapacity).toBe(5);
      expect(c.authRateRefill).toBe(2);
      expect(c.authRateIntervalMs).toBe(5000);
    });

    it("allows exactly 5 attempts, then 429 with Retry-After", async () => {
      const a = await limitedApp();
      const email = `rl-${randomUUID()}@example.com`;
      const codes: number[] = [];
      let last;
      for (let i = 0; i < 7; i++) {
        last = await postFrom(a, "198.51.100.10", "/v1/auth/login/email", { email, password: "wrong" });
        codes.push(last.statusCode);
      }
      expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(codes.slice(5)).toEqual([429, 429]);
      expect(last!.json().error.code).toBe("rate_limited");
      const retry = Number(last!.headers["retry-after"]);
      expect(Number.isInteger(retry)).toBe(true);
      expect(retry).toBeGreaterThanOrEqual(1);
      expect(retry).toBeLessThanOrEqual(5);
      await a.close();
    });

    it("is atomic under concurrency: 25 parallel hits on one key admit exactly 5", async () => {
      const key = `test:concurrent:${randomUUID()}`;
      const results = await Promise.all(
        Array.from({ length: 25 }, async () => {
          try {
            await consumeAuthToken(pool, { ...config, authRateCapacity: 5, authRateRefill: 2, authRateIntervalMs: 60_000 }, key);
            return true;
          } catch {
            return false;
          }
        }),
      );
      expect(results.filter(Boolean)).toHaveLength(5);
    });

    it("refills +2 tokens per interval and never above capacity", async () => {
      const cfg = { ...config, authRateCapacity: 5, authRateRefill: 2, authRateIntervalMs: 700 };
      const key = `test:refill:${randomUUID()}`;
      for (let i = 0; i < 5; i++) await consumeAuthToken(pool, cfg, key);
      await expect(consumeAuthToken(pool, cfg, key)).rejects.toMatchObject({ statusCode: 429 });
      await new Promise((r) => setTimeout(r, 800));
      await consumeAuthToken(pool, cfg, key);
      await consumeAuthToken(pool, cfg, key);
      await expect(consumeAuthToken(pool, cfg, key)).rejects.toMatchObject({ statusCode: 429 });
      // long idle never overfills past capacity
      await new Promise((r) => setTimeout(r, 4000));
      let ok = 0;
      for (let i = 0; i < 8; i++) {
        try {
          await consumeAuthToken(pool, cfg, key);
          ok++;
        } catch {
          /* denied */
        }
      }
      expect(ok).toBe(5);
    }, 20_000);

    it("supports weighted costs and denies a cost above capacity", async () => {
      const cfg = { ...config, authRateCapacity: 5, authRateRefill: 2, authRateIntervalMs: 60_000 };
      const key = `test:cost:${randomUUID()}`;
      expect(await consumeAuthToken(pool, cfg, key, 3)).toBe(2);
      await expect(consumeAuthToken(pool, cfg, key, 3)).rejects.toMatchObject({ statusCode: 429 });
      expect(await consumeAuthToken(pool, cfg, key, 2)).toBe(0);
      await expect(consumeAuthToken(pool, cfg, `test:big:${randomUUID()}`, 6)).rejects.toMatchObject({
        statusCode: 429,
      });
    });

    it("is not driven by the caller's clock: a future last_refill must not invent refill tokens", async () => {
      const cfg = { ...config, authRateCapacity: 5, authRateRefill: 2, authRateIntervalMs: 5000 };
      const key = `test:clock:${randomUUID()}`;
      // Start full (5), spend 1 → 4.
      expect(await consumeAuthToken(pool, cfg, key)).toBe(4);
      await pool.query(`UPDATE auth_rate_buckets SET last_refill = now() + interval '1 hour' WHERE bucket_key = $1`, [key]);
      // Next spend must be exactly 3 (no bonus refill from the skewed clock).
      expect(await consumeAuthToken(pool, cfg, key)).toBe(3);
      const row = await pool.query<{ tokens: string }>(`SELECT tokens FROM auth_rate_buckets WHERE bucket_key=$1`, [key]);
      expect(Number(row.rows[0]!.tokens)).toBe(3);
    });

    it("R2-08: cost above capacity is 429 without a Retry-After that implies waiting helps", async () => {
      const cfg = { ...config, authRateCapacity: 5, authRateRefill: 2, authRateIntervalMs: 60_000 };
      const key = `test:overcap:${randomUUID()}`;
      try {
        await consumeAuthToken(pool, cfg, key, 6);
        expect.unreachable("should deny");
      } catch (err: any) {
        expect(err.statusCode).toBe(429);
        expect(err.retryAfterSeconds).toBeUndefined();
      }
      expect(
        (await pool.query(`SELECT 1 FROM auth_rate_buckets WHERE bucket_key=$1`, [key])).rowCount,
      ).toBe(0);
    });
  });

  // ------------------------------------------------------------------ AUD-01
  describe("AUD-01 client address trust", () => {
    it("ignores a spoofed X-Forwarded-For: rotating it does not reset the per-IP bucket", async () => {
      const a = await limitedApp();
      const codes: number[] = [];
      for (let i = 0; i < 8; i++) {
        const res = await postFrom(
          a,
          "198.51.100.20",
          "/v1/auth/login/email",
          { email: `spoof-${i}-${randomUUID()}@example.com`, password: "x" },
          { "x-forwarded-for": `203.0.113.${i + 1}` },
        );
        codes.push(res.statusCode);
      }
      expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
      expect(codes.slice(5).every((c) => c === 429)).toBe(true);
      await a.close();
    });

    it("does not 500 or poison the audit log on a malformed X-Forwarded-For", async () => {
      const res = await loginEmail("admin-a@example.com", app, {
        "x-forwarded-for": "not-an-ip'; DROP TABLE users;--",
      });
      expect(res.statusCode).toBe(200);
      const ev = await pool.query(
        `SELECT ip::text FROM security_audit_events WHERE event_type='auth.login.success' ORDER BY occurred_at DESC LIMIT 1`,
      );
      expect(ev.rows[0]!.ip === null || /^[0-9a-f.:/]+$/i.test(ev.rows[0]!.ip)).toBe(true);
      expect((await pool.query(`SELECT 1 FROM users LIMIT 1`)).rowCount).toBeGreaterThan(0);
    });
  });

  // ------------------------------------------------------------------ AUD-02
  describe("AUD-02 suspended school after the session was issued", () => {
    it("denies members and org admins of a school suspended later; super admin may still act", async () => {
      const teacher = await loginId(ids.tenantA, "TC-0001");
      const t = teacher.json().token as string;
      const orgAdmin = await loginEmail("orgadmin@example.com");
      const o = orgAdmin.json().token as string;
      const superAdmin = await loginEmail("super@example.com");
      const s = superAdmin.json().token as string;
      expect(
        (await app.inject({ method: "GET", url: "/v1/rbac/permissions", headers: bearer(t) })).statusCode,
      ).toBe(200);

      await pool.query(`UPDATE tenants SET status='suspended' WHERE id=$1`, [ids.tenantA]);
      try {
        const m = await app.inject({ method: "GET", url: "/v1/rbac/permissions", headers: bearer(t) });
        expect(m.statusCode).toBe(403);
        const org = await app.inject({
          method: "GET",
          url: `/v1/tenants/${ids.tenantA}`,
          headers: bearer(o, { "x-tenant-id": ids.tenantA }),
        });
        expect(org.statusCode).toBe(403);
        const sup = await app.inject({
          method: "GET",
          url: `/v1/tenants/${ids.tenantA}`,
          headers: bearer(s, { "x-tenant-id": ids.tenantA }),
        });
        expect(sup.statusCode).toBe(200);
      } finally {
        await pool.query(`UPDATE tenants SET status='active' WHERE id=$1`, [ids.tenantA]);
      }
    });
  });

  // ------------------------------------------------------------------ AUD-06
  describe("AUD-06 stale active tenant must not lock the caller out", () => {
    it("lets a user with an archived membership log out, list memberships and select another school", async () => {
      const uid = await addUser("multi@example.com");
      await pool.query(
        `INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES
          ($1,$2,'teacher','TC-0201'), ($1,$3,'teacher','TC-0201')`,
        [uid, ids.tenantA, ids.tenantB],
      );
      const login = await loginEmail("multi@example.com");
      expect(login.json().activeTenantId).toBeNull();
      const token = login.json().token as string;
      const sel = await post(app, "/v1/auth/select-tenant", { tenantId: ids.tenantA }, bearer(token));
      expect(sel.statusCode).toBe(200);

      await pool.query(`UPDATE school_memberships SET archived_at = now() WHERE user_id=$1 AND tenant_id=$2`, [uid, ids.tenantA]);

      const tenantScoped = await app.inject({ method: "GET", url: `/v1/tenants/${ids.tenantA}`, headers: bearer(token) });
      expect(tenantScoped.statusCode).toBe(403);
      const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: bearer(token) });
      expect(me.statusCode).toBe(200);
      expect(me.json().session.activeTenantId).toBeNull();
      const switched = await post(app, "/v1/auth/select-tenant", { tenantId: ids.tenantB }, bearer(token));
      expect(switched.statusCode).toBe(200);
      const logout = await post(app, "/v1/auth/logout", {}, bearer(token));
      expect(logout.statusCode).toBe(200);
      const replay = await app.inject({ method: "GET", url: "/v1/auth/me", headers: bearer(token) });
      expect(replay.statusCode).toBe(401);
    });
  });

  // ------------------------------------------------------------------ session lifecycle
  describe("session lifecycle", () => {
    it("issues distinct high-entropy tokens and stores only their hash", async () => {
      const a = await loginEmail("admin-a@example.com");
      const b = await loginEmail("admin-a@example.com");
      const ta = a.json().token as string;
      const tb = b.json().token as string;
      expect(ta).not.toBe(tb);
      expect(ta).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const dump = JSON.stringify((await pool.query(`SELECT * FROM sessions`)).rows);
      expect(dump).not.toContain(ta);
      expect(dump).not.toContain(tb);
    });

    it("a disabled user's live session stops working immediately", async () => {
      const uid = await addUser("soon-disabled@example.com");
      await pool.query(
        `INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1,$2,'staff','SF-0301')`,
        [uid, ids.tenantA],
      );
      const token = (await loginEmail("soon-disabled@example.com")).json().token as string;
      expect((await app.inject({ method: "GET", url: "/v1/auth/me", headers: bearer(token) })).statusCode).toBe(200);
      await pool.query(`UPDATE users SET status='disabled' WHERE id=$1`, [uid]);
      expect((await app.inject({ method: "GET", url: "/v1/auth/me", headers: bearer(token) })).statusCode).toBe(401);
      expect((await loginEmail("soon-disabled@example.com")).statusCode).toBe(401);
    });

    it("a revoked membership removes access without needing a new login", async () => {
      const token = (await loginId(ids.tenantA, "PT-0001")).json().token as string;
      expect((await app.inject({ method: "GET", url: `/v1/tenants/${ids.tenantA}`, headers: bearer(token) })).statusCode).toBe(200);
      await pool.query(`UPDATE school_memberships SET archived_at=now() WHERE user_id=$1`, [ids.parentA]);
      try {
        expect((await app.inject({ method: "GET", url: `/v1/tenants/${ids.tenantA}`, headers: bearer(token) })).statusCode).toBe(403);
        expect((await loginId(ids.tenantA, "PT-0001")).statusCode).toBe(401);
      } finally {
        await pool.query(`UPDATE school_memberships SET archived_at=NULL WHERE user_id=$1`, [ids.parentA]);
      }
    });

    it("a login_id from another school cannot be used against this school", async () => {
      expect((await loginId(ids.tenantB, "PT-0001")).statusCode).toBe(401);
    });
  });

  // ------------------------------------------------------------------ AUD-11 / RBAC
  describe("RBAC revocation, acting-as and escalation", () => {
    it("revoking an area removes the permission on the very next request", async () => {
      const admin = (await loginEmail("admin-a@example.com")).json().token as string;
      const teacher = (await loginId(ids.tenantA, "TC-0001")).json().token as string;
      const put = (areas: string[]) =>
        app.inject({ method: "PUT", url: "/v1/rbac/staff-areas", headers: bearer(admin), payload: { userId: ids.teacherA, areas } });
      expect((await put(["people"])).statusCode).toBe(200);
      const allowed = await app.inject({ method: "GET", url: `/v1/tenants/${ids.tenantA}/resources/learners`, headers: bearer(teacher) });
      expect(allowed.statusCode).toBe(200);
      expect((await put([])).statusCode).toBe(200);
      const denied = await app.inject({ method: "GET", url: `/v1/tenants/${ids.tenantA}/resources/learners`, headers: bearer(teacher) });
      expect(denied.statusCode).toBe(403);
    });

    it("an admin cannot grant areas to a member of another school or to a non-member", async () => {
      const admin = (await loginEmail("admin-a@example.com")).json().token as string;
      for (const userId of [ids.teacherB, randomUUID()]) {
        const res = await app.inject({ method: "PUT", url: "/v1/rbac/staff-areas", headers: bearer(admin), payload: { userId, areas: ["fees"] } });
        expect(res.statusCode).toBe(404);
      }
    });

    it("audits the previous and new areas, without secrets", async () => {
      const admin = (await loginEmail("admin-a@example.com")).json().token as string;
      const put = (areas: string[]) =>
        app.inject({ method: "PUT", url: "/v1/rbac/staff-areas", headers: bearer(admin), payload: { userId: ids.teacherA, areas } });
      await put(["fees", "fees", "attendance"]);
      await put(["attendance"]);
      const ev = await pool.query<{ detail: { areas: string[]; previousAreas: string[] } }>(
        `SELECT detail FROM security_audit_events WHERE event_type='rbac.staff_areas.changed' ORDER BY occurred_at DESC LIMIT 1`,
      );
      expect(ev.rows[0]!.detail.areas).toEqual(["attendance"]);
      expect(ev.rows[0]!.detail.previousAreas.sort()).toEqual(["attendance", "fees"]);
    });

    it("org admin cannot reach another organisation's school; header cannot widen access", async () => {
      const o = (await loginEmail("orgadmin@example.com")).json().token as string;
      const sel = await post(app, "/v1/auth/select-tenant", { tenantId: ids.tenantB }, bearer(o));
      expect(sel.statusCode).toBe(403);
      const hdr = await app.inject({ method: "GET", url: `/v1/tenants/${ids.tenantB}`, headers: bearer(o, { "x-tenant-id": ids.tenantB }) });
      expect(hdr.statusCode).toBe(403);
    });

    it("AUD-11 / R2-05 super admin can read tenant; org admin needs tenant.read delegation", async () => {
      const s = (await loginEmail("super@example.com")).json().token as string;
      const res = await app.inject({ method: "GET", url: `/v1/tenants/${ids.tenantA}`, headers: bearer(s, { "x-tenant-id": ids.tenantA }) });
      expect(res.statusCode).toBe(200);
      const o = (await loginEmail("orgadmin@example.com")).json().token as string;
      const denied = await app.inject({
        method: "GET",
        url: `/v1/tenants/${ids.tenantA}`,
        headers: bearer(o, { "x-tenant-id": ids.tenantA }),
      });
      expect(denied.statusCode).toBe(403);
      const admin = (await loginEmail("admin-a@example.com")).json().token as string;
      const grant = await app.inject({
        method: "POST",
        url: "/v1/rbac/org-delegations",
        headers: bearer(admin),
        payload: { delegateUserId: ids.orgAdmin, permissionCodes: ["tenant.read"] },
      });
      expect(grant.statusCode).toBe(200);
      const allowed = await app.inject({
        method: "GET",
        url: `/v1/tenants/${ids.tenantA}`,
        headers: bearer(o, { "x-tenant-id": ids.tenantA }),
      });
      expect(allowed.statusCode).toBe(200);
    });

    it("AUD-07 concurrent grants on one member never 500 and leave a consistent set", async () => {
      const admin = (await loginEmail("admin-a@example.com")).json().token as string;
      const sets = [["fees"], ["attendance", "medical"], ["people", "audit"], ["leave"]];
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          app.inject({ method: "PUT", url: "/v1/rbac/staff-areas", headers: bearer(admin), payload: { userId: ids.teacherA, areas: sets[i % sets.length] } }),
        ),
      );
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      const rows = await pool.query<{ area: string }>(
        `SELECT area FROM staff_area_grants WHERE user_id=$1 AND tenant_id=$2 ORDER BY area`,
        [ids.teacherA, ids.tenantA],
      );
      const got = rows.rows.map((r) => r.area);
      expect(sets.map((s) => [...s].sort().join(",")).includes(got.join(","))).toBe(true);
    });

    it("AUD-07 a grant racing a membership archive cannot leave a grant on an archived member", async () => {
      const uid = await addUser(null);
      await pool.query(
        `INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1,$2,'staff','SF-0401')`,
        [uid, ids.tenantA],
      );
      const admin = (await loginEmail("admin-a@example.com")).json().token as string;
      const [grant] = await Promise.all([
        app.inject({ method: "PUT", url: "/v1/rbac/staff-areas", headers: bearer(admin), payload: { userId: uid, areas: ["fees"] } }),
        pool.query(`UPDATE school_memberships SET archived_at = now() WHERE user_id=$1`, [uid]),
      ]);
      expect([200, 404]).toContain(grant.statusCode);
      const membership = await pool.query<{ archived_at: string | null }>(
        `SELECT archived_at FROM school_memberships WHERE user_id=$1 AND tenant_id=$2`,
        [uid, ids.tenantA],
      );
      expect(membership.rows[0]?.archived_at).toBeTruthy();
      // Non-vacuous: grants must not remain on the archived membership row.
      const orphaned = await pool.query(
        `SELECT 1 FROM staff_area_grants WHERE user_id=$1 AND tenant_id=$2`,
        [uid, ids.tenantA],
      );
      expect(orphaned.rowCount).toBe(0);
    });
  });

  // ------------------------------------------------------------------ AUD-05
  describe("AUD-05 database tenant integrity", () => {
    it("refuses a role assignment whose role belongs to another tenant", async () => {
      const role = await pool.query<{ id: string }>(
        `INSERT INTO school_roles (tenant_id, name, areas) VALUES ($1,'Bursar',ARRAY['fees']) RETURNING id`,
        [ids.tenantB],
      );
      await expect(
        pool.query(`INSERT INTO school_role_assignments (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`, [ids.tenantA, ids.teacherA, role.rows[0]!.id]),
      ).rejects.toThrow();
    });

    it("refuses a role assignment or area grant for a user with no membership in that tenant", async () => {
      const role = await pool.query<{ id: string }>(
        `INSERT INTO school_roles (tenant_id, name, areas) VALUES ($1,'Registrar',ARRAY['people']) RETURNING id`,
        [ids.tenantA],
      );
      await expect(
        pool.query(`INSERT INTO school_role_assignments (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`, [ids.tenantA, ids.teacherB, role.rows[0]!.id]),
      ).rejects.toThrow();
      await expect(
        pool.query(`INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1,$2,'fees')`, [ids.tenantA, ids.teacherB]),
      ).rejects.toThrow();
    });

    it("AUD-15 accepts legacy login IDs beyond 9999 and still rejects malformed ones", async () => {
      const uid = await addUser(null);
      await pool.query(
        `INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1,$2,'student','ST-10000')`,
        [uid, ids.tenantA],
      );
      const bad = await addUser(null);
      for (const id of ["st-0001", "S-0001", "ST-1", "ST-0001x", "ST-1234567890"]) {
        await expect(
          pool.query(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1,$2,'student',$3)`, [bad, ids.tenantB, id]),
        ).rejects.toThrow();
      }
    });

    it("a custom school role confers areas only inside its own tenant", async () => {
      const role = await pool.query<{ id: string }>(
        `INSERT INTO school_roles (tenant_id, name, areas) VALUES ($1,'Fees clerk',ARRAY['fees']) RETURNING id`,
        [ids.tenantA],
      );
      await pool.query(`INSERT INTO school_role_assignments (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`, [ids.tenantA, ids.teacherA, role.rows[0]!.id]);
      const t = (await loginId(ids.tenantA, "TC-0001")).json().token as string;
      const perms = await app.inject({ method: "GET", url: "/v1/rbac/permissions", headers: bearer(t) });
      expect(perms.json().permissions).toContain("area.fees");
      await pool.query(`DELETE FROM school_role_assignments WHERE role_id=$1`, [role.rows[0]!.id]);
    });
  });

  // ------------------------------------------------------------------ AUD-08
  describe("AUD-08 security audit log is append-only and secret-free", () => {
    it("refuses UPDATE and DELETE of audit events", async () => {
      await loginEmail("admin-a@example.com");
      await expect(pool.query(`UPDATE security_audit_events SET event_type='x'`)).rejects.toThrow();
      await expect(pool.query(`DELETE FROM security_audit_events`)).rejects.toThrow();
    });

    it("still lets a referenced user be deleted (FK SET NULL is the only permitted update)", async () => {
      const uid = await addUser("temp-delete@example.com");
      await pool.query(`INSERT INTO security_audit_events (actor_user_id, event_type) VALUES ($1,'auth.logout')`, [uid]);
      await pool.query(`DELETE FROM users WHERE id=$1`, [uid]);
      const r = await pool.query(`SELECT 1 FROM security_audit_events WHERE actor_user_id=$1`, [uid]);
      expect(r.rowCount).toBe(0);
    });

    it("never stores passwords, tokens or token hashes in audit detail", async () => {
      const email = "admin-a@example.com";
      await post(app, "/v1/auth/login/email", { email, password: "wrong-pass-123" });
      const ok = await loginEmail(email);
      const token = ok.json().token as string;
      await app.inject({ method: "PUT", url: "/v1/rbac/staff-areas", headers: bearer(token), payload: { userId: ids.parentA, areas: ["fees"] } });
      const dump = JSON.stringify((await pool.query(`SELECT detail, ip::text FROM security_audit_events`)).rows).toLowerCase();
      for (const secret of ["wrong-pass-123", PASSWORD, token.toLowerCase()]) {
        expect(dump).not.toContain(secret.toLowerCase());
      }
      const failures = await pool.query(`SELECT detail FROM security_audit_events WHERE event_type='auth.login.failure'`);
      expect(JSON.stringify(failures.rows)).not.toContain(email);
    });
  });

  // ------------------------------------------------------------------ AUD-09 / AUD-13
  describe("AUD-09 / AUD-13 error shape and input bounds", () => {
    const shape = (b: any) => b && b.error && typeof b.error.code === "string" && typeof b.error.message === "string";

    it("malformed JSON is a 400 validation_error, not a 500", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/login/email",
        headers: { "content-type": "application/json" },
        payload: "{not json",
      });
      expect(res.statusCode).toBe(400);
      expect(shape(res.json())).toBe(true);
      expect(res.body.toLowerCase()).not.toContain("syntaxerror");
    });

    it("unknown routes use the standard error shape", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/nope" });
      expect(res.statusCode).toBe(404);
      expect(shape(res.json())).toBe(true);
    });

    it("a non-UUID X-Tenant-Id is rejected cleanly, never a 500", async () => {
      const token = (await loginEmail("admin-a@example.com")).json().token as string;
      const res = await app.inject({ method: "GET", url: "/v1/rbac/permissions", headers: bearer(token, { "x-tenant-id": "'; select 1;--" }) });
      expect(res.statusCode).toBe(400);
      expect(shape(res.json())).toBe(true);
    });

    it("oversized credentials are refused before any hashing", async () => {
      const res = await post(app, "/v1/auth/login/email", { email: "admin-a@example.com", password: "x".repeat(5000) });
      expect(res.statusCode).toBe(400);
    });
  });

  // ------------------------------------------------------------------ AUD-10
  describe("AUD-10 OpenAPI describes the real surface", () => {
    const spec = parse(readFileSync(resolve(__dirname, "../openapi/openapi.yaml"), "utf8")) as any;

    it("documents exactly the routes the server registers", async () => {
      const registered = new Set<string>();
      for (const r of (app as any).routeTable as Array<{ method: string; url: string }>) {
        if (r.method === "HEAD" || r.method === "OPTIONS") continue;
        registered.add(`${r.method.toLowerCase()} ${r.url.replace(/:([A-Za-z]+)/g, "{$1}")}`);
      }
      const documented = new Set<string>();
      for (const [path, ops] of Object.entries<any>(spec.paths)) {
        for (const m of Object.keys(ops)) documented.add(`${m} ${path}`);
      }
      expect([...registered].sort()).toEqual([...documented].sort());
    });

    it("every protected operation declares 401, every permission operation 403, and every operation its authz class", () => {
      for (const [path, ops] of Object.entries<any>(spec.paths)) {
        for (const [method, op] of Object.entries<any>(ops)) {
          const where = `${method} ${path}`;
          expect(["public", "authenticated", "permission"], where).toContain(op["x-figbloom-authz"]);
          if (op["x-figbloom-authz"] !== "public") {
            expect(op.responses["401"], where).toBeTruthy();
            expect(op.security, where).toBeTruthy();
          }
          if (op["x-figbloom-authz"] === "permission") expect(op.responses["403"], where).toBeTruthy();
          if (op.requestBody) expect(op.responses["400"], where).toBeTruthy();
          const json = JSON.stringify(op);
          for (const ref of json.match(/#\/components\/[A-Za-z]+\/[A-Za-z]+/g) ?? []) {
            const [, , group, name] = ref.split("/");
            expect(spec.components[group!]?.[name!], `${where} -> ${ref}`).toBeTruthy();
          }
        }
      }
    });

    it("documents the 429 Retry-After header on rate-limited login", () => {
      const r = spec.components.responses.RateLimited;
      expect(r.headers["Retry-After"]).toBeTruthy();
    });

    it("test reset guard refuses non-isolated databases", () => {
      expect(() => assertIsolatedTestDatabase("postgresql://u:p@db.example.com:5432/figbloom_api")).toThrow();
      expect(() => assertIsolatedTestDatabase("postgresql://u:p@127.0.0.1:58322/postgres")).toThrow();
      expect(() => assertIsolatedTestDatabase("postgresql://u:p@127.0.0.1:58322/figbloom_api")).not.toThrow();
    });
  });
});
