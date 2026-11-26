import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createTestApp } from "./support.js";

/**
 * Owner decision 6.5: sensitive actions require recent authentication. A session counts as recent when it was created, or the
 * password was re-confirmed, within the window (default 300 s). An old session must call POST /v1/auth/reauth. Wrong passwords
 * are refused, audited and throttled; a stale or other person's session can never be stamped.
 */
describe("sensitive-action re-authentication (migration 077)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  const PASSWORD = "correct-horse-battery";
  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await login();
  }, 120_000);
  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });
  beforeEach(async () => {
    await ctx.pool.query(`DELETE FROM auth_rate_buckets`); // throttle state is shared persistent state; each test starts clean
  });
  const login = async () => (await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "admin-a@example.com", password: PASSWORD } })).json().token as string;
  const A = () => ctx.ids.tenantA;
  const call = (method: "POST", url: string, token: string, payload?: unknown) =>
    ctx.app.inject({ method, url, headers: { authorization: `Bearer ${token}`, "x-tenant-id": A() }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  const sensitive = (token: string) => call("POST", `/v1/tenants/${A()}/members/${ctx.ids.teacherA}/password-reset`, token);

  it("a fresh login may perform a sensitive action; an old session is refused with reauth_required until the password is confirmed", async () => {
    const fresh = await sensitive(admin);
    expect(fresh.statusCode, JSON.stringify(fresh.json())).toBe(201);
    await ctx.pool.query(`UPDATE sessions SET created_at = created_at - interval '1 hour', expires_at = expires_at - interval '1 hour'`); // age every session
    const stale = await sensitive(admin);
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.code).toBe("reauth_required");
    expect(JSON.stringify(stale.json())).not.toMatch(/sessions|created_at/i);
    // ordinary (non-sensitive) operations are unaffected by an old session
    expect((await ctx.app.inject({ method: "GET", url: `/v1/tenants/${A()}/learners`, headers: { authorization: `Bearer ${admin}`, "x-tenant-id": A() } })).statusCode).toBe(200);
    // wrong password: 401, audited, nothing stamped
    expect((await call("POST", "/v1/auth/reauth", admin, { password: "definitely-wrong-password" })).statusCode).toBe(401);
    expect((await sensitive(admin)).json().error.code).toBe("reauth_required");
    expect((await ctx.pool.query(`SELECT 1 FROM security_audit_events WHERE event_type = 'auth.login.failure' AND detail->>'method' = 'reauth' AND actor_user_id = $1`, [ctx.ids.adminA])).rowCount).toBeGreaterThanOrEqual(1);
    // right password: stamped, the action now succeeds, and the stamp expires with the window
    const ok = await call("POST", "/v1/auth/reauth", admin, { password: PASSWORD });
    expect(ok.statusCode, JSON.stringify(ok.json())).toBe(200);
    expect(ok.json()).toEqual({ ok: true, valid_for_seconds: 300 });
    expect((await sensitive(admin)).statusCode).toBe(201);
    expect((await ctx.pool.query(`SELECT 1 FROM security_audit_events WHERE event_type = 'auth.reauthenticated' AND actor_user_id = $1`, [ctx.ids.adminA])).rowCount).toBeGreaterThanOrEqual(1);
    await ctx.pool.query(`UPDATE sessions SET reauthenticated_at = now() - interval '10 minutes'`);
    expect((await sensitive(admin)).json().error.code).toBe("reauth_required");
  });

  it("every sensitive operation is gated: a stale session gets reauth_required, a fresh one is not refused for freshness", async () => {
    const su = (await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "super@example.com", password: PASSWORD } })).json().token as string;
    const id = "00000000-0000-4000-8000-0000000000ee";
    const T = `/v1/tenants/${A()}`;
    const ops: [string, string, unknown, "admin" | "super"][] = [
      ["POST", `${T}/members/${id}/password-reset`, undefined, "admin"],
      ["POST", `${T}/members/${id}/deactivate`, undefined, "admin"],
      ["POST", `${T}/invitations`, { email: "gate@example.com", role: "school_admin" }, "admin"],
      ["POST", `${T}/guardians/${id}/account-link/revoke`, { reason: "gate test reason" }, "admin"],
      ["POST", `${T}/finance/reconciliation-findings/${id}/resolve`, { note: "gate test", evidence: "gate test evidence" }, "admin"],
      ["POST", `${T}/finance/payments/${id}/withdraw-unacknowledged-prompt`, { reason: "gate test", evidence: "gate evidence" }, "admin"],
      ["POST", `${T}/finance/payments/${id}/mpesa-reconciliation`, { action: "refresh", note: "gate test note text" }, "admin"],
      ["POST", "/v1/platform/schools", { school_name: "Gate School", slug: "gate-school-x", admin_email: "gate-admin@example.com" }, "super"],
      ["POST", `/v1/platform/finance/unmatched-callbacks/${id}/resolve`, { resolution: "other_evidenced", reason: "gate test reason", evidence: "gate test evidence" }, "super"],
      ["POST", `/v1/platform/finance/unmatched-callbacks/${id}/reopen`, { reason: "gate test reason" }, "super"],
      ["POST", "/v1/platform/incidents", { severity: "SEV-3", title: "Gate incident", summary: "gate test summary", affected_schools: 0 }, "super"],
      ["POST", `/v1/platform/incidents/${id}/resolve`, undefined, "super"],
      ["POST", `/v1/platform/org-signups/${id}/approve`, {}, "super"],
      ["POST", `/v1/platform/org-signups/${id}/reject`, {}, "super"],
      ["POST", `/v1/platform/org-signups/${id}/reissue-setup`, undefined, "super"],
    ];
    const send = (m: string, u: string, p: unknown, who: "admin" | "super") =>
      ctx.app.inject({ method: m as "POST", url: u, headers: { authorization: `Bearer ${who === "admin" ? admin : su}`, "x-tenant-id": A() }, ...(p === undefined ? {} : { payload: p as Record<string, unknown> }) });
    await ctx.pool.query(`UPDATE sessions SET created_at = created_at - interval '1 hour', expires_at = expires_at - interval '1 hour', reauthenticated_at = NULL`);
    for (const [m, u, p, who] of ops) {
      const r = await send(m, u, p, who);
      expect(r.statusCode, `stale ${u}`).toBe(403);
      expect(r.json().error.code, `stale ${u}`).toBe("reauth_required");
    }
    await ctx.pool.query(`UPDATE sessions SET reauthenticated_at = now()`);
    for (const [m, u, p, who] of ops) {
      const r = await send(m, u, p, who);
      expect(r.json().error?.code, `fresh ${u} -> ${r.statusCode}`).not.toBe("reauth_required");
    }
  });

  it("re-authentication needs a valid session, a body, and is throttled", async () => {
    expect((await ctx.app.inject({ method: "POST", url: "/v1/auth/reauth", payload: { password: PASSWORD } })).statusCode).toBe(401);
    const t = await login();
    expect((await call("POST", "/v1/auth/reauth", t, {})).statusCode).toBe(400);
    expect((await call("POST", "/v1/auth/reauth", t, { password: "x", extra: 1 })).statusCode).toBe(400);
    const limitedApp = await buildApp({ ...ctx.config, authRateCapacity: 5, authRateRefill: 2, authRateIntervalMs: 60_000 }, ctx.runtimePool);
    await limitedApp.ready();
    let limited = 0;
    try {
      for (let i = 0; i < 30 && !limited; i++) {
        const r = await limitedApp.inject({ method: "POST", url: "/v1/auth/reauth", headers: { authorization: `Bearer ${t}` }, payload: { password: "wrong-password-" + i } });
        if (r.statusCode === 429) limited = i + 1;
      }
    } finally {
      await limitedApp.close();
    }
    expect(limited, "repeated wrong passwords must be rate limited").toBeGreaterThan(0);
  });

  it("the stamp is bound to the session's own user: another person's session id cannot be stamped", async () => {
    const other = (await ctx.pool.query(`SELECT id FROM sessions WHERE user_id = $1 LIMIT 1`, [ctx.ids.adminA])).rows[0]?.id as string;
    const c = await ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.ids.teacherA]);
      expect((await c.query(`SELECT public.auth_mark_reauthenticated($1) AS ok`, [other])).rows[0].ok).toBe(false);
      expect((await c.query(`SELECT public.auth_session_recent($1, 600) AS ok`, [other])).rows[0].ok).toBe(false);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });

  describe("authority-changing operations added in the residual closure", () => {
    const id = "00000000-0000-4000-8000-0000000000ef";
    const send = (m: string, u: string, p: unknown, token = admin) =>
      ctx.app.inject({ method: m as "POST", url: u, headers: { authorization: `Bearer ${token}`, "x-tenant-id": A() }, ...(p === undefined ? {} : { payload: p as Record<string, unknown> }) });
    const gated: [string, string, unknown][] = [
      ["POST", "/v1/rbac/org-delegations", { delegateUserId: id, permissionCodes: ["area.fees"] }],
      ["DELETE", "/v1/rbac/org-delegations", { delegateUserId: id }],
      ["POST", "/v1/rbac/guardian-access", { userId: id, permissionCodes: ["resource.guardian.read"] }],
      ["DELETE", "/v1/rbac/guardian-access", { userId: id }],
      ["PUT", "/v1/rbac/staff-areas", { userId: id, areas: [] }],
      ["PATCH", "/v1/tenants/TENANT/school-profile", { name: "Renamed School" }],
      ["PATCH", "/v1/tenants/TENANT/school-profile", { timezone: "Africa/Nairobi" }],
    ];
    const url = (u: string) => u.replace("TENANT", A());
    const ageAll = () => ctx.pool.query(`UPDATE sessions SET created_at = created_at - interval '1 hour', expires_at = expires_at - interval '1 hour', reauthenticated_at = NULL`);

    it("each qualifying operation refuses a stale session (reauth_required, nothing changed) and accepts a re-authenticated one", async () => {
      const before = (await ctx.pool.query(`SELECT name, timezone FROM tenants WHERE id = $1`, [A()])).rows[0];
      await ageAll();
      for (const [m, u, p] of gated) {
        const r = await send(m, url(u), p);
        expect(r.statusCode, `stale ${m} ${u}`).toBe(403);
        expect(r.json().error.code, `stale ${m} ${u}`).toBe("reauth_required");
      }
      expect((await ctx.pool.query(`SELECT name, timezone FROM tenants WHERE id = $1`, [A()])).rows[0]).toEqual(before); // nothing was applied
      expect((await call("POST", "/v1/auth/reauth", admin, { password: PASSWORD })).statusCode).toBe(200);
      for (const [m, u, p] of gated.filter(([, uu]) => !uu.includes("school-profile"))) {
        const r = await send(m, url(u), p);
        expect(r.json().error?.code, `fresh ${m} ${u} -> ${r.statusCode}`).not.toBe("reauth_required");
      }
    });

    it("ordinary school-profile content (county, contacts) is deliberately NOT gated; only name/timezone are", async () => {
      await ageAll();
      const r = await send("PATCH", url("/v1/tenants/TENANT/school-profile"), { county: "Nairobi" });
      expect(r.json().error?.code).not.toBe("reauth_required");
      expect(r.statusCode).toBe(200);
    });

    it("authorization is checked before freshness: an unauthorized caller learns nothing about re-authentication", async () => {
      const teacher = (await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId: A(), loginId: "TC-0001", password: PASSWORD } })).json().token as string;
      await ageAll();
      for (const [m, u, p] of gated) {
        const r = await send(m, url(u), p, teacher);
        expect(r.statusCode, `${m} ${u}`).toBe(403); // not authorized; the answer is the same as for a fresh session (never reauth_required)
        expect(r.json().error.code).not.toBe("reauth_required");
      }
      const t2 = (await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId: A(), loginId: "TC-0001", password: PASSWORD } })).json().token as string;
      for (const [m, u, p] of gated) {
        const r = await send(m, url(u), p, t2);
        expect(r.statusCode, `fresh teacher ${m} ${u}`).toBe(403);
        expect(r.json().error.code).not.toBe("reauth_required");
      }
    });

    it("the stamp belongs to ONE session: re-authenticating session A does not freshen session B; it expires with the window; revoked and disabled accounts cannot use or obtain it", async () => {
      const a = await login();
      const b = await login();
      await ageAll();
      expect((await call("POST", "/v1/auth/reauth", a, { password: PASSWORD })).statusCode).toBe(200);
      expect((await send("PUT", url("/v1/rbac/staff-areas"), { userId: id, areas: [] }, a)).json().error?.code).not.toBe("reauth_required");
      expect((await send("PUT", url("/v1/rbac/staff-areas"), { userId: id, areas: [] }, b)).json().error.code).toBe("reauth_required"); // replay on another session
      await ctx.pool.query(`UPDATE sessions SET reauthenticated_at = now() - interval '6 minutes' WHERE reauthenticated_at IS NOT NULL`);
      expect((await send("PUT", url("/v1/rbac/staff-areas"), { userId: id, areas: [] }, a)).json().error.code).toBe("reauth_required"); // expired evidence
      // revoked session
      expect((await call("POST", "/v1/auth/reauth", b, { password: PASSWORD })).statusCode).toBe(200);
      await ctx.pool.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1`, [ctx.ids.adminA]);
      expect((await send("PUT", url("/v1/rbac/staff-areas"), { userId: id, areas: [] }, b)).statusCode).toBe(401);
      expect((await call("POST", "/v1/auth/reauth", b, { password: PASSWORD })).statusCode).toBe(401);
      // disabled account (fresh login first, then disable)
      const d = await login();
      await ctx.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [ctx.ids.adminA]);
      expect((await call("POST", "/v1/auth/reauth", d, { password: PASSWORD })).statusCode).toBe(401);
      expect((await send("PUT", url("/v1/rbac/staff-areas"), { userId: id, areas: [] }, d)).statusCode).toBe(401);
      await ctx.pool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [ctx.ids.adminA]);
    });

    it("concurrent sensitive requests after one re-authentication all pass the freshness gate; concurrent wrong passwords stay throttled and audited", async () => {
      const t = await login();
      await ageAll();
      expect((await call("POST", "/v1/auth/reauth", t, { password: PASSWORD })).statusCode).toBe(200);
      const rs = await Promise.all(Array.from({ length: 6 }, () => send("PUT", url("/v1/rbac/staff-areas"), { userId: id, areas: [] }, t)));
      for (const r of rs) expect(r.json().error?.code).not.toBe("reauth_required");
      const before = (await ctx.pool.query(`SELECT count(*)::int AS n FROM security_audit_events WHERE event_type = 'auth.login.failure' AND detail->>'method' = 'reauth'`)).rows[0].n;
      const bad = await Promise.all(Array.from({ length: 4 }, (_, i) => call("POST", "/v1/auth/reauth", t, { password: "wrong-concurrent-" + i })));
      for (const r of bad) expect([401, 429]).toContain(r.statusCode);
      const after = (await ctx.pool.query(`SELECT count(*)::int AS n FROM security_audit_events WHERE event_type = 'auth.login.failure' AND detail->>'method' = 'reauth'`)).rows[0].n;
      expect(after).toBeGreaterThan(before); // failures were audited, not erased by a rollback
    });
  });
});
