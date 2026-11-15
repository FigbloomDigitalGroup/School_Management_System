import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";
import { loadConfig } from "../src/config.js";
import { withIdentityAccess } from "../src/db/identityAccess.js";
import { findValidSession, hashSessionToken } from "../src/modules/auth/session.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

/**
 * FIG-1624 / AD-11: last_seen_at is written at most once per interval, while expiry,
 * revocation and tenant state are still evaluated on every request.
 * Writes are counted by a trigger on sessions (test-only objects; the database is reset per run),
 * so the assertions are about real UPDATE statements, not about timestamps.
 */
describe("session last_seen throttle", () => {
  let ctx: Ctx;
  let token: string;
  let sessionId: string;

  const writes = async () =>
    Number((await ctx.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM zz_session_update_log`)).rows[0]!.n);

  const me = (t = token) =>
    ctx.app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${t}` } });

  async function newSession(): Promise<{ token: string; id: string }> {
    const login = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email: "admin-a@example.com", password: "correct-horse-battery" },
    });
    expect(login.statusCode).toBe(200);
    const t = login.json().token as string;
    const row = await ctx.pool.query<{ id: string }>(`SELECT id FROM sessions WHERE token_hash = $1`, [hashSessionToken(t)]);
    return { token: t, id: row.rows[0]!.id };
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    await ctx.pool.query(`
      CREATE TABLE zz_session_update_log (id bigserial PRIMARY KEY, session_id uuid, at timestamptz DEFAULT now());
      CREATE FUNCTION zz_log_session_update() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
        SET search_path = pg_catalog, pg_temp
        AS $$ BEGIN INSERT INTO public.zz_session_update_log (session_id) VALUES (NEW.id); RETURN NEW; END $$;
      CREATE TRIGGER zz_session_update AFTER UPDATE ON sessions
        FOR EACH ROW EXECUTE FUNCTION zz_log_session_update();
    `);
    const s = await newSession();
    token = s.token;
    sessionId = s.id;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("default interval is 300 s and the config is range-checked", () => {
    expect(ctx.config.sessionLastSeenIntervalSeconds).toBe(300);
    const base = { DATABASE_URL: "postgresql://figbloom_app:x@127.0.0.1:58322/figbloom_api" };
    expect(loadConfig({ ...base, SESSION_LAST_SEEN_INTERVAL_SECONDS: "0" }).sessionLastSeenIntervalSeconds).toBe(0);
    expect(() => loadConfig({ ...base, SESSION_LAST_SEEN_INTERVAL_SECONDS: "-1" })).toThrow(/sessionLastSeenIntervalSeconds/);
    expect(() => loadConfig({ ...base, SESSION_LAST_SEEN_INTERVAL_SECONDS: "3601" })).toThrow(/sessionLastSeenIntervalSeconds/);
  });

  it("N requests inside the interval write nothing", async () => {
    const before = await writes();
    for (let i = 0; i < 10; i++) expect((await me()).statusCode).toBe(200);
    expect(await writes()).toBe(before);
  });

  it("after the interval one request writes once, then the window closes again", async () => {
    await ctx.pool.query(`UPDATE sessions SET last_seen_at = now() - interval '10 minutes' WHERE id = $1`, [sessionId]);
    const before = await writes();
    expect((await me()).statusCode).toBe(200);
    expect(await writes()).toBe(before + 1);
    const seen = await ctx.pool.query<{ age: number }>(
      `SELECT extract(epoch FROM now() - last_seen_at)::float AS age FROM sessions WHERE id = $1`,
      [sessionId],
    );
    expect(seen.rows[0]!.age).toBeLessThan(10);
    for (let i = 0; i < 5; i++) expect((await me()).statusCode).toBe(200);
    expect(await writes()).toBe(before + 1);
  });

  it("concurrent requests on a stale session produce exactly one write", async () => {
    await ctx.pool.query(`UPDATE sessions SET last_seen_at = now() - interval '10 minutes' WHERE id = $1`, [sessionId]);
    const before = await writes();
    const results = await Promise.all(Array.from({ length: 20 }, () => me()));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(await writes()).toBe(before + 1);
  });

  it("a revoked session is refused at once even inside the interval", async () => {
    const s = await newSession();
    expect((await me(s.token)).statusCode).toBe(200); // fresh: inside the window
    await ctx.pool.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [s.id]);
    const r = await me(s.token);
    expect(r.statusCode).toBe(401);
  });

  it("an expired session is refused at once even inside the interval", async () => {
    const s = await newSession();
    expect((await me(s.token)).statusCode).toBe(200);
    await ctx.pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, [s.id]);
    expect((await me(s.token)).statusCode).toBe(401);
  });

  it("school suspension takes effect on the very next request (no authorisation caching)", async () => {
    const s = await newSession();
    const url = `/v1/tenants/${ctx.ids.tenantA}`;
    const headers = { authorization: `Bearer ${s.token}`, "x-tenant-id": ctx.ids.tenantA };
    expect((await ctx.app.inject({ method: "GET", url, headers })).statusCode).toBe(200);
    await ctx.pool.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [ctx.ids.tenantA]);
    try {
      expect((await ctx.app.inject({ method: "GET", url, headers })).statusCode).toBe(403);
    } finally {
      await ctx.pool.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [ctx.ids.tenantA]);
    }
  });

  it("negative control: interval 0 writes on every request, so the counter would notice a missing throttle", async () => {
    const s = await newSession();
    const call = (interval: number) =>
      withIdentityAccess(ctx.runtimePool, (db) => findValidSession(db, s.token, interval));
    // Make the session stale once so interval 0 and 300 are distinguishable.
    await ctx.pool.query(`UPDATE sessions SET last_seen_at = now() - interval '10 minutes' WHERE id = $1`, [s.id]);
    let before = await writes();
    for (let i = 0; i < 3; i++) expect(await call(0)).not.toBeNull();
    expect(await writes()).toBe(before + 3);
    before = await writes();
    for (let i = 0; i < 3; i++) expect(await call(300)).not.toBeNull();
    expect(await writes()).toBe(before);
  });
});
