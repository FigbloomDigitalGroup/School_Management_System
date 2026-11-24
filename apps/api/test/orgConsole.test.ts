/**
 * S11: organisation console reads (migration 105, docs/ORG-CONSOLE.md).
 *   GET /v1/org/organizations
 *   GET /v1/org/organizations/{organizationId}/admins
 *   GET /v1/org/organizations/{organizationId}/audit-events
 * The cross-organisation boundary is the point: an org admin sees only their own organisations, only the admins of an
 * active organisation they administer, and only their OWN audit events about it. Everyone else gets 403.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/modules/identity/password.js";
import { createTestApp, type FixtureIds } from "./support.js";

const PASSWORD = "correct-horse-battery";
type Ctx = Awaited<ReturnType<typeof createTestApp>>;

describe("org console reads (S11)", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  const tok: Record<string, string> = {};
  /** Second admin of Org A, admin of Org B, a suspended organisation the fixture org admin also runs, a second Org A school. */
  const x = { coAdmin: randomUUID(), adminOfB: randomUUID(), orgSuspended: randomUUID(), tenantA2: randomUUID() };

  const get = (who: string, url: string, headers: Record<string, string> = {}) =>
    ctx.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${tok[who]}`, ...headers } });
  const login = async (body: Record<string, unknown>) => {
    const r = await ctx.app.inject({ method: "POST", url: body.email ? "/v1/auth/login/email" : "/v1/auth/login/login-id", payload: body });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().token as string;
  };
  const audit = (actor: string, tenantId: string | null, eventType: string, detail: Record<string, unknown> = {}, at = "now()") =>
    ctx.pool.query(
      `INSERT INTO security_audit_events (actor_user_id, tenant_id, event_type, detail, ip, occurred_at)
       VALUES ($1, $2, $3, $4::jsonb, '10.1.2.3', ${at})`,
      [actor, tenantId, eventType, JSON.stringify(detail)],
    );

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    const hash = await hashPassword(PASSWORD);
    for (const [id, email, name] of [
      [x.coAdmin, "coadmin@example.com", "Co Admin"],
      [x.adminOfB, "orgadmin-b@example.com", "Org B Admin"],
    ] as const) {
      await ctx.pool.query(`INSERT INTO users (id, email, password_hash, full_name, phone, status) VALUES ($1, $2, $3, $4, '+254700000001', 'active')`, [id, email, hash, name]);
    }
    await ctx.pool.query(`INSERT INTO organizations (id, name, slug, kind, status) VALUES ($1, 'Dormant Org', 'dormant-org', 'group_owner', 'suspended')`, [x.orgSuspended]);
    await ctx.pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role) VALUES ($1, $3, 'org_admin'), ($2, $4, 'org_admin'), ($5, $6, 'org_admin')`,
      [x.coAdmin, x.adminOfB, ids.orgA, ids.orgB, ids.orgAdmin, x.orgSuspended],
    );
    await ctx.pool.query(`INSERT INTO tenants (id, organization_id, name, slug, status) VALUES ($1, $2, 'School A2', 'school-a2', 'active')`, [x.tenantA2, ids.orgA]);

    tok.org = await login({ email: "orgadmin@example.com", password: PASSWORD });
    tok.coAdmin = await login({ email: "coadmin@example.com", password: PASSWORD });
    tok.adminOfB = await login({ email: "orgadmin-b@example.com", password: PASSWORD });
    tok.schoolAdmin = await login({ email: "admin-a@example.com", password: PASSWORD });
    tok.teacher = await login({ tenantId: ids.tenantA, loginId: "TC-0001", password: PASSWORD });
    tok.parent = await login({ tenantId: ids.tenantA, loginId: "PT-0001", password: PASSWORD });
    tok.superAdmin = await login({ email: "super@example.com", password: PASSWORD });
  }, 180_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  describe("GET /v1/org/organizations", () => {
    it("lists only the caller's own organisations, every status, ordered by name", async () => {
      const r = await get("org", "/v1/org/organizations");
      expect(r.statusCode, r.body).toBe(200);
      const items = r.json().items as Array<Record<string, unknown>>;
      expect(items.map((o) => [o.name, o.status, o.kind])).toEqual([
        ["Dormant Org", "suspended", "group_owner"],
        ["Org A", "active", "group_owner"],
      ]);
      expect(Object.keys(items[0]!).sort()).toEqual(["id", "kind", "name", "slug", "status"]);
      expect(items.some((o) => o.id === ids.orgB)).toBe(false);
      expect(r.json().page.next_cursor).toBeNull();
    });

    it("pages one at a time without skipping, and a cursor is bound to its caller", async () => {
      const first = await get("org", "/v1/org/organizations?limit=1");
      expect(first.json().items).toHaveLength(1);
      const cursor = first.json().page.next_cursor as string;
      expect(cursor).toBeTruthy();
      const second = await get("org", `/v1/org/organizations?limit=1&cursor=${encodeURIComponent(cursor)}`);
      expect(second.json().items.map((o: { name: string }) => o.name)).toEqual(["Org A"]);
      expect(second.json().page.next_cursor).toBeNull();
      // another org admin cannot reuse it (fingerprint carries the caller)
      const stolen = await get("adminOfB", `/v1/org/organizations?limit=1&cursor=${encodeURIComponent(cursor)}`);
      expect(stolen.statusCode).toBe(400);
      expect(stolen.json().error.code).toBe("validation_error");
    });

    it("another organisation's admin sees only their own", async () => {
      const r = await get("adminOfB", "/v1/org/organizations");
      expect(r.json().items.map((o: { id: string }) => o.id)).toEqual([ids.orgB]);
    });

    it.each(["schoolAdmin", "teacher", "parent", "superAdmin"])("%s (no org.tenants.read) gets 403", async (who) => {
      const r = await get(who, "/v1/org/organizations", { "x-tenant-id": ids.tenantA });
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().error.code).toBe("forbidden");
      expect(r.body).not.toContain("Org A");
    });

    it("anonymous callers get 401", async () => {
      expect((await ctx.app.inject({ method: "GET", url: "/v1/org/organizations" })).statusCode).toBe(401);
    });
  });

  describe("GET /v1/org/organizations/{organizationId}/admins", () => {
    it("lists the organisation's admins with name, sign-in e-mail, status and since; marks the caller; no phone", async () => {
      const r = await get("org", `/v1/org/organizations/${ids.orgA}/admins`);
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json();
      expect(body.organizationId).toBe(ids.orgA);
      const items = body.items as Array<Record<string, unknown>>;
      expect(items.map((a) => [a.fullName, a.email, a.isYou, a.status])).toEqual([
        ["Org Admin", "orgadmin@example.com", true, "active"],
        ["Co Admin", "coadmin@example.com", false, "active"],
      ]);
      expect(Object.keys(items[0]!).sort()).toEqual(["email", "fullName", "isYou", "since", "status", "userId"]);
      expect(r.body).not.toContain("+254700000001");
      expect(r.body).not.toContain("Org B Admin");
      expect(items[0]!.since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    });

    it("pages with a (since, id) cursor", async () => {
      const first = await get("org", `/v1/org/organizations/${ids.orgA}/admins?limit=1`);
      const cursor = first.json().page.next_cursor as string;
      const second = await get("org", `/v1/org/organizations/${ids.orgA}/admins?limit=1&cursor=${encodeURIComponent(cursor)}`);
      expect(second.statusCode, second.body).toBe(200);
      expect([...first.json().items, ...second.json().items].map((a: { fullName: string }) => a.fullName)).toEqual(["Org Admin", "Co Admin"]);
      expect(second.json().page.next_cursor).toBeNull();
      // the co-admin cannot replay the caller's cursor
      expect((await get("coAdmin", `/v1/org/organizations/${ids.orgA}/admins?limit=1&cursor=${encodeURIComponent(cursor)}`)).statusCode).toBe(400);
    });

    it("another organisation, an unknown id and a suspended organisation all get the same 403 (existence not revealed)", async () => {
      const answers = [];
      for (const orgId of [ids.orgB, randomUUID(), x.orgSuspended]) {
        const r = await get("org", `/v1/org/organizations/${orgId}/admins`);
        expect(r.statusCode, orgId).toBe(403);
        expect(r.body).not.toContain("Org B Admin");
        answers.push({ code: r.json().error.code, message: r.json().error.message });
      }
      expect(answers[1]).toEqual(answers[0]);
      expect(answers[2]).toEqual(answers[0]);
      // and the other way round
      expect((await get("adminOfB", `/v1/org/organizations/${ids.orgA}/admins`)).statusCode).toBe(403);
    });

    it("the refusal is audited, with the organisation and the reason", async () => {
      await get("adminOfB", `/v1/org/organizations/${ids.orgA}/admins`);
      const ev = await ctx.pool.query(
        `SELECT detail FROM security_audit_events
          WHERE event_type = 'rbac.permission.denied' AND actor_user_id = $1 AND occurred_at > now() - interval '1 minute'
          ORDER BY occurred_at DESC LIMIT 1`,
        [x.adminOfB],
      );
      expect(ev.rows[0]?.detail).toMatchObject({ permission: "org.admins.read", organizationId: ids.orgA, reason: "not_org_admin_of_active_org" });
    });

    it.each(["schoolAdmin", "teacher", "parent", "superAdmin"])("%s (no org.admins.read) gets 403", async (who) => {
      const r = await get(who, `/v1/org/organizations/${ids.orgA}/admins`, { "x-tenant-id": ids.tenantA });
      expect(r.statusCode, r.body).toBe(403);
      expect(r.body).not.toContain("orgadmin@example.com");
    });

    it("a malformed id is 400 and an anonymous caller 401", async () => {
      expect((await get("org", "/v1/org/organizations/not-a-uuid/admins")).statusCode).toBe(400);
      expect((await ctx.app.inject({ method: "GET", url: `/v1/org/organizations/${ids.orgA}/admins` })).statusCode).toBe(401);
    });

    it("an org admin whose organisation is suspended loses the list on the next request", async () => {
      expect((await get("coAdmin", `/v1/org/organizations/${ids.orgA}/admins`)).statusCode).toBe(200);
      await ctx.pool.query(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [ids.orgA]);
      try {
        expect((await get("coAdmin", `/v1/org/organizations/${ids.orgA}/admins`)).statusCode).toBe(403);
        expect((await get("coAdmin", `/v1/org/organizations/${ids.orgA}/audit-events`)).statusCode).toBe(403);
      } finally {
        await ctx.pool.query(`UPDATE organizations SET status = 'active' WHERE id = $1`, [ids.orgA]);
      }
    });
  });

  describe("GET /v1/org/organizations/{organizationId}/audit-events", () => {
    beforeAll(async () => {
      // A real event: the org admin delegates tenant.read in School A to the co-admin (FIG-1609 path).
      const g = await ctx.app.inject({
        method: "POST",
        url: "/v1/rbac/org-delegations",
        headers: { authorization: `Bearer ${tok.org}`, "x-tenant-id": ids.tenantA },
        payload: { delegateUserId: x.coAdmin, permissionCodes: ["tenant.read"] },
      });
      expect(g.statusCode, g.body).toBe(200);
      // Own events: in the other Org A school, and an org-level one with no school.
      await audit(ids.orgAdmin, x.tenantA2, "directory.learner.created", { learnerId: randomUUID() }, "now() - interval '1 hour'");
      await audit(ids.orgAdmin, null, "rbac.org_delegation.revoked", { organizationId: ids.orgA, note: "org-level" }, "now() - interval '2 hours'");
      // Must never appear: own events elsewhere, own events with no organisation, other people's events.
      await audit(ids.orgAdmin, ids.tenantB, "directory.learner.created", { marker: "own-in-org-b" });
      await audit(ids.orgAdmin, null, "auth.login.success", { marker: "own-no-org" });
      await audit(ids.orgAdmin, null, "rbac.org_delegation.granted", { organizationId: ids.orgB, marker: "own-names-org-b" });
      await audit(x.coAdmin, ids.tenantA, "directory.learner.created", { marker: "co-admin-in-a" });
      await audit(ids.adminA, ids.tenantA, "directory.learner.created", { marker: "school-admin-in-a" });
      await audit(x.adminOfB, null, "rbac.org_delegation.granted", { organizationId: ids.orgA, marker: "other-names-org-a" });
    });

    it("returns only the caller's own events about the organisation, newest first, with the school name and no ip", async () => {
      const r = await get("org", `/v1/org/organizations/${ids.orgA}/audit-events`);
      expect(r.statusCode, r.body).toBe(200);
      const items = r.json().items as Array<Record<string, any>>;
      expect(items.map((e) => e.eventType)).toEqual(["rbac.org_delegation.granted", "directory.learner.created", "rbac.org_delegation.revoked"]);
      expect(items[0]).toMatchObject({ schoolId: ids.tenantA, schoolName: "School A" });
      expect(items[0]!.detail).toMatchObject({ organizationId: ids.orgA, delegateUserId: x.coAdmin });
      expect(items[1]).toMatchObject({ schoolId: x.tenantA2, schoolName: "School A2" });
      expect(items[2]).toMatchObject({ schoolId: null, schoolName: null });
      for (const e of items) expect(Object.keys(e).sort()).toEqual(["detail", "eventType", "id", "occurredAt", "schoolId", "schoolName"]);
      expect(r.body).not.toContain("10.1.2.3");
      for (const marker of ["own-in-org-b", "own-no-org", "own-names-org-b", "co-admin-in-a", "school-admin-in-a", "other-names-org-a"]) {
        expect(r.body, marker).not.toContain(marker);
      }
    });

    it("the co-admin sees their own event in School A, not the caller's", async () => {
      const r = await get("coAdmin", `/v1/org/organizations/${ids.orgA}/audit-events`);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.body).toContain("co-admin-in-a");
      expect(r.body).not.toContain("rbac.org_delegation.granted");
    });

    it("pages one at a time in the same order without duplicates; a cursor is bound to caller and organisation", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let firstCursor: string | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const r: { statusCode: number; body: string; json(): any } = await get("org", `/v1/org/organizations/${ids.orgA}/audit-events?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        expect(r.statusCode, r.body).toBe(200);
        seen.push(...r.json().items.map((e: { id: string }) => e.id));
        cursor = r.json().page.next_cursor;
        firstCursor ??= cursor;
        if (!cursor) break;
      }
      const all = (await get("org", `/v1/org/organizations/${ids.orgA}/audit-events`)).json().items.map((e: { id: string }) => e.id);
      expect(seen).toEqual(all);
      expect(new Set(seen).size).toBe(seen.length);
      expect((await get("coAdmin", `/v1/org/organizations/${ids.orgA}/audit-events?cursor=${encodeURIComponent(firstCursor!)}`)).statusCode).toBe(400);
      expect((await get("org", `/v1/org/organizations/${ids.orgA}/audit-events?sort=occurred_at_asc`)).statusCode).toBe(400);
    });

    it("another organisation, an unknown id and a suspended organisation all get the same 403", async () => {
      const bodies = [];
      for (const orgId of [ids.orgB, randomUUID(), x.orgSuspended]) {
        const r = await get("org", `/v1/org/organizations/${orgId}/audit-events`);
        expect(r.statusCode, orgId).toBe(403);
        bodies.push(r.json().error.message);
      }
      expect(new Set(bodies).size).toBe(1);
      const b = await get("adminOfB", `/v1/org/organizations/${ids.orgA}/audit-events`);
      expect(b.statusCode).toBe(403);
      expect(b.body).not.toContain("rbac.org_delegation");
    });

    it.each(["schoolAdmin", "teacher", "parent", "superAdmin"])("%s (no org.audit.read) gets 403", async (who) => {
      const r = await get(who, `/v1/org/organizations/${ids.orgA}/audit-events`, { "x-tenant-id": ids.tenantA });
      expect(r.statusCode, r.body).toBe(403);
      expect(r.body).not.toContain("directory.learner.created");
    });
  });

  describe("database boundary (as the figbloom_app login)", () => {
    const asApp = async <T>(userId: string | null, fn: (c: import("pg").PoolClient) => Promise<T>) => {
      const c = await ctx.runtimePool.connect();
      try {
        await c.query("BEGIN");
        if (userId) await c.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
        return await fn(c);
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
    };

    it("the runtime role still cannot read the audit table directly", async () => {
      await expect(asApp(ids.orgAdmin, (c) => c.query(`SELECT 1 FROM security_audit_events LIMIT 1`))).rejects.toMatchObject({ code: "42501" });
    });

    it("the reader refuses a missing actor, another organisation and a suspended organisation (42501)", async () => {
      const call = (userId: string | null, org: string) =>
        asApp(userId, (c) => c.query(`SELECT * FROM public.org_my_audit_events($1, NULL, NULL, 50)`, [org]));
      await expect(call(null, ids.orgA)).rejects.toMatchObject({ code: "42501" });
      await expect(call(ids.orgAdmin, ids.orgB)).rejects.toMatchObject({ code: "42501" });
      await expect(call(ids.orgAdmin, x.orgSuspended)).rejects.toMatchObject({ code: "42501" });
      await expect(call(ids.adminA, ids.orgA)).rejects.toMatchObject({ code: "42501" });
      // a half cursor is refused, not read as "from the start"
      await expect(asApp(ids.orgAdmin, (c) => c.query(`SELECT * FROM public.org_my_audit_events($1, now(), NULL, 50)`, [ids.orgA]))).rejects.toMatchObject({ code: "22023" });
    });

    it("the reader returns only the GUC actor's rows and never more than 201", async () => {
      const rows = await asApp(x.coAdmin, (c) => c.query<{ event_type: string; detail: Record<string, unknown> }>(`SELECT event_type, detail FROM public.org_my_audit_events($1, NULL, NULL, 100000)`, [ids.orgA]));
      // the co-admin's own marker event, plus their own refusals while Org A was suspended (they name Org A); nothing else
      expect(rows.rows.map((r) => r.detail.marker).filter(Boolean)).toEqual(["co-admin-in-a"]);
      for (const r of rows.rows.filter((row) => !row.detail.marker)) {
        expect(r).toMatchObject({ event_type: "rbac.permission.denied", detail: { organizationId: ids.orgA } });
      }
      await ctx.pool.query(
        `INSERT INTO security_audit_events (actor_user_id, tenant_id, event_type, detail)
         SELECT $1, $2, 'directory.learner.created', jsonb_build_object('n', g) FROM generate_series(1, 210) g`,
        [x.coAdmin, ids.tenantA],
      );
      const many = await asApp(x.coAdmin, (c) => c.query(`SELECT id FROM public.org_my_audit_events($1, NULL, NULL, 100000)`, [ids.orgA]));
      expect(many.rowCount).toBe(201);
    });
  });
});
