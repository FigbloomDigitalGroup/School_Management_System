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
  "guardian_links_active_learner_guard()": { secdef: true, grantees: [], why: "trigger; FOR SHARE on learners via SECURITY DEFINER (race-safe archived-learner guard)" },
  "directory_update_tenant_identity(text,text)": { secdef: true, grantees: ["figbloom_app"], why: "audited school name/timezone update; tenants remain SELECT-only for figbloom_app" },
  // Migrations 021-022 (Phase 3 remediation): invoker-rights trigger functions. NOT definers: they read
  // only through the caller's own tenant policy, so they widen nothing.
  "directory_documents_before_insert()": { secdef: false, grantees: [], why: "trigger; server-generated storage key + same-tenant subject guard (F-04)" },
  "school_profiles_before_insert()": { secdef: false, grantees: [], why: "trigger; discards any client-supplied logo_object_key, the INSERT half of P3-AUDIT-005 (audit A-04)" },
  "directory_documents_before_update()": { secdef: false, grantees: [], why: "trigger; document identity/storage fields immutable, archive one-way (F-04)" },
  "staff_members_check_user_link()": { secdef: false, grantees: [], why: "trigger; a staff record may only link a user with an active membership in the same school (S-01)" },
  "school_memberships_on_archive()": { secdef: true, grantees: [], why: "trigger; clears grants and writes the audit row when a membership is archived" },
  "security_audit_events_guard()": { secdef: true, grantees: [], why: "trigger; append-only guard for the audit table" },
  "schema_migration_checksum_audit_append_only()": { secdef: false, grantees: [], why: "runner-created trigger (ensureBootstrap), not a migration object" },
  // Migration 011: the only way the runtime role can reach users.password_hash (exact key, one account).
  // Migration 025 (FIG-1609 hardening, FIG-1614 Option D).
  "is_delegable_permission(text)": { secdef: false, grantees: ["figbloom_app"], why: "pure allowlist predicate; no table access" },
  "org_delegation_guard()": { secdef: true, grantees: [], why: "trigger; allowlist + FOR SHARE on tenants/users so a grant cannot race a suspension or a disabled recipient" },
  "staff_resource_grants_guard()": { secdef: true, grantees: [], why: "trigger; grantee must be an active teacher/staff member of the school (FOR SHARE)" },
  "staff_resource_grants_on_membership_change()": { secdef: true, grantees: [], why: "trigger; archive, role change or delete of a membership revokes its guardian grants so a restore cannot revive them" },
  // Migration 026 (delegation lifecycle): invalidation on user, membership and organization changes.
  "invalidate_org_delegations(uuid,uuid,text)": { secdef: true, grantees: [], why: "internal helper; revokes active delegations (final, audited) when the authorization relationship changes" },
  "invalidate_guardian_grants(uuid,uuid,text)": { secdef: true, grantees: [], why: "internal helper; revokes active explicit guardian grants (final, audited)" },
  "users_status_invalidates_grants()": { secdef: true, grantees: [], why: "trigger; a disabled user loses delegations and guardian grants for good" },
  "org_membership_invalidates_delegations()": { secdef: true, grantees: [], why: "trigger; removing, moving or changing an organization membership revokes its delegations" },
  "organizations_status_invalidates_delegations()": { secdef: true, grantees: [], why: "trigger; an organization leaving 'active' revokes every delegation in it" },
  "org_delegation_immutable_guard()": { secdef: false, grantees: [], why: "trigger; delegation identity/code/grantor immutable, revocation final (review M-1)" },
  "staff_resource_grants_immutable_guard()": { secdef: false, grantees: [], why: "trigger; grant identity/code/grantor immutable, revocation final (review M-1)" },
  "auth_credential_by_email(text)": { secdef: true, grantees: ["figbloom_app"], why: "login by e-mail; returns (user id, hash, status) for one e-mail" },
  "auth_credential_by_login_id(uuid,text)": { secdef: true, grantees: ["figbloom_app"], why: "login by login id; one account per (school, login id)" },
  "auth_password_credential(uuid)": { secdef: true, grantees: ["figbloom_app"], why: "password change; the caller's own user id" },
  // Migration 013 (WP-A1 review R-02, R-04).
  "auth_change_own_password(uuid,text,text,inet)": { secdef: true, grantees: ["figbloom_app"], why: "the only write path to users.password_hash; account derived from the session, compare-and-swap, audited" },
  "prune_idempotency_keys(interval,integer)": { secdef: false, grantees: [], why: "owner-run housekeeping; not an API call" },
  // Migration 014 (OD-1 / R-02 session mint containment).
  "auth_hmac_sha256_hex(bytea,bytea)": { secdef: false, grantees: [], why: "internal HMAC helper; not an API call" },
  "auth_hmac_hex_equals(text,text)": { secdef: false, grantees: [], why: "internal constant-time compare; not an API call" },
  "auth_active_session_hmac_secret()": { secdef: true, grantees: [], why: "reads owner-only secret; called only by other definers" },
  "auth_consume_session_proof(text,text,text,timestamp with time zone,text,interval)": {
    secdef: true,
    grantees: [],
    why: "proof verify + nonce consume; called only by other definers",
  },
  "auth_install_session_hmac_secret(text,text)": { secdef: true, grantees: [], why: "owner/migrator installs HMAC secret; never executable by figbloom_app" },
  // Migration 015 (provisioning safety, nonce housekeeping, tenant eligibility).
  "auth_session_hmac_matches(text,text)": { secdef: false, grantees: [], why: "internal verify against active keys; called only by definers" },
  "auth_rotate_session_hmac_secret(text,text)": { secdef: true, grantees: [], why: "owner-run rotation step 1 (adds a second active key)" },
  "auth_retire_session_hmac_secret(text)": { secdef: true, grantees: [], why: "owner-run rotation step 2 (retires a key; never the last one)" },
  "auth_session_hmac_status(text,text)": { secdef: true, grantees: ["figbloom_app"], why: "readiness self-test: ok / mismatch / no_secret; selftest payloads only, no key material" },
  "auth_purge_session_proof_nonces(integer)": { secdef: true, grantees: [], why: "owner-run bounded nonce housekeeping; not an API call" },
  "auth_session_tenant_eligible(uuid,uuid)": { secdef: false, grantees: [], why: "internal tenant eligibility rules; called only by auth_set_session_tenant" },
  "auth_mint_session(uuid,text,timestamp with time zone,uuid,uuid,text,inet,text,uuid,timestamp with time zone,text,text)": {
    secdef: true,
    grantees: ["figbloom_app"],
    why: "only INSERT path for sessions; HMAC proof required",
  },
  "auth_touch_session(text,double precision)": {
    secdef: true,
    grantees: ["figbloom_app"],
    why: "session validate + throttled last_seen write",
  },
  "auth_revoke_session(uuid,uuid,timestamp with time zone,text,text)": {
    secdef: true,
    grantees: ["figbloom_app"],
    why: "session revoke with HMAC proof",
  },
  "auth_revoke_all_user_sessions(uuid,uuid,uuid,timestamp with time zone,text,text)": {
    secdef: true,
    grantees: ["figbloom_app"],
    why: "bulk revoke with HMAC proof",
  },
  "auth_set_session_tenant(uuid,uuid,uuid,uuid,timestamp with time zone,text,text)": {
    secdef: true,
    grantees: ["figbloom_app"],
    why: "select-tenant write with HMAC proof",
  },
  // Migration 029: class membership year/learner guard. Trigger only.
  "class_memberships_integrity_guard()": {
    secdef: true,
    grantees: [],
    why: "trigger; class year and active-learner checks without widening the caller's grants",
  },
  // Migrations 030–031: storage keys for metadata-only rows. Invoker triggers.
  "learning_materials_before_insert()": {
    secdef: false,
    grantees: [],
    why: "trigger; discards a client storage key and forces metadata_only",
  },
  "evidence_assets_before_insert()": {
    secdef: false,
    grantees: [],
    why: "trigger; discards a client storage key and forces metadata_only",
  },
  // Migration 033: attendance register rules and the counting twin. Not definers.
  "attendance_afternoon_allowed()": {
    secdef: false,
    grantees: [],
    why: "trigger; refuses an afternoon insert while the school register is off (SQLSTATE 23514)",
  },
  "attendance_register_guard()": {
    secdef: false,
    grantees: [],
    why: "trigger; school-today and term window, newest marked_at wins, identical replay is a no-op",
  },
  "attendance_counted(uuid,uuid)": {
    secdef: false,
    grantees: ["figbloom_app"],
    why: "session/day counting twin; invoker so RLS still applies; live early sign-out drops afternoon absent/excused",
  },
  // Migration 034 (Stage 9/10 independent review): integrity triggers. Invokers, no grantees.
  "early_sign_outs_void_once()": {
    secdef: false,
    grantees: [],
    why: "trigger; an early sign-out goes live -> voided once, at the database clock (R10-3)",
  },
  "early_sign_out_collectors_guard()": {
    secdef: false,
    grantees: [],
    why: "trigger; collector details immutable, void reason set once and only on a voided sign-out (R10-3)",
  },
  "online_exam_attempts_forward_only()": {
    secdef: false,
    grantees: [],
    why: "trigger; a submitted attempt is final (A9-4)",
  },
  "mark_entries_version_step()": {
    secdef: false,
    grantees: [],
    why: "trigger; every mark UPDATE advances row_version by exactly one (A9-15)",
  },
  // Migration 035 (owner decisions): revision-gated changes, forward-only status, paged counting. Invokers.
  "mark_corrections_before_insert()": {
    secdef: false,
    grantees: [],
    why: "trigger; a mark correction must name the current score/grade and the next row_version (OD-1)",
  },
  "mark_entries_publication_lock()": {
    secdef: false,
    grantees: [],
    why: "trigger; a mark of a non-draft assessment changes only with its matching correction row (OD-1)",
  },
  "assessments_status_forward_only()": {
    secdef: false,
    grantees: [],
    why: "trigger; a published assessment cannot return to draft to unlock its marks (OD-1)",
  },
  "cbe_result_revisions_before_insert()": {
    secdef: false,
    grantees: [],
    why: "trigger; a CBE revision must name the current result and the next row_version (OD-3)",
  },
  "cbe_results_revision_required()": {
    secdef: false,
    grantees: [],
    why: "trigger; a CBE result changes only with its matching revision row (OD-3)",
  },
  "cbe_results_first_version()": {
    secdef: false,
    grantees: [],
    why: "trigger; a new CBE result starts at row_version 1 (OD-3)",
  },
  "he_grade_revisions_before_insert()": {
    secdef: false,
    grantees: [],
    why: "trigger; an HE grade revision must name the current grade and the next row_version (OD-5)",
  },
  "he_grades_guard()": {
    secdef: false,
    grantees: [],
    why: "trigger; first grade only for an enrolled learner; later changes only with a revision row (OD-5)",
  },
  "attendance_counted_page(uuid,uuid,uuid,date,uuid,text,integer)": {
    secdef: false,
    grantees: ["figbloom_app"],
    why: "paged counting twin (OD-4); invoker so RLS still applies; same rules as attendance_counted",
  },
};

/** The only SECURITY DEFINER functions the runtime role may execute. */
const RUNTIME_EXECUTABLE_DEFINERS = [
  "auth_credential_by_email(text)",
  "auth_credential_by_login_id(uuid,text)",
  "auth_password_credential(uuid)",
  "auth_change_own_password(uuid,text,text,inet)",
  "auth_mint_session(uuid,text,timestamp with time zone,uuid,uuid,text,inet,text,uuid,timestamp with time zone,text,text)",
  "auth_touch_session(text,double precision)",
  "auth_revoke_session(uuid,uuid,timestamp with time zone,text,text)",
  "auth_revoke_all_user_sessions(uuid,uuid,uuid,timestamp with time zone,text,text)",
  "auth_set_session_tenant(uuid,uuid,uuid,uuid,timestamp with time zone,text,text)",
  "auth_session_hmac_status(text,text)",
  "directory_update_tenant_identity(text,text)",
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
    // 3 before migration 025, plus org_delegation_guard, staff_resource_grants_guard and the
    // membership-change function, which is attached twice (UPDATE and DELETE). Migration 026 adds
    // four: users (status), organizations (status) and organization_memberships (UPDATE and DELETE).
    // Migration 029 adds class_memberships_integrity_guard. Later attendance triggers are invokers.
    expect(r.rows.length).toBe(12);
    for (const row of r.rows) expect(row.fn_owner, row.fn).toBe(row.table_owner);
  });

  it("the runtime role owns no function and can execute only the allowlisted definers (no trigger function)", async () => {
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
