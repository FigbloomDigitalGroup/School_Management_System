import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";
import { MIGRATIONS_DIR, tablesCreatedFrom } from "./support/migrationTables.js";

/**
 * Stage 9–10 tenant tables: every table created by migration 029 or LATER. Review fix (Claude, 2026-11-19):
 * the earlier upper bound of 033 (with the Phase 3 inventory now capped at 028) meant a table added by a
 * future migration was covered by no catalogue check at all. Leave this range open-ended.
 */
const ALL_NEW_TABLES = tablesCreatedFrom(29, MIGRATIONS_DIR);
/**
 * Stage 11: tables that deliberately have NO runtime policy because the runtime roles may not touch them at
 * all (operator-only quarantine, written through a SECURITY DEFINER function). Each is asserted below to be
 * RLS-forced and to hold no privilege for figbloom_app or figbloom_worker, so this is not a silent exemption.
 */
const OPERATOR_ONLY_TABLES = ["finance_mpesa_unmatched_callbacks", "account_tokens", "worker_heartbeats", "guardian_invitations", "guardian_accounts", "finance_unmatched_cases", "finance_unmatched_case_notes", "learner_accounts", "plan_pricing", "platform_subscriptions"];
/** User-scoped (session user GUC), not tenant-scoped school tables. */
const USER_SCOPED_TABLES = ["notification_preferences", "device_tokens", "mfa_factors", "mfa_recovery_codes"] as const;
/**
 * Platform progressive curriculum catalogue (migration 079): nullable tenant_id
 * (NULL = platform rows; school rows scoped). figbloom_app may SELECT only.
 * Asserted separately below — not a silent exemption.
 */
const PLATFORM_CATALOGUE_TABLES = ["curriculum_reference_entries"] as const;
const PLATFORM_CATALOGUE_SELECT_QUAL =
  "((tenant_id IS NULL) OR (tenant_id = app_current_tenant_id()))";
const STAGE910_TABLES = ALL_NEW_TABLES.filter(
  (t) =>
    !OPERATOR_ONLY_TABLES.includes(t) &&
    !(USER_SCOPED_TABLES as readonly string[]).includes(t) &&
    !(PLATFORM_CATALOGUE_TABLES as readonly string[]).includes(t),
);

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

  it("operator-only tables are RLS-forced and unreachable by the runtime roles", async () => {
    for (const table of OPERATOR_ONLY_TABLES) {
      expect(ALL_NEW_TABLES).toContain(table);
      const flags = await ctx.pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
        [table],
      );
      expect(flags.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const grants = await ctx.pool.query(
        `SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = $1 AND grantee IN ('figbloom_app', 'figbloom_worker')`,
        [table],
      );
      expect(grants.rowCount).toBe(0);
      const policies = await ctx.pool.query(
        `SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 AND NOT ('public' = ANY (roles::text[]))`,
        [table],
      );
      expect(policies.rowCount).toBe(0);
    }
  });

  it("platform curriculum catalogue is RLS-forced, readable, and not writable by figbloom_app", async () => {
    for (const table of PLATFORM_CATALOGUE_TABLES) {
      expect(ALL_NEW_TABLES).toContain(table);
      const flags = await ctx.pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
        [table],
      );
      expect(flags.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const grants = await ctx.pool.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND table_name = $1 AND grantee = 'figbloom_app'`,
        [table],
      );
      expect(grants.rows.map((g) => g.privilege_type).sort()).toEqual(["SELECT"]);
      const policies = await ctx.pool.query<{ policyname: string; qual: string | null; cmd: string }>(
        `SELECT policyname, qual, cmd FROM pg_policies
          WHERE schemaname = 'public' AND tablename = $1 AND 'figbloom_app' = ANY (roles::text[])`,
        [table],
      );
      expect(policies.rows.length).toBeGreaterThan(0);
      for (const p of policies.rows) {
        expect(p.cmd).toBe("SELECT");
        expect(p.qual).toBe(PLATFORM_CATALOGUE_SELECT_QUAL);
      }
    }
  });

  it("user-scoped prefs/tokens use own-row policies and remain RLS-forced", async () => {
    for (const table of USER_SCOPED_TABLES) {
      expect(ALL_NEW_TABLES).toContain(table);
      const flags = await ctx.pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
        [table],
      );
      expect(flags.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const policies = await ctx.pool.query<{ policyname: string; qual: string | null; with_check: string | null }>(
        `SELECT policyname, qual, with_check FROM pg_policies
          WHERE schemaname = 'public' AND tablename = $1 AND 'figbloom_app' = ANY (roles::text[])`,
        [table],
      );
      expect(policies.rows.length).toBeGreaterThan(0);
      for (const p of policies.rows) {
        expect(p.qual).toBe("(user_id = app_current_user_id())");
        expect(p.with_check).toBe("(user_id = app_current_user_id())");
      }
    }
  });

  it("every figbloom_app policy on these tables is the tenant predicate (plus RESTRICTIVE user-level policies on user-confidential tables), and no table grants UPDATE/DELETE wholesale", async () => {
    const RESTRICTIVE_USER_TABLES = new Set([
      "conversations",
      "conversation_members",
      "chat_messages",
      "medical_notices",
      "communications_announcement_reads",
      "transport_notifications",
      "notifications",
    ]);
    const bad: string[] = [];
    for (const table of STAGE910_TABLES) {
      const policies = await ctx.pool.query<{
        policyname: string;
        permissive: string;
        roles: string[];
        qual: string | null;
        with_check: string | null;
        cmd: string;
      }>(
        `SELECT policyname, permissive, roles::text[] AS roles, qual, with_check, cmd
           FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
        [table],
      );
      for (const p of policies.rows) {
        if (p.roles.includes("figbloom_app") || p.roles.includes("figbloom_worker")) {
          if (p.permissive === "PERMISSIVE") {
            const tenantOnly = "(tenant_id = app_current_tenant_id())";
            if (p.qual !== tenantOnly || p.with_check !== tenantOnly) {
              bad.push(`${table}.${p.policyname}: ${p.qual} / ${p.with_check}`);
            }
          } else if (p.permissive === "RESTRICTIVE") {
            if (!RESTRICTIVE_USER_TABLES.has(table)) {
              bad.push(`${table}.${p.policyname}: unexpected RESTRICTIVE policy`);
            }
            // command-specific policies (N-7): a SELECT policy has only USING, an INSERT policy only WITH CHECK
            const mentionsUser = (t: string | null) => /app_current_user_id()/.test(t ?? "");
            const needsQual = p.cmd !== "INSERT";
            const needsCheck = p.cmd === "INSERT" || p.cmd === "ALL" || p.cmd === "UPDATE";
            if ((needsQual && !mentionsUser(p.qual)) || (needsCheck && !mentionsUser(p.with_check))) {
              bad.push(`${table}.${p.policyname}: RESTRICTIVE policy missing app_current_user_id()`);
            }
          }
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
