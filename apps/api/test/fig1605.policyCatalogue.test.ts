import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";

/**
 * FIG-1605 criteria 6-9 and the catalogue: every table with row security is documented in
 * docs/RLS-CATALOGUE.md, and no policy applicable to the runtime role (directly, or through
 * PUBLIC) can grant access without a tenant, user or owner predicate.
 */
export interface PolicyRow {
  table: string;
  policy: string;
  cmd: string; // ALL | SELECT | INSERT | UPDATE | DELETE
  permissive: string; // PERMISSIVE | RESTRICTIVE
  roles: string[];
  qual: string | null;
  with_check: string | null;
}

const isTrue = (expr: string | null) => expr === null || expr.trim().toLowerCase() === "true";
const OWNER_PREDICATE = /pg_get_userbyid|relowner/i;

/**
 * Policies that could let the runtime role (figbloom_app) in without a predicate.
 * A PUBLIC policy is acceptable only when it is an owner-only policy; a figbloom_app policy only
 * when it is not unconditional. Pure function so a negative control can prove it fires.
 */
export function findUnconditionalRuntimePolicies(rows: PolicyRow[]): string[] {
  const bad: string[] = [];
  for (const p of rows) {
    if (p.permissive !== "PERMISSIVE") continue;
    const applies = p.roles.includes("public") || p.roles.includes("figbloom_app");
    if (!applies) continue;
    const reads = p.cmd === "ALL" || p.cmd === "SELECT" || p.cmd === "UPDATE" || p.cmd === "DELETE";
    const where = `${p.table}.${p.policy}`;
    if (reads && isTrue(p.qual)) bad.push(`${where}: unconditional USING`);
    // An ALL policy with no WITH CHECK falls back to USING, which the line above covers.
    const explicitCheck = p.cmd === "INSERT" || (p.cmd === "ALL" && p.with_check !== null);
    if (explicitCheck && isTrue(p.with_check)) bad.push(`${where}: unconditional WITH CHECK`);
    if (p.roles.includes("public") && !OWNER_PREDICATE.test(p.qual ?? "") && !OWNER_PREDICATE.test(p.with_check ?? "")) {
      bad.push(`${where}: PUBLIC policy that is not owner-only`);
    }
  }
  return bad;
}

describe("FIG-1605 policy detector (negative controls)", () => {
  const base: PolicyRow = {
    table: "t",
    policy: "p",
    cmd: "ALL",
    permissive: "PERMISSIVE",
    roles: ["figbloom_app"],
    qual: "(tenant_id = app_current_tenant_id())",
    with_check: "(tenant_id = app_current_tenant_id())",
  };
  it("accepts the tenant policy and an owner-only PUBLIC policy", () => {
    expect(findUnconditionalRuntimePolicies([base])).toEqual([]);
    expect(
      findUnconditionalRuntimePolicies([
        { ...base, roles: ["public"], qual: "(CURRENT_USER = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c))", with_check: "(CURRENT_USER = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c))" },
      ]),
    ).toEqual([]);
  });
  it("fires on USING (true) for PUBLIC, for the runtime role, and on a missing predicate", () => {
    expect(findUnconditionalRuntimePolicies([{ ...base, roles: ["public"], qual: "true", with_check: "true" }]).length).toBeGreaterThan(0);
    expect(findUnconditionalRuntimePolicies([{ ...base, qual: "true" }])).toContain("t.p: unconditional USING");
    expect(findUnconditionalRuntimePolicies([{ ...base, cmd: "SELECT", qual: null }])).toContain("t.p: unconditional USING");
    expect(findUnconditionalRuntimePolicies([{ ...base, cmd: "INSERT", qual: null, with_check: "true" }])).toContain(
      "t.p: unconditional WITH CHECK",
    );
    expect(
      findUnconditionalRuntimePolicies([{ ...base, roles: ["public"], qual: "(tenant_id = app_current_tenant_id())" }]),
    ).toContain("t.p: PUBLIC policy that is not owner-only");
  });
  it("ignores policies that cannot apply to the runtime role", () => {
    expect(findUnconditionalRuntimePolicies([{ ...base, roles: ["someone_else"], qual: "true" }])).toEqual([]);
  });
});

describe("FIG-1605 live catalogue", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => {
    ctx = await createTestApp();
  }, 120_000);
  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("no policy gives the runtime role (or PUBLIC) access without a predicate", async () => {
    const res = await ctx.pool.query<PolicyRow>(
      `SELECT tablename AS "table", policyname AS policy, cmd, permissive, roles::text[] AS roles, qual, with_check
         FROM pg_policies WHERE schemaname = 'public'`,
    );
    expect(res.rowCount).toBeGreaterThan(10);
    expect(findUnconditionalRuntimePolicies(res.rows)).toEqual([]);
  });

  it("every table with row security is ENABLE + FORCE and listed in docs/RLS-CATALOGUE.md", async () => {
    const tables = await ctx.pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity
        ORDER BY relname`,
    );
    expect(tables.rowCount).toBeGreaterThan(10);
    const doc = readFileSync(join(process.cwd(), "docs", "RLS-CATALOGUE.md"), "utf8");
    const undocumented: string[] = [];
    for (const t of tables.rows) {
      expect(t.relforcerowsecurity, `${t.relname} not FORCEd`).toBe(true);
      if (!doc.includes(`\`${t.relname}\``)) undocumented.push(t.relname);
    }
    expect(undocumented, "add these tables to apps/api/docs/RLS-CATALOGUE.md").toEqual([]);
  });

  it("every table carrying tenant_id has a runtime-role policy that names the tenant context (or is insert-only)", async () => {
    const withTenant = await ctx.pool.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' ORDER BY 1`,
    );
    const policies = await ctx.pool.query<{ tablename: string; roles: string[]; qual: string | null }>(
      `SELECT tablename, roles::text[] AS roles, qual FROM pg_policies WHERE schemaname = 'public'`,
    );
    // account_tokens (072) is owner-only by design: no runtime privilege at all, reached only through definer functions
    const insertOnly = new Set(["security_audit_events", "account_tokens", "guardian_invitations", "guardian_accounts", "finance_unmatched_cases", "finance_unmatched_case_notes"]);
    const missing = withTenant.rows
      .map((r) => r.table_name)
      .filter((t) => !insertOnly.has(t))
      .filter(
        (t) => !policies.rows.some((p) => p.tablename === t && p.roles.includes("figbloom_app") && /app_current_tenant_id/.test(p.qual ?? "")),
      );
    expect(missing).toEqual([]);
  });

  it("the runtime connection is a genuine non-owner: no superuser, no BYPASSRLS, owns nothing, cannot assume the owner", async () => {
    const c = await ctx.runtimePool.connect();
    try {
      const who = await c.query<{ u: string; super: boolean; bypass: boolean }>(
        `SELECT current_user AS u, r.rolsuper AS super, r.rolbypassrls AS bypass
           FROM pg_roles r WHERE r.rolname = current_user`,
      );
      expect(who.rows[0]).toEqual({ u: "figbloom_app", super: false, bypass: false });
      const owned = await c.query(
        `SELECT 1 FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
         UNION ALL SELECT 1 FROM pg_proc WHERE proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)`,
      );
      expect(owned.rowCount).toBe(0);
      const owner = await ctx.pool.query<{ u: string }>(`SELECT current_user AS u`);
      expect(owner.rows[0]!.u).not.toBe("figbloom_app"); // the fixture/owner pool is a different role
      await expect(c.query(`SET ROLE ${owner.rows[0]!.u}`)).rejects.toThrow();
      // Without tenant context the runtime role sees no tenant rows even though the table has data.
      const seeded = await ctx.pool.query(`SELECT count(*)::int AS n FROM school_memberships`);
      expect(seeded.rows[0].n).toBeGreaterThan(0);
      const blind = await c.query(`SELECT count(*)::int AS n FROM school_memberships`);
      expect(blind.rows[0].n).toBe(0);
    } finally {
      c.release();
    }
  });

  it("migration 024 (delegation authority) leaves the runtime role's privileges and RLS untouched", async () => {
    const privileged = await ctx.pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'figbloom_app'`,
    );
    expect(privileged.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const perms = await ctx.pool.query(`SELECT 1 FROM permissions WHERE code IN ('org.delegations.grant','org.delegations.revoke')`);
    expect(perms.rowCount).toBe(2);
  });
});
