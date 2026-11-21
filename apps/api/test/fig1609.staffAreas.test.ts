import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";
import { hashPassword } from "../src/modules/identity/password.js";

/**
 * Staff-area and school-role assignment (owner principle, 2026-11-17): an administrator may not assign
 * capabilities exceeding the authority they are permitted to administer. A school administrator or
 * super administrator administers every area; an organization administrator acting through a
 * delegation administers exactly the area.* codes delegated to them. School roles have no write path.
 * Real HTTP application, real figbloom_app runtime login.
 */
describe("staff-area and school-role assignment: no authority beyond what the actor administers", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const PASSWORD = "correct-horse-battery";
  const tokens: Record<string, string> = {};
  let delegate = ""; // org admin of org A (the actor under test)
  let targetB = ""; // a second staff member of school A
  const A = () => ctx.ids.tenantA;

  const login = async (email: string) => {
    const r = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email, password: PASSWORD } });
    expect(r.statusCode).toBe(200);
    return r.json().token as string;
  };
  const call = (method: "GET" | "POST" | "PUT" | "DELETE", who: string, url: string, body?: unknown, tenant = A()) =>
    ctx.app.inject({ method, url, headers: { authorization: `Bearer ${tokens[who]}`, "x-tenant-id": tenant }, payload: body as never });
  const setAreas = (who: string, userId: string, areas: string[], tenant = A()) =>
    call("PUT", who, "/v1/rbac/staff-areas", { userId, areas }, tenant);
  const delegate_ = (codes: string[]) =>
    call("POST", "admin", "/v1/rbac/org-delegations", { delegateUserId: delegate, permissionCodes: codes });
  const areasOf = async (userId: string) =>
    (
      await ctx.pool.query<{ area: string }>(`SELECT area FROM staff_area_grants WHERE tenant_id = $1 AND user_id = $2 ORDER BY 1`, [A(), userId])
    ).rows.map((r) => r.area);
  const reset = async () => {
    await ctx.pool.query(`DELETE FROM org_admin_school_delegations WHERE tenant_id = $1`, [A()]);
    await ctx.pool.query(`DELETE FROM staff_area_grants WHERE tenant_id = $1`, [A()]);
  };
  const now = async () => (await ctx.pool.query<{ t: string }>(`SELECT clock_timestamp()::text AS t`)).rows[0]!.t;

  beforeAll(async () => {
    ctx = await createTestApp();
    const hash = await hashPassword(PASSWORD);
    const mk = async (email: string | null, name: string) => {
      const id = randomUUID();
      await ctx.pool.query(`INSERT INTO users (id, email, password_hash, full_name, status) VALUES ($1, $2, $3, $4, 'active')`, [id, email, hash, name]);
      return id;
    };
    delegate = await mk("staffareas-delegate@example.com", "Delegate");
    targetB = await mk(null, "Target B");
    await ctx.pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role) VALUES ($1, $2, 'org_admin')`, [delegate, ctx.ids.orgA]);
    await ctx.pool.query(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'staff', 'SF-0101')`, [targetB, A()]);
    tokens.admin = await login("admin-a@example.com");
    tokens.super = await login("super@example.com");
    tokens.org1 = await login("orgadmin@example.com");
    tokens.delegate = await login("staffareas-delegate@example.com");
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("a delegate holding only rbac.staff_areas.manage cannot assign any area; the refusal is audited and nothing changes", async () => {
    await reset();
    expect((await delegate_(["rbac.staff_areas.manage", "tenant.read"])).statusCode).toBe(200);
    const t0 = await now();
    for (const areas of [["people"], ["fees"], ["audit"], ["attendance", "academics"]]) {
      const r = await setAreas("delegate", ctx.ids.teacherA, areas);
      expect(r.statusCode, areas.join()).toBe(403);
      expect(r.json().error.message).toMatch(/beyond your own delegated authority/);
    }
    expect(await areasOf(ctx.ids.teacherA)).toEqual([]);
    const ev = await ctx.pool.query<{ detail: Record<string, any> }>(
      `SELECT detail FROM security_audit_events WHERE event_type = 'rbac.staff_areas.denied' AND actor_user_id = $1 AND occurred_at >= $2::timestamptz ORDER BY occurred_at, id`,
      [delegate, t0],
    );
    expect(ev.rowCount).toBe(4);
    expect(ev.rows[0]!.detail).toMatchObject({
      reason: "area_beyond_authority",
      targetUserId: ctx.ids.teacherA,
      requestedBeyondAuthority: ["people"],
      delegatedAreas: [],
      actingVia: "org_admin_delegation",
    });
  });

  it("a delegate may assign exactly the areas delegated to them, and the event records that scope", async () => {
    await reset();
    expect((await delegate_(["rbac.staff_areas.manage", "area.attendance", "area.fees"])).statusCode).toBe(200);
    const t0 = await now();
    const ok = await setAreas("delegate", ctx.ids.teacherA, ["attendance", "fees"]);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().areas).toEqual(["fees", "attendance"].sort((a, b) => ["people", "fees", "academics", "attendance"].indexOf(a) - ["people", "fees", "academics", "attendance"].indexOf(b)));
    expect(await areasOf(ctx.ids.teacherA)).toEqual(["attendance", "fees"]);
    const ev = await ctx.pool.query<{ detail: Record<string, any> }>(
      `SELECT detail FROM security_audit_events WHERE event_type = 'rbac.staff_areas.changed' AND actor_user_id = $1 AND occurred_at >= $2::timestamptz`,
      [delegate, t0],
    );
    expect(ev.rowCount).toBe(1);
    expect(ev.rows[0]!.detail).toMatchObject({ actingVia: "org_admin_delegation", actorIsOrgAdmin: true, delegatedAreas: ["fees", "attendance"] });

    // One area beyond the delegated set refuses the whole request: nothing is partially applied.
    const mixed = await setAreas("delegate", ctx.ids.teacherA, ["attendance", "people"]);
    expect(mixed.statusCode).toBe(403);
    expect(await areasOf(ctx.ids.teacherA)).toEqual(["attendance", "fees"]);
  });

  it("areas the person holds outside the delegate's authority are kept; only the delegated ones are changed", async () => {
    await reset();
    expect((await call("PUT", "admin", "/v1/rbac/staff-areas", { userId: targetB, areas: ["audit", "attendance"] })).statusCode).toBe(200);
    expect((await delegate_(["rbac.staff_areas.manage", "area.attendance"])).statusCode).toBe(200);
    // Replace with nothing: the delegate removes what it administers (attendance) and cannot touch audit.
    const removed = await setAreas("delegate", targetB, []);
    expect(removed.statusCode).toBe(200);
    expect(removed.json().areas).toEqual(["audit"]);
    expect(await areasOf(targetB)).toEqual(["audit"]);
    const added = await setAreas("delegate", targetB, ["attendance"]);
    expect(added.statusCode).toBe(200);
    expect(await areasOf(targetB)).toEqual(["attendance", "audit"]);
  });

  it("`people` cannot be created through this door: it is not delegable, so a new delegate can never assign it", async () => {
    await reset();
    expect((await delegate_(["area.people"])).statusCode).toBe(400);
    expect((await delegate_(["rbac.staff_areas.manage", "area.fees"])).statusCode).toBe(200);
    expect((await setAreas("delegate", ctx.ids.teacherA, ["people"])).statusCode).toBe(403);
    expect(await areasOf(ctx.ids.teacherA)).toEqual([]);
  });

  it("an EXISTING area.people delegation is within its holder's authority (pinned: this is what the review procedure must decide on)", async () => {
    await reset();
    expect((await delegate_(["rbac.staff_areas.manage"])).statusCode).toBe(200);
    await ctx.pool.query(`ALTER TABLE org_admin_school_delegations DISABLE TRIGGER org_admin_school_delegations_guard`);
    try {
      await ctx.pool.query(
        `INSERT INTO org_admin_school_delegations (organization_id, tenant_id, delegate_user_id, permission_code, granted_by) VALUES ($1, $2, $3, 'area.people', $4)`,
        [ctx.ids.orgA, A(), delegate, ctx.ids.adminA],
      );
    } finally {
      await ctx.pool.query(`ALTER TABLE org_admin_school_delegations ENABLE TRIGGER org_admin_school_delegations_guard`);
    }
    expect((await setAreas("delegate", ctx.ids.teacherA, ["people"])).statusCode).toBe(200);
    expect((await setAreas("delegate", ctx.ids.teacherA, ["people", "fees"])).statusCode).toBe(403);
  });

  it("school administrators and super administrators still assign any area", async () => {
    await reset();
    for (const who of ["admin", "super"]) {
      const r = await call("PUT", who, "/v1/rbac/staff-areas", { userId: ctx.ids.teacherA, areas: ["people", "fees", "audit"] });
      expect(r.statusCode, who).toBe(200);
      expect(await areasOf(ctx.ids.teacherA)).toEqual(["audit", "fees", "people"]);
    }
  });

  it("assignment stays inside the delegate's school and organization", async () => {
    await reset();
    expect((await delegate_(["rbac.staff_areas.manage", "area.fees"])).statusCode).toBe(200);
    // Another organization's school: no authority at all.
    expect((await setAreas("delegate", ctx.ids.teacherB, ["fees"], ctx.ids.tenantB)).statusCode).toBe(403);
    // A user who is not a member of this school.
    expect((await setAreas("delegate", ctx.ids.parentA, ["fees"])).statusCode).toBe(403); // parents cannot hold areas
    expect((await setAreas("delegate", ctx.ids.teacherB, ["fees"])).statusCode).toBe(404); // not in school A
    // Not oneself.
    expect((await setAreas("delegate", delegate, ["fees"])).statusCode).toBe(403);
  });

  it("revoking the delegate's authority takes effect on the next request; areas already assigned stay (school configuration)", async () => {
    await reset();
    expect((await delegate_(["rbac.staff_areas.manage", "area.fees"])).statusCode).toBe(200);
    expect((await setAreas("delegate", ctx.ids.teacherA, ["fees"])).statusCode).toBe(200);
    const rev = await call("DELETE", "admin", "/v1/rbac/org-delegations", { delegateUserId: delegate });
    expect(rev.statusCode).toBe(200);
    expect((await setAreas("delegate", ctx.ids.teacherA, [])).statusCode).toBe(403);
    expect(await areasOf(ctx.ids.teacherA)).toEqual(["fees"]); // not undone by the revocation
    const row = await ctx.pool.query<{ granted_by: string }>(`SELECT granted_by FROM staff_area_grants WHERE tenant_id = $1 AND user_id = $2`, [A(), ctx.ids.teacherA]);
    expect(row.rows[0]!.granted_by).toBe(delegate); // attributable afterwards
  });

  describe("assignment provenance (owner decision 2026-11-17)", () => {
    const rowsOf = async (userId: string) =>
      (
        await ctx.pool.query<{ area: string; granted_by: string | null; granted_at: Date }>(
          `SELECT area, granted_by, granted_at FROM staff_area_grants WHERE tenant_id = $1 AND user_id = $2 ORDER BY area`,
          [A(), userId],
        )
      ).rows;

    it("an assignment made under a delegation becomes a school-level assignment that stays attributable, whoever edits the person later", async () => {
      await reset();
      expect((await delegate_(["rbac.staff_areas.manage", "area.attendance"])).statusCode).toBe(200);
      const delegationRows = await ctx.pool.query<{ id: string; permission_code: string }>(
        `SELECT id, permission_code FROM org_admin_school_delegations WHERE tenant_id = $1 AND delegate_user_id = $2 AND revoked_at IS NULL`,
        [A(), delegate],
      );
      const t0 = await now();
      expect((await setAreas("delegate", targetB, ["attendance"])).statusCode).toBe(200);
      const first = (await rowsOf(targetB)).find((r) => r.area === "attendance")!;
      expect(first.granted_by).toBe(delegate);

      // The event says who, when, which school, in what capacity, and under which delegations.
      const ev = await ctx.pool.query<{ detail: Record<string, any>; tenant_id: string; occurred_at: Date }>(
        `SELECT detail, tenant_id, occurred_at FROM security_audit_events WHERE event_type = 'rbac.staff_areas.changed' AND actor_user_id = $1 AND occurred_at >= $2::timestamptz`,
        [delegate, t0],
      );
      expect(ev.rowCount).toBe(1);
      expect(ev.rows[0]!.tenant_id).toBe(A());
      expect(ev.rows[0]!.detail).toMatchObject({
        targetUserId: targetB,
        actingVia: "org_admin_delegation",
        addedAreas: ["attendance"],
        removedAreas: [],
        areas: ["attendance"],
        delegatedAreas: ["attendance"],
      });
      expect([...ev.rows[0]!.detail.authorizingDelegationIds].sort()).toEqual(delegationRows.rows.map((r) => r.id).sort());

      // A school administrator later adds an unrelated area: the delegate's assignment keeps its maker and time.
      expect((await call("PUT", "admin", "/v1/rbac/staff-areas", { userId: targetB, areas: ["attendance", "fees"] })).statusCode).toBe(200);
      const after = await rowsOf(targetB);
      const att = after.find((r) => r.area === "attendance")!;
      expect(att.granted_by).toBe(delegate);
      expect(att.granted_at.getTime()).toBe(first.granted_at.getTime());
      expect(after.find((r) => r.area === "fees")!.granted_by).toBe(ctx.ids.adminA);

      // Revoking the delegation ends the delegate's authority to assign, immediately.
      expect((await call("DELETE", "admin", "/v1/rbac/org-delegations", { delegateUserId: delegate })).statusCode).toBe(200);
      expect((await setAreas("delegate", targetB, ["attendance"])).statusCode).toBe(403);
      // ... but does not undo what was legitimately assigned (no cascade).
      expect((await rowsOf(targetB)).map((r) => r.area)).toEqual(["attendance", "fees"]);
      expect((await rowsOf(targetB)).find((r) => r.area === "attendance")!.granted_by).toBe(delegate);

      // Normal school administration can modify or remove it afterwards; the removal is attributed to the administrator.
      const t1 = await now();
      expect((await call("PUT", "admin", "/v1/rbac/staff-areas", { userId: targetB, areas: ["fees"] })).statusCode).toBe(200);
      expect((await rowsOf(targetB)).map((r) => r.area)).toEqual(["fees"]);
      const rem = await ctx.pool.query<{ detail: Record<string, any> }>(
        `SELECT detail FROM security_audit_events WHERE event_type = 'rbac.staff_areas.changed' AND actor_user_id = $1 AND occurred_at >= $2::timestamptz`,
        [ctx.ids.adminA, t1],
      );
      expect(rem.rows[0]!.detail).toMatchObject({ removedAreas: ["attendance"], previousAreas: ["attendance", "fees"], actingVia: "school_admin" });
    });

    it("areas a delegate does not administer keep their original assigner and time when the delegate edits the person", async () => {
      await reset();
      expect((await call("PUT", "admin", "/v1/rbac/staff-areas", { userId: ctx.ids.teacherA, areas: ["audit", "attendance"] })).statusCode).toBe(200);
      const before = await rowsOf(ctx.ids.teacherA);
      expect((await delegate_(["rbac.staff_areas.manage", "area.attendance"])).statusCode).toBe(200);
      expect((await setAreas("delegate", ctx.ids.teacherA, [])).statusCode).toBe(200); // removes attendance only
      const after = await rowsOf(ctx.ids.teacherA);
      expect(after.map((r) => r.area)).toEqual(["audit"]);
      expect(after[0]!.granted_by).toBe(ctx.ids.adminA); // not re-stamped as the delegate
      expect(after[0]!.granted_at.getTime()).toBe(before.find((r) => r.area === "audit")!.granted_at.getTime());
    });

    it("assignment cannot cross schools: a delegate's grant is stored only for the school it was authorized for", async () => {
      await reset();
      expect((await delegate_(["rbac.staff_areas.manage", "area.fees"])).statusCode).toBe(200);
      expect((await setAreas("delegate", ctx.ids.teacherB, ["fees"], ctx.ids.tenantB)).statusCode).toBe(403);
      const other = await ctx.pool.query(`SELECT 1 FROM staff_area_grants WHERE tenant_id = $1 AND user_id = $2`, [ctx.ids.tenantB, ctx.ids.teacherB]);
      expect(other.rowCount).toBe(0);
    });
  });

  describe("school roles: no write path exists", () => {
    it("there is no school-role endpoint, and the runtime role cannot write the tables", async () => {
      await reset();
      expect((await delegate_(["rbac.school_roles.manage", "tenant.read"])).statusCode).toBe(200);
      for (const [m, u] of [
        ["POST", "/v1/rbac/school-roles"],
        ["PUT", "/v1/rbac/school-roles"],
        ["POST", "/v1/rbac/school-role-assignments"],
        ["PUT", "/v1/rbac/school-roles/assignments"],
      ] as const) {
        const r = await call(m, "delegate", u, { name: "x", areas: ["people"] });
        expect(r.statusCode, `${m} ${u}`).toBe(404);
      }
      const c = await ctx.runtimePool.connect();
      try {
        for (const table of ["school_roles", "school_role_assignments"]) {
          for (const priv of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
            const r = await c.query<{ ok: boolean }>(`SELECT has_table_privilege(current_user, $1, $2) AS ok`, [table, priv]);
            expect(r.rows[0]!.ok, `${table} ${priv}`).toBe(false);
          }
        }
      } finally {
        c.release();
      }
      // The delegated code confers no capability: nothing in the effective set follows from it.
      expect(await areasOf(ctx.ids.teacherA)).toEqual([]);
    });

    it("an assigned `people` area expands to exactly the People set: learner, staff and document read/write, never guardian or profile write", async () => {
      await reset();
      expect((await call("PUT", "admin", "/v1/rbac/staff-areas", { userId: ctx.ids.teacherA, areas: ["people"] })).statusCode).toBe(200);
      tokens.teacher = (await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId: A(), loginId: "TC-0001", password: PASSWORD } })).json().token as string;
      const perms = (await call("GET", "teacher", "/v1/rbac/permissions?limit=200")).json().items as string[];
      for (const c of ["resource.learner.read", "resource.learner.write", "resource.staff.read", "resource.staff.write", "resource.document.read", "resource.document.write"]) {
        expect(perms, c).toContain(c);
      }
      for (const c of ["resource.guardian.read", "resource.guardian.write", "resource.school_profile.write", "rbac.staff_areas.manage"]) {
        expect(perms, c).not.toContain(c);
      }
    });
  });
});
