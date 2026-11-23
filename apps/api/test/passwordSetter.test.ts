import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";
import { hashPassword } from "../src/modules/identity/password.js";
import { withIdentityAccess } from "../src/db/identityAccess.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

const MIGRATIONS = join(process.cwd(), "migrations");
const FIXTURE_PASSWORD = "correct-horse-battery";

/**
 * WP-A1 review R-02: the runtime role can no longer write users at all. The only way to
 * change a password hash is auth_change_own_password(session, current hash, new hash, ip).
 * Everything here runs as figbloom_app (ctx.runtimePool); effective privileges are read from
 * PostgreSQL, not from the migration text.
 */
describe("R-02: password hash write path (migration 013)", () => {
  let ctx: Ctx;
  let ids: FixtureIds;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  async function hashOf(userId: string): Promise<string> {
    const r = await ctx.pool.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
    return r.rows[0]!.password_hash;
  }

  async function newSession(userId: string, tenantId: string | null = null): Promise<string> {
    const id = randomUUID();
    await ctx.pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, active_tenant_id, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [id, userId, `th-${id}`, tenantId],
    );
    return id;
  }

  async function callSetter(sessionId: string, expected: string, next: string, ip: string | null = null): Promise<boolean> {
    const r = await withIdentityAccess(ctx.runtimePool, (db) =>
      db.query<{ ok: boolean }>(`SELECT public.auth_change_own_password($1::uuid, $2::text, $3::text, $4::inet) AS ok`, [
        sessionId,
        expected,
        next,
        ip,
      ]),
    );
    return r.rows[0]!.ok;
  }

  async function restoreHash(userId: string, hash: string): Promise<void> {
    await ctx.pool.query(`UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1`, [userId, hash]);
  }

  it("the runtime role holds no UPDATE privilege on users: effective table and every column", async () => {
    const eff = await ctx.pool.query<{ tbl: boolean }>(`SELECT has_table_privilege('figbloom_app', 'public.users', 'UPDATE') AS tbl`);
    expect(eff.rows[0]!.tbl).toBe(false);
    const cols = await ctx.pool.query<{ attname: string; upd: boolean }>(
      `SELECT a.attname, has_column_privilege('figbloom_app', 'public.users', a.attname, 'UPDATE') AS upd
         FROM pg_attribute a WHERE a.attrelid = 'public.users'::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
    );
    expect(cols.rows.length).toBeGreaterThan(5);
    expect(cols.rows.filter((c) => c.upd)).toEqual([]);
    // ...and no privilege the migration text could have left behind through a role membership or PUBLIC.
    const catalog = await ctx.pool.query(
      `SELECT 1 FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'users' AND privilege_type = 'UPDATE'
          AND grantee IN ('figbloom_app', 'PUBLIC')`,
    );
    expect(catalog.rowCount).toBe(0);
    // Negative control: the detection above sees a re-granted column privilege (rolled back).
    const c = await ctx.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`GRANT UPDATE (password_hash) ON TABLE public.users TO figbloom_app`);
      const regrant = await c.query<{ upd: boolean }>(
        `SELECT has_column_privilege('figbloom_app', 'public.users', 'password_hash', 'UPDATE') AS upd`,
      );
      expect(regrant.rows[0]!.upd).toBe(true);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("direct UPDATE of the hash (or any users column) as figbloom_app is refused, for any account including a super admin", async () => {
    const before = await hashOf(ids.superAdmin);
    const attempts: Array<[string, unknown[]]> = [
      [`UPDATE users SET password_hash = 'scrypt$1$1$1$AAAA$AAAA' WHERE id = $1`, [ids.superAdmin]],
      [`UPDATE users SET must_change_password = false WHERE id = $1`, [ids.superAdmin]],
      [`UPDATE users SET updated_at = now() WHERE id = $1`, [ids.superAdmin]],
      [`UPDATE users SET password_hash = 'scrypt$1$1$1$AAAA$AAAA'`, []],
    ];
    for (const [sql, params] of attempts) {
      await expect(withIdentityAccess(ctx.runtimePool, (db) => db.query(sql, params))).rejects.toThrow(
        /permission denied for table users/i,
      );
    }
    expect(await hashOf(ids.superAdmin)).toBe(before);
  });

  it("changes the hash for the session's own user, revokes the other sessions, keeps this one, and writes the audit row", async () => {
    const original = await hashOf(ids.teacherA);
    const keep = await newSession(ids.teacherA, ids.tenantA);
    const other = await newSession(ids.teacherA, ids.tenantA);
    const bystander = await newSession(ids.parentA, ids.tenantA);
    const next = await hashPassword("a-different-passphrase-1");
    try {
      expect(await callSetter(keep, original, next, "203.0.113.9")).toBe(true);
      expect(await hashOf(ids.teacherA)).toBe(next);
      const s = await ctx.pool.query<{ id: string; revoked: boolean }>(
        `SELECT id, revoked_at IS NOT NULL AS revoked FROM sessions WHERE id = ANY($1::uuid[])`,
        [[keep, other, bystander]],
      );
      const state = Object.fromEntries(s.rows.map((r) => [r.id, r.revoked]));
      expect(state[keep]).toBe(false);
      expect(state[other]).toBe(true);
      expect(state[bystander]).toBe(false);
      const audit = await ctx.pool.query<{ actor_user_id: string; tenant_id: string; detail: Record<string, unknown>; ip: string }>(
        `SELECT actor_user_id, tenant_id, detail, host(ip) AS ip FROM security_audit_events
          WHERE event_type = 'auth.password.changed' AND actor_user_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
        [ids.teacherA],
      );
      expect(audit.rows[0]).toMatchObject({ actor_user_id: ids.teacherA, tenant_id: ids.tenantA, ip: "203.0.113.9" });
      expect(audit.rows[0]!.detail).toEqual({ revokedOtherSessions: true, keptSessionId: keep });
      expect(JSON.stringify(audit.rows[0]!.detail)).not.toMatch(/scrypt/);
    } finally {
      await restoreHash(ids.teacherA, original);
    }
  });

  it("is not an arbitrary-user reset: another user's session cannot change the super admin's hash, with or without the right hash", async () => {
    // The shared fixtures give every user the same hash; make the victim's distinct so a
    // compare-and-swap match could only come from the victim's own row.
    const fixtureHash = await hashOf(ids.superAdmin);
    const superHash = await hashPassword("victim-super-admin-passphrase-1");
    await restoreHash(ids.superAdmin, superHash);
    const adminHash = await hashOf(ids.adminA);
    const adminSession = await newSession(ids.adminA, ids.tenantA);
    const next = await hashPassword("attacker-chosen-passphrase-1");
    try {
    // The caller names no account: the account is the session's user. Presenting the victim's
    // hash as "current" cannot redirect the write to the victim.
    expect(await callSetter(adminSession, superHash, next)).toBe(false);
    expect(await hashOf(ids.superAdmin)).toBe(superHash);
    expect(await hashOf(ids.adminA)).toBe(adminHash);
    // A wrong current hash for the session's own user changes nothing either.
    expect(await callSetter(adminSession, "scrypt$16384$8$1$AAAA$AAAA", next)).toBe(false);
    expect(await hashOf(ids.adminA)).toBe(adminHash);
    const noEvent = await ctx.pool.query(
      `SELECT 1 FROM security_audit_events WHERE event_type = 'auth.password.changed' AND actor_user_id = ANY($1::uuid[])
        AND detail->>'keptSessionId' = $2`,
      [[ids.superAdmin, ids.adminA], adminSession],
    );
    expect(noEvent.rowCount).toBe(0);
    } finally {
      await restoreHash(ids.superAdmin, fixtureHash);
    }
  });

  it("a super administrator can change their own password through their own session (and only that)", async () => {
    const original = await hashOf(ids.superAdmin);
    const session = await newSession(ids.superAdmin, null);
    const next = await hashPassword("super-admin-new-passphrase-1");
    try {
      expect(await callSetter(session, original, next)).toBe(true);
      expect(await hashOf(ids.superAdmin)).toBe(next);
      // A privileged org admin's hash is untouched by the super admin's change.
      expect(await hashOf(ids.orgAdmin)).not.toBe(next);
    } finally {
      await restoreHash(ids.superAdmin, original);
    }
  });

  it("refuses (false, no write) for a revoked, expired, unknown or disabled-user session and for malformed hashes", async () => {
    const original = await hashOf(ids.teacherB);
    const next = await hashPassword("refusal-matrix-passphrase-1");
    const revoked = await newSession(ids.teacherB);
    await ctx.pool.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [revoked]);
    const expired = await newSession(ids.teacherB);
    await ctx.pool.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [expired]);
    const live = await newSession(ids.teacherB);
    try {
      expect(await callSetter(revoked, original, next)).toBe(false);
      expect(await callSetter(expired, original, next)).toBe(false);
      expect(await callSetter(randomUUID(), original, next)).toBe(false);
      // malformed new hashes: plaintext, wrong prefix, bad characters, oversize, same as current
      for (const bad of ["plaintext-password", "bcrypt$10$abc$def", "scrypt$1$1$1$AA AA$AAAA", `scrypt$1$1$1$${"A".repeat(600)}$AAAA`, original]) {
        expect(await callSetter(live, original, bad), bad.slice(0, 20)).toBe(false);
      }
      expect(await hashOf(ids.teacherB)).toBe(original);
      // disabled user
      await ctx.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [ids.teacherB]);
      expect(await callSetter(live, original, next)).toBe(false);
      expect(await hashOf(ids.teacherB)).toBe(original);
    } finally {
      await ctx.pool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [ids.teacherB]);
    }
  });

  it("two concurrent changes from the same current hash: exactly one wins (compare-and-swap)", async () => {
    const original = await hashOf(ids.parentA);
    const session = await newSession(ids.parentA, ids.tenantA);
    const a = await hashPassword("concurrent-passphrase-A-1");
    const b = await hashPassword("concurrent-passphrase-B-1");
    try {
      const results = await Promise.all([callSetter(session, original, a), callSetter(session, original, b)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect([a, b]).toContain(await hashOf(ids.parentA));
      const events = await ctx.pool.query(
        `SELECT 1 FROM security_audit_events WHERE event_type = 'auth.password.changed' AND detail->>'keptSessionId' = $1`,
        [session],
      );
      expect(events.rowCount).toBe(1);
    } finally {
      await restoreHash(ids.parentA, original);
    }
  });

  it("over HTTP, a concurrent double submit of the same change succeeds once and refuses the other", async () => {
    const login = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email: "admin-a@example.com", password: FIXTURE_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const token = login.json().token as string;
    const original = await hashOf(ids.adminA);
    try {
      const send = (newPassword: string) =>
        ctx.app.inject({
          method: "POST",
          url: "/v1/auth/password/change",
          headers: { authorization: `Bearer ${token}` },
          payload: { currentPassword: FIXTURE_PASSWORD, newPassword },
        });
      const [r1, r2] = await Promise.all([send("http-double-submit-A-1"), send("http-double-submit-B-1")]);
      const codes = [r1.statusCode, r2.statusCode].sort();
      expect(codes).toEqual([200, 401]);
    } finally {
      await restoreHash(ids.adminA, original);
    }
  });

  it("EXECUTE is granted to figbloom_app only; PUBLIC and other roles are refused; the function is a hardened definer", async () => {
    const meta = await ctx.pool.query<{ secdef: boolean; owner: string; config: string[]; pub: boolean; app: boolean }>(
      `SELECT p.prosecdef AS secdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
              has_function_privilege('figbloom_app', p.oid, 'EXECUTE') AS app
         FROM pg_proc p WHERE p.oid = 'public.auth_change_own_password(uuid,text,text,inet)'::regprocedure`,
    );
    expect(meta.rows[0]).toMatchObject({ secdef: true, config: ["search_path=pg_catalog, pg_temp"], pub: false, app: true });
    expect(meta.rows[0]!.owner).not.toBe("figbloom_app");

    const c = await ctx.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`CREATE ROLE probe_pw_nogrant NOLOGIN`);
      await c.query(`GRANT probe_pw_nogrant TO CURRENT_USER`);
      await c.query(`SET LOCAL ROLE probe_pw_nogrant`);
      await expect(
        c.query(`SELECT public.auth_change_own_password(gen_random_uuid(), 'x', 'y', NULL)`),
      ).rejects.toThrow(/permission denied for function/i);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("shadowing: temp tables named users/sessions created by the caller do not redirect the definer", async () => {
    const original = await hashOf(ids.teacherA);
    const db = (await ctx.pool.query<{ d: string }>("SELECT current_database() AS d")).rows[0]!.d;
    await ctx.pool.query(`GRANT TEMPORARY ON DATABASE ${db} TO figbloom_app`);
    const victimSession = randomUUID();
    const c = await ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL search_path = pg_temp, public`);
      await c.query(
        `CREATE TEMP TABLE sessions (id uuid, user_id uuid, active_tenant_id uuid, expires_at timestamptz, revoked_at timestamptz)`,
      );
      await c.query(`CREATE TEMP TABLE users (id uuid, status text, password_hash text, must_change_password boolean, updated_at timestamptz)`);
      await c.query(`INSERT INTO pg_temp.users VALUES ($1, 'active', 'FAKE', false, now())`, [ids.teacherA]);
      await c.query(`INSERT INTO pg_temp.sessions VALUES ($1, $2, NULL, now() + interval '1 hour', NULL)`, [victimSession, ids.teacherA]);
      // Control: an unqualified reference in this connection IS fooled by the shadow tables.
      const control = await c.query(`SELECT count(*)::int AS n FROM sessions WHERE id = $1`, [victimSession]);
      expect(control.rows[0].n).toBe(1);
      const next = await hashPassword("shadow-attempt-passphrase-1");
      const r = await c.query<{ ok: boolean }>(`SELECT public.auth_change_own_password($1, 'FAKE', $2, NULL) AS ok`, [victimSession, next]);
      expect(r.rows[0]!.ok).toBe(false);
    } finally {
      await c.query("ROLLBACK");
      c.release();
      await ctx.pool.query(`REVOKE TEMPORARY ON DATABASE ${db} FROM figbloom_app`);
    }
    expect(await hashOf(ids.teacherA)).toBe(original);
  });
});

describe("R-04: idempotency housekeeping (migration 013)", () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await createTestApp();
  }, 120_000);
  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  async function insertKey(label: string, expiresInterval: string): Promise<void> {
    await ctx.pool.query(
      `INSERT INTO idempotency_keys (tenant_id, actor_user_id, idempotency_key, route, fingerprint, expires_at)
       VALUES ($1, $2, $3, 'POST /v1/learners', $4, now() + $5::interval)`,
      [ctx.ids.tenantA, ctx.ids.adminA, `housekeeping-${label}`, "a".repeat(64), expiresInterval],
    );
  }

  it("is owner-only: the runtime role can neither execute it nor delete from the table", async () => {
    const eff = await ctx.pool.query<{ app: boolean; pub: boolean }>(
      `SELECT has_function_privilege('figbloom_app', 'public.prune_idempotency_keys(interval,integer)', 'EXECUTE') AS app,
              has_function_privilege('public', 'public.prune_idempotency_keys(interval,integer)', 'EXECUTE') AS pub`,
    );
    expect(eff.rows[0]).toEqual({ app: false, pub: false });
    await expect(
      withIdentityAccess(ctx.runtimePool, (db) => db.query(`SELECT public.prune_idempotency_keys()`)),
    ).rejects.toThrow(/permission denied for function/i);
    await expect(
      withIdentityAccess(ctx.runtimePool, (db) => db.query(`DELETE FROM idempotency_keys`)),
    ).rejects.toThrow(/permission denied/i);
  });

  it("deletes only expired rows, honours the grace period and the batch size, and returns the count", async () => {
    await ctx.pool.query(`DELETE FROM idempotency_keys`);
    await insertKey("expired-1", "-2 hours");
    await insertKey("expired-2", "-3 hours");
    await insertKey("expired-3", "-10 minutes");
    await insertKey("live-1", "1 hour");
    const count = async () => (await ctx.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM idempotency_keys`)).rows[0]!.n;
    expect(await count()).toBe(4);

    // grace keeps rows expired less than 1 hour ago
    const withGrace = await ctx.pool.query<{ n: string }>(`SELECT public.prune_idempotency_keys(interval '1 hour', 10) AS n`);
    expect(Number(withGrace.rows[0]!.n)).toBe(2);
    expect(await count()).toBe(2);
    // batch size bounds one call; repeat until zero
    await insertKey("expired-4", "-1 hours");
    await insertKey("expired-5", "-1 hours");
    const first = await ctx.pool.query<{ n: string }>(`SELECT public.prune_idempotency_keys(interval '0', 1) AS n`);
    expect(Number(first.rows[0]!.n)).toBe(1);
    const rest = await ctx.pool.query<{ n: string }>(`SELECT public.prune_idempotency_keys(interval '0', 100) AS n`);
    expect(Number(rest.rows[0]!.n)).toBe(2);
    const again = await ctx.pool.query<{ n: string }>(`SELECT public.prune_idempotency_keys() AS n`);
    expect(Number(again.rows[0]!.n)).toBe(0);
    // the unexpired key is untouched
    const left = await ctx.pool.query<{ idempotency_key: string }>(`SELECT idempotency_key FROM idempotency_keys`);
    expect(left.rows.map((r) => r.idempotency_key)).toEqual(["housekeeping-live-1"]);
  });

  it("has an index on the actor FK and the expiry column", async () => {
    const r = await ctx.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'idempotency_keys'`,
    );
    const names = r.rows.map((x) => x.indexname);
    expect(names).toContain("idempotency_keys_expires_idx");
    expect(names).toContain("idempotency_keys_actor_idx");
  });
});

describe("Bug report: runtime role attributes (migrations 004 and 013)", () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await createTestApp();
  }, 120_000);
  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("the CREATE ROLE statement of migration 004, executed verbatim under another name, yields NOLOGIN NOINHERIT and no privileged attribute", async () => {
    const text = readFileSync(join(MIGRATIONS, "004_closure_roles_lifecycle_identity.sql"), "utf8");
    const m = /CREATE ROLE figbloom_app ([A-Z ]+);/.exec(text);
    expect(m, "CREATE ROLE statement not found in 004").not.toBeNull();
    const c = await ctx.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`CREATE ROLE probe_004_role ${m![1]}`);
      const r = await c.query(
        `SELECT rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication,
                rolpassword IS NULL AS no_password_field
           FROM pg_authid WHERE rolname = 'probe_004_role'`,
      );
      expect(r.rows[0]).toEqual({
        rolcanlogin: false,
        rolinherit: false,
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        no_password_field: true,
      });
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("the live runtime role carries no privileged attribute (and holds no password-less LOGIN outside a running test)", async () => {
    const r = await ctx.pool.query<Record<string, boolean>>(
      `SELECT rolinherit, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = 'figbloom_app'`,
    );
    expect(r.rows[0]).toEqual({ rolinherit: false, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false });
    // The test harness enables LOGIN with a random password; a LOGIN role must always have one.
    const login = await ctx.pool.query<{ rolcanlogin: boolean; has_password: boolean }>(
      `SELECT rolcanlogin, rolpassword IS NOT NULL AS has_password FROM pg_authid WHERE rolname = 'figbloom_app'`,
    );
    if (login.rows[0]!.rolcanlogin) expect(login.rows[0]!.has_password).toBe(true);
  });

  it("migration 013 refuses to run when the runtime role carries a privileged attribute (changes nothing)", async () => {
    const sql = readFileSync(join(MIGRATIONS, "013_password_setter_and_housekeeping.sql"), "utf8");
    const block = /DO \$\$\n[\s\S]*?\n\$\$;\n?$/.exec(sql)![0];
    for (const attr of ["CREATEDB", "CREATEROLE", "INHERIT"]) {
      const c = await ctx.pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(`ALTER ROLE figbloom_app ${attr}`);
        await expect(c.query(block), attr).rejects.toThrow(/privileged attribute/);
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    }
    // control: the same block passes on the real, correctly provisioned role
    await expect(ctx.pool.query(block)).resolves.toBeDefined();
  });
});
