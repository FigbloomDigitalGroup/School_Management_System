import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";
import { hashPassword } from "../src/modules/identity/password.js";

/**
 * The production review script for existing area.people delegations (docs/sql/area-people-delegation-review.sql).
 * It must be complete (active, revoked and invalidated rows), say whether each grant works today, name
 * the school, organization, grantor and recipient, show the capabilities, and be strictly read-only and
 * free of personal contact data. Run here against fixtures only; it has not been run against production.
 */
describe("area.people delegation review script", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const A = () => ctx.ids.tenantA;
  const sql = readFileSync(join(process.cwd(), "docs", "sql", "area-people-delegation-review.sql"), "utf8");
  const ids = { effective: "", revoked: "", invalidated: "" };

  const seed = async (user: string) => {
    await ctx.pool.query(`ALTER TABLE org_admin_school_delegations DISABLE TRIGGER org_admin_school_delegations_guard`);
    try {
      await ctx.pool.query(
        `INSERT INTO org_admin_school_delegations (organization_id, tenant_id, delegate_user_id, permission_code, granted_by) VALUES ($1, $2, $3, 'area.people', $4)`,
        [ctx.ids.orgA, A(), user, ctx.ids.adminA],
      );
    } finally {
      await ctx.pool.query(`ALTER TABLE org_admin_school_delegations ENABLE TRIGGER org_admin_school_delegations_guard`);
    }
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    const hash = await hashPassword("correct-horse-battery");
    for (const k of Object.keys(ids) as Array<keyof typeof ids>) {
      ids[k] = randomUUID();
      await ctx.pool.query(
        `INSERT INTO users (id, email, password_hash, full_name, status) VALUES ($1, $2, $3, $4, 'active')`,
        [ids[k], `review-${k}@example.com`, hash, `Review ${k}`],
      );
      await ctx.pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role) VALUES ($1, $2, 'org_admin')`, [ids[k], ctx.ids.orgA]);
      await seed(ids[k]);
    }
    // A delegation held in addition (second route to People powers) and one assignment made by the recipient.
    await ctx.pool.query(
      `INSERT INTO org_admin_school_delegations (organization_id, tenant_id, delegate_user_id, permission_code, granted_by) VALUES ($1, $2, $3, 'rbac.staff_areas.manage', $4)`,
      [ctx.ids.orgA, A(), ids.effective, ctx.ids.adminA],
    );
    await ctx.pool.query(`INSERT INTO staff_area_grants (tenant_id, user_id, area, granted_by) VALUES ($1, $2, 'people', $3)`, [A(), ctx.ids.teacherA, ids.effective]);
    // One revoked by an administrator, one invalidated by the lifecycle trigger (user disabled).
    await ctx.pool.query(
      `UPDATE org_admin_school_delegations SET revoked_at = now(), revoked_by = $2 WHERE delegate_user_id = $1 AND permission_code = 'area.people'`,
      [ids.revoked, ctx.ids.adminA],
    );
    await ctx.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [ids.invalidated]);
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("is read-only by construction: a READ ONLY transaction and no write or DDL statement", () => {
    const code = sql.replace(/--[^\n]*/g, "");
    expect(code).toMatch(/BEGIN READ ONLY;/);
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|COPY|CALL|DO)\b/i);
  });

  it("returns every area.people delegation, with state, effectiveness, names, capabilities and the proxy-route indicators", async () => {
    const before = (await ctx.pool.query(`SELECT count(*)::int AS n FROM org_admin_school_delegations`)).rows[0].n;
    const res = (await ctx.pool.query(sql)) as unknown as Array<{ rows: Array<Record<string, any>> }>;
    const rows = res[1]!.rows;
    expect(rows).toHaveLength(3);
    const byName = Object.fromEntries(rows.map((r) => [r.recipient_name, r]));

    const eff = byName["Review effective"];
    expect(eff).toMatchObject({
      state: "active",
      currently_effective: true,
      organization: "Org A",
      school: "School A",
      school_status: "active",
      recipient_status: "active",
      recipient_org_membership_live: true,
      recipient_also_holds_staff_areas_manage: true,
      staff_areas_assigned_by_recipient: 1,
      grantor_user_id: ctx.ids.adminA,
    });
    expect(eff.effective_capabilities_when_effective).toEqual(
      expect.arrayContaining(["resource.learner.write", "resource.staff.write", "resource.document.write"]),
    );
    expect(eff.effective_capabilities_when_effective).not.toContain("resource.guardian.read");
    expect(eff.granted_at).toBeTruthy();

    expect(byName["Review revoked"]).toMatchObject({ state: "revoked", currently_effective: false, revoke_reason: null, revoked_by: ctx.ids.adminA });
    expect(byName["Review invalidated"]).toMatchObject({
      state: "invalidated",
      currently_effective: false,
      revoke_reason: "user_disabled",
      recipient_status: "disabled",
    });
    // Active rows are listed first.
    expect(rows[0]!.state).toBe("active");

    // Result 2: the summary to record.
    expect(res[2]!.rows[0]).toEqual({
      active_total: 1,
      active_currently_effective: 1,
      invalidated_total: 1,
      revoked_total: 1,
      distinct_active_recipients: 1,
      distinct_schools_affected: 1,
    });
    // It changed nothing.
    expect((await ctx.pool.query(`SELECT count(*)::int AS n FROM org_admin_school_delegations`)).rows[0].n).toBe(before);
  });

  it("exposes no contact or credential data, and an effective-state change is reflected (suspended school)", async () => {
    let res = (await ctx.pool.query(sql)) as unknown as Array<{ rows: Array<Record<string, any>>; fields: Array<{ name: string }> }>;
    for (const f of res[1]!.fields) expect(f.name, f.name).not.toMatch(/email|phone|password|hash|token|secret|session|login/i);
    await ctx.pool.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [A()]);
    try {
      res = (await ctx.pool.query(sql)) as never;
      const eff = res[1]!.rows.find((r) => r.recipient_name === "Review effective")!;
      expect(eff.state).toBe("active"); // still on record: suspension is not an invalidation
      expect(eff.currently_effective).toBe(false); // but not exercisable while suspended
      expect(res[2]!.rows[0]).toMatchObject({ active_total: 1, active_currently_effective: 0 });
    } finally {
      await ctx.pool.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [A()]);
    }
  });
});
