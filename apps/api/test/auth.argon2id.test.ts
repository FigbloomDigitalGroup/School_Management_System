import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";
import { ARGON2_PARAMS, hashPassword, legacyScryptHash, passwordNeedsRehash, verifyPassword } from "../src/modules/identity/password.js";

const PASSWORD = "correct-horse-battery";

describe("Argon2id password hashing with lazy migration from scrypt", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => {
    ctx = await createTestApp();
  }, 120_000);
  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  const hashOf = async (id: string) => (await ctx.pool.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [id])).rows[0]!.password_hash;
  const login = (email: string, password = PASSWORD) => ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email, password } });
  async function legacyUser(): Promise<{ id: string; email: string; hash: string }> {
    const id = randomUUID();
    const email = `legacy-${id}@example.com`;
    const hash = await legacyScryptHash(PASSWORD);
    await ctx.pool.query(`INSERT INTO users (id, email, password_hash, full_name, status) VALUES ($1, $2, $3, 'Legacy', 'active')`, [id, email, hash]);
    return { id, email, hash };
  }

  it("new hashes are Argon2id PHC strings with OWASP-baseline parameters, unique salts, and verify; wrong passwords and tampering fail", async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).toMatch(/^\$argon2id\$v=19\$m=47104,t=1,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(a).not.toBe(b); // unique salt
    expect(ARGON2_PARAMS.memory).toBeGreaterThanOrEqual(19456);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword(PASSWORD + "x", a)).toBe(false);
    expect(await verifyPassword(PASSWORD, a.slice(0, -2) + (a.endsWith("AA") ? "BB" : "AA"))).toBe(false);
    expect(passwordNeedsRehash(a)).toBe(false);
    expect(passwordNeedsRehash(await legacyScryptHash(PASSWORD))).toBe(true);
    expect(passwordNeedsRehash("$argon2id$v=19$m=8192,t=1,p=1$AAAAAAAAAAAAAAAAAAAAAA$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB")).toBe(true); // weaker params
  });

  it("hostile or malformed stored hashes are refused without work (capped parameters, unknown formats)", async () => {
    const huge = "$argon2id$v=19$m=900000,t=1,p=1$AAAAAAAAAAAAAAAAAAAAAA$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const slow = "$argon2id$v=19$m=47104,t=99,p=1$AAAAAAAAAAAAAAAAAAAAAA$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const started = Date.now();
    expect(await verifyPassword(PASSWORD, huge)).toBe(false);
    expect(await verifyPassword(PASSWORD, slow)).toBe(false);
    expect(await verifyPassword(PASSWORD, "bcrypt$whatever")).toBe(false);
    expect(await verifyPassword(PASSWORD, "scrypt$99999999$8$1$AA==$AA==")).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("an existing scrypt user still logs in; the first successful login migrates the hash to Argon2id; later logins keep working", async () => {
    const u = await legacyUser();
    expect((await login(u.email, "wrong-password-1")).statusCode).toBe(401);
    expect(await hashOf(u.id)).toBe(u.hash); // a FAILED login never migrates
    expect((await login(u.email)).statusCode).toBe(200);
    const after = await hashOf(u.id);
    expect(after.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(PASSWORD, after)).toBe(true);
    expect((await login(u.email)).statusCode).toBe(200);
    expect(await hashOf(u.id)).toBe(after); // already current: not rewritten
    const audit = await ctx.pool.query(`SELECT detail FROM security_audit_events WHERE event_type = 'auth.password.rehashed' AND actor_user_id = $1`, [u.id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.detail).toEqual({ from: "scrypt", to: "argon2id" });
    expect(JSON.stringify(audit.rows[0]!.detail)).not.toContain("argon2id$");
  });

  it("concurrent logins migrate exactly once and never corrupt the hash", async () => {
    const u = await legacyUser();
    const results = await Promise.all(Array.from({ length: 6 }, () => login(u.email)));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
    const h = await hashOf(u.id);
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(PASSWORD, h)).toBe(true);
    const n = await ctx.pool.query(`SELECT count(*)::int AS n FROM security_audit_events WHERE event_type = 'auth.password.rehashed' AND actor_user_id = $1`, [u.id]);
    expect(n.rows[0]!.n).toBe(1); // the CAS lets only one writer win
    expect((await login(u.email)).statusCode).toBe(200);
  });

  it("the rehash function cannot downgrade, accept plaintext/arbitrary strings, or overwrite a hash it did not verify", async () => {
    const u = await legacyUser();
    const good = await hashPassword(PASSWORD);
    const call = async (expected: string, next: string) =>
      (await ctx.runtimePool.query<{ ok: boolean }>(`SELECT public.auth_rehash_password($1::uuid, $2::text, $3::text) AS ok`, [u.id, expected, next])).rows[0]!.ok;
    expect(await call(u.hash, await legacyScryptHash(PASSWORD))).toBe(false); // downgrade to scrypt refused
    expect(await call(u.hash, "plaintext-password")).toBe(false);
    expect(await call(u.hash, "$argon2id$v=19$m=47104,t=1,p=1$bad!$bad!")).toBe(false);
    expect(await call("scrypt$1$1$1$AA==$AA==", good)).toBe(false); // wrong expected hash (CAS)
    expect(await hashOf(u.id)).toBe(u.hash);
    expect(await call(u.hash, good)).toBe(true);
    expect(await call(u.hash, await hashPassword(PASSWORD))).toBe(false); // the old hash is no longer current
    // disabled accounts are never rewritten
    await ctx.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [u.id]);
    expect(await call(await hashOf(u.id), await hashPassword(PASSWORD))).toBe(false);
  });

  it("passwords never appear in the audit trail or the login response", async () => {
    const u = await legacyUser();
    const r = await login(u.email);
    expect(JSON.stringify(r.json())).not.toMatch(/argon2|scrypt|password_hash|correct-horse/);
    const rows = await ctx.pool.query(`SELECT detail::text AS d FROM security_audit_events WHERE actor_user_id = $1`, [u.id]);
    expect(rows.rows.map((x) => x.d).join("")).not.toMatch(/correct-horse|\$argon2id|scrypt\$/);
  });
});
