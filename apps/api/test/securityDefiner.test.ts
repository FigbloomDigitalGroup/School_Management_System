import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createTestApp } from "./support.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

const MIGRATIONS = join(process.cwd(), "migrations");

/** The pre-fix text of one function, taken from the historical migration file, not retyped. */
export function historicalFunction(file: string, name: string): string {
  const text = readFileSync(join(MIGRATIONS, file), "utf8");
  const m = new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\([\\s\\S]*?\\n\\$\\$;`).exec(text);
  if (!m) throw new Error(`function ${name} not found in ${file}`);
  return m[0];
}

interface FnRow {
  signature: string;
  owner: string;
  secdef: boolean;
  config: string[] | null;
  grantees: string[];
}

/**
 * Stage D inventory. Read from the LIVE catalogue of a freshly migrated database,
 * not from the migration files. Extension-owned functions (pgcrypto, installed by
 * the platform image) are not ours and are excluded by pg_depend.
 *
 * Completeness: a function added by a later migration that is not listed here
 * fails this test, so a new definer (or any new function) cannot arrive without
 * a reviewer deciding its owner, search_path and EXECUTE grants.
 */
const EXPECTED: Record<string, { secdef: boolean; grantees: string[]; why: string }> = {
  "app_current_tenant_id()": { secdef: false, grantees: ["figbloom_app"], why: "RLS helper evaluated by tenant policies" },
  "app_current_user_id()": { secdef: false, grantees: ["figbloom_app"], why: "RLS helper evaluated by the self-read policy" },
  "consume_rate_token(text,numeric,numeric,numeric,integer)": { secdef: false, grantees: ["figbloom_app"], why: "called by the API for the PG token bucket" },
  "prune_rate_buckets(interval)": { secdef: false, grantees: [], why: "housekeeping; not an API call" },
  "guardian_links_active_learner_guard()": { secdef: true, grantees: [], why: "trigger; takes FOR SHARE on learners, which figbloom_app cannot (no UPDATE)" },
  "school_memberships_on_archive()": { secdef: true, grantees: [], why: "trigger; clears grants and writes the audit row when a membership is archived" },
  "security_audit_events_guard()": { secdef: true, grantees: [], why: "trigger; append-only guard for the audit table" },
  "schema_migration_checksum_audit_append_only()": { secdef: false, grantees: [], why: "runner-created trigger (ensureBootstrap), not a migration object" },
  // Migration 011: the only way the runtime role can reach users.password_hash (exact key, one account).
  "auth_credential_by_email(text)": { secdef: true, grantees: ["figbloom_app"], why: "login by e-mail; returns (user id, hash, status) for one e-mail" },
  "auth_credential_by_login_id(uuid,text)": { secdef: true, grantees: ["figbloom_app"], why: "login by login id; one account per (school, login id)" },
  "auth_password_credential(uuid)": { secdef: true, grantees: ["figbloom_app"], why: "password change; the caller's own user id" },
  // Migration 013 (WP-A1 review R-02, R-04).
  "auth_change_own_password(uuid,text,text,inet)": { secdef: true, grantees: ["figbloom_app"], why: "the only write path to users.password_hash; account derived from the session, compare-and-swap, audited" },
  "prune_idempotency_keys(interval,integer)": { secdef: false, grantees: [], why: "owner-run housekeeping; not an API call" },
};

/** The only SECURITY DEFINER functions the runtime role may execute. */
const RUNTIME_EXECUTABLE_DEFINERS = [
  "auth_credential_by_email(text)",
  "auth_credential_by_login_id(uuid,text)",
  "auth_password_credential(uuid)",
  "auth_change_own_password(uuid,text,text,inet)",
];

async function inventory(pool: pg.Pool): Promise<FnRow[]> {
  const r = await pool.query<FnRow>(
    `SELECT p.oid::regprocedure::text AS signature,
            pg_get_userbyid(p.proowner) AS owner,
            p.prosecdef AS secdef,
            p.proconfig AS config,
            COALESCE(
              (SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                                ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END)
                 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                WHERE a.grantee <> p.proowner AND a.privilege_type = 'EXECUTE'),
              ARRAY[]::text[]) AS grantees
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
      ORDER BY 1`,
  );
  return r.rows;
}

describe("Stage D: SECURITY DEFINER and function inventory (live catalogue)", () => {
  let ctx: Ctx;
  let migrator: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    migrator = (await ctx.pool.query<{ u: string }>("SELECT current_user AS u")).rows[0]!.u;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("lists exactly the expected application functions (completeness)", async () => {
    const rows = await inventory(ctx.pool);
    expect(rows.map((r) => r.signature).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it("every function: owned by the migrator, pg_temp-last fixed search_path, no PUBLIC EXECUTE, only expected grantees", async () => {
    for (const row of await inventory(ctx.pool)) {
      const want = EXPECTED[row.signature]!;
      expect(row.owner, `${row.signature} owner`).toBe(migrator);
      expect(row.owner, `${row.signature} owner`).not.toBe("figbloom_app");
      expect(row.secdef, `${row.signature} secdef`).toBe(want.secdef);
      expect(row.config, `${row.signature} search_path`).toEqual(["search_path=pg_catalog, pg_temp"]);
      expect(row.grantees, `${row.signature} EXECUTE grantees`).toEqual(want.grantees);
      expect(row.grantees, `${row.signature} PUBLIC`).not.toContain("PUBLIC");
    }
  });

  it("each SECURITY DEFINER trigger function is owned by the owner of the table it guards", async () => {
    const r = await ctx.pool.query<{ fn: string; fn_owner: string; table_owner: string }>(
      `SELECT p.oid::regprocedure::text AS fn,
              pg_get_userbyid(p.proowner) AS fn_owner,
              pg_get_userbyid(c.relowner) AS table_owner
         FROM pg_trigger t
         JOIN pg_proc p ON p.oid = t.tgfoid
         JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND p.prosecdef`,
    );
    expect(r.rows.length).toBe(3);
    for (const row of r.rows) expect(row.fn_owner, row.fn).toBe(row.table_owner);
  });

  it("the runtime role owns no function and can execute only the four credential definers (no trigger function)", async () => {
    const owned = await ctx.pool.query(
      `SELECT 1 FROM pg_proc p WHERE pg_get_userbyid(p.proowner) = 'figbloom_app'`,
    );
    expect(owned.rowCount).toBe(0);
    const exec = await ctx.pool.query<{ sig: string }>(
      `SELECT p.oid::regprocedure::text AS sig
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef
          AND has_function_privilege('figbloom_app', p.oid, 'EXECUTE')`,
    );
    expect(exec.rows.map((r) => r.sig).sort()).toEqual([...RUNTIME_EXECUTABLE_DEFINERS].sort());
  });

  it("a function created later by the migrator is not executable by PUBLIC by default", async () => {
    const c = await ctx.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`CREATE FUNCTION public.zz_default_acl_probe() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
      const r = await c.query<{ public_exec: boolean }>(
        `SELECT has_function_privilege('public.zz_default_acl_probe()'::regprocedure, 'EXECUTE')
                AND EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0)
                AS public_exec
           FROM pg_proc p WHERE p.oid = 'public.zz_default_acl_probe()'::regprocedure`,
      );
      expect(r.rows[0]!.public_exec).toBe(false);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("a definer or helper added without being listed would fail the completeness check (negative control)", async () => {
    const c = await ctx.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        `CREATE FUNCTION public.zz_unlisted_definer() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`,
      );
      const names = (await inventory(c as unknown as pg.Pool)).map((r) => r.signature);
      expect(names).toContain("zz_unlisted_definer()");
      expect(Object.keys(EXPECTED)).not.toContain("zz_unlisted_definer()");
      const unlisted = (await inventory(c as unknown as pg.Pool)).filter((r) => !(r.signature in EXPECTED));
      expect(unlisted.map((r) => r.signature)).toEqual(["zz_unlisted_definer()"]);
      // ...and it would also fail the search_path rule.
      expect(unlisted[0]!.config).toBeNull();
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
});

describe("Stage D: temp-table and search_path shadowing attacks", () => {
  let ctx: Ctx;
  let membershipId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    const m = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM school_memberships WHERE user_id = $1 AND tenant_id = $2`,
      [ctx.ids.teacherA, ctx.ids.tenantA],
    );
    membershipId = m.rows[0]!.id;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  /**
   * The attacker is a purpose-built role that, unlike figbloom_app, may archive a
   * membership (a permissive policy models any future role or policy that can).
   * It creates TEMP tables with the names the trigger function uses and puts
   * pg_temp first in its search_path, then archives the membership.
   * Everything runs in one owner transaction that is rolled back, so no role,
   * policy, grant or function change survives. It does NOT rely on
   * REVOKE TEMPORARY: TEMPORARY is granted to the attacker explicitly.
   */
  async function archiveWithShadowTables(opts: { preFixFunction?: string }) {
    const c = await ctx.pool.connect();
    try {
      await c.query("BEGIN");
      if (opts.preFixFunction) await c.query(opts.preFixFunction);
      await c.query(`CREATE ROLE probe_attacker NOLOGIN`);
      await c.query(`GRANT probe_attacker TO CURRENT_USER`); // allow SET ROLE inside this rolled-back transaction
      await c.query(`GRANT TEMPORARY ON DATABASE ${(await c.query("SELECT current_database() AS d")).rows[0].d} TO probe_attacker`);
      await c.query(`GRANT USAGE ON SCHEMA public TO probe_attacker`);
      await c.query(`GRANT SELECT, UPDATE ON school_memberships TO probe_attacker`);
      await c.query(`CREATE POLICY probe_all ON school_memberships FOR ALL TO probe_attacker USING (true) WITH CHECK (true)`);

      // Real state: one grant and one audit baseline.
      await c.query(
        `INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'attendance')`,
        [ctx.ids.tenantA, ctx.ids.teacherA],
      );
      const before = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM security_audit_events WHERE event_type = 'membership.archived.authz_revoked'`,
      );

      await c.query(`SET LOCAL ROLE probe_attacker`);
      await c.query(`SET search_path = pg_temp, public`);
      await c.query(`CREATE TEMP TABLE staff_area_grants (tenant_id uuid, user_id uuid, area text, granted_by uuid, granted_at timestamptz)`);
      await c.query(`CREATE TEMP TABLE school_role_assignments (tenant_id uuid, user_id uuid, role_id uuid)`);
      await c.query(
        `CREATE TEMP TABLE security_audit_events (id uuid DEFAULT gen_random_uuid(), occurred_at timestamptz DEFAULT now(), actor_user_id uuid, tenant_id uuid, event_type text, detail jsonb DEFAULT '{}', ip inet)`,
      );
      await c.query(`INSERT INTO pg_temp.staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'decoy')`, [
        ctx.ids.tenantA,
        ctx.ids.teacherA,
      ]);
      await c.query(`UPDATE public.school_memberships SET archived_at = now() WHERE id = $1`, [membershipId]);
      const tempGrants = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_temp.staff_area_grants`);
      const tempAudit = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_temp.security_audit_events`);
      await c.query(`RESET ROLE`);
      await c.query(`RESET search_path`);

      const realGrants = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.staff_area_grants WHERE user_id = $1 AND tenant_id = $2`,
        [ctx.ids.teacherA, ctx.ids.tenantA],
      );
      const after = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.security_audit_events WHERE event_type = 'membership.archived.authz_revoked'`,
      );
      return {
        realGrants: Number(realGrants.rows[0]!.n),
        realAuditAdded: Number(after.rows[0]!.n) - Number(before.rows[0]!.n),
        tempGrantsLeft: Number(tempGrants.rows[0]!.n),
        tempAuditRows: Number(tempAudit.rows[0]!.n),
      };
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  }

  it("NC-D1 negative control: against the migration-004 definition the same attack neutralises the revocation and hides the audit row", async () => {
    const pre = historicalFunction("004_closure_roles_lifecycle_identity.sql", "school_memberships_on_archive");
    expect(pre).toContain("SET search_path = public");
    const r = await archiveWithShadowTables({ preFixFunction: pre });
    // The DELETE hit the attacker's temp table: the real grant survives, and the
    // audit row went into the attacker's temp table instead of the real audit log.
    expect(r.realGrants).toBe(1);
    expect(r.realAuditAdded).toBe(0);
    expect(r.tempAuditRows).toBe(1);
    expect(r.tempGrantsLeft).toBe(0);
  });

  it("hardened school_memberships_on_archive: real grants are cleared, the real audit row is written, shadow tables are untouched", async () => {
    const r = await archiveWithShadowTables({});
    expect(r.realGrants).toBe(0);
    expect(r.realAuditAdded).toBe(1);
    expect(r.tempAuditRows).toBe(0);
    expect(r.tempGrantsLeft).toBe(1); // the decoy row was not deleted
  });

  async function rateBucketShadow(opts: { preFixFunction?: string }) {
    const c = await ctx.pool.connect();
    try {
      await c.query("BEGIN");
      if (opts.preFixFunction) await c.query(opts.preFixFunction);
      const db = (await c.query("SELECT current_database() AS d")).rows[0].d as string;
      await c.query(`GRANT TEMPORARY ON DATABASE ${db} TO figbloom_app`);
      await c.query(`SET LOCAL ROLE figbloom_app`);
      await c.query(`SET search_path = pg_temp, public`);
      await c.query(
        `CREATE TEMP TABLE auth_rate_buckets (bucket_key text PRIMARY KEY, tokens numeric NOT NULL, last_refill timestamptz NOT NULL DEFAULT now())`,
      );
      await c.query(`SELECT * FROM consume_rate_token('zz-shadow-key', 1, 5, 2, 5000)`);
      const temp = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_temp.auth_rate_buckets`);
      await c.query(`RESET ROLE`);
      await c.query(`RESET search_path`);
      const real = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.auth_rate_buckets WHERE bucket_key = 'zz-shadow-key'`,
      );
      return { temp: Number(temp.rows[0]!.n), real: Number(real.rows[0]!.n) };
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  }

  it("NC-D2 negative control: the migration-003 consume_rate_token is hijacked by a temp table", async () => {
    const pre = historicalFunction("003_r2_remediation.sql", "consume_rate_token");
    const r = await rateBucketShadow({ preFixFunction: pre });
    expect(r).toEqual({ temp: 1, real: 0 });
  });

  it("hardened consume_rate_token always uses the real bucket table", async () => {
    const r = await rateBucketShadow({});
    expect(r).toEqual({ temp: 0, real: 1 });
  });

  it("an unqualified reference fails loudly instead of resolving through the caller's path", async () => {
    const c = await ctx.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        `CREATE FUNCTION public.zz_unqualified() RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
           SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN (SELECT count(*) FROM learners); END $$`,
      );
      await expect(c.query(`SELECT public.zz_unqualified()`)).rejects.toThrow(/relation "learners" does not exist/);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("guardian_links_active_learner_guard still refuses an archived learner while temp 'learners' shadows exist", async () => {
    const owner = ctx.pool;
    const db = (await owner.query("SELECT current_database() AS d")).rows[0].d as string;
    const learnerId = (
      await owner.query<{ id: string }>(
        `INSERT INTO learners (tenant_id, admission_no, full_name, gender, active, archived_at)
         VALUES ($1, 'ZZ-SHADOW', 'Shadow Archived', 'female', false, now()) RETURNING id`,
        [ctx.ids.tenantA],
      )
    ).rows[0]!.id;
    const guardianId = (
      await owner.query<{ id: string }>(
        `INSERT INTO guardians (tenant_id, full_name) VALUES ($1, 'Shadow Guardian') RETURNING id`,
        [ctx.ids.tenantA],
      )
    ).rows[0]!.id;
    await owner.query(`GRANT TEMPORARY ON DATABASE ${db} TO figbloom_app`);
    const c = await ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [ctx.ids.tenantA]);
      await c.query(`SET LOCAL search_path = pg_temp, public`);
      await c.query(
        `CREATE TEMP TABLE learners (id uuid, tenant_id uuid, active boolean DEFAULT true)`,
      );
      await c.query(`INSERT INTO pg_temp.learners (id, tenant_id, active) VALUES ($1, $2, true)`, [learnerId, ctx.ids.tenantA]);
      await expect(
        c.query(
          `INSERT INTO public.guardian_links (tenant_id, guardian_id, learner_id, relationship) VALUES ($1, $2, $3, 'mother')`,
          [ctx.ids.tenantA, guardianId, learnerId],
        ),
      ).rejects.toMatchObject({ code: "P0002" });
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
      await owner.query(`REVOKE TEMPORARY ON DATABASE ${db} FROM figbloom_app`);
      await owner.query(`DELETE FROM guardians WHERE id = $1`, [guardianId]);
      await owner.query(`DELETE FROM learners WHERE id = $1`, [learnerId]);
    }
  });
});
