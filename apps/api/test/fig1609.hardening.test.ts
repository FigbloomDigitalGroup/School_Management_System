import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";
import { hashPassword } from "../src/modules/identity/password.js";
import { DELEGABLE_PERMISSIONS, isDelegablePermission } from "../src/modules/rbac/delegations.js";
import { ADMIN_AREAS } from "../src/modules/identity/roles.js";

/**
 * FIG-1609 review hardening: grant-versus-suspension race, idempotent replay, disabled recipients,
 * database allowlist. The race tests hold a row lock from a second connection so the interleaving
 * is forced, not hoped for.
 */
describe("FIG-1609 hardening", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const PASSWORD = "correct-horse-battery";
  const tokens: Record<string, string> = {};
  let orgAdmin2 = "";

  beforeAll(async () => {
    ctx = await createTestApp();
    orgAdmin2 = randomUUID();
    await ctx.pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, status) VALUES ($1, 'orgadmin2h@example.com', $2, 'OA2', 'active')`,
      [orgAdmin2, await hashPassword(PASSWORD)],
    );
    await ctx.pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role) VALUES ($1, $2, 'org_admin')`,
      [orgAdmin2, ctx.ids.orgA],
    );
    for (const [k, email] of [
      ["admin", "admin-a@example.com"],
      ["org1", "orgadmin@example.com"],
      ["org2", "orgadmin2h@example.com"],
    ] as const) {
      const r = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email, password: PASSWORD } });
      expect(r.statusCode, email).toBe(200);
      tokens[k] = r.json().token as string;
    }
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  const A = () => ctx.ids.tenantA;
  const call = (method: "GET" | "POST" | "DELETE", who: string, url: string, body?: unknown, extra: Record<string, string> = {}) =>
    ctx.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${tokens[who]}`, "x-tenant-id": A(), ...extra },
      payload: body as never,
    });
  const grant = (who: string, codes: string[], extra: Record<string, string> = {}) =>
    call("POST", who, "/v1/rbac/org-delegations", { delegateUserId: orgAdmin2, permissionCodes: codes }, extra);
  const revoke = (who: string) => call("DELETE", who, "/v1/rbac/org-delegations", { delegateUserId: orgAdmin2 });
  const reads = (who: string) => call("GET", who, `/v1/tenants/${A()}`);

  async function active(): Promise<string[]> {
    const r = await ctx.pool.query<{ permission_code: string }>(
      `SELECT permission_code FROM org_admin_school_delegations WHERE tenant_id = $1 AND delegate_user_id = $2 AND revoked_at IS NULL ORDER BY 1`,
      [A(), orgAdmin2],
    );
    return r.rows.map((x) => x.permission_code);
  }
  const clear = () => ctx.pool.query(`DELETE FROM org_admin_school_delegations WHERE tenant_id = $1`, [A()]);
  async function lastEvent(type: string, actor: string) {
    const r = await ctx.pool.query<{ detail: Record<string, any> }>(
      `SELECT detail FROM security_audit_events WHERE event_type = $1 AND actor_user_id = $2 ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [type, actor],
    );
    return r.rows[0]?.detail;
  }
  /** Wait until some backend is blocked on a lock while running a statement matching `like`. */
  async function waitBlocked(like: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const r = await ctx.pool.query(
        `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1 AND pid <> pg_backend_pid()`,
        [like],
      );
      if ((r.rowCount ?? 0) > 0) return;
      await new Promise((res) => setTimeout(res, 40));
    }
    throw new Error(`no backend blocked on: ${like}`);
  }

  describe("A. grant versus suspension race", () => {
    it("a suspension that commits while the grant is in flight wins: 403, no row, audited", async () => {
      await clear();
      const c1 = await ctx.pool.connect();
      try {
        await c1.query("BEGIN");
        await c1.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [A()]);
        // The request's own status read (READ COMMITTED) still sees 'active'; only the
        // trigger's FOR SHARE can notice, and it must wait for the suspension to commit.
        const pending = grant("org1", ["tenant.read"]);
        await waitBlocked("%INSERT INTO org_admin_school_delegations%");
        await c1.query("COMMIT");
        const res = await pending;
        expect(res.statusCode, JSON.stringify(res.json())).toBe(403);
        expect(await active()).toEqual([]);
        expect((await lastEvent("rbac.org_delegation.denied", ctx.ids.orgAdmin))?.reason).toBe("school_suspended");
      } finally {
        c1.release();
        await ctx.pool.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [A()]);
      }
    });

    it("a grant that commits first makes the suspension wait; the grant exists but is inert", async () => {
      await clear();
      const c1 = await ctx.pool.connect();
      const c2 = await ctx.pool.connect();
      try {
        await c1.query("BEGIN");
        await c1.query(
          `INSERT INTO org_admin_school_delegations (organization_id, tenant_id, delegate_user_id, permission_code, granted_by)
           VALUES ($1, $2, $3, 'tenant.read', $4)`,
          [ctx.ids.orgA, A(), orgAdmin2, ctx.ids.orgAdmin],
        );
        const suspension = c2.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [A()]);
        await waitBlocked("%UPDATE tenants SET status%");
        await c1.query("COMMIT");
        await suspension;
        expect(await active()).toEqual(["tenant.read"]);
        // Suspended: the delegation cannot be exercised, even though it exists.
        expect((await reads("org2")).statusCode).toBe(403);
      } finally {
        c1.release();
        c2.release();
        await ctx.pool.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [A()]);
      }
      expect((await reads("org2")).statusCode).toBe(200); // restoration: still valid, resumes
    });

    it("concurrent grants do not serialise each other (shared lock) and finish without deadlock", async () => {
      await clear();
      const results = await Promise.all(Array.from({ length: 10 }, () => grant("org1", ["tenant.read", "resource.learner.read"])));
      for (const r of results) expect(r.statusCode).toBe(200);
      expect(await active()).toEqual(["resource.learner.read", "tenant.read"]);
    });
  });

  describe("B. idempotent replay never bypasses current state", () => {
    const key = () => ({ "idempotency-key": randomUUID() });

    it("a legitimate replay while everything is valid returns the stored result", async () => {
      await clear();
      const k = key();
      const first = await grant("org1", ["tenant.read"], k);
      expect(first.statusCode).toBe(200);
      expect(first.headers["idempotent-replayed"]).toBeUndefined();
      const again = await grant("org1", ["tenant.read"], k);
      expect(again.statusCode).toBe(200);
      expect(again.headers["idempotent-replayed"]).toBe("true");
      expect(await active()).toEqual(["tenant.read"]);
    });

    it("replay after suspension is refused with 403 and audited", async () => {
      await clear();
      const k = key();
      expect((await grant("org1", ["tenant.read"], k)).statusCode).toBe(200);
      await ctx.pool.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [A()]);
      try {
        const again = await grant("org1", ["tenant.read"], k);
        expect(again.statusCode).toBe(403);
        expect(again.headers["idempotent-replayed"]).toBeUndefined();
        expect((await lastEvent("rbac.org_delegation.denied", ctx.ids.orgAdmin))?.reason).toBe("school_suspended");
      } finally {
        await ctx.pool.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [A()]);
      }
    });

    it("replay after the delegation was revoked is a 409, not a stale 200", async () => {
      await clear();
      const k = key();
      expect((await grant("org1", ["tenant.read"], k)).statusCode).toBe(200);
      expect((await revoke("admin")).statusCode).toBe(200);
      const again = await grant("org1", ["tenant.read"], k);
      expect(again.statusCode).toBe(409);
      expect(await active()).toEqual([]);
    });

    it("replay after the actor lost authority is refused", async () => {
      await clear();
      const k = key();
      expect((await grant("org1", ["tenant.read"], k)).statusCode).toBe(200);
      await ctx.pool.query(`DELETE FROM organization_memberships WHERE user_id = $1`, [ctx.ids.orgAdmin]);
      try {
        const again = await grant("org1", ["tenant.read"], k);
        expect(again.statusCode).toBe(403);
      } finally {
        await ctx.pool.query(
          `INSERT INTO organization_memberships (user_id, organization_id, role) VALUES ($1, $2, 'org_admin')`,
          [ctx.ids.orgAdmin, ctx.ids.orgA],
        );
      }
    });
  });

  describe("C. disabled recipients", () => {
    it("a disabled user cannot receive a delegation; an active one can", async () => {
      await clear();
      await ctx.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [orgAdmin2]);
      try {
        const res = await grant("org1", ["tenant.read"]);
        expect(res.statusCode).toBe(400);
        expect(await active()).toEqual([]);
        expect((await lastEvent("rbac.org_delegation.denied", ctx.ids.orgAdmin))?.reason).toBe("ineligible_recipient");
      } finally {
        await ctx.pool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [orgAdmin2]);
      }
      expect((await grant("org1", ["tenant.read"])).statusCode).toBe(200);
    });

    it("a recipient disabled while the grant is in flight is refused (forced interleaving)", async () => {
      await clear();
      const c1 = await ctx.pool.connect();
      try {
        await c1.query("BEGIN");
        await c1.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [orgAdmin2]);
        const pending = grant("org1", ["tenant.read"]);
        await waitBlocked("%INSERT INTO org_admin_school_delegations%");
        await c1.query("COMMIT");
        const res = await pending;
        expect(res.statusCode, JSON.stringify(res.json())).toBe(400);
        expect(await active()).toEqual([]);
      } finally {
        c1.release();
        await ctx.pool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [orgAdmin2]);
      }
    });

    it("disabling the recipient invalidates the delegation for good: re-enabling does NOT restore it (migration 026)", async () => {
      await clear();
      expect((await grant("org1", ["tenant.read"])).statusCode).toBe(200);
      expect((await reads("org2")).statusCode).toBe(200);
      await ctx.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [orgAdmin2]);
      try {
        expect((await reads("org2")).statusCode).toBe(401); // the disabled user's session is dead
        expect(await active()).toEqual([]); // revoked, not merely dormant
      } finally {
        await ctx.pool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [orgAdmin2]);
      }
      expect((await reads("org2")).statusCode).toBe(403); // active again, but the grant is gone
      expect((await grant("org1", ["tenant.read"])).statusCode).toBe(200); // a fresh grant works
      expect((await reads("org2")).statusCode).toBe(200);
    });
  });

  describe("M-1. the runtime role cannot rewrite a delegation", () => {
    it("only revoked_at/revoked_by are updatable; the code, recipient and grantor are immutable; revocation is final", async () => {
      await clear();
      expect((await grant("org1", ["tenant.read"])).statusCode).toBe(200);
      const c = await ctx.runtimePool.connect();
      const asRuntime = async (sql: string, params: unknown[] = []) => {
        await c.query("BEGIN");
        try {
          await c.query(`SELECT set_config('app.user_id', $1, true), set_config('app.tenant_id', $2, true)`, [ctx.ids.adminA, A()]);
          return await c.query(sql, params);
        } finally {
          await c.query("ROLLBACK");
        }
      };
      try {
        await expect(asRuntime(`UPDATE org_admin_school_delegations SET permission_code = 'rbac.org_delegations.manage'`)).rejects.toThrow(/permission denied/i);
        await expect(asRuntime(`UPDATE org_admin_school_delegations SET delegate_user_id = $1`, [ctx.ids.teacherA])).rejects.toThrow(/permission denied/i);
        // The permitted columns still work (this is how revoke does it).
        const ok = await asRuntime(`UPDATE org_admin_school_delegations SET revoked_at = now(), revoked_by = $1 WHERE revoked_at IS NULL`, [ctx.ids.adminA]);
        expect(ok.rowCount).toBe(1);
      } finally {
        c.release();
      }
      await ctx.pool.query(`UPDATE org_admin_school_delegations SET revoked_at = now(), revoked_by = $1`, [ctx.ids.adminA]);
      await expect(ctx.pool.query(`UPDATE org_admin_school_delegations SET revoked_at = NULL`)).rejects.toThrow(/revocation_is_final/);
      await expect(ctx.pool.query(`UPDATE org_admin_school_delegations SET permission_code = 'rbac.org_delegations.manage'`)).rejects.toThrow(/delegation_immutable|revocation_is_final/);
    });
  });

  describe("L-3. re-grant and replay re-check the recipient", () => {
    it("re-granting already-active codes to a disabled recipient is refused; a replay then answers 409", async () => {
      await clear();
      const k = { "idempotency-key": randomUUID() };
      expect((await grant("org1", ["tenant.read"], k)).statusCode).toBe(200);
      await ctx.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [orgAdmin2]);
      try {
        expect((await grant("org1", ["tenant.read"])).statusCode).toBe(400);
        expect((await grant("org1", ["tenant.read"], k)).statusCode).toBe(409);
      } finally {
        await ctx.pool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [orgAdmin2]);
      }
    });
  });

  describe("D. listing", () => {
    it("org admins cannot list delegations (listing was never required; no permission was broadened)", async () => {
      const res = await call("GET", "org1", "/v1/rbac/org-delegations");
      expect(res.statusCode).toBe(403);
      // They can see their own effective delegated permissions instead.
      const perms = await call("GET", "org1", "/v1/rbac/permissions");
      expect(perms.statusCode).toBe(200);
      expect(Array.isArray(perms.json().delegatedPermissions)).toBe(true);
    });
  });

  describe("E. database allowlist", () => {
    it("the database predicate agrees with the TypeScript allowlist for every candidate code", async () => {
      const catalogue = await ctx.pool.query<{ code: string }>(`SELECT code FROM permissions`);
      const candidates = new Set<string>([
        ...catalogue.rows.map((r) => r.code),
        ...DELEGABLE_PERMISSIONS,
        ...ADMIN_AREAS.map((a) => `area.${a}`),
        "area.not_a_real_area",
        "area.",
        "platform.tenants.manage",
        "tenant.write",
        "org.delegations.grant",
        "org.delegations.revoke",
        "rbac.org_delegations.manage",
        "rbac.guardian_access.manage",
        "",
      ]);
      for (const code of candidates) {
        const r = await ctx.pool.query<{ ok: boolean }>(`SELECT public.is_delegable_permission($1) AS ok`, [code]);
        expect(r.rows[0]!.ok, `code "${code}"`).toBe(isDelegablePermission(code));
      }
      for (const code of DELEGABLE_PERMISSIONS) expect(isDelegablePermission(code)).toBe(true);
    });

    it("a direct database write of a non-delegable code is refused; a delegable one is accepted", async () => {
      await clear();
      const ins = (code: string) =>
        ctx.pool.query(
          `INSERT INTO org_admin_school_delegations (organization_id, tenant_id, delegate_user_id, permission_code, granted_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [ctx.ids.orgA, A(), orgAdmin2, code, ctx.ids.orgAdmin],
        );
      for (const code of ["rbac.org_delegations.manage", "org.delegations.grant", "platform.tenants.manage"]) {
        await expect(ins(code)).rejects.toThrow(/permission_not_delegable/);
      }
      await ins("tenant.read");
      expect(await active()).toEqual(["tenant.read"]);
    });

    it("rows that exist before the guard are not re-validated (migration cannot break old data) and still revoke", async () => {
      await clear();
      await ctx.pool.query(`ALTER TABLE org_admin_school_delegations DISABLE TRIGGER org_admin_school_delegations_guard`);
      try {
        await ctx.pool.query(
          `INSERT INTO org_admin_school_delegations (organization_id, tenant_id, delegate_user_id, permission_code, granted_by)
           VALUES ($1, $2, $3, 'tenant.read', $4)`,
          [ctx.ids.orgA, A(), orgAdmin2, ctx.ids.orgAdmin],
        );
      } finally {
        await ctx.pool.query(`ALTER TABLE org_admin_school_delegations ENABLE TRIGGER org_admin_school_delegations_guard`);
      }
      expect((await revoke("org1")).statusCode).toBe(200);
      expect(await active()).toEqual([]);
    });
  });

  describe("Owner decision 2026-11-17: the allowlist is exactly the approved five families", () => {
    const APPROVED = [
      "tenant.read",
      "rbac.staff_areas.manage",
      "rbac.school_roles.manage",
      "resource.learner.read",
      // area.people is NOT grantable (owner decision 2026-11-17): it carries learner, staff and document writes.
      // area.discipline (the behaviour log, docs/BEHAVIOUR.md) holds staff-only notes about children: not grantable until the owner says so.
      ...ADMIN_AREAS.filter((a) => a !== "people" && a !== "discipline").map((a) => `area.${a}`),
    ];
    const UNAPPROVED = [
      "area.people",
      "area.discipline",
      "resource.learner.write",
      "resource.guardian.read",
      "resource.guardian.write",
      "resource.staff.read",
      "resource.staff.write",
      "resource.school_profile.read",
      "resource.school_profile.write",
      "resource.document.read",
      "resource.document.write",
    ];

    it("TypeScript and the database accept exactly the approved codes and refuse every unapproved family", async () => {
      expect([...DELEGABLE_PERMISSIONS].sort()).toEqual([...APPROVED].sort());
      for (const code of APPROVED) {
        expect(isDelegablePermission(code), code).toBe(true);
        expect((await ctx.pool.query(`SELECT public.is_delegable_permission($1) AS ok`, [code])).rows[0].ok, code).toBe(true);
      }
      for (const code of UNAPPROVED) {
        expect(isDelegablePermission(code), code).toBe(false);
        expect((await ctx.pool.query(`SELECT public.is_delegable_permission($1) AS ok`, [code])).rows[0].ok, code).toBe(false);
      }
    });

    it("every approved code can be granted through the API, every unapproved one is refused with 400 and nothing is written", async () => {
      await clear();
      for (const code of APPROVED) {
        expect((await grant("org1", [code])).statusCode, code).toBe(200);
      }
      await clear();
      for (const code of UNAPPROVED) {
        const res = await grant("org1", [code]);
        expect(res.statusCode, code).toBe(400);
        expect((await lastEvent("rbac.org_delegation.denied", ctx.ids.orgAdmin))?.reason, code).toBe("not_delegable");
      }
      // Mixed with an approved code: the whole request is refused, nothing partial.
      expect((await grant("org1", ["tenant.read", "resource.guardian.read"])).statusCode).toBe(400);
      expect(await active()).toEqual([]);
    });

    it("direct database writes of every unapproved code are refused", async () => {
      await clear();
      for (const code of UNAPPROVED) {
        await expect(
          ctx.pool.query(
            `INSERT INTO org_admin_school_delegations (organization_id, tenant_id, delegate_user_id, permission_code, granted_by)
             VALUES ($1, $2, $3, $4, $5)`,
            [ctx.ids.orgA, A(), orgAdmin2, code, ctx.ids.orgAdmin],
          ),
          code,
        ).rejects.toThrow(/permission_not_delegable/);
      }
    });

    describe("legacy rows with a no-longer-delegable code", () => {
      async function insertLegacy(code: string): Promise<void> {
        await ctx.pool.query(`ALTER TABLE org_admin_school_delegations DISABLE TRIGGER org_admin_school_delegations_guard`);
        try {
          await ctx.pool.query(
            `INSERT INTO org_admin_school_delegations (organization_id, tenant_id, delegate_user_id, permission_code, granted_by)
             VALUES ($1, $2, $3, $4, $5)`,
            [ctx.ids.orgA, A(), orgAdmin2, code, ctx.ids.adminA],
          );
        } finally {
          await ctx.pool.query(`ALTER TABLE org_admin_school_delegations ENABLE TRIGGER org_admin_school_delegations_guard`);
        }
      }
      const legacyBlock = () => {
        const sql = readFileSync(join(process.cwd(), "migrations", "025_delegation_guards_and_guardian_access.sql"), "utf8");
        const a = sql.indexOf("DO $legacy$");
        const b = sql.indexOf("$legacy$;", a + 5) + "$legacy$;".length;
        return sql.slice(a, b);
      };

      it("an active legacy guardian grant is INERT: no guardian access, not even listed as effective; the row stays and is revocable", async () => {
        await clear();
        await insertLegacy("resource.guardian.read");
        await insertLegacy("resource.learner.write");
        await insertLegacy("tenant.read"); // an approved code next to them still works
        expect(await active()).toEqual(["resource.guardian.read", "resource.learner.write", "tenant.read"]); // on record
        expect((await reads("org2")).statusCode).toBe(200); // tenant.read still effective
        const guardians = await call("GET", "org2", `/v1/tenants/${A()}/guardians`);
        expect(guardians.statusCode).toBe(403);
        const learnerWrite = await call("POST", "org2", `/v1/tenants/${A()}/learners`, { admission_no: "LG-1", full_name: "Legacy", gender: "male" });
        expect(learnerWrite.statusCode).toBe(403);
        const perms = await call("GET", "org2", "/v1/rbac/permissions?limit=200");
        expect(perms.json().items).toContain("tenant.read");
        expect(perms.json().items).not.toContain("resource.guardian.read");
        expect(perms.json().items).not.toContain("resource.learner.write");
        expect(perms.json().delegatedPermissions).toEqual(["tenant.read"]);
        // Revocation of the legacy rows still works and is attributed.
        const rv = await revoke("org1");
        expect(rv.statusCode).toBe(200);
        expect(rv.json().revoked).toEqual(["resource.guardian.read", "resource.learner.write", "tenant.read"]);
        expect(await active()).toEqual([]);
      });

      it("a revoked legacy grant cannot be restored by re-granting or by replay", async () => {
        await clear();
        await insertLegacy("resource.guardian.write");
        expect((await revoke("admin")).statusCode).toBe(200);
        const k = { "idempotency-key": randomUUID() };
        expect((await grant("org1", ["resource.guardian.write"], k)).statusCode).toBe(400);
        expect((await grant("org1", ["resource.guardian.write"], k)).statusCode).toBe(400);
        expect(await active()).toEqual([]);
        await expect(
          ctx.pool.query(`UPDATE org_admin_school_delegations SET revoked_at = NULL`),
        ).rejects.toThrow(/revocation_is_final/);
      });

      it("the migration's legacy block records each active legacy row once, deletes nothing, and is idempotent", async () => {
        await clear();
        await insertLegacy("resource.guardian.read");
        await insertLegacy("resource.document.write");
        await insertLegacy("tenant.read");
        const mine = await ctx.pool.query<{ id: string; permission_code: string }>(
          `SELECT id, permission_code FROM org_admin_school_delegations WHERE tenant_id = $1 AND delegate_user_id = $2`,
          [A(), orgAdmin2],
        );
        const ids = mine.rows.map((r) => r.id);
        const before = await ctx.pool.query(`SELECT count(*)::int AS n FROM org_admin_school_delegations`);
        await ctx.pool.query(legacyBlock());
        await ctx.pool.query(legacyBlock()); // re-run adds nothing
        // Only this test's own rows are inspected: other rows or earlier runs on a reused database do not matter.
        const events = await ctx.pool.query<{ detail: Record<string, any> }>(
          `SELECT detail FROM security_audit_events
            WHERE event_type = 'rbac.org_delegation.legacy_inert' AND detail->>'delegationId' = ANY($1::text[])
            ORDER BY detail->>'permissionCode'`,
          [ids],
        );
        expect(events.rows.map((e) => e.detail.permissionCode)).toEqual(["resource.document.write", "resource.guardian.read"]);
        expect(events.rows[0]!.detail).toMatchObject({ originalGrantor: ctx.ids.adminA, delegateUserId: orgAdmin2, organizationId: ctx.ids.orgA });
        const after = await ctx.pool.query(`SELECT count(*)::int AS n FROM org_admin_school_delegations`);
        expect(after.rows[0].n).toBe(before.rows[0].n);
      });

      it("a revocation must be complete and not dated in the future", async () => {
        await clear();
        expect((await grant("org1", ["tenant.read"])).statusCode).toBe(200);
        await expect(ctx.pool.query(`UPDATE org_admin_school_delegations SET revoked_by = $1`, [ctx.ids.adminA])).rejects.toThrow(/revocation_incomplete/);
        await expect(ctx.pool.query(`UPDATE org_admin_school_delegations SET revoked_at = now()`)).rejects.toThrow(/revocation_incomplete/);
        await expect(
          ctx.pool.query(`UPDATE org_admin_school_delegations SET revoked_at = now() + interval '1 day', revoked_by = $1`, [ctx.ids.adminA]),
        ).rejects.toThrow(/revocation_incomplete/);
        expect(await active()).toEqual(["tenant.read"]);
      });
    });
  });

  describe("M-2: delegation cannot bypass the explicit guardian model", () => {
    it("an org admin cannot pass guardian access or guardian-access management to another org admin", async () => {
      await clear();
      for (const code of ["resource.guardian.read", "resource.guardian.write", "rbac.guardian_access.manage", "org.delegations.grant"]) {
        expect((await grant("org1", [code])).statusCode, code).toBe(400);
        expect((await grant("admin", [code])).statusCode, `admin ${code}`).toBe(400);
      }
      expect(await active()).toEqual([]);
    });

    it("the management permissions an org admin can hold do not reach guardian access", async () => {
      await clear();
      expect(
        (await grant("org1", ["rbac.staff_areas.manage", "rbac.school_roles.manage", "area.fees", "resource.learner.read", "tenant.read"])).statusCode,
      ).toBe(200);
      expect((await call("GET", "org2", `/v1/tenants/${A()}/guardians`)).statusCode).toBe(403);
      expect((await call("POST", "org2", "/v1/rbac/guardian-access", { userId: ctx.ids.teacherA, permissionCodes: ["resource.guardian.read"] })).statusCode).toBe(403);
      expect((await call("GET", "org2", `/v1/rbac/guardian-access?userId=${ctx.ids.teacherA}`)).statusCode).toBe(403);
      const perms = await call("GET", "org2", "/v1/rbac/permissions?limit=200");
      for (const c of perms.json().items as string[]) expect(c.startsWith("resource.guardian"), c).toBe(false);
    });

    it("an org admin cannot become an explicit grantee: only teacher/staff members are eligible", async () => {
      await expect(
        ctx.pool.query(
          `INSERT INTO staff_resource_grants (tenant_id, user_id, permission_code, granted_by) VALUES ($1, $2, 'resource.guardian.read', $3)`,
          [A(), orgAdmin2, ctx.ids.adminA],
        ),
      ).rejects.toThrow(/grantee_not_eligible/);
    });
  });

});
