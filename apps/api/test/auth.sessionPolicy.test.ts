import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createTestApp } from "./support.js";

const PASSWORD = "correct-horse-battery";

describe("session policy: idle 15 min staff/admin, 30 min guardians, absolute 8 h — enforced by the server", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => {
    ctx = await createTestApp();
  }, 120_000);
  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  const tenant = () => ctx.ids.tenantA;
  async function loginId(loginId: string): Promise<{ token: string; id: string }> {
    const r = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId: tenant(), loginId, password: PASSWORD } });
    expect(r.statusCode).toBe(200);
    const token = r.json().token as string;
    const row = await ctx.pool.query<{ id: string }>(`SELECT id FROM sessions WHERE minted_by = 'login' ORDER BY created_at DESC LIMIT 1`);
    return { token, id: row.rows[0]!.id };
  }
  const me = (token: string) => ctx.app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${token}` } });
  const idleFor = (id: string, minutes: number) => ctx.pool.query(`UPDATE sessions SET last_seen_at = now() - make_interval(mins => $2) WHERE id = $1`, [id, minutes]);

  it("a staff session idle for 16 minutes is rejected; at 14 minutes it is accepted", async () => {
    const s = await loginId("TC-0001");
    expect((await me(s.token)).statusCode).toBe(200);
    await idleFor(s.id, 14);
    expect((await me(s.token)).statusCode).toBe(200);
    await idleFor(s.id, 16);
    expect((await me(s.token)).statusCode).toBe(401);
  });

  it("an idle-expired session cannot be revived by later requests (last_seen is never advanced for it)", async () => {
    const s = await loginId("AD-0001");
    await idleFor(s.id, 20);
    for (let i = 0; i < 3; i++) expect((await me(s.token)).statusCode).toBe(401);
    const seen = await ctx.pool.query<{ idle: number }>(`SELECT extract(epoch FROM now() - last_seen_at)::int AS idle FROM sessions WHERE id = $1`, [s.id]);
    expect(seen.rows[0]!.idle).toBeGreaterThanOrEqual(19 * 60);
  });

  it("a guardian (parent-only) session gets 30 minutes: valid at 20, rejected at 31", async () => {
    const s = await loginId("PT-0001");
    await idleFor(s.id, 20);
    expect((await me(s.token)).statusCode).toBe(200);
    await idleFor(s.id, 31);
    expect((await me(s.token)).statusCode).toBe(401);
  });

  it("activity within the window keeps the session alive (last_seen advances at most once per interval)", async () => {
    const s = await loginId("TC-0001");
    await idleFor(s.id, 10);
    expect((await me(s.token)).statusCode).toBe(200); // 10 min idle > 60 s interval: this request records activity
    const idle = await ctx.pool.query<{ idle: number }>(`SELECT extract(epoch FROM now() - last_seen_at)::int AS idle FROM sessions WHERE id = $1`, [s.id]);
    expect(idle.rows[0]!.idle).toBeLessThan(30);
  });

  it("the absolute lifetime is 8 hours: an older session is rejected however active, and the configuration cannot exceed 8 hours", async () => {
    const s = await loginId("TC-0001");
    await ctx.pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, [s.id]);
    expect((await me(s.token)).statusCode).toBe(401);
    expect(ctx.config.sessionTtlSeconds).toBe(28_800);
    const base = { DATABASE_URL: "postgresql://figbloom_app:x@127.0.0.1:59822/figbloom_api" };
    expect(() => loadConfig({ ...base, SESSION_TTL_SECONDS: "28801" })).toThrow(/sessionTtlSeconds/);
    expect(loadConfig({ ...base, SESSION_TTL_SECONDS: "3600" }).sessionTtlSeconds).toBe(3600);
    // the database also refuses a NEW session that would outlive 8 h
    await expect(
      ctx.pool.query(`UPDATE sessions SET expires_at = created_at + interval '9 hours' WHERE id = $1`, [s.id]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("revoked sessions and disabled users are rejected immediately", async () => {
    const s = await loginId("TC-0001");
    await ctx.pool.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [s.id]);
    expect((await me(s.token)).statusCode).toBe(401);
    const s2 = await loginId("TC-0001");
    await ctx.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [ctx.ids.teacherA]);
    try {
      expect((await me(s2.token)).statusCode).toBe(401);
    } finally {
      await ctx.pool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [ctx.ids.teacherA]);
    }
  });

  it("the idle policy function classifies accounts (default is the stricter 15 minutes)", async () => {
    const q = async (id: string) => (await ctx.pool.query<{ s: number }>(`SELECT public.auth_session_idle_seconds($1) AS s`, [id])).rows[0]!.s;
    expect(await q(ctx.ids.teacherA)).toBe(900);
    expect(await q(ctx.ids.adminA)).toBe(900);
    expect(await q(ctx.ids.superAdmin)).toBe(900);
    expect(await q(ctx.ids.parentA)).toBe(1800);
    expect(await q("00000000-0000-4000-8000-0000000000ff")).toBe(900);
  });
});
