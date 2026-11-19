import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";
import { MIGRATIONS_DIR, tablesCreatedFrom } from "./support/migrationTables.js";

/**
 * Stage 9–10 tenant tables: every table created by migration 029 or LATER. Review fix (Claude, 2026-11-19):
 * the earlier upper bound of 033 (with the Phase 3 inventory now capped at 028) meant a table added by a
 * future migration was covered by no catalogue check at all. Leave this range open-ended.
 */
const STAGE910_TABLES = tablesCreatedFrom(29, MIGRATIONS_DIR);

describe("Stage 9/10 RLS catalogue", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("migrations 029–033 create the expected tenant-owned tables", () => {
    expect(STAGE910_TABLES.length).toBeGreaterThan(10);
    for (const required of [
      "academic_years",
      "classes",
      "class_memberships",
      "assessments",
      "mark_entries",
      "curriculum_provenance",
      "learning_areas",
      "attendance",
      "attendance_afternoon",
      "early_sign_outs",
      "early_sign_out_collectors",
    ]) {
      expect(STAGE910_TABLES).toContain(required);
    }
  });

  it("every Stage 9/10 table has ENABLE + FORCE RLS and a figbloom_app tenant policy", async () => {
    expect(STAGE910_TABLES.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const table of STAGE910_TABLES) {
      const flags = await ctx.pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
        [table],
      );
      const f = flags.rows[0];
      const policies = await ctx.pool.query<{ polname: string }>(
        `SELECT pol.polname::text AS polname
           FROM pg_policy pol
           JOIN pg_class c ON c.oid = pol.polrelid
          WHERE c.relname = $1 AND c.relnamespace = 'public'::regnamespace
            AND pg_get_userbyid(pol.polroles[1]) = 'figbloom_app'`,
        [table],
      );
      // attendance_settings uses tenant_id as PK; still must be RLS-forced.
      if (!f?.relrowsecurity || !f?.relforcerowsecurity || policies.rowCount === 0) {
        bad.push(table);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every figbloom_app policy on these tables is exactly the tenant predicate, and no table grants UPDATE/DELETE wholesale", async () => {
    const bad: string[] = [];
    for (const table of STAGE910_TABLES) {
      const policies = await ctx.pool.query<{ policyname: string; roles: string[]; qual: string | null; with_check: string | null }>(
        `SELECT policyname, roles::text[] AS roles, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
        [table],
      );
      for (const p of policies.rows) {
        if (p.roles.includes("figbloom_app")) {
          const tenantOnly = "(tenant_id = app_current_tenant_id())";
          if (p.qual !== tenantOnly || p.with_check !== tenantOnly) bad.push(`${table}.${p.policyname}: ${p.qual} / ${p.with_check}`);
        } else if (!p.policyname.endsWith("_owner")) {
          bad.push(`${table}.${p.policyname}: unexpected policy for ${p.roles.join(",")}`);
        }
      }
      const grants = await ctx.pool.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND table_name = $1 AND grantee = 'figbloom_app'
            AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')`,
        [table],
      );
      for (const g of grants.rows) bad.push(`${table}: table-level ${g.privilege_type} granted`);
    }
    expect(bad).toEqual([]);
  });

  it("migration files 029–033 remain forward-only (no edits to 001–028)", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f));
    for (const file of files) {
      const n = Number(file.split("_")[0]);
      if (n < 29) continue;
      const sql = readFileSync(`${MIGRATIONS_DIR}${file}`, "utf8");
      expect(sql, file).toMatch(/Forward-only/i);
    }
  });
});
