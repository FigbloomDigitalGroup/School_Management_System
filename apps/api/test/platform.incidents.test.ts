/**
 * The platform incident list (docs/PLATFORM-CONSOLE.md section 3.4, owner decision D5; migration 121).
 *
 * Refusals first: no session, a school administrator, an organisation administrator, a teacher and a parent, with and
 * without X-Tenant-Id, get 401/403 on every route and nothing is written; a super administrator whose sign-in is older
 * than the re-authentication window cannot declare or resolve; the runtime role cannot touch the table, and the definer
 * functions refuse anyone but a super administrator. Then the work: declare, list (newest first, state filter, paging),
 * resolve, resolve again (nothing changes), unknown and malformed ids, and the body rules.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";
import { loadSpec, responseSchema, validate } from "./support/openapiConformance.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
const PASSWORD = "correct-horse-battery";
const B = "/v1/platform/incidents";
const spec = loadSpec();

describe("platform incidents (slice S5, migration 121)", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  const tokens: Record<string, string> = {};

  const login = async (payload: Record<string, unknown>) => {
    const url = "email" in payload ? "/v1/auth/login/email" : "/v1/auth/login/login-id";
    const res = await ctx.app.inject({ method: "POST", url, payload });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    return res.json().token as string;
  };
  const send = (method: "GET" | "POST", url: string, token?: string, opts: { tenant?: string; body?: unknown } = {}) =>
    ctx.app.inject({
      method,
      url,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.tenant ? { "x-tenant-id": opts.tenant } : {}) },
      ...(opts.body === undefined ? {} : { payload: opts.body as Record<string, unknown> }),
    });
  const count = async () => Number((await ctx.pool.query(`SELECT count(*)::int AS n FROM platform_incidents`)).rows[0].n);
  const audits = async (type: string) =>
    (await ctx.pool.query<{ actor_user_id: string; tenant_id: string | null; detail: Record<string, unknown> }>(
      `SELECT actor_user_id, tenant_id, detail FROM security_audit_events WHERE event_type = $1 ORDER BY occurred_at, id`,
      [type],
    )).rows;
  const conforms = (method: string, path: string, status: number, body: unknown) => {
    const schema = responseSchema(spec, method, path, status);
    expect(typeof schema, `${method} ${path} ${status}`).toBe("object");
    expect(validate(spec, schema, body)).toEqual([]);
  };
  const VALID = { severity: "SEV-2", title: "Attendance sync backlog", summary: "Teachers see yesterday's roster", affected_schools: 3 };
  const declare = async (body: Record<string, unknown> = VALID) => {
    const res = await send("POST", B, tokens.super, { body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().incident as Record<string, unknown> & { id: string };
  };
  const ageSessions = () =>
    ctx.pool.query(`UPDATE sessions SET created_at = created_at - interval '1 hour', expires_at = expires_at - interval '1 hour', reauthenticated_at = NULL`);

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    tokens.super = await login({ email: "super@example.com", password: PASSWORD });
    tokens.schoolAdmin = await login({ email: "admin-a@example.com", password: PASSWORD });
    tokens.orgAdmin = await login({ email: "orgadmin@example.com", password: PASSWORD });
    tokens.teacher = await login({ tenantId: ids.tenantA, loginId: "TC-0001", password: PASSWORD });
    tokens.parent = await login({ tenantId: ids.tenantA, loginId: "PT-0001", password: PASSWORD });
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  describe("who may not", () => {
    it("an unauthenticated caller gets 401 on every route, and nothing is written", async () => {
      const id = randomUUID();
      expect((await send("GET", B)).statusCode).toBe(401);
      expect((await send("POST", B, undefined, { body: VALID })).statusCode).toBe(401);
      expect((await send("POST", `${B}/${id}/resolve`)).statusCode).toBe(401);
      expect(await count()).toBe(0);
    });

    it("school admin, org admin, teacher and parent get 403 on every route, with or without X-Tenant-Id, before any input is read", async () => {
      const id = randomUUID();
      for (const who of ["schoolAdmin", "orgAdmin", "teacher", "parent"]) {
        for (const tenant of [undefined, ids.tenantA, ids.tenantB]) {
          const tag = `${who}${tenant ? "+tenant" : ""}`;
          expect((await send("GET", B, tokens[who], { tenant })).statusCode, `GET ${tag}`).toBe(403);
          expect((await send("GET", `${B}?state=nonsense`, tokens[who], { tenant })).statusCode, `GET bad filter ${tag}`).toBe(403);
          expect((await send("POST", B, tokens[who], { tenant, body: VALID })).statusCode, `POST ${tag}`).toBe(403);
          expect((await send("POST", B, tokens[who], { tenant, body: { nonsense: true } })).statusCode, `POST bad body ${tag}`).toBe(403);
          expect((await send("POST", `${B}/${id}/resolve`, tokens[who], { tenant })).statusCode, `resolve ${tag}`).toBe(403);
          expect((await send("POST", `${B}/not-a-uuid/resolve`, tokens[who], { tenant })).statusCode, `resolve bad id ${tag}`).toBe(403);
        }
      }
      expect(await count()).toBe(0);
      const denied = await ctx.pool.query(
        `SELECT count(*)::int AS n FROM security_audit_events WHERE event_type = 'rbac.permission.denied' AND detail->>'permission' = 'platform.incidents.manage'`,
      );
      expect(denied.rows[0].n).toBeGreaterThan(0);
    });

    it("the runtime role holds no privilege on platform_incidents, and the definer functions refuse anyone but a super administrator", async () => {
      const grants = await ctx.pool.query(
        `SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'platform_incidents' AND grantee IN ('figbloom_app', 'figbloom_worker', 'PUBLIC')`,
      );
      expect(grants.rows).toEqual([]);
      const flags = (await ctx.pool.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.platform_incidents'::regclass`)).rows[0];
      expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

      const c = await ctx.runtimePool.connect();
      const attempt = async (userId: string | null, sql: string, params: unknown[] = []) => {
        await c.query("BEGIN");
        try {
          if (userId) await c.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
          await c.query(sql, params);
          return "ok";
        } catch (e) {
          return (e as { code?: string }).code ?? "error";
        } finally {
          await c.query("ROLLBACK");
        }
      };
      try {
        expect(await attempt(ids.superAdmin, `SELECT * FROM platform_incidents`)).toBe("42501");
        expect(await attempt(ids.superAdmin, `INSERT INTO platform_incidents (severity, title, summary) VALUES ('SEV-1', 'x', 'y')`)).toBe("42501");
        for (const who of [null, ids.adminA, ids.teacherA, ids.parentA, ids.orgAdmin]) {
          expect(await attempt(who, `SELECT * FROM public.platform_incidents_list(NULL, NULL, NULL, NULL, 10)`), `list ${who}`).toBe("42501");
          expect(await attempt(who, `SELECT public.platform_incident_declare('SEV-1', 'x', 'y', 0)`), `declare ${who}`).toBe("42501");
          expect(await attempt(who, `SELECT public.platform_incident_resolve($1)`, [randomUUID()]), `resolve ${who}`).toBe("42501");
        }
      } finally {
        c.release();
      }
      expect(await count()).toBe(0);
    });

    it("a super administrator whose sign-in is older than the window cannot declare or resolve (reauth_required, nothing changed), but may still read", async () => {
      const open = await declare();
      const stale = await login({ email: "super@example.com", password: PASSWORD });
      await ageSessions();
      try {
        const before = await count();
        const d = await send("POST", B, stale, { body: VALID });
        expect(d.statusCode).toBe(403);
        expect(d.json().error.code).toBe("reauth_required");
        const r = await send("POST", `${B}/${open.id}/resolve`, stale);
        expect(r.statusCode).toBe(403);
        expect(r.json().error.code).toBe("reauth_required");
        expect(await count()).toBe(before);
        expect((await ctx.pool.query(`SELECT status FROM platform_incidents WHERE id = $1`, [open.id])).rows[0].status).toBe("investigating");
        expect((await send("GET", B, stale)).statusCode).toBe(200);
      } finally {
        await ctx.pool.query(`UPDATE sessions SET reauthenticated_at = now()`);
      }
    });
  });

  describe("the super administrator", () => {
    it("declares an incident: stored as sent (trimmed), opened now by the caller, audited without its text", async () => {
      const res = await send("POST", B, tokens.super, {
        body: { severity: "SEV-1", title: "  M-Pesa prompts failing  ", summary: "  Parents cannot pay  ", affected_schools: 12 },
      });
      expect(res.statusCode, res.body).toBe(201);
      conforms("POST", B, 201, res.json());
      const inc = res.json().incident;
      expect(inc).toMatchObject({
        severity: "SEV-1",
        title: "M-Pesa prompts failing",
        summary: "Parents cannot pay",
        affectedSchools: 12,
        status: "investigating",
        openedBy: ids.superAdmin,
        openedByName: "Super Admin",
        resolvedAt: null,
        resolvedBy: null,
        resolvedByName: null,
      });
      expect(Math.abs(Date.parse(inc.openedAt) - Date.now())).toBeLessThan(60_000);
      const a = (await audits("platform.incident.declared")).find((r) => r.detail.incidentId === inc.id);
      expect(a).toBeTruthy();
      expect(a!.actor_user_id).toBe(ids.superAdmin);
      expect(a!.tenant_id).toBeNull();
      expect(a!.detail).toEqual({ incidentId: inc.id, severity: "SEV-1", affectedSchools: 12 });
    });

    it("refuses a body that breaks the rules, and writes nothing", async () => {
      const before = await count();
      const bad: unknown[] = [
        {},
        { ...VALID, severity: "SEV-4" },
        { ...VALID, title: "   " },
        { ...VALID, summary: "" },
        { ...VALID, title: "x".repeat(201) },
        { ...VALID, summary: "x".repeat(2001) },
        { ...VALID, affected_schools: -1 },
        { ...VALID, affected_schools: 1.5 },
        { ...VALID, affected_schools: 100001 },
        { ...VALID, affected_schools: "3" },
        { ...VALID, status: "resolved" },
        { ...VALID, opened_by: ids.adminA },
      ];
      for (const body of bad) {
        const res = await send("POST", B, tokens.super, { body });
        expect(res.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
        expect(res.json().error.code).toBe("validation_error");
      }
      expect(await count()).toBe(before);
    });

    it("lists newest first, filters open and resolved, pages with a cursor, and ignores X-Tenant-Id", async () => {
      for (let i = 0; i < 4; i++) await declare({ ...VALID, title: `Paging ${i}` });
      const all = await send("GET", B, tokens.super);
      expect(all.statusCode).toBe(200);
      conforms("GET", B, 200, all.json());
      const items = all.json().items as Array<{ id: string; openedAt: string; status: string }>;
      const sorted = [...items].sort((a, b) => (a.openedAt === b.openedAt ? a.id.localeCompare(b.id) : b.openedAt.localeCompare(a.openedAt)));
      expect(items.map((i) => i.id)).toEqual(sorted.map((i) => i.id));
      expect(items.length).toBe(await count());

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 20; guard++) {
        const res = await send("GET", `${B}?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, tokens.super);
        expect(res.statusCode, res.body).toBe(200);
        seen.push(...(res.json().items as Array<{ id: string }>).map((i) => i.id));
        cursor = res.json().page.next_cursor;
        if (!cursor) break;
      }
      expect(seen).toEqual(items.map((i) => i.id));

      const withHeader = await send("GET", B, tokens.super, { tenant: ids.tenantA });
      expect(withHeader.json().items.map((i: { id: string }) => i.id)).toEqual(items.map((i) => i.id));

      const first = await send("GET", `${B}?limit=2`, tokens.super);
      const reused = await send("GET", `${B}?state=open&cursor=${encodeURIComponent(first.json().page.next_cursor)}`, tokens.super);
      expect(reused.statusCode).toBe(400); // a cursor is bound to its filter
      expect((await send("GET", `${B}?state=all`, tokens.super)).statusCode).toBe(400);
      expect((await send("GET", `${B}?limit=0`, tokens.super)).statusCode).toBe(400);
    });

    it("resolves once: resolved now by the caller and audited; a second resolve changes nothing and writes no audit row", async () => {
      const inc = await declare({ ...VALID, severity: "SEV-3" });
      const r1 = await send("POST", `${B}/${inc.id}/resolve`, tokens.super);
      expect(r1.statusCode, r1.body).toBe(200);
      conforms("POST", `${B}/{incidentId}/resolve`, 200, r1.json());
      expect(r1.json().changed).toBe(true);
      expect(r1.json().incident).toMatchObject({ id: inc.id, status: "resolved", resolvedBy: ids.superAdmin, resolvedByName: "Super Admin" });
      const resolvedAt = r1.json().incident.resolvedAt as string;
      expect(Date.parse(resolvedAt)).toBeGreaterThanOrEqual(Date.parse(String(inc.openedAt)));

      const r2 = await send("POST", `${B}/${inc.id}/resolve`, tokens.super);
      expect(r2.statusCode).toBe(200);
      expect(r2.json().changed).toBe(false);
      expect(r2.json().incident.resolvedAt).toBe(resolvedAt);
      const rows = (await audits("platform.incident.resolved")).filter((a) => a.detail.incidentId === inc.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.detail).toEqual({ incidentId: inc.id, severity: "SEV-3", previousStatus: "investigating" });

      const open = await send("GET", `${B}?state=open`, tokens.super);
      expect(open.json().items.some((i: { id: string }) => i.id === inc.id)).toBe(false);
      const resolved = await send("GET", `${B}?state=resolved`, tokens.super);
      expect(resolved.json().items.map((i: { id: string }) => i.id)).toContain(inc.id);
      expect((resolved.json().items as Array<{ status: string }>).every((i) => i.status === "resolved")).toBe(true);
      expect((open.json().items as Array<{ status: string }>).every((i) => i.status !== "resolved")).toBe(true);
    });

    it("two resolves at the same moment resolve it once", async () => {
      const inc = await declare();
      const [a, b] = await Promise.all([send("POST", `${B}/${inc.id}/resolve`, tokens.super), send("POST", `${B}/${inc.id}/resolve`, tokens.super)]);
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      expect([a.json().changed, b.json().changed].sort()).toEqual([false, true]);
      expect((await audits("platform.incident.resolved")).filter((r) => r.detail.incidentId === inc.id)).toHaveLength(1);
    });

    it("an unknown incident is 404 and a malformed id is 400", async () => {
      const unknown = await send("POST", `${B}/${randomUUID()}/resolve`, tokens.super);
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error.code).toBe("not_found");
      expect((await send("POST", `${B}/not-a-uuid/resolve`, tokens.super)).statusCode).toBe(400);
    });

    it("the database refuses rows that break the rules even from the owner (no blank text, no resolve before open, status and time together)", async () => {
      const fails = async (sql: string) => {
        await expect(ctx.pool.query(sql)).rejects.toMatchObject({ code: "23514" });
      };
      await fails(`INSERT INTO platform_incidents (severity, title, summary) VALUES ('SEV-1', '  ', 'y')`);
      await fails(`INSERT INTO platform_incidents (severity, title, summary, status) VALUES ('SEV-1', 'x', 'y', 'resolved')`);
      await fails(`INSERT INTO platform_incidents (severity, title, summary, affected_schools) VALUES ('SEV-1', 'x', 'y', -1)`);
      await fails(
        `INSERT INTO platform_incidents (severity, title, summary, status, opened_at, resolved_at) VALUES ('SEV-1', 'x', 'y', 'resolved', now(), now() - interval '1 day')`,
      );
    });
  });
});
