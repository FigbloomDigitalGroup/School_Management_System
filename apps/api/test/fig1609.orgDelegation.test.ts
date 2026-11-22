import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";
import { hashPassword } from "../src/modules/identity/password.js";

/**
 * FIG-1609 (approved policy, Ancel 2026-11-12): organization administrators grant and revoke
 * allowlisted school delegations. Real HTTP application, real figbloom_app runtime login.
 */
describe("FIG-1609 organization administrator delegation grant / revoke", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const PASSWORD = "correct-horse-battery";
  let orgAdmin2 = "";
  let orgBAdmin = "";
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await createTestApp();
    const hash = await hashPassword(PASSWORD);
    const mk = async (email: string, org: string) => {
      const id = randomUUID();
      await ctx.pool.query(
        `INSERT INTO users (id, email, password_hash, full_name, status) VALUES ($1, $2, $3, $2, 'active')`,
        [id, email, hash],
      );
      await ctx.pool.query(
        `INSERT INTO organization_memberships (user_id, organization_id, role) VALUES ($1, $2, 'org_admin')`,
        [id, org],
      );
      return id;
    };
    orgAdmin2 = await mk("orgadmin2@example.com", ctx.ids.orgA);
    orgBAdmin = await mk("orgadmin-b@example.com", ctx.ids.orgB);
    for (const [key, email] of [
      ["admin", "admin-a@example.com"],
      ["super", "super@example.com"],
      ["org1", "orgadmin@example.com"],
      ["org2", "orgadmin2@example.com"],
      ["orgB", "orgadmin-b@example.com"],
    ] as const) {
      const res = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email, password: PASSWORD } });
      expect(res.statusCode, email).toBe(200);
      tokens[key] = res.json().token as string;
    }
    const teacher = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/login-id",
      payload: { tenantId: ctx.ids.tenantA, loginId: "TC-0001", password: PASSWORD },
    });
    expect(teacher.statusCode).toBe(200);
    tokens.teacher = teacher.json().token as string;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  const A = () => ctx.ids.tenantA;
  const call = (method: "GET" | "POST" | "DELETE" | "PUT", who: string, url: string, body?: unknown, tenant = A()) =>
    ctx.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${tokens[who]}`, "x-tenant-id": tenant },
      payload: body as never,
    });
  const grant = (who: string, delegate: string, codes: string[], tenant = A()) =>
    call("POST", who, "/v1/rbac/org-delegations", { delegateUserId: delegate, permissionCodes: codes }, tenant);
  const revoke = (who: string, delegate: string, codes?: string[], tenant = A()) =>
    call("DELETE", who, "/v1/rbac/org-delegations", { delegateUserId: delegate, ...(codes ? { permissionCodes: codes } : {}) }, tenant);
  const reads = (who: string) => call("GET", who, `/v1/tenants/${A()}`);

  async function active(delegate: string): Promise<string[]> {
    const r = await ctx.pool.query<{ permission_code: string }>(
      `SELECT permission_code FROM org_admin_school_delegations
        WHERE tenant_id = $1 AND delegate_user_id = $2 AND revoked_at IS NULL ORDER BY 1`,
      [A(), delegate],
    );
    return r.rows.map((x) => x.permission_code);
  }
  async function clear(): Promise<void> {
    await ctx.pool.query(`DELETE FROM org_admin_school_delegations WHERE tenant_id = $1`, [A()]);
  }
  async function lastEvent(type: string, actor: string) {
    const r = await ctx.pool.query<{ detail: Record<string, any> }>(
      `SELECT detail FROM security_audit_events WHERE event_type = $1 AND actor_user_id = $2
        ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [type, actor],
    );
    return r.rows[0]?.detail;
  }
  async function setStatus(status: "active" | "suspended") {
    await ctx.pool.query(`UPDATE tenants SET status = $2 WHERE id = $1`, [A(), status]);
  }

  describe("granting", () => {
    it("an org admin grants to another org admin without holding the permission, and the grant works", async () => {
      await clear();
      // The grantor holds neither permission.
      expect((await call("GET", "org1", `/v1/rbac/permissions`)).json().items).not.toContain("rbac.staff_areas.manage");
      // area.attendance: a delegate may only assign the areas delegated to them (owner principle).
      const res = await grant("org1", orgAdmin2, ["rbac.staff_areas.manage", "tenant.read", "area.attendance"]);
      expect(res.statusCode).toBe(200);
      expect(res.json().granted).toEqual(expect.arrayContaining(["rbac.staff_areas.manage", "tenant.read"]));
      expect(await active(orgAdmin2)).toEqual(["area.attendance", "rbac.staff_areas.manage", "tenant.read"]);

      const set = await call("PUT", "org2", "/v1/rbac/staff-areas", { userId: ctx.ids.teacherA, areas: ["attendance"] });
      expect(set.statusCode).toBe(200);

      const ev = await lastEvent("rbac.org_delegation.granted", ctx.ids.orgAdmin);
      expect(ev).toMatchObject({
        operation: "grant",
        outcome: "granted",
        actingVia: "org_admin",
        grantedBy: ctx.ids.orgAdmin,
        delegateUserId: orgAdmin2,
        organizationId: ctx.ids.orgA,
      });
      expect(ev!.permissionCodes).toEqual(expect.arrayContaining(["rbac.staff_areas.manage", "tenant.read"]));
      expect(JSON.stringify(ev)).not.toMatch(/token|password|secret/i);
    });

    it("refuses self-delegation, non-delegable codes, ineligible and cross-organization recipients, each audited", async () => {
      await clear();
      const self = await grant("org1", ctx.ids.orgAdmin, ["tenant.read"]);
      expect(self.statusCode).toBe(403);
      expect((await lastEvent("rbac.org_delegation.denied", ctx.ids.orgAdmin))?.reason).toBe("self_delegation");

      for (const code of [
        "org.delegations.grant",
        "org.delegations.revoke",
        "rbac.org_delegations.manage",
        "rbac.permissions.read",
        "platform.tenants.manage",
        "area.not_a_real_area",
      ]) {
        const res = await grant("org1", orgAdmin2, [code]);
        expect(res.statusCode, code).toBe(400);
        expect((await lastEvent("rbac.org_delegation.denied", ctx.ids.orgAdmin))?.reason, code).toBe("not_delegable");
      }

      const teacher = await grant("org1", ctx.ids.teacherA, ["tenant.read"]);
      expect(teacher.statusCode).toBe(400);
      expect((await lastEvent("rbac.org_delegation.denied", ctx.ids.orgAdmin))?.reason).toBe("ineligible_recipient");

      const crossOrg = await grant("org1", orgBAdmin, ["tenant.read"]);
      expect(crossOrg.statusCode).toBe(400);
      expect(await active(orgBAdmin)).toEqual([]);
      expect(await active(ctx.ids.teacherA)).toEqual([]);
    });

    it("a delegated user cannot re-delegate what they received", async () => {
      await clear();
      expect((await grant("admin", orgAdmin2, ["tenant.read"])).statusCode).toBe(200);
      // orgAdmin2 may grant only as an org admin, and the delegable set excludes every authority code.
      const res = await grant("org2", ctx.ids.orgAdmin, ["org.delegations.grant"]);
      expect(res.statusCode).toBe(400);
    });

    it("an org admin of another organization has no authority over this school", async () => {
      await clear();
      const g = await grant("orgB", orgAdmin2, ["tenant.read"]);
      expect(g.statusCode).toBe(403);
      expect((await lastEvent("rbac.org_delegation.denied", orgBAdmin))?.reason).toBe("no_authority");
      await grant("admin", orgAdmin2, ["tenant.read"]);
      const r = await revoke("orgB", orgAdmin2);
      expect(r.statusCode).toBe(403);
      expect(await active(orgAdmin2)).toEqual(["tenant.read"]);
    });

    it("a teacher and an unauthenticated caller have no authority", async () => {
      await clear();
      const t = await grant("teacher", orgAdmin2, ["tenant.read"]);
      expect(t.statusCode).toBe(403);
      expect((await lastEvent("rbac.org_delegation.denied", ctx.ids.teacherA))?.reason).toBe("no_authority");
      const none = await ctx.app.inject({
        method: "POST",
        url: "/v1/rbac/org-delegations",
        headers: { "x-tenant-id": A() },
        payload: { delegateUserId: orgAdmin2, permissionCodes: ["tenant.read"] },
      });
      expect(none.statusCode).toBe(401);
      expect(await active(orgAdmin2)).toEqual([]);
    });

    it("school admin and super admin grants keep working", async () => {
      await clear();
      expect((await grant("admin", orgAdmin2, ["tenant.read"])).statusCode).toBe(200);
      expect((await lastEvent("rbac.org_delegation.granted", ctx.ids.adminA))?.actingVia).toBe("school_admin");
      expect((await grant("super", orgAdmin2, ["resource.learner.read"])).statusCode).toBe(200);
      expect((await lastEvent("rbac.org_delegation.granted", ctx.ids.superAdmin))?.actingVia).toBe("super_admin");
    });
  });

  describe("revoking", () => {
    it("an org admin revokes a delegation a school admin granted; effect is immediate; audit names the original grantor", async () => {
      await clear();
      expect((await grant("admin", orgAdmin2, ["tenant.read"])).statusCode).toBe(200);
      expect((await reads("org2")).statusCode).toBe(200);

      const res = await revoke("org1", orgAdmin2);
      expect(res.statusCode).toBe(200);
      expect(res.json().revoked).toEqual(["tenant.read"]);
      expect((await reads("org2")).statusCode).toBe(403); // next request, no restart, no cache

      const ev = await lastEvent("rbac.org_delegation.revoked", ctx.ids.orgAdmin);
      expect(ev).toMatchObject({
        operation: "revoke",
        outcome: "revoked",
        actingVia: "org_admin",
        revokedBy: ctx.ids.orgAdmin,
        delegateUserId: orgAdmin2,
        organizationId: ctx.ids.orgA,
        permissionCodes: ["tenant.read"],
      });
      expect(ev!.originalGrantors).toEqual([{ permissionCode: "tenant.read", grantedBy: ctx.ids.adminA }]);
    });

    it("revoking nothing is a 404 and is audited; a school admin and a super admin may also revoke", async () => {
      await clear();
      const none = await revoke("org1", orgAdmin2);
      expect(none.statusCode).toBe(404);
      expect((await lastEvent("rbac.org_delegation.denied", ctx.ids.orgAdmin))?.reason).toBe("no_active_delegation");

      await grant("org1", orgAdmin2, ["tenant.read", "resource.learner.read"]);
      expect((await revoke("admin", orgAdmin2, ["tenant.read"])).statusCode).toBe(200);
      expect(await active(orgAdmin2)).toEqual(["resource.learner.read"]);
      expect((await revoke("super", orgAdmin2)).statusCode).toBe(200);
      expect(await active(orgAdmin2)).toEqual([]);
    });

    it("grant and revoke authority are separate permissions", async () => {
      await clear();
      await grant("admin", orgAdmin2, ["tenant.read"]);
      // Take away only the revoke authority from the org_admin role.
      await ctx.pool.query(`DELETE FROM role_permissions WHERE role = 'org_admin' AND permission_code = 'org.delegations.revoke'`);
      try {
        expect((await grant("org1", orgAdmin2, ["resource.learner.read"])).statusCode).toBe(200);
        expect((await revoke("org1", orgAdmin2)).statusCode).toBe(403);
        expect(await active(orgAdmin2)).toEqual(["resource.learner.read", "tenant.read"]);
      } finally {
        await ctx.pool.query(
          `INSERT INTO role_permissions (role, permission_code) VALUES ('org_admin', 'org.delegations.revoke') ON CONFLICT DO NOTHING`,
        );
      }
      await ctx.pool.query(`DELETE FROM role_permissions WHERE role = 'org_admin' AND permission_code = 'org.delegations.grant'`);
      try {
        expect((await grant("org1", orgAdmin2, ["area.fees"])).statusCode).toBe(403);
        expect((await revoke("org1", orgAdmin2)).statusCode).toBe(200);
      } finally {
        await ctx.pool.query(
          `INSERT INTO role_permissions (role, permission_code) VALUES ('org_admin', 'org.delegations.grant') ON CONFLICT DO NOTHING`,
        );
      }
    });

    it("the two authority permissions exist only for org_admin and are not delegable", async () => {
      const rows = await ctx.pool.query<{ role: string; permission_code: string }>(
        `SELECT role, permission_code FROM role_permissions WHERE permission_code LIKE 'org.delegations.%' ORDER BY 1, 2`,
      );
      expect(rows.rows).toEqual([
        { role: "org_admin", permission_code: "org.delegations.grant" },
        { role: "org_admin", permission_code: "org.delegations.revoke" },
      ]);
    });
  });

  describe("suspended schools", () => {
    it("no administrator may grant on a suspended school, a super administrator included; each refusal is audited", async () => {
      await clear();
      await setStatus("suspended");
      try {
        for (const [who, actor] of [
          ["admin", ctx.ids.adminA],
          ["org1", ctx.ids.orgAdmin],
          ["super", ctx.ids.superAdmin],
        ] as const) {
          const res = await grant(who, orgAdmin2, ["tenant.read"]);
          expect(res.statusCode, who).toBe(403);
          expect((await lastEvent("rbac.org_delegation.denied", actor))?.reason, who).toBe("school_suspended");
        }
        expect(await active(orgAdmin2)).toEqual([]); // no record created
      } finally {
        await setStatus("active");
      }
    });

    it("revocation stays available to the school admin, the org admin and the super admin; use is refused meanwhile", async () => {
      for (const revoker of ["admin", "org1", "super"] as const) {
        await clear();
        await grant("admin", orgAdmin2, ["tenant.read", "resource.learner.read"]);
        await setStatus("suspended");
        try {
          // A delegation cannot be exercised on a suspended school, even on an existing session.
          expect((await reads("org2")).statusCode).toBe(403);
          const res = await revoke(revoker, orgAdmin2);
          expect(res.statusCode, revoker).toBe(200);
          expect(res.json().revoked).toEqual(["resource.learner.read", "tenant.read"]);
          expect(await active(orgAdmin2)).toEqual([]);
        } finally {
          await setStatus("active");
        }
        // Restoration does not bring a revoked delegation back.
        expect((await reads("org2")).statusCode).toBe(403);
      }
    });

    it("restoration reactivates only delegations that are still valid", async () => {
      await clear();
      await grant("admin", orgAdmin2, ["tenant.read", "resource.learner.read"]);
      await setStatus("suspended");
      try {
        expect((await revoke("org1", orgAdmin2, ["tenant.read"])).statusCode).toBe(200);
      } finally {
        await setStatus("active");
      }
      // tenant.read was revoked during suspension and stays revoked; the other one resumes.
      expect((await reads("org2")).statusCode).toBe(403);
      expect(await active(orgAdmin2)).toEqual(["resource.learner.read"]);
    });

    it("a school administrator cannot revoke outside their own school", async () => {
      await clear();
      await grant("admin", orgAdmin2, ["tenant.read"]);
      const res = await revoke("admin", orgAdmin2, undefined, ctx.ids.tenantB);
      expect(res.statusCode).toBe(403);
      expect(await active(orgAdmin2)).toEqual(["tenant.read"]);
    });
  });

  describe("concurrency", () => {
    it("concurrent grants and revokes never 500 and leave at most one active row per permission", async () => {
      await clear();
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          i % 3 === 2 ? revoke("org1", orgAdmin2) : grant(i % 2 ? "admin" : "org1", orgAdmin2, ["tenant.read"]),
        ),
      );
      for (const r of results) expect([200, 404]).toContain(r.statusCode);
      const dup = await ctx.pool.query(
        `SELECT permission_code, count(*)::int AS n FROM org_admin_school_delegations
          WHERE tenant_id = $1 AND delegate_user_id = $2 AND revoked_at IS NULL GROUP BY 1 HAVING count(*) > 1`,
        [A(), orgAdmin2],
      );
      expect(dup.rowCount).toBe(0);
    });

    it("concurrent grants of one code: exactly one audit event claims it as newly granted, and it names the stored grantor", async () => {
      await clear();
      const t0 = (await ctx.pool.query<{ t: string }>(`SELECT clock_timestamp()::text AS t`)).rows[0]!.t;
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => grant(i % 2 ? "admin" : "org1", orgAdmin2, ["tenant.read"])),
      );
      for (const r of results) expect(r.statusCode).toBe(200);
      const row = await ctx.pool.query<{ granted_by: string }>(
        `SELECT granted_by FROM org_admin_school_delegations
          WHERE tenant_id = $1 AND delegate_user_id = $2 AND permission_code = 'tenant.read' AND revoked_at IS NULL`,
        [A(), orgAdmin2],
      );
      expect(row.rowCount).toBe(1);
      const events = await ctx.pool.query<{ detail: Record<string, any> }>(
        `SELECT detail FROM security_audit_events
          WHERE event_type = 'rbac.org_delegation.granted' AND detail->>'delegateUserId' = $1 AND occurred_at >= $2::timestamptz`,
        [orgAdmin2, t0],
      );
      expect(events.rowCount).toBe(12);
      const claimed = events.rows.filter((e) => (e.detail.newlyGranted as string[]).includes("tenant.read"));
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.detail.grantedBy).toBe(row.rows[0]!.granted_by);
    });
  });

  describe("revocation input", () => {
    it("an empty permissionCodes array is refused (400) and revokes nothing; omitting the field still revokes all", async () => {
      await clear();
      expect((await grant("org1", orgAdmin2, ["tenant.read", "resource.learner.read"])).statusCode).toBe(200);
      const empty = await call("DELETE", "org1", "/v1/rbac/org-delegations", { delegateUserId: orgAdmin2, permissionCodes: [] });
      expect(empty.statusCode).toBe(400);
      expect(await active(orgAdmin2)).toEqual(["resource.learner.read", "tenant.read"]);
      const all = await revoke("org1", orgAdmin2);
      expect(all.statusCode).toBe(200);
      expect(all.json().revoked.sort()).toEqual(["resource.learner.read", "tenant.read"]);
      expect(await active(orgAdmin2)).toEqual([]);
    });
  });
});
