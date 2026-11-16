/**
 * R-02 / OD-1 independent boundary verification (migration 014), run as the real
 * runtime role (figbloom_app) against PostgreSQL. Complements r02.sessionMint.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createTestApp, type FixtureIds } from "./support.js";
import {
  LOCAL_SESSION_MINT_HMAC_KEY,
  buildRevokeAllPayload,
  buildRevokePayload,
  buildSetTenantPayload,
  newProofNonce,
  proofTimestampUtc,
  signSessionProof,
} from "../src/modules/auth/sessionProof.js";
import {
  createSession,
  findValidSession,
  revokeAllUserSessions,
  revokeSession,
} from "../src/modules/auth/session.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

const DEFINERS = [
  "auth_install_session_hmac_secret",
  "auth_active_session_hmac_secret",
  "auth_consume_session_proof",
  "auth_mint_session",
  "auth_touch_session",
  "auth_revoke_session",
  "auth_revoke_all_user_sessions",
  "auth_set_session_tenant",
] as const;

/** Functions the runtime role may execute (everything else must be owner-only). */
const RUNTIME_EXECUTABLE = new Set([
  "auth_mint_session",
  "auth_touch_session",
  "auth_revoke_session",
  "auth_revoke_all_user_sessions",
  "auth_set_session_tenant",
]);

describe("R-02 runtime-role boundary (migration 014)", () => {
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

  async function asRuntime<T>(fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
    const c = await ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("ROLLBACK");
      return out;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  it("runtime role cannot read the secret or nonce tables", async () => {
    for (const table of ["auth_session_hmac_secrets", "auth_session_proof_nonces"]) {
      await asRuntime(async (c) => {
        await expect(c.query(`SELECT * FROM public.${table}`)).rejects.toThrow(/permission denied/i);
      });
      await asRuntime(async (c) => {
        await expect(c.query(`INSERT INTO public.${table} DEFAULT VALUES`)).rejects.toThrow(
          /permission denied|null value|violates/i,
        );
      });
    }
  });

  it("runtime role cannot execute the secret / proof / hmac helper functions", async () => {
    const calls: Array<[string, unknown[]]> = [
      [`SELECT public.auth_active_session_hmac_secret()`, []],
      [
        `SELECT public.auth_consume_session_proof('mint','x',$1,now(),$2,interval '100 years')`,
        ["0".repeat(64), newProofNonce()],
      ],
      [`SELECT public.auth_hmac_sha256_hex('a'::bytea,'b'::bytea)`, []],
      [`SELECT public.auth_hmac_hex_equals('a','a')`, []],
      [`SELECT public.auth_install_session_hmac_secret('k', $1)`, [LOCAL_SESSION_MINT_HMAC_KEY]],
    ];
    for (const [sql, params] of calls) {
      await asRuntime(async (c) => {
        await expect(c.query(sql, params)).rejects.toThrow(/permission denied/i);
      });
    }
  });

  it("runtime role cannot UPDATE or DELETE sessions directly (no revocation / expiry tampering)", async () => {
    const { session } = await createSession(ctx.runtimePool, ctx.config, { userId: ids.adminA });
    await asRuntime(async (c) => {
      await expect(
        c.query(`UPDATE public.sessions SET revoked_at = NULL, expires_at = now() + interval '100 years' WHERE id = $1`, [
          session.id,
        ]),
      ).rejects.toThrow(/permission denied/i);
    });
    await asRuntime(async (c) => {
      await expect(c.query(`DELETE FROM public.sessions WHERE id = $1`, [session.id])).rejects.toThrow(
        /permission denied/i,
      );
    });
    await asRuntime(async (c) => {
      await expect(
        c.query(`UPDATE public.sessions SET active_tenant_id = $2 WHERE id = $1`, [session.id, ids.tenantB]),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it("catalog: definers are SECURITY DEFINER, owner-owned, pinned search_path, no PUBLIC execute, runtime grants exact", async () => {
    const r = await ctx.pool.query<{
      proname: string;
      prosecdef: boolean;
      owner: string;
      proconfig: string[] | null;
      public_exec: boolean;
      runtime_exec: boolean;
    }>(
      `SELECT p.proname, p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
              EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec,
              has_function_privilege('figbloom_app', p.oid, 'EXECUTE') AS runtime_exec
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1)`,
      [DEFINERS as unknown as string[]],
    );
    expect(r.rows.map((x) => x.proname).sort()).toEqual([...DEFINERS].sort());
    const migrator = (await ctx.pool.query<{ u: string }>(`SELECT current_user AS u`)).rows[0]!.u;
    for (const row of r.rows) {
      expect(row.prosecdef, row.proname).toBe(true);
      expect(row.owner, row.proname).toBe(migrator);
      expect(row.owner, row.proname).not.toBe("figbloom_app");
      expect(row.proconfig, row.proname).toContain("search_path=pg_catalog, pg_temp");
      expect(row.public_exec, `${row.proname} PUBLIC execute`).toBe(false);
      expect(row.runtime_exec, `${row.proname} runtime execute`).toBe(RUNTIME_EXECUTABLE.has(row.proname));
    }
    // Non-definer helpers must not be callable by PUBLIC either.
    const helpers = await ctx.pool.query<{ proname: string; public_exec: boolean; runtime_exec: boolean }>(
      `SELECT p.proname,
              EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec,
              has_function_privilege('figbloom_app', p.oid, 'EXECUTE') AS runtime_exec
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('auth_hmac_sha256_hex', 'auth_hmac_hex_equals')`,
    );
    expect(helpers.rowCount).toBe(2);
    for (const h of helpers.rows) {
      expect(h.public_exec, h.proname).toBe(false);
      expect(h.runtime_exec, h.proname).toBe(false);
    }
    const tablePrivs = await ctx.pool.query<{ ins: boolean; upd: boolean; del: boolean; sel: boolean }>(
      `SELECT has_table_privilege('figbloom_app','public.sessions','INSERT') AS ins,
              has_table_privilege('figbloom_app','public.sessions','UPDATE') AS upd,
              has_table_privilege('figbloom_app','public.sessions','DELETE') AS del,
              has_table_privilege('figbloom_app','public.sessions','SELECT') AS sel`,
    );
    expect(tablePrivs.rows[0]).toEqual({ ins: false, upd: false, del: false, sel: true });
    const colUpd = await ctx.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.columns
        WHERE table_schema='public' AND table_name='sessions'
          AND has_column_privilege('figbloom_app','public.sessions', column_name, 'UPDATE')`,
    );
    expect(colUpd.rows[0]!.n).toBe("0");
  });

  it("revoke: forged / wrong-actor / replayed proofs fail and never revoke; a genuine proof revokes once", async () => {
    const { token, session } = await createSession(ctx.runtimePool, ctx.config, { userId: ids.adminA });
    const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const callRevoke = async (opts: { actor: string; mac?: string; nonce?: string; key?: string }) => {
      const nonce = opts.nonce ?? newProofNonce();
      const payload = buildRevokePayload({ sessionId: session.id, issuedAt, nonce, actorUserId: opts.actor });
      const mac = opts.mac ?? signSessionProof(opts.key ?? LOCAL_SESSION_MINT_HMAC_KEY, payload);
      const res = await ctx.runtimePool.query<{ ok: boolean }>(
        `SELECT public.auth_revoke_session($1::uuid,$2::uuid,$3::timestamptz,$4::text,$5::text) AS ok`,
        [session.id, opts.actor, proofTimestampUtc(issuedAt), nonce, mac],
      );
      return { ok: res.rows[0]!.ok, nonce, mac };
    };
    // forged key
    expect((await callRevoke({ actor: ids.adminA, key: "y".repeat(40) })).ok).toBe(false);
    // wrong actor (valid MAC for that actor, but not the session owner)
    expect((await callRevoke({ actor: ids.superAdmin })).ok).toBe(false);
    // junk MAC
    expect((await callRevoke({ actor: ids.adminA, mac: "A".repeat(64) })).ok).toBe(false);
    expect(await findValidSession(ctx.runtimePool, token)).not.toBeNull();
    // genuine, then replay of the identical proof
    const good = await callRevoke({ actor: ids.adminA });
    expect(good.ok).toBe(true);
    expect(await findValidSession(ctx.runtimePool, token)).toBeNull();
    const replay = await callRevoke({ actor: ids.adminA, nonce: good.nonce, mac: good.mac });
    expect(replay.ok).toBe(false);
  });

  it("revoke-all: cannot be aimed at another user, forged proofs fail, genuine keeps the kept session", async () => {
    const a = await createSession(ctx.runtimePool, ctx.config, { userId: ids.teacherA });
    const b = await createSession(ctx.runtimePool, ctx.config, { userId: ids.teacherA });
    const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const nonce = newProofNonce();
    // Attacker (holding a valid HMAC for itself) tries to revoke every session of another user.
    const payload = buildRevokeAllPayload({
      userId: ids.teacherA,
      keepSessionId: null,
      issuedAt,
      nonce,
      actorUserId: ids.teacherB,
    });
    const crossUser = await ctx.runtimePool.query<{ n: number }>(
      `SELECT public.auth_revoke_all_user_sessions($1::uuid,$2::uuid,NULL,$3::timestamptz,$4::text,$5::text) AS n`,
      [ids.teacherA, ids.teacherB, proofTimestampUtc(issuedAt), nonce, signSessionProof(LOCAL_SESSION_MINT_HMAC_KEY, payload)],
    );
    expect(crossUser.rows[0]!.n).toBe(0);
    // forged
    const forged = await ctx.runtimePool.query<{ n: number }>(
      `SELECT public.auth_revoke_all_user_sessions($1::uuid,$1::uuid,NULL,$2::timestamptz,$3::text,$4::text) AS n`,
      [ids.teacherA, proofTimestampUtc(issuedAt), newProofNonce(), "f".repeat(64)],
    );
    expect(forged.rows[0]!.n).toBe(0);
    expect(await findValidSession(ctx.runtimePool, a.token)).not.toBeNull();
    expect(await findValidSession(ctx.runtimePool, b.token)).not.toBeNull();
    const n = await revokeAllUserSessions(ctx.runtimePool, ctx.config, ids.teacherA, a.session.id);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await findValidSession(ctx.runtimePool, a.token)).not.toBeNull();
    expect(await findValidSession(ctx.runtimePool, b.token)).toBeNull();
  });

  it("set-tenant: forged and cross-owner proofs fail and leave the session unchanged", async () => {
    const { session } = await createSession(ctx.runtimePool, ctx.config, { userId: ids.adminA });
    const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const attempt = async (actor: string, key: string) => {
      const nonce = newProofNonce();
      const payload = buildSetTenantPayload({
        sessionId: session.id,
        tenantId: ids.tenantA,
        organizationId: ids.orgA,
        issuedAt,
        nonce,
        actorUserId: actor,
      });
      const res = await ctx.runtimePool.query(
        `SELECT id FROM public.auth_set_session_tenant($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::timestamptz,$6::text,$7::text)`,
        [session.id, ids.tenantA, ids.orgA, actor, proofTimestampUtc(issuedAt), nonce, signSessionProof(key, payload)],
      );
      return res.rowCount;
    };
    expect(await attempt(ids.adminA, "z".repeat(40))).toBe(0); // forged
    expect(await attempt(ids.superAdmin, LOCAL_SESSION_MINT_HMAC_KEY)).toBe(0); // not the session owner
    const row = await ctx.pool.query(`SELECT active_tenant_id FROM sessions WHERE id = $1`, [session.id]);
    expect(row.rows[0]!.active_tenant_id).toBeNull();
  });

  it("mint is refused for a non-active user even with a genuine proof", async () => {
    await ctx.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [ids.parentA]);
    try {
      await expect(createSession(ctx.runtimePool, ctx.config, { userId: ids.parentA })).rejects.toThrow(
        /Unable to create session/,
      );
    } finally {
      await ctx.pool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [ids.parentA]);
    }
  });

  it("revoked and expired sessions are never returned or extended by the throttled touch", async () => {
    const { token, session } = await createSession(ctx.runtimePool, ctx.config, { userId: ids.adminA });
    expect(await findValidSession(ctx.runtimePool, token, 300)).not.toBeNull();
    await revokeSession(ctx.runtimePool, ctx.config, session.id, ids.adminA);
    expect(await findValidSession(ctx.runtimePool, token, 300)).toBeNull();
    const exp = await createSession(ctx.runtimePool, ctx.config, { userId: ids.adminA });
    await ctx.pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      exp.session.id,
    ]);
    expect(await findValidSession(ctx.runtimePool, exp.token, 0)).toBeNull();
  });

  it("a nonce consumed by one purpose cannot be replayed under another", async () => {
    const { session } = await createSession(ctx.runtimePool, ctx.config, { userId: ids.adminA });
    const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const nonce = randomBytes(24).toString("base64url");
    const revokePayload = buildRevokePayload({ sessionId: session.id, issuedAt, nonce, actorUserId: ids.adminA });
    const first = await ctx.runtimePool.query<{ ok: boolean }>(
      `SELECT public.auth_revoke_session($1::uuid,$2::uuid,$3::timestamptz,$4::text,$5::text) AS ok`,
      [session.id, ids.adminA, proofTimestampUtc(issuedAt), nonce, signSessionProof(LOCAL_SESSION_MINT_HMAC_KEY, revokePayload)],
    );
    expect(first.rows[0]!.ok).toBe(true);
    const keepPayload = buildRevokeAllPayload({
      userId: ids.adminA,
      keepSessionId: null,
      issuedAt,
      nonce,
      actorUserId: ids.adminA,
    });
    const second = await ctx.runtimePool.query<{ n: number }>(
      `SELECT public.auth_revoke_all_user_sessions($1::uuid,$1::uuid,NULL,$2::timestamptz,$3::text,$4::text) AS n`,
      [ids.adminA, proofTimestampUtc(issuedAt), nonce, signSessionProof(LOCAL_SESSION_MINT_HMAC_KEY, keepPayload)],
    );
    expect(second.rows[0]!.n).toBe(0);
  });
});
