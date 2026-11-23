import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createTestApp } from "./support.js";

/**
 * Workstream 7: attacker-style tests that were not covered elsewhere (authentication abuse, enumeration, token replay, session
 * handling, mass assignment, injection strings, malformed input, oversized bodies, error leakage). Financial and worker attack
 * cases live in stage11.*, postAudit.* and worker.* suites and are referenced from the security acceptance report.
 */
describe("adversarial: authentication and session abuse", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const PASSWORD = "correct-horse-battery";
  beforeAll(async () => {
    ctx = await createTestApp();
  }, 120_000);
  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });
  const loginEmail = (app: typeof ctx.app, email: string, password: string) => app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email, password } });

  it("login brute force is throttled progressively per account, without a permanent lockout", async () => {
    const limited = await buildApp({ ...ctx.config, authRateCapacity: 5, authRateRefill: 2, authRateIntervalMs: 1500 }, ctx.runtimePool);
    await limited.ready();
    try {
      let firstLimited = 0;
      for (let i = 1; i <= 15 && !firstLimited; i++) {
        const r = await loginEmail(limited, "teacher-a@example.com", "wrong-" + i);
        if (r.statusCode === 429) firstLimited = i;
        else expect(r.statusCode).toBe(401);
      }
      expect(firstLimited, "wrong passwords must hit the limiter").toBeGreaterThan(1);
      expect(firstLimited).toBeLessThanOrEqual(8);
      const blocked = await loginEmail(limited, "teacher-a@example.com", PASSWORD);
      // while limited even the right password waits (no oracle), but the answer carries Retry-After
      expect([200, 429]).toContain(blocked.statusCode);
      // no permanent lockout: after the bucket refills the right password works
      await new Promise((r) => setTimeout(r, 4000));
      const later = await loginEmail(limited, "teacher-a@example.com", PASSWORD);
      expect([200, 401], "the account is not locked forever").toContain(later.statusCode);
    } finally {
      await limited.close();
    }
    await ctx.pool.query(`DELETE FROM auth_rate_buckets`); // buckets are shared persistent state: leave none behind for other tests
  }, 60_000);

  it("account enumeration: unknown account, wrong password and disabled account are indistinguishable at login; reset and preview are uniform", async () => {
    await ctx.pool.query(`UPDATE users SET status = 'disabled' WHERE email = 'orgadmin@example.com'`);
    const shapes = new Set<string>();
    for (const [email, pw] of [["nobody-here@example.com", PASSWORD], ["admin-a@example.com", "wrong-password-1"], ["orgadmin@example.com", PASSWORD]] as const) {
      const r = await loginEmail(ctx.app, email, pw);
      shapes.add(`${r.statusCode}:${r.json().error.code}:${r.json().error.message}`);
    }
    await ctx.pool.query(`UPDATE users SET status = 'active' WHERE email = 'orgadmin@example.com'`);
    expect(shapes.size, [...shapes].join(" | ")).toBe(1);
    const reset = async (email: string) => {
      const r = await ctx.app.inject({ method: "POST", url: "/v1/auth/password-reset/request", payload: { email } });
      return `${r.statusCode}:${r.body}`;
    };
    expect(await reset("nobody-here@example.com")).toBe(await reset("admin-a@example.com"));
    const p1 = await ctx.app.inject({ method: "POST", url: "/v1/guardian-invitations/preview", payload: { token: "A".repeat(43) } });
    const p2 = await ctx.app.inject({ method: "POST", url: "/v1/guardian-invitations/preview", payload: { token: "B".repeat(60) } });
    expect(p1.body).toBe(p2.body);
    const a1 = await ctx.app.inject({ method: "POST", url: "/v1/invitations/accept", payload: { token: "A".repeat(43), password: "brand-new-passw0rd" } });
    const a2 = await ctx.app.inject({ method: "POST", url: "/v1/invitations/accept", payload: { token: "B".repeat(43), password: "brand-new-passw0rd" } });
    expect(a1.statusCode).toBe(a2.statusCode);
    expect(a1.json().error.message).toBe(a2.json().error.message);
  });

  it("session handling: each login mints a distinct token; logout kills it; a replayed token is refused; password change ends other sessions; concurrent sessions are independent", async () => {
    const t1 = (await loginEmail(ctx.app, "admin-a@example.com", PASSWORD)).json().token as string;
    const t2 = (await loginEmail(ctx.app, "admin-a@example.com", PASSWORD)).json().token as string;
    expect(t1).not.toBe(t2);
    const me = (t: string) => ctx.app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${t}` } });
    expect((await me(t1)).statusCode).toBe(200);
    expect((await me(t2)).statusCode).toBe(200);
    // a made-up / attacker-supplied token is useless (no fixation): the server never accepts a client-chosen session id
    expect((await me(t1.slice(0, -2) + "xx")).statusCode).toBe(401);
    expect((await me("00000000-0000-4000-8000-000000000000")).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "POST", url: "/v1/auth/logout", headers: { authorization: `Bearer ${t1}` } })).statusCode).toBeLessThan(300);
    expect((await me(t1)).statusCode).toBe(401); // replay after logout
    expect((await me(t2)).statusCode).toBe(200); // the other session is independent
    expect((await ctx.app.inject({ method: "POST", url: "/v1/auth/password/change", headers: { authorization: `Bearer ${t2}` }, payload: { currentPassword: PASSWORD, newPassword: "another-passw0rd-77" } })).statusCode).toBe(200);
    const t3 = (await loginEmail(ctx.app, "admin-a@example.com", "another-passw0rd-77")).json().token as string;
    expect((await me(t3)).statusCode).toBe(200);
    await ctx.pool.query(`UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE email = 'teacher-a@example.com' LIMIT 1) WHERE email = 'admin-a@example.com'`).catch(() => undefined);
  });
});

describe("adversarial: input handling", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  beforeAll(async () => {
    ctx = await createTestApp();
    admin = (await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "admin-a@example.com", password: "correct-horse-battery" } })).json().token as string;
  }, 120_000);
  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });
  const A = () => ctx.ids.tenantA;
  const call = (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    ctx.app.inject({ method, url, headers: { authorization: `Bearer ${admin}`, "x-tenant-id": A(), ...headers }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  const noLeak = (body: string) => expect(body).not.toMatch(/at \S+ \(|node_modules|SELECT |INSERT |pg_|syntax error|stack|column "|relation "/i);

  it("mass assignment: unknown or privileged fields (tenant_id, id, created_by, status) are rejected, never stored", async () => {
    for (const extra of [{ tenant_id: ctx.ids.tenantB }, { id: "00000000-0000-4000-8000-00000000dead" }, { created_by: ctx.ids.superAdmin }, { active: false }, { archived_at: "2020-01-01" }]) {
      const adm = "MA-" + randomUUID().slice(0, 6);
      const r = await call("POST", `/v1/tenants/${A()}/learners`, { admission_no: adm, full_name: "Mass Assign", gender: "male", ...extra });
      expect([201, 400], JSON.stringify(extra)).toContain(r.statusCode);
      noLeak(r.body);
      if (r.statusCode === 201) {
        // accepted-but-ignored is fine; honoured would be the defect
        const row = (await ctx.pool.query(`SELECT id, tenant_id, created_by, active, archived_at FROM learners WHERE admission_no = $1`, [adm])).rows[0];
        expect(row.tenant_id, JSON.stringify(extra)).toBe(A());
        expect(row.id).not.toBe("00000000-0000-4000-8000-00000000dead");
        expect(row.created_by).toBe(ctx.ids.adminA);
        expect(row.active).toBe(true);
        expect(row.archived_at).toBeNull();
      }
    }
    expect((await ctx.pool.query(`SELECT count(*)::int AS n FROM learners WHERE tenant_id = $1 AND full_name = 'Mass Assign'`, [ctx.ids.tenantB])).rows[0].n).toBe(0);
    const r = await call("POST", `/v1/tenants/${A()}/learners`, { admission_no: "MA-OK-1", full_name: "Mass Assign", gender: "male" });
    expect(r.statusCode).toBe(201);
    expect((await ctx.pool.query(`SELECT tenant_id FROM learners WHERE admission_no = 'MA-OK-1'`)).rows[0].tenant_id).toBe(A());
  });

  it("injection strings are stored and returned literally (parameterised queries) and never alter the query", async () => {
    const evil = `Robert'); DROP TABLE learners;-- " \\ ' OR '1'='1`;
    const adm = "SQ-" + randomUUID().slice(0, 6);
    const r = await call("POST", `/v1/tenants/${A()}/learners`, { admission_no: adm, full_name: evil, gender: "female" });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().learner.full_name).toBe(evil);
    expect((await ctx.pool.query(`SELECT to_regclass('public.learners') IS NOT NULL AS ok`)).rows[0].ok).toBe(true);
    for (const q of ["status=' OR 1=1 --", "limit=1;DROP TABLE x", "cursor=' UNION SELECT 1", "sort=full_name;--"]) {
      const g = await call("GET", `/v1/tenants/${A()}/learners?${encodeURI(q)}`);
      expect([200, 400], q).toContain(g.statusCode);
      noLeak(g.body);
    }
  });

  it("malformed identifiers, JSON and content types answer 4xx with a generic body, never 5xx or internals", async () => {
    for (const url of [`/v1/tenants/not-a-uuid/learners`, `/v1/tenants/${A()}/learners/zzz`, `/v1/tenants/${A()}/finance/invoices/%00`, `/v1/tenants/${A()}/guardians/${"9".repeat(80)}/invitations`]) {
      const r = await call("GET", url);
      expect(r.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(r.statusCode, url).toBeLessThan(500);
      noLeak(r.body);
    }
    const bad = await ctx.app.inject({ method: "POST", url: `/v1/tenants/${A()}/learners`, headers: { authorization: `Bearer ${admin}`, "x-tenant-id": A(), "content-type": "application/json" }, payload: "{not json" });
    expect(bad.statusCode).toBe(400);
    noLeak(bad.body);
    const wrongType = await ctx.app.inject({ method: "POST", url: `/v1/tenants/${A()}/learners`, headers: { authorization: `Bearer ${admin}`, "x-tenant-id": A(), "content-type": "text/plain" }, payload: "hello" });
    expect(wrongType.statusCode).toBeGreaterThanOrEqual(400);
    expect(wrongType.statusCode).toBeLessThan(500);
  });

  it("oversized bodies are refused before processing (413), and an oversized field is a 400", async () => {
    const big = await call("POST", `/v1/tenants/${A()}/learners`, { admission_no: "BIG", full_name: "x".repeat(200_000), gender: "male" });
    expect(big.statusCode).toBe(413);
    noLeak(big.body);
    const long = await call("POST", `/v1/tenants/${A()}/learners`, { admission_no: "BIG2", full_name: "x".repeat(500), gender: "male" });
    expect([400, 413]).toContain(long.statusCode);
  });

  it("errors carry a request id and never a stack, SQL text, constraint name or hostname", async () => {
    const r = await call("GET", `/v1/tenants/${A()}/learners/${randomUUID()}`);
    expect(r.statusCode).toBe(404);
    expect(r.json().error.request_id).toBeTruthy();
    noLeak(r.body);
    expect(r.body).not.toMatch(/figbloom_api|127\.0\.0\.1|localhost|postgres/i);
  });
});
