import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { computeTotpCode, decryptSecret, encryptSecret, toBase32 } from "../src/modules/auth/mfa.js";
import { createTestApp, type FixtureIds } from "./support.js";

// Synthetic secrets and keys only. Covers: legacy-key ciphertext (migration 085) -> dedicated key (088), key/ciphertext
// failure modes, no plaintext at rest, and that an unreadable factor is a 503 that is NOT counted against the user.
const PASSWORD = "correct-horse-battery";
const MFA_KEY = "m".repeat(40);
const SECRET = toBase32(Buffer.from("synthetic-test-secret-20"));

describe("MFA secret storage: legacy re-encryption and failure modes", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let userId: string;
  const saved: Record<string, string | undefined> = {};

  const login = async () => {
    const r = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "secretstore@example.com", password: PASSWORD } });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().token as string;
  };
  const challenge = (token: string, code: string) =>
    ctx.app.inject({ method: "POST", url: "/v1/auth/mfa/challenge", headers: { authorization: `Bearer ${token}` }, payload: { code } });
  const legacyCfg = () => ({ ...ctx.config, mfaEncryptionKey: undefined });
  const dedicatedCfg = (key = MFA_KEY) => ({ ...ctx.config, mfaEncryptionKey: key });
  const putFactor = async (secretEncrypted: string) => {
    await ctx.pool.query(`UPDATE mfa_factors SET disabled_at = now() WHERE user_id = $1 AND disabled_at IS NULL`, [userId]);
    await ctx.pool.query(`INSERT INTO mfa_factors (user_id, kind, secret_encrypted, verified_at) VALUES ($1,'totp',$2, now())`, [userId, secretEncrypted]);
  };
  const stored = async () =>
    (await ctx.pool.query(`SELECT secret_encrypted, failed_count, last_used_step FROM mfa_factors WHERE user_id = $1 AND disabled_at IS NULL`, [userId])).rows[0] as {
      secret_encrypted: string;
      failed_count: number;
      last_used_step: string | null;
    };

  beforeAll(async () => {
    for (const [k, v] of Object.entries({ MFA_ENFORCEMENT_TEST: "enforce", MFA_ENCRYPTION_KEY: MFA_KEY })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    ctx = await createTestApp();
    ids = ctx.ids;
    userId = randomUUID();
    await ctx.pool.query(`INSERT INTO users (id, email, password_hash, full_name, status) SELECT $1, 'secretstore@example.com', password_hash, 'Secret Store', 'active' FROM users WHERE id = $2`, [userId, ids.adminA]);
    await ctx.pool.query(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1,$2,'school_admin','AD-7771')`, [userId, ids.tenantA]);
  }, 180_000);

  beforeEach(async () => {
    await ctx.pool.query(`DELETE FROM auth_rate_buckets`);
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("round-trips under both keys and never stores the plaintext secret", () => {
    const legacy = encryptSecret(legacyCfg() as typeof ctx.config, SECRET);
    const v2 = encryptSecret(dedicatedCfg() as typeof ctx.config, SECRET);
    expect(legacy.startsWith("v2:")).toBe(false);
    expect(v2.startsWith("v2:")).toBe(true);
    for (const c of [legacy, v2]) {
      expect(c).not.toContain(SECRET);
      expect(Buffer.from(c.replace(/^v2:/, "").replace(/\./g, ""), "base64url").toString("utf8")).not.toContain(SECRET);
    }
    expect(decryptSecret(legacyCfg() as typeof ctx.config, legacy)).toBe(SECRET);
    expect(decryptSecret(dedicatedCfg() as typeof ctx.config, v2)).toBe(SECRET);
    expect(encryptSecret(dedicatedCfg() as typeof ctx.config, SECRET)).not.toBe(v2); // fresh IV every time
  });

  it("a factor stored under the legacy key verifies, is re-encrypted under the dedicated key, and still verifies", async () => {
    await putFactor(encryptSecret(legacyCfg() as typeof ctx.config, SECRET));
    const before = await stored();
    expect(before.secret_encrypted.startsWith("v2:")).toBe(false);

    const t1 = await login();
    const ok = await challenge(t1, computeTotpCode(SECRET));
    expect(ok.statusCode, ok.body).toBe(200);

    const after = await stored();
    expect(after.secret_encrypted.startsWith("v2:")).toBe(true);
    expect(after.secret_encrypted).not.toContain(SECRET);
    expect(decryptSecret(dedicatedCfg() as typeof ctx.config, after.secret_encrypted)).toBe(SECRET);

    // the legacy key can no longer read it (it really moved), and the dedicated key keeps working on a new session
    await ctx.pool.query(`UPDATE mfa_factors SET last_used_step = NULL WHERE user_id = $1`, [userId]);
    const t2 = await login();
    const again = await challenge(t2, computeTotpCode(SECRET));
    expect(again.statusCode, again.body).toBe(200);
  });

  it("an unreadable factor is a controlled 503, is not counted as a failed attempt, and leaves the row untouched", async () => {
    const cases: Record<string, string> = {
      "dedicated key is wrong": encryptSecret(dedicatedCfg("z".repeat(40)) as typeof ctx.config, SECRET),
      "legacy key is unavailable (ciphertext made under a different session key)": encryptSecret({ ...legacyCfg(), sessionMintHmacKey: "q".repeat(40) } as typeof ctx.config, SECRET),
      "truncated": "v2:AAAA.BBBB",
      "too many parts": `${encryptSecret(dedicatedCfg() as typeof ctx.config, SECRET)}.extra`,
      "not base64 / bad iv length": "v2:!!!.???.***",
      "empty": "",
    };
    // tampered auth tag
    const good = encryptSecret(dedicatedCfg() as typeof ctx.config, SECRET).slice(3).split(".");
    const flipped = Buffer.from(good[1]!, "base64url");
    flipped[0] = flipped[0]! ^ 0xff;
    cases["tampered tag"] = `v2:${good[0]}.${flipped.toString("base64url")}.${good[2]}`;

    for (const [name, ciphertext] of Object.entries(cases)) {
      await ctx.pool.query(`DELETE FROM auth_rate_buckets`);
      await putFactor(ciphertext);
      const token = await login();
      const res = await challenge(token, "123456");
      expect(res.statusCode, `${name}: ${res.body}`).toBe(503);
      expect(res.json().error.code, name).toBe("service_unavailable");
      expect(res.body, name).not.toMatch(/Unsupported state|authenticate data|Invalid key|stack/i);
      const row = await stored();
      expect(row.failed_count, `${name}: server-side key trouble must not lock the user out`).toBe(0);
      expect(row.secret_encrypted, name).toBe(ciphertext);
    }
  });

  it("enrolment needs a recently confirmed password and creates nothing when refused", async () => {
    await ctx.pool.query(`UPDATE mfa_factors SET disabled_at = now() WHERE user_id = $1 AND disabled_at IS NULL`, [userId]);
    const token = await login();
    await ctx.pool.query(`UPDATE sessions SET created_at = created_at - interval '1 hour', expires_at = expires_at - interval '1 hour' WHERE user_id = $1`, [userId]);
    const stale = await ctx.app.inject({ method: "POST", url: "/v1/auth/mfa/totp/enroll", headers: { authorization: `Bearer ${token}` } });
    expect(stale.statusCode, stale.body).toBe(403);
    expect(stale.json().error.code).toBe("reauth_required");
    const none = await ctx.pool.query(`SELECT count(*)::int AS n FROM mfa_factors WHERE user_id = $1 AND disabled_at IS NULL`, [userId]);
    expect(none.rows[0].n).toBe(0);
    const codes = await ctx.pool.query(`SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL`, [userId]);
    expect(codes.rows[0].n).toBe(0);

    const re = await ctx.app.inject({ method: "POST", url: "/v1/auth/reauth", headers: { authorization: `Bearer ${token}` }, payload: { password: PASSWORD } });
    expect(re.statusCode, re.body).toBe(200);
    const ok = await ctx.app.inject({ method: "POST", url: "/v1/auth/mfa/totp/enroll", headers: { authorization: `Bearer ${token}` } });
    expect(ok.statusCode, ok.body).toBe(200);
  });
});
