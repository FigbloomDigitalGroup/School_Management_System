import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";
import { withIdentityAccess } from "../src/db/identityAccess.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

function walkTs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".ts")) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** F-C1 / F-C2 (migration 011): exact-key credential functions and no tenant scoping key at login. */
describe("credential access (migration 011)", () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  const byLoginId = (tenant: string, loginId: string) =>
    withIdentityAccess(ctx.runtimePool, (db) =>
      db.query<{ user_id: string; status: string }>(
        `SELECT user_id, status FROM public.auth_credential_by_login_id($1, $2)`,
        [tenant, loginId],
      ),
    );

  it("by login id: exactly one account per (school, login id), case-insensitive, other school and unknown excluded", async () => {
    const a = await byLoginId(ctx.ids.tenantA, "tc-0001");
    expect(a.rows).toEqual([{ user_id: ctx.ids.teacherA, status: "active" }]);
    // The same login id exists in school B for a different person: no mixing.
    const b = await byLoginId(ctx.ids.tenantB, "TC-0001");
    expect(b.rows).toEqual([{ user_id: ctx.ids.teacherB, status: "active" }]);
    expect((await byLoginId(ctx.ids.tenantA, "NOPE-1")).rows).toEqual([]);
    expect((await byLoginId("00000000-0000-4000-8000-0000000000ff", "TC-0001")).rows).toEqual([]);
  });

  it("by login id: an archived membership is not returned", async () => {
    const m = await ctx.pool.query<{ id: string }>(
      `UPDATE school_memberships SET archived_at = now() WHERE user_id = $1 AND tenant_id = $2 RETURNING id`,
      [ctx.ids.parentA, ctx.ids.tenantA],
    );
    expect(m.rowCount).toBe(1);
    try {
      expect((await byLoginId(ctx.ids.tenantA, "PT-0001")).rows).toEqual([]);
    } finally {
      await ctx.pool.query(`UPDATE school_memberships SET archived_at = NULL WHERE id = $1`, [m.rows[0]!.id]);
    }
  });

  it("the functions work with NO tenant or user context set (the Stage C scoping window is gone)", async () => {
    const c = await ctx.runtimePool.connect();
    try {
      const ctxRow = await c.query<{ t: string | null; u: string | null }>(
        `SELECT current_setting('app.tenant_id', true) AS t, current_setting('app.user_id', true) AS u`,
      );
      expect([null, ""]).toContain(ctxRow.rows[0]!.t);
      expect([null, ""]).toContain(ctxRow.rows[0]!.u);
      const r = await c.query(`SELECT user_id FROM public.auth_credential_by_login_id($1, 'AD-0001')`, [ctx.ids.tenantA]);
      expect(r.rowCount).toBe(1);
      // Without context the membership table itself still shows the runtime role nothing.
      const direct = await c.query(`SELECT 1 FROM school_memberships`);
      expect(direct.rowCount).toBe(0);
    } finally {
      c.release();
    }
  });

  it("source: no code path sets the request tenant as a login scoping key", () => {
    const src = walkTs(join(process.cwd(), "src"))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    expect(src).not.toMatch(/withLoginIdTenantScope/);
    // Credentials are read only through the definer functions, never from users directly.
    const svc = readFileSync(join(process.cwd(), "src", "modules", "auth", "service.ts"), "utf8");
    expect(svc).not.toMatch(/FROM users WHERE (email|id) = /);
    expect(svc).toMatch(/auth_credential_by_email/);
    expect(svc).toMatch(/auth_credential_by_login_id/);
    expect(svc).toMatch(/auth_password_credential/);
  });

  it("EXECUTE is limited to figbloom_app: PUBLIC and other roles are refused", async () => {
    // Credential + session-write definers granted to figbloom_app. Owner-only helpers
    // (install secret, consume proof, active secret) must NOT be executable by it.
    const eff = await ctx.pool.query<{ pub: boolean; app: boolean }>(
      `SELECT bool_or(has_function_privilege('public', p.oid, 'EXECUTE')) AS pub,
              bool_and(has_function_privilege('figbloom_app', p.oid, 'EXECUTE')) AS app
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef
          AND p.proname IN (
            'auth_credential_by_email',
            'auth_credential_by_login_id',
            'auth_password_credential',
            'auth_change_own_password',
            'auth_mint_session',
            'auth_touch_session',
            'auth_revoke_session',
            'auth_revoke_all_user_sessions',
            'auth_set_session_tenant'
          )`,
    );
    expect(eff.rows[0]).toEqual({ pub: false, app: true });
    const ownerOnly = await ctx.pool.query<{ name: string; app: boolean }>(
      `SELECT p.proname AS name,
              has_function_privilege('figbloom_app', p.oid, 'EXECUTE') AS app
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef
          AND p.proname IN (
            'auth_install_session_hmac_secret',
            'auth_consume_session_proof',
            'auth_active_session_hmac_secret'
          )
        ORDER BY 1`,
    );
    expect(ownerOnly.rows.every((r) => r.app === false)).toBe(true);

    const c = await ctx.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`CREATE ROLE probe_nogrant NOLOGIN`);
      await c.query(`GRANT probe_nogrant TO CURRENT_USER`);
      await c.query(`SET LOCAL ROLE probe_nogrant`);
      await expect(c.query(`SELECT * FROM public.auth_credential_by_email('admin-a@example.com')`)).rejects.toThrow(
        /permission denied for function/i,
      );
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  /** The attacker is figbloom_app itself, with TEMPORARY granted explicitly for the attack (not relying on its revocation). */
  async function shadowUsers(opts: { call: string; pre?: string }) {
    const db = (await ctx.pool.query("SELECT current_database() AS d")).rows[0].d as string;
    await ctx.pool.query(`GRANT TEMPORARY ON DATABASE ${db} TO figbloom_app`);
    const c = await ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL search_path = pg_temp, public`);
      await c.query(
        `CREATE TEMP TABLE users (id uuid, email text, password_hash text, status text, full_name text)`,
      );
      await c.query(
        `INSERT INTO pg_temp.users (id, email, password_hash, status, full_name) VALUES (gen_random_uuid(), 'admin-a@example.com', 'FAKE-ATTACKER-HASH', 'active', 'x')`,
      );
      const r = await c.query<{ password_hash: string }>(opts.call);
      return r.rows.map((x) => x.password_hash);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
      await ctx.pool.query(`REVOKE TEMPORARY ON DATABASE ${db} FROM figbloom_app`);
    }
  }

  it("hardened function ignores a temp 'users' shadow and returns the real hash", async () => {
    const hashes = await shadowUsers({
      call: `SELECT password_hash FROM public.auth_credential_by_email('admin-a@example.com')`,
    });
    expect(hashes).toHaveLength(1);
    expect(hashes[0]!.startsWith("$argon2id$")).toBe(true);
  });

  it("NC-D3 negative control: the same lookup written the pre-hardening way is hijacked by the shadow", async () => {
    // A definer function with search_path = public and an unqualified table (the 004 pattern).
    await ctx.pool.query(`
      CREATE OR REPLACE FUNCTION public.zz_vulnerable_credential(p_email text)
      RETURNS TABLE (password_hash text) LANGUAGE sql SECURITY DEFINER SET search_path = public
      AS $$ SELECT u.password_hash FROM users u WHERE u.email = p_email $$`);
    await ctx.pool.query(`GRANT EXECUTE ON FUNCTION public.zz_vulnerable_credential(text) TO figbloom_app`);
    try {
      const hashes = await shadowUsers({
        call: `SELECT password_hash FROM public.zz_vulnerable_credential('admin-a@example.com')`,
      });
      expect(hashes).toEqual(["FAKE-ATTACKER-HASH"]);
    } finally {
      await ctx.pool.query(`DROP FUNCTION public.zz_vulnerable_credential(text)`);
    }
  });

  it("documented residual: a known e-mail yields that one account's hash to arbitrary SQL, never a bulk read", async () => {
    const r = await withIdentityAccess(ctx.runtimePool, (db) =>
      db.query(`SELECT * FROM public.auth_credential_by_email($1)`, ["super@example.com"]),
    );
    expect(r.rowCount).toBe(1);
    // There is no argument that matches many accounts: NULL and '' match nothing.
    for (const key of [null, ""]) {
      const none = await withIdentityAccess(ctx.runtimePool, (db) =>
        db.query(`SELECT * FROM public.auth_credential_by_email($1)`, [key]),
      );
      expect(none.rowCount).toBe(0);
    }
  });

  it("login by login id, e-mail and password change still work end to end through the functions", async () => {
    const good = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/login-id",
      payload: { tenantId: ctx.ids.tenantA, loginId: "ad-0001", password: "correct-horse-battery" },
    });
    expect(good.statusCode).toBe(200);
    const bad = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/login-id",
      payload: { tenantId: ctx.ids.tenantA, loginId: "AD-0001", password: "wrong-password" },
    });
    expect(bad.statusCode).toBe(401);
    const unknown = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/login-id",
      payload: { tenantId: ctx.ids.tenantA, loginId: "ZZ-9999", password: "correct-horse-battery" },
    });
    expect(unknown.statusCode).toBe(401);
    // The other school's id for the same login id never signs in to this school.
    const cross = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/login-id",
      payload: { tenantId: ctx.ids.tenantB, loginId: "AD-0001", password: "correct-horse-battery" },
    });
    expect(cross.statusCode).toBe(401);
  });
});
