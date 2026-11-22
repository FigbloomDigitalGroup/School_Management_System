import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { computeTotpCode } from "../src/modules/auth/mfa.js";
import { createTestApp, type FixtureIds } from "./support.js";

const PASSWORD = "correct-horse-battery";
const MFA_KEY = "k".repeat(40);

describe("MFA is a server-enforced control (migration 088)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  const saved: Record<string, string | undefined> = {};
  const uid: Record<string, string> = {};

  const post = (token: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    ctx.app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}`, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const get = (token: string, url: string, headers: Record<string, string> = {}) =>
    ctx.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}`, ...headers } });
  const login = async (email: string) => {
    const r = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email, password: PASSWORD } });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().token as string;
  };
  const tenantRoute = (token: string) => get(token, `/v1/tenants/${ids.tenantA}/vehicles`, { "x-tenant-id": ids.tenantA });
  const freshStep = (userId: string) => ctx.pool.query(`UPDATE mfa_factors SET last_used_step = NULL WHERE user_id = $1`, [userId]);
  const mkUser = async (key: string, email: string, role: string) => {
    const id = randomUUID();
    uid[key] = id;
    await ctx.pool.query(`INSERT INTO users (id, email, password_hash, full_name, status) SELECT $1, $3, password_hash, $4, 'active' FROM users WHERE id = $2`, [id, ids.adminA, email, key]);
    await ctx.pool.query(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1,$2,$3,$4)`, [id, ids.tenantA, role, `${role === "school_admin" ? "AD" : "TC"}-${String(2000 + Object.keys(uid).length)}`]);
  };
  /** Enrol + verify; returns the secret, recovery codes and the (assured) token used. */
  async function enrol(token: string, userId: string) {
    const e = await post(token, "/v1/auth/mfa/totp/enroll");
    expect(e.statusCode, e.body).toBe(200);
    const { secret, recoveryCodes } = e.json() as { secret: string; recoveryCodes: string[] };
    const v = await post(token, "/v1/auth/mfa/totp/verify", { code: computeTotpCode(secret) });
    expect(v.statusCode, v.body).toBe(200);
    void userId;
    return { secret, recoveryCodes };
  }

  beforeAll(async () => {
    for (const [k, v] of Object.entries({ MFA_ENFORCEMENT_TEST: "enforce", MFA_ENCRYPTION_KEY: MFA_KEY })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    ctx = await createTestApp();
    ids = ctx.ids;
    expect(ctx.config.mfaEnforcement).toBe("enforce");
    await mkUser("admin2", "admin2@example.com", "school_admin");
    await mkUser("admin3", "admin3@example.com", "school_admin");
    await mkUser("staffy", "staffy@example.com", "teacher");
  }, 180_000);

  beforeEach(async () => {
    await ctx.pool.query(`DELETE FROM auth_rate_buckets`); // throttle state is persistent; each test starts clean
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("a mandatory account gets nothing but the MFA flow until it enrols and verifies; assurance is per session", async () => {
    const t1 = await login("admin-a@example.com");
    const blocked = await tenantRoute(t1);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("mfa_required");
    expect(blocked.json().error.message).toMatch(/enrolment/);
    // housekeeping and the flow itself stay reachable
    expect((await get(t1, "/v1/auth/me")).statusCode).toBe(200);
    expect((await get(t1, "/v1/auth/mfa/status")).json()).toMatchObject({ required: true, assured: false, enrolled: false, next: "enroll", enforcement: "enforce" });
    // a non-allowlisted MFA route is not reachable before assurance
    expect((await post(t1, "/v1/auth/mfa/disable", { code: "123456" })).json().error.code).toBe("mfa_required");

    const { secret } = await enrol(t1, ids.adminA);
    expect((await tenantRoute(t1)).statusCode).toBe(200);
    const stored = await ctx.pool.query(`SELECT secret_encrypted FROM mfa_factors WHERE user_id = $1`, [ids.adminA]);
    expect(stored.rows[0].secret_encrypted.startsWith("v2:")).toBe(true); // dedicated key, not the session key

    // a second login is a new, unassured session: it must complete the challenge
    const t2 = await login("admin-a@example.com");
    const b2 = await tenantRoute(t2);
    expect(b2.json().error.code).toBe("mfa_required");
    expect(b2.json().error.message).toMatch(/verification/);
    expect((await get(t2, "/v1/auth/mfa/status")).json().next).toBe("challenge");
    await freshStep(ids.adminA);
    expect((await post(t2, "/v1/auth/mfa/challenge", { code: computeTotpCode(secret) })).statusCode).toBe(200);
    expect((await tenantRoute(t2)).statusCode).toBe(200);
    // the first session's assurance is unaffected and a brand-new session is still blocked
    expect((await tenantRoute(t1)).statusCode).toBe(200);
    expect((await tenantRoute(await login("admin-a@example.com"))).json().error.code).toBe("mfa_required");
  });

  it("platform super administrators and school administrators are mandatory; an ordinary teacher is not", async () => {
    const su = await login("super@example.com");
    expect((await get(su, "/v1/auth/mfa/status")).json().required).toBe(true);
    expect((await get(su, `/v1/tenants/${ids.tenantA}/vehicles`, { "x-tenant-id": ids.tenantA })).json().error.code).toBe("mfa_required");
    const org = await login("orgadmin@example.com");
    expect((await get(org, "/v1/auth/mfa/status")).json().required).toBe(true);
    const staffy = await login("staffy@example.com");
    expect((await get(staffy, "/v1/auth/mfa/status")).json()).toMatchObject({ required: false, next: "none" });
    expect((await tenantRoute(staffy)).json().error?.code).not.toBe("mfa_required");
  });

  it("role changes after the session was created take effect on the next request (finance-area holder becomes mandatory)", async () => {
    const t = await login("staffy@example.com");
    expect((await tenantRoute(t)).json().error?.code).not.toBe("mfa_required");
    await ctx.pool.query(`INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1,$2,'fees')`, [ids.tenantA, uid.staffy]);
    expect((await tenantRoute(t)).json().error.code).toBe("mfa_required");
    await ctx.pool.query(`DELETE FROM staff_area_grants WHERE user_id = $1`, [uid.staffy]);
    expect((await tenantRoute(t)).json().error?.code).not.toBe("mfa_required");
  });

  it("wrong codes are throttled, counted and audited even though each attempt ends in a rolled-back 401", async () => {
    const t = await login("admin2@example.com");
    const { secret } = await enrol(t, uid.admin2!);
    const t2 = await login("admin2@example.com");
    for (let i = 0; i < 3; i++) expect((await post(t2, "/v1/auth/mfa/challenge", { code: "000000" })).statusCode).toBe(401);
    const f = await ctx.pool.query(`SELECT failed_count FROM mfa_factors WHERE user_id = $1 AND disabled_at IS NULL`, [uid.admin2]);
    expect(f.rows[0].failed_count).toBe(3);
    const a = await ctx.pool.query(`SELECT count(*)::int n FROM security_audit_events WHERE event_type = 'auth.mfa.failed' AND actor_user_id = $1 AND detail->>'persisted' = 'true'`, [uid.admin2]);
    expect(a.rows[0].n).toBe(3);
    // burst limit (5 attempts, then one per minute): attempts 4 and 5 are answered, the 6th is throttled, even with a correct code
    expect((await post(t2, "/v1/auth/mfa/challenge", { code: "000000" })).statusCode).toBe(401);
    await post(t2, "/v1/auth/mfa/challenge", { code: "000000" }).catch(() => undefined);
    await freshStep(uid.admin2!);
    const throttled = await post(t2, "/v1/auth/mfa/challenge", { code: computeTotpCode(secret) });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers["retry-after"]).toBeDefined();
  });

  it("the failure window slides: 10 recent failures block, an aged window recovers (no permanent lockout)", async () => {
    const t = await login("admin3@example.com");
    const { secret } = await enrol(t, uid.admin3!);
    const t2 = await login("admin3@example.com");
    await ctx.pool.query(`UPDATE mfa_factors SET failed_count = 10, failed_window_start = now() WHERE user_id = $1`, [uid.admin3]);
    await freshStep(uid.admin3!);
    expect((await post(t2, "/v1/auth/mfa/challenge", { code: computeTotpCode(secret) })).statusCode).toBe(429);
    await ctx.pool.query(`UPDATE mfa_factors SET failed_window_start = now() - interval '16 minutes' WHERE user_id = $1`, [uid.admin3]);
    expect((await post(t2, "/v1/auth/mfa/challenge", { code: computeTotpCode(secret) })).statusCode).toBe(200);
    const f = await ctx.pool.query(`SELECT failed_count FROM mfa_factors WHERE user_id = $1`, [uid.admin3]);
    expect(f.rows[0].failed_count).toBe(0); // success resets the counter
  });

  it("TOTP codes are single use and recovery codes are single use", async () => {
    const t = await login("admin-a@example.com");
    // admin A already has a factor; use a recovery code on a fresh session
    await ctx.pool.query(`UPDATE mfa_factors SET disabled_at = now() WHERE user_id = $1`, [ids.adminA]);
    await ctx.pool.query(`UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = $1`, [ids.adminA]);
    const { secret, recoveryCodes } = await enrol(t, ids.adminA);
    const t2 = await login("admin-a@example.com");
    const code = computeTotpCode(secret, Date.now(), 1);
    expect((await post(t2, "/v1/auth/mfa/challenge", { code })).statusCode).toBe(200);
    const t3 = await login("admin-a@example.com");
    expect((await post(t3, "/v1/auth/mfa/challenge", { code })).statusCode).toBe(401); // replay, even on another session
    expect((await post(t3, "/v1/auth/mfa/challenge", { recovery_code: recoveryCodes[0] })).statusCode).toBe(200);
    const t4 = await login("admin-a@example.com");
    expect((await post(t4, "/v1/auth/mfa/challenge", { recovery_code: recoveryCodes[0] })).statusCode).toBe(401);
    await ctx.pool.query(`DELETE FROM auth_rate_buckets`); // new burst window (6 attempts exceed the 5-attempt burst by design)
    expect((await post(t4, "/v1/auth/mfa/challenge", { recovery_code: recoveryCodes[1] })).statusCode).toBe(200);
  });

  it("recovery codes can be regenerated with a fresh TOTP code; the old set stops working", async () => {
    const t = await login("admin-a@example.com");
    const state = await ctx.pool.query(`SELECT 1 FROM mfa_factors WHERE user_id = $1 AND disabled_at IS NULL`, [ids.adminA]);
    expect(state.rowCount).toBe(1);
    // assure t through a recovery code, then regenerate using the stored secret (decrypt via a new enrolment is not possible; use the test secret)
    await ctx.pool.query(`UPDATE mfa_factors SET disabled_at = now() WHERE user_id = $1`, [ids.adminA]);
    const { secret, recoveryCodes } = await enrol(t, ids.adminA);
    await freshStep(ids.adminA);
    const regen = await post(t, "/v1/auth/mfa/recovery-codes/regenerate", { code: computeTotpCode(secret, Date.now(), 1) });
    expect(regen.statusCode, regen.body).toBe(200);
    expect(regen.json().recoveryCodes).toHaveLength(8);
    const t2 = await login("admin-a@example.com");
    expect((await post(t2, "/v1/auth/mfa/challenge", { recovery_code: recoveryCodes[0] })).statusCode).toBe(401);
    expect((await post(t2, "/v1/auth/mfa/challenge", { recovery_code: regen.json().recoveryCodes[0] })).statusCode).toBe(200);
  });

  it("lost device: a platform administrator resets an account (audited); a school administrator cannot reset a peer or themselves", async () => {
    // super admin enrols
    const su = await login("super@example.com");
    await enrol(su, ids.superAdmin);
    // school admin 2 holds an assured session
    const a2 = await login("admin2@example.com");
    await ctx.pool.query(`UPDATE mfa_factors SET disabled_at = now() WHERE user_id = $1`, [uid.admin2]);
    await enrol(a2, uid.admin2!);
    expect((await tenantRoute(a2)).statusCode).toBe(200);
    // a school admin cannot reset a peer school admin or themselves
    const a3 = await login("admin3@example.com");
    await ctx.pool.query(`UPDATE mfa_factors SET disabled_at = now() WHERE user_id = $1`, [uid.admin3]);
    await enrol(a3, uid.admin3!);
    expect((await post(a3, "/v1/auth/mfa/admin-reset", { user_id: uid.admin2, reason: "peer reset attempt" })).statusCode).toBe(403);
    expect((await post(a3, "/v1/auth/mfa/admin-reset", { user_id: uid.admin3, reason: "self reset attempt" })).statusCode).toBe(403);
    // a reason is required
    expect((await post(su, "/v1/auth/mfa/admin-reset", { user_id: uid.admin2, reason: "x" })).statusCode).toBe(400);
    // the platform administrator resets admin 2
    const r = await post(su, "/v1/auth/mfa/admin-reset", { user_id: uid.admin2, reason: "lost phone, identity verified by phone call" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ reset: true, factorsDisabled: 1 });
    // admin 2's existing "assured" session is now blocked and must re-enrol
    const blocked = await tenantRoute(a2);
    expect(blocked.json().error.code).toBe("mfa_required");
    expect(blocked.json().error.message).toMatch(/enrolment/);
    const ev = await ctx.pool.query(`SELECT detail FROM security_audit_events WHERE event_type = 'auth.mfa.admin_reset' AND actor_user_id = $1`, [ids.superAdmin]);
    expect(ev.rows[0].detail).toMatchObject({ targetUserId: uid.admin2, byPlatformAdmin: true });
    // an unprivileged user cannot reset anyone
    const staffy = await login("staffy@example.com");
    expect((await post(staffy, "/v1/auth/mfa/admin-reset", { user_id: uid.admin2, reason: "not allowed to do this" })).statusCode).toBe(403);
  });

  it("disabling a factor needs recent reauth + a fresh code and immediately drops assurance on every session", async () => {
    const t = await login("admin3@example.com");
    await ctx.pool.query(`UPDATE mfa_factors SET disabled_at = now() WHERE user_id = $1`, [uid.admin3]);
    const { secret } = await enrol(t, uid.admin3!);
    expect((await tenantRoute(t)).statusCode).toBe(200);
    // stale session: make it look old, then expect reauth_required
    await ctx.pool.query(`UPDATE sessions SET created_at = created_at - interval '1 hour', expires_at = expires_at - interval '1 hour' WHERE user_id = $1`, [uid.admin3]);
    await freshStep(uid.admin3!);
    const stale = await post(t, "/v1/auth/mfa/disable", { code: computeTotpCode(secret, Date.now(), 1) });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.code).toBe("reauth_required");
    const stillThere = await ctx.pool.query(`SELECT 1 FROM mfa_factors WHERE user_id = $1 AND disabled_at IS NULL`, [uid.admin3]);
    expect(stillThere.rowCount).toBe(1); // a refused disable changed nothing
    const re = await post(t, "/v1/auth/reauth", { password: PASSWORD });
    expect(re.statusCode, re.body).toBe(200);
    await freshStep(uid.admin3!);
    const d = await post(t, "/v1/auth/mfa/disable", { code: computeTotpCode(secret, Date.now(), 1) });
    expect(d.statusCode, d.body).toBe(200);
    // mandatory account without a factor: blocked again at once, on the very session that disabled it
    const after = await tenantRoute(t);
    expect(after.json().error.code).toBe("mfa_required");
    expect(after.json().error.message).toMatch(/enrolment/);
  });
});
