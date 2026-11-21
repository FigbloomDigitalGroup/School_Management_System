/**
 * WP-A1 final remediation: HMAC secret provisioning, rotation, fail-closed behaviour and
 * readiness (migration 015 + scripts/session-hmac.mjs). Real PostgreSQL, real runtime role,
 * the real script run as a child process.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestApp } from "./support.js";
import { buildApp } from "../src/app.js";
import { checkDatabaseReady } from "../src/db/identityAccess.js";
import { createSession, findValidSession } from "../src/modules/auth/session.js";
import {
  LOCAL_SESSION_MINT_HMAC_KEY,
  buildSelftestPayload,
  newProofNonce,
  signSessionProof,
} from "../src/modules/auth/sessionProof.js";

// Same resolution as test/support.ts, captured before createTestApp touches DATABASE_URL.
const OWNER_URL =
  process.env.MIGRATION_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "";
const SCRIPT = fileURLToPath(new URL("../scripts/session-hmac.mjs", import.meta.url));

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

function randomKey(): string {
  return randomBytes(48).toString("base64url");
}

function run(args: string[], env: Record<string, string> = {}) {
  const base: NodeJS.ProcessEnv = { ...process.env, MIGRATION_DATABASE_URL: OWNER_URL };
  delete base.SESSION_MINT_HMAC_KEY;
  delete base.SESSION_MINT_HMAC_KEY_NEW;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...base, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("session HMAC provisioning (migrations 014/015, scripts/session-hmac.mjs)", () => {
  let ctx: Ctx;
  let readyApp: Awaited<ReturnType<typeof buildApp>>;
  let tmp: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    tmp = mkdtempSync(join(tmpdir(), "fb-hmac-"));
    // Fresh app with the readiness cache off so each probe reflects the database right now.
    readyApp = await buildApp({ ...ctx.config, readinessCacheMs: 0 }, ctx.runtimePool);
    await readyApp.ready();
  }, 120_000);

  afterAll(async () => {
    await readyApp.close();
    await ctx.app.close();
    await ctx.runtimePool.end();
    await ctx.pool.end();
    rmSync(tmp, { recursive: true, force: true });
  });

  const clearKeys = () => ctx.pool.query(`DELETE FROM public.auth_session_hmac_secrets`);
  const keyRows = async () =>
    (await ctx.pool.query<{ key_id: string; revoked_at: Date | null }>(
      `SELECT key_id, revoked_at FROM public.auth_session_hmac_secrets ORDER BY created_at`,
    )).rows;
  const cfgWith = (key: string) => ({ ...ctx.config, sessionMintHmacKey: key });

  beforeEach(async () => {
    // Every test starts from the standard local state; tests that need "no secret" clear it.
    await clearKeys();
    await ctx.pool.query(`SELECT public.auth_install_session_hmac_secret('local', $1)`, [
      LOCAL_SESSION_MINT_HMAC_KEY,
    ]);
  });

  it("a database with no provisioned secret is not ready, and login fails closed", async () => {
    await clearKeys();
    const ready = await readyApp.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: "unavailable", reason: "configuration" });
    // Probes stay live: configuration is a readiness failure, not a liveness one.
    expect((await readyApp.inject({ method: "GET", url: "/livez" })).statusCode).toBe(200);

    const login = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email: "admin-a@example.com", password: "correct-horse-battery" },
    });
    expect(login.statusCode).toBe(401);
    expect(login.json().token).toBeUndefined();
    const sessions = await ctx.pool.query(`SELECT 1 FROM sessions WHERE user_id = (SELECT id FROM users WHERE email='admin-a@example.com') AND created_at > now() - interval '1 minute'`);
    expect(sessions.rowCount).toBe(0);
  });

  it("a mismatched application key is not ready, and login fails closed", async () => {
    await clearKeys();
    const secret = randomKey();
    const r = run(["provision", "--key-id", "prod-1", "--from-env"], { SESSION_MINT_HMAC_KEY: secret });
    expect(r.code, r.out).toBe(0);
    // The app under test still holds the local key, which does not match.
    const ready = await readyApp.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: "unavailable", reason: "configuration" });
    expect(ready.body).not.toContain(secret);
    const login = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email: "admin-a@example.com", password: "correct-horse-battery" },
    });
    expect(login.statusCode).toBe(401);
    // The matching application key works end to end.
    const ok = await createSession(ctx.runtimePool, cfgWith(secret), { userId: ctx.ids.adminA });
    expect(ok.token).toBeTruthy();
  });

  it("the database self-test reports ok / mismatch / no_secret without key material", async () => {
    const opts = { acquireTimeoutMs: 5000, queryTimeoutMs: 5000 };
    expect(await checkDatabaseReady(ctx.runtimePool, { ...opts, sessionMintHmacKey: LOCAL_SESSION_MINT_HMAC_KEY })).toBe("ok");
    expect(await checkDatabaseReady(ctx.runtimePool, { ...opts, sessionMintHmacKey: randomKey() })).toBe("mismatch");
    await clearKeys();
    expect(await checkDatabaseReady(ctx.runtimePool, { ...opts, sessionMintHmacKey: LOCAL_SESSION_MINT_HMAC_KEY })).toBe("no_secret");
    // Without a key configured the probe does not run the self-test (database-only readiness).
    expect(await checkDatabaseReady(ctx.runtimePool, opts)).toBeUndefined();
  });

  it("the status function verifies selftest payloads only and consumes nothing", async () => {
    const nonces = async () => (await ctx.pool.query(`SELECT count(*)::int AS n FROM auth_session_proof_nonces`)).rows[0]!.n as number;
    const before = await nonces();
    const nonce = newProofNonce();
    const good = signSessionProof(LOCAL_SESSION_MINT_HMAC_KEY, buildSelftestPayload(nonce));
    const status = (n: string, mac: string) =>
      ctx.runtimePool.query<{ s: string }>(`SELECT public.auth_session_hmac_status($1::text, $2::text) AS s`, [n, mac]);
    expect((await status(nonce, good)).rows[0]!.s).toBe("ok");
    // A valid MAC for any other payload shape (e.g. a mint proof) is not accepted here.
    const other = signSessionProof(LOCAL_SESSION_MINT_HMAC_KEY, `v1|mint|${nonce}`);
    expect((await status(nonce, other)).rows[0]!.s).toBe("mismatch");
    expect((await status("short", good)).rows[0]!.s).toBe("invalid");
    expect((await status(nonce, "NOT-HEX")).rows[0]!.s).toBe("invalid");
    expect(await nonces()).toBe(before);
  });

  it("provision --generate-to: CSPRNG secret to an exclusive file, never printed, accepted by the application", async () => {
    await clearKeys();
    const file = join(tmp, `gen-${randomBytes(4).toString("hex")}.key`);
    const r = run(["provision", "--key-id", "prod-1", "--generate-to", file]);
    expect(r.code, r.out).toBe(0);
    const secret = readFileSync(file, "utf8").trim();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{64}$/); // 48 random bytes, base64url
    expect(secret).not.toBe(LOCAL_SESSION_MINT_HMAC_KEY);
    expect(r.out).not.toContain(secret);
    expect(r.out).toContain("provision: ok (key id prod-1)");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
    expect(await keyRows()).toHaveLength(1);

    const opts = { acquireTimeoutMs: 5000, queryTimeoutMs: 5000 };
    expect(await checkDatabaseReady(ctx.runtimePool, { ...opts, sessionMintHmacKey: secret })).toBe("ok");
    const v = run(["verify"], { SESSION_MINT_HMAC_KEY: secret });
    expect(v.code, v.out).toBe(0);
    expect(v.stdout).toContain("verify: ok");
    expect(v.out).not.toContain(secret);
    const bad = run(["verify"], { SESSION_MINT_HMAC_KEY: randomKey() });
    expect(bad.code).toBe(2);
    expect(bad.stdout).toContain("verify: mismatch");
    // The secret is not stored anywhere an application endpoint or audit row can reach.
    const audit = await ctx.pool.query(`SELECT 1 FROM security_audit_events WHERE detail::text LIKE $1`, [`%${secret}%`]);
    expect(audit.rowCount).toBe(0);
    // And a runtime role cannot read it.
    await expect(ctx.runtimePool.query(`SELECT secret FROM public.auth_session_hmac_secrets`)).rejects.toThrow(/permission denied/i);
  });

  it("provision never silently replaces an existing secret; the same key is idempotent", async () => {
    await clearKeys();
    const secret = randomKey();
    expect(run(["provision", "--key-id", "prod-1", "--from-env"], { SESSION_MINT_HMAC_KEY: secret }).code).toBe(0);
    const before = await ctx.pool.query(`SELECT secret FROM public.auth_session_hmac_secrets`);

    // Same key id and secret: idempotent no-op.
    const again = run(["provision", "--key-id", "prod-1", "--from-env"], { SESSION_MINT_HMAC_KEY: secret });
    expect(again.code, again.out).toBe(0);
    expect(await keyRows()).toHaveLength(1);

    // A different secret (new id or same id) is refused; a generated file for it is removed.
    const other = randomKey();
    const differentId = run(["provision", "--key-id", "prod-2", "--from-env"], { SESSION_MINT_HMAC_KEY: other });
    expect(differentId.code).toBe(1);
    expect(differentId.out).toContain("already provisioned");
    expect(differentId.out).not.toContain(other);
    const sameIdOtherSecret = run(["provision", "--key-id", "prod-1", "--from-env"], { SESSION_MINT_HMAC_KEY: other });
    expect(sameIdOtherSecret.code).toBe(1);
    const file = join(tmp, `refused-${randomBytes(4).toString("hex")}.key`);
    const generated = run(["provision", "--key-id", "prod-3", "--generate-to", file]);
    expect(generated.code).toBe(1);
    expect(existsSync(file)).toBe(false);

    const after = await ctx.pool.query(`SELECT secret FROM public.auth_session_hmac_secrets`);
    expect(after.rows).toEqual(before.rows);
    expect(await keyRows()).toHaveLength(1);
    // Existing sessions are untouched by a refused re-provision.
    const s = await createSession(ctx.runtimePool, cfgWith(secret), { userId: ctx.ids.adminA });
    expect(await findValidSession(ctx.runtimePool, s.token)).not.toBeNull();
  });

  it("the script refuses weak input: dev key, short secret, whitespace, bad key id, missing env, existing file", async () => {
    await clearKeys();
    const dev = run(["provision", "--key-id", "k", "--from-env"], { SESSION_MINT_HMAC_KEY: LOCAL_SESSION_MINT_HMAC_KEY });
    expect(dev.code).toBe(1);
    expect(dev.out).toContain("local/test development key");
    expect(run(["provision", "--key-id", "k", "--from-env"], { SESSION_MINT_HMAC_KEY: "short" }).code).toBe(1);
    expect(run(["provision", "--key-id", "k", "--from-env"], { SESSION_MINT_HMAC_KEY: `${randomKey()} ${randomKey()}` }).code).toBe(1);
    expect(run(["provision", "--key-id", "bad id!", "--from-env"], { SESSION_MINT_HMAC_KEY: randomKey() }).code).toBe(1);
    expect(run(["provision", "--key-id", "k", "--from-env"]).code).toBe(1);
    expect(run(["provision", "--key-id", "k"]).code).toBe(1); // neither source chosen
    const existing = join(tmp, "exists.key");
    writeFileSync(existing, "do not overwrite");
    expect(run(["provision", "--key-id", "k", "--generate-to", existing]).code).toBe(1);
    expect(readFileSync(existing, "utf8")).toBe("do not overwrite");
    expect(await keyRows()).toHaveLength(0);
    // The documented dev key literal in the script matches the source constant.
    expect(readFileSync(SCRIPT, "utf8")).toContain(`"${LOCAL_SESSION_MINT_HMAC_KEY}"`);
  });

  it("rotation overlaps two keys, retiring the old one never touches existing sessions, the last key cannot be retired", async () => {
    await clearKeys();
    const s1 = randomKey();
    const s2 = randomKey();
    expect(run(["provision", "--key-id", "k1", "--from-env"], { SESSION_MINT_HMAC_KEY: s1 }).code).toBe(0);
    const existing = await createSession(ctx.runtimePool, cfgWith(s1), { userId: ctx.ids.adminA });

    const rot = run(["rotate", "--key-id", "k2", "--from-env"], { SESSION_MINT_HMAC_KEY_NEW: s2 });
    expect(rot.code, rot.out).toBe(0);
    expect(rot.out).not.toContain(s2);
    expect((await keyRows()).filter((k) => !k.revoked_at)).toHaveLength(2);
    // Both applications keys work during the overlap (zero-downtime rollout).
    expect((await createSession(ctx.runtimePool, cfgWith(s1), { userId: ctx.ids.teacherA })).token).toBeTruthy();
    expect((await createSession(ctx.runtimePool, cfgWith(s2), { userId: ctx.ids.teacherA })).token).toBeTruthy();
    expect(run(["verify"], { SESSION_MINT_HMAC_KEY: s1 }).code).toBe(0);
    expect(run(["verify"], { SESSION_MINT_HMAC_KEY: s2 }).code).toBe(0);
    // A third key while two are active is refused, as is re-using an id.
    expect(run(["rotate", "--key-id", "k3", "--from-env"], { SESSION_MINT_HMAC_KEY_NEW: randomKey() }).code).toBe(1);

    const retire = run(["retire", "--key-id", "k1"]);
    expect(retire.code, retire.out).toBe(0);
    // Old key no longer mints; new key does; the session minted under the old key is unaffected.
    await expect(createSession(ctx.runtimePool, cfgWith(s1), { userId: ctx.ids.teacherA })).rejects.toThrow(/Unable to create session/);
    expect((await createSession(ctx.runtimePool, cfgWith(s2), { userId: ctx.ids.teacherA })).token).toBeTruthy();
    expect(await findValidSession(ctx.runtimePool, existing.token)).not.toBeNull();
    expect(run(["verify"], { SESSION_MINT_HMAC_KEY: s1 }).code).toBe(2);
    // The only remaining key cannot be retired, an unknown id is refused.
    const last = run(["retire", "--key-id", "k2"]);
    expect(last.code).toBe(1);
    expect(last.out).toContain("cannot retire the only active");
    expect(run(["retire", "--key-id", "nope"]).code).toBe(1);
    const status = run(["status"]);
    expect(status.code, status.out).toBe(0);
    expect(status.stdout).toContain("ACTIVE");
    expect(status.out).not.toContain(s1);
    expect(status.out).not.toContain(s2);
  });

  it("owner-only functions are not callable by the runtime role", async () => {
    for (const sql of [
      `SELECT public.auth_rotate_session_hmac_secret('x', '${"a".repeat(40)}')`,
      `SELECT public.auth_retire_session_hmac_secret('local')`,
      `SELECT public.auth_purge_session_proof_nonces(10)`,
      `SELECT public.auth_install_session_hmac_secret('x', '${"a".repeat(40)}')`,
      `SELECT public.auth_session_hmac_matches('a', 'b')`,
      `SELECT public.auth_session_tenant_eligible(gen_random_uuid(), gen_random_uuid())`,
    ]) {
      await expect(ctx.runtimePool.query(sql), sql).rejects.toThrow(/permission denied/i);
    }
  });

  it("catalog: every new function is owner-owned, hardened, and PUBLIC cannot execute it", async () => {
    const r = await ctx.pool.query<{
      proname: string; prosecdef: boolean; owner: string; proconfig: string[] | null; public_exec: boolean; runtime_exec: boolean;
    }>(
      `SELECT p.proname, p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
              EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec,
              has_function_privilege('figbloom_app', p.oid, 'EXECUTE') AS runtime_exec
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname = ANY($1)`,
      [[
        "auth_session_hmac_matches", "auth_rotate_session_hmac_secret", "auth_retire_session_hmac_secret",
        "auth_session_hmac_status", "auth_purge_session_proof_nonces", "auth_session_tenant_eligible",
        "auth_install_session_hmac_secret", "auth_consume_session_proof", "auth_set_session_tenant",
      ]],
    );
    expect(r.rowCount).toBe(9);
    const migrator = (await ctx.pool.query<{ u: string }>(`SELECT current_user AS u`)).rows[0]!.u;
    const runtimeAllowed = new Set(["auth_session_hmac_status", "auth_set_session_tenant"]);
    for (const row of r.rows) {
      expect(row.owner, row.proname).toBe(migrator);
      expect(row.proconfig, row.proname).toContain("search_path=pg_catalog, pg_temp");
      expect(row.public_exec, row.proname).toBe(false);
      expect(row.runtime_exec, row.proname).toBe(runtimeAllowed.has(row.proname));
    }
  });
});
