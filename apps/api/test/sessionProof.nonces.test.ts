/**
 * WP-A1 final remediation: nonce housekeeping (migration 015 auth_purge_session_proof_nonces)
 * and replay protection under purge and concurrency. Real PostgreSQL, real runtime role.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createTestApp, type FixtureIds } from "./support.js";
import { createSession, hashSessionToken, mintSessionToken } from "../src/modules/auth/session.js";
import {
  LOCAL_SESSION_MINT_HMAC_KEY,
  buildMintPayload,
  newProofNonce,
  proofTimestampUtc,
  signSessionProof,
} from "../src/modules/auth/sessionProof.js";

const OWNER_URL =
  process.env.MIGRATION_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:58322/figbloom_api";
const SCRIPT = fileURLToPath(new URL("../scripts/session-hmac.mjs", import.meta.url));

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

describe("session proof nonces: housekeeping and replay protection", () => {
  let ctx: Ctx;
  let ids: FixtureIds;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.runtimePool.end();
    await ctx.pool.end();
  });

  beforeEach(async () => {
    await ctx.pool.query(`DELETE FROM public.auth_session_proof_nonces`);
  });

  const insertNonce = async (consumedAgo: string, expiresIn: string) => {
    const nonce = randomBytes(16).toString("hex");
    await ctx.pool.query(
      `INSERT INTO public.auth_session_proof_nonces (nonce, purpose, consumed_at, expires_at)
       VALUES ($1, 'mint', now() - $2::interval, now() + $3::interval)`,
      [nonce, consumedAgo, expiresIn],
    );
    return nonce;
  };
  const exists = async (nonce: string) =>
    ((await ctx.pool.query(`SELECT 1 FROM public.auth_session_proof_nonces WHERE nonce = $1`, [nonce])).rowCount ?? 0) === 1;
  const purge = async (batch?: number) =>
    (await ctx.pool.query<{ n: number }>(`SELECT public.auth_purge_session_proof_nonces(${batch ?? ""}) AS n`)).rows[0]!.n;

  function mintArgs(opts: { userId: string; issuedAt?: Date; nonce?: string; tokenHash?: string }) {
    const issuedAt = opts.issuedAt ?? new Date(Math.floor(Date.now() / 1000) * 1000);
    const expiresAt = new Date(issuedAt.getTime() + 3_600_000);
    const nonce = opts.nonce ?? newProofNonce();
    const tokenHash = opts.tokenHash ?? hashSessionToken(mintSessionToken());
    const payload = buildMintPayload({
      userId: opts.userId, tokenHash, expiresAt, issuedAt, nonce, mintedBy: "login",
      actorUserId: opts.userId, activeTenantId: null, activeOrganizationId: null,
    });
    const mac = signSessionProof(LOCAL_SESSION_MINT_HMAC_KEY, payload);
    return {
      tokenHash,
      nonce,
      call: (pool: Ctx["runtimePool"]) =>
        pool.query(
          `SELECT id FROM public.auth_mint_session($1::uuid,$2::text,$3::timestamptz,NULL,NULL,NULL,NULL,'login',$1::uuid,$4::timestamptz,$5::text,$6::text)`,
          [opts.userId, tokenHash, proofTimestampUtc(expiresAt), proofTimestampUtc(issuedAt), nonce, mac],
        ),
    };
  }

  it("removes only nonces that are expired AND at least an hour old, in bounded batches", async () => {
    const old = [] as string[];
    for (let i = 0; i < 5; i++) old.push(await insertNonce("26 hours", "-2 hours"));
    const expiredButRecent = await insertNonce("10 minutes", "-1 minute"); // expiry passed, row young
    const live = await insertNonce("0 seconds", "1 day"); // normal live nonce
    const consumedLongAgoButNotExpired = await insertNonce("30 hours", "1 hour"); // not yet expired

    expect(await purge(2)).toBe(2);
    expect(await purge(2)).toBe(2);
    expect(await purge(2)).toBe(1);
    expect(await purge(2)).toBe(0);

    for (const n of old) expect(await exists(n)).toBe(false);
    expect(await exists(expiredButRecent)).toBe(true);
    expect(await exists(live)).toBe(true);
    expect(await exists(consumedLongAgoButNotExpired)).toBe(true);
  });

  it("rejects invalid batch sizes", async () => {
    for (const bad of ["0", "-1", "10001", "NULL"]) {
      await expect(ctx.pool.query(`SELECT public.auth_purge_session_proof_nonces(${bad})`), bad).rejects.toThrow(/batch must be between/);
    }
  });

  it("a freshly consumed nonce is retained by purge, so an immediate replay is still refused", async () => {
    const m = mintArgs({ userId: ids.adminA });
    expect((await m.call(ctx.runtimePool)).rowCount).toBe(1);
    expect((await m.call(ctx.runtimePool)).rowCount).toBe(0); // replay
    expect(await purge(10000)).toBe(0);
    expect(await exists(m.nonce)).toBe(true);
    expect((await m.call(ctx.runtimePool)).rowCount).toBe(0); // still refused after purge
    const sessions = await ctx.pool.query(`SELECT 1 FROM sessions WHERE token_hash = $1`, [m.tokenHash]);
    expect(sessions.rowCount).toBe(1);
  });

  it("a purged (old) nonce can never be replayed: the age window refuses the proof by itself", async () => {
    // Everything purge removes is older than an hour; a proof is accepted only for 60 s (+5 s skew).
    const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 2 * 3_600_000);
    const m = mintArgs({ userId: ids.adminA, issuedAt });
    expect(await exists(m.nonce)).toBe(false); // nonce row absent, as after a purge
    expect((await m.call(ctx.runtimePool)).rowCount).toBe(0);
    const edge = mintArgs({ userId: ids.adminA, issuedAt: new Date(Math.floor(Date.now() / 1000) * 1000 - 61_000) });
    expect((await edge.call(ctx.runtimePool)).rowCount).toBe(0); // just outside the 60 s window
  });

  it("the same proof fired concurrently succeeds exactly once", async () => {
    const m = mintArgs({ userId: ids.teacherA });
    const results = await Promise.all(Array.from({ length: 10 }, () => m.call(ctx.runtimePool)));
    expect(results.filter((r) => r.rowCount === 1)).toHaveLength(1);
    const sessions = await ctx.pool.query(`SELECT 1 FROM sessions WHERE token_hash = $1`, [m.tokenHash]);
    expect(sessions.rowCount).toBe(1);
    const nonces = await ctx.pool.query(`SELECT 1 FROM public.auth_session_proof_nonces WHERE nonce = $1`, [m.nonce]);
    expect(nonces.rowCount).toBe(1);
  });

  it("purging concurrently with session minting loses nothing and blocks nothing", async () => {
    for (let i = 0; i < 200; i++) await insertNonce("26 hours", "-2 hours");
    const mints = Array.from({ length: 12 }, () => createSession(ctx.runtimePool, ctx.config, { userId: ids.adminA }));
    const purges = Array.from({ length: 4 }, () => purge(50));
    const [minted, purged] = await Promise.all([Promise.all(mints), Promise.all(purges)]);
    expect(minted).toHaveLength(12);
    expect(new Set(minted.map((s) => s.session.id)).size).toBe(12);
    expect(purged.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(200);
    // Drain the rest; all 200 expired rows go and the 12 live nonces stay.
    while ((await purge(100)) > 0) { /* bounded batches */ }
    const left = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.auth_session_proof_nonces WHERE expires_at > now()`,
    );
    expect(left.rows[0]!.n).toBeGreaterThanOrEqual(12);
    const stale = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.auth_session_proof_nonces WHERE expires_at < now() AND consumed_at < now() - interval '1 hour'`,
    );
    expect(stale.rows[0]!.n).toBe(0);
  });

  it("a purge never waits for rows a concurrent transaction holds (SKIP LOCKED)", async () => {
    const held = await insertNonce("26 hours", "-2 hours");
    const free = await insertNonce("26 hours", "-2 hours");
    const c = await ctx.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT 1 FROM public.auth_session_proof_nonces WHERE nonce = $1 FOR UPDATE`, [held]);
      const started = Date.now();
      expect(await purge(100)).toBe(1); // returns immediately with the unlocked row only
      expect(Date.now() - started).toBeLessThan(2000);
      expect(await exists(held)).toBe(true);
      expect(await exists(free)).toBe(false);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
    expect(await purge(100)).toBe(1);
  });

  it("the operator script reports and purges nonces without printing anything sensitive", async () => {
    for (let i = 0; i < 3; i++) await insertNonce("26 hours", "-2 hours");
    const live = await insertNonce("0 seconds", "1 day");
    const env = { ...process.env, MIGRATION_DATABASE_URL: OWNER_URL };
    const status = spawnSync(process.execPath, [SCRIPT, "status"], { env, encoding: "utf8" });
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain("nonces: 4 (purgeable 3)");
    const purged = spawnSync(process.execPath, [SCRIPT, "purge-nonces", "--batch", "2"], { env, encoding: "utf8" });
    expect(purged.status, purged.stderr).toBe(0);
    expect(purged.stdout).toContain("purge-nonces: removed 3");
    expect(await exists(live)).toBe(true);
    expect(spawnSync(process.execPath, [SCRIPT, "purge-nonces", "--batch", "0"], { env, encoding: "utf8" }).status).toBe(1);
  });
});
