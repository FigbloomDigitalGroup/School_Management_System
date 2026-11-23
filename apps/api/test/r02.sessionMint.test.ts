/**
 * R-02 / OD-1: migration 014 session-mint containment as figbloom_app.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createTestApp, type FixtureIds } from "./support.js";
import {
  LOCAL_SESSION_MINT_HMAC_KEY,
  buildMintPayload,
  newProofNonce,
  proofTimestampUtc,
  signSessionProof,
} from "../src/modules/auth/sessionProof.js";
import { createSession, hashSessionToken } from "../src/modules/auth/session.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

describe("R-02 session mint HMAC containment (migration 014)", () => {
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

  async function asRuntime<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
    const c = await ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("ROLLBACK");
      return out;
    } catch (err) {
      try {
        await c.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    } finally {
      c.release();
    }
  }

  it("1. direct session INSERT fails as figbloom_app", async () => {
    await asRuntime(async (c) => {
      await expect(
        c.query(
          `INSERT INTO sessions (user_id, token_hash, expires_at)
           VALUES ($1, $2, now() + interval '1 hour')`,
          [ids.superAdmin, createHash("sha256").update("x").digest("hex")],
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it("2. valid authorised proof succeeds (login path)", async () => {
    const { token, session } = await createSession(ctx.runtimePool, ctx.config, {
      userId: ids.adminA,
      mintedBy: "login",
    });
    expect(token).toBeTruthy();
    expect(session.user_id).toBe(ids.adminA);
    const login = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email: "admin-a@example.com", password: "correct-horse-battery" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().token).toBeTruthy();
  });

  it("3–8. invalid, forged, expired, replayed, wrong principal, wrong tenant proofs fail", async () => {
    await asRuntime(async (c) => {
      const tokenHash = hashSessionToken(randomBytes(32).toString("base64url"));
      const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 3_600_000);
      const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
      const nonce = newProofNonce();
      const base = {
        userId: ids.adminA,
        tokenHash,
        expiresAt,
        issuedAt,
        nonce,
        mintedBy: "login" as const,
        actorUserId: ids.adminA,
        activeTenantId: null as string | null,
        activeOrganizationId: null as string | null,
      };
      const payload = buildMintPayload(base);
      const mac = signSessionProof(LOCAL_SESSION_MINT_HMAC_KEY, payload);

      const call = (
        overrides: Partial<{
          userId: string;
          actor: string;
          mac: string;
          issuedAt: string;
          nonce: string;
          tenantId: string | null;
        }> = {},
      ) =>
        c.query(
          `SELECT id FROM public.auth_mint_session(
             $1::uuid, $2::text, $3::timestamptz, $4::uuid, $5::uuid, NULL, NULL,
             'login', $6::uuid, $7::timestamptz, $8::text, $9::text
           )`,
          [
            overrides.userId ?? ids.adminA,
            tokenHash,
            proofTimestampUtc(expiresAt),
            overrides.tenantId === undefined ? null : overrides.tenantId,
            null,
            overrides.actor ?? ids.adminA,
            overrides.issuedAt ?? proofTimestampUtc(issuedAt),
            overrides.nonce ?? nonce,
            overrides.mac ?? mac,
          ],
        );

      // Invalid proof (empty mac)
      expect((await call({ mac: "0".repeat(64) })).rowCount).toBe(0);

      // Forged proof (wrong key)
      const forged = signSessionProof("x".repeat(32), payload);
      expect((await call({ mac: forged })).rowCount).toBe(0);

      // Expired proof
      const oldIssued = new Date(Date.now() - 120_000);
      const oldPayload = buildMintPayload({ ...base, issuedAt: oldIssued, nonce: newProofNonce() });
      const oldMac = signSessionProof(LOCAL_SESSION_MINT_HMAC_KEY, oldPayload);
      expect(
        (
          await call({
            issuedAt: proofTimestampUtc(oldIssued),
            nonce: oldPayload.split("|")[6],
            mac: oldMac,
          })
        ).rowCount,
      ).toBe(0);

      // Valid once
      const okNonce = newProofNonce();
      const okPayload = buildMintPayload({ ...base, nonce: okNonce });
      const okMac = signSessionProof(LOCAL_SESSION_MINT_HMAC_KEY, okPayload);
      expect((await call({ nonce: okNonce, mac: okMac })).rowCount).toBe(1);

      // Replay same nonce
      expect((await call({ nonce: okNonce, mac: okMac })).rowCount).toBe(0);

      // Wrong principal (actor ≠ user)
      const otherNonce = newProofNonce();
      const otherPayload = buildMintPayload({
        ...base,
        userId: ids.superAdmin,
        actorUserId: ids.adminA,
        nonce: otherNonce,
      });
      // SQL rejects actor ≠ user before HMAC; also MAC wouldn't match if we used admin as actor in SQL
      expect(
        (
          await call({
            userId: ids.superAdmin,
            actor: ids.adminA,
            nonce: otherNonce,
            mac: signSessionProof(LOCAL_SESSION_MINT_HMAC_KEY, otherPayload),
          })
        ).rowCount,
      ).toBe(0);

      // Tenant binding: adminA has no membership on a random tenant
      const foreignTenant = randomUUID();
      const tNonce = newProofNonce();
      const tPayload = buildMintPayload({
        ...base,
        nonce: tNonce,
        activeTenantId: foreignTenant,
      });
      expect(
        (
          await call({
            nonce: tNonce,
            mac: signSessionProof(LOCAL_SESSION_MINT_HMAC_KEY, tPayload),
            tenantId: foreignTenant,
          })
        ).rowCount,
      ).toBe(0);
    });
  });

  it("9. audit attribution identifies the initiating actor", async () => {
    const before = await ctx.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM security_audit_events
       WHERE event_type = 'auth.session.minted' AND actor_user_id = $1`,
      [ids.adminA],
    );
    await createSession(ctx.runtimePool, ctx.config, { userId: ids.adminA, mintedBy: "login" });
    const after = await ctx.pool.query<{ n: string; actor: string }>(
      `SELECT count(*)::text AS n, max(actor_user_id::text) AS actor
       FROM security_audit_events
       WHERE event_type = 'auth.session.minted' AND actor_user_id = $1`,
      [ids.adminA],
    );
    expect(Number(after.rows[0]!.n)).toBeGreaterThan(Number(before.rows[0]!.n));
    expect(after.rows[0]!.actor).toBe(ids.adminA);
  });

  it("10. unauthorized function execution fails (install secret)", async () => {
    await asRuntime(async (c) => {
      await expect(
        c.query(`SELECT public.auth_install_session_hmac_secret('x', $1)`, [
          LOCAL_SESSION_MINT_HMAC_KEY,
        ]),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it("11. temporary-table shadowing fails for mint", async () => {
    // figbloom_app cannot CREATE TEMP; exercise shadowing as migrator then SET ROLE.
    const c = await ctx.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        `CREATE TEMP TABLE sessions (
           id uuid, user_id uuid, token_hash text, active_tenant_id uuid,
           active_organization_id uuid, expires_at timestamptz, revoked_at timestamptz,
           user_agent text, ip inet, minted_by text, minted_actor_user_id uuid
         )`,
      );
      await c.query("SET LOCAL ROLE figbloom_app");
      const tokenHash = hashSessionToken("shadow-test");
      const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 3_600_000);
      const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
      const nonce = newProofNonce();
      const payload = buildMintPayload({
        userId: ids.teacherA,
        tokenHash,
        expiresAt,
        issuedAt,
        nonce,
        mintedBy: "login",
        actorUserId: ids.teacherA,
        activeTenantId: null,
        activeOrganizationId: null,
      });
      const mac = signSessionProof(LOCAL_SESSION_MINT_HMAC_KEY, payload);
      const minted = await c.query(
        `SELECT id, user_id FROM public.auth_mint_session(
           $1::uuid, $2::text, $3::timestamptz, NULL, NULL, NULL, NULL,
           'login', $1::uuid, $4::timestamptz, $5::text, $6::text
         )`,
        [
          ids.teacherA,
          tokenHash,
          proofTimestampUtc(expiresAt),
          proofTimestampUtc(issuedAt),
          nonce,
          mac,
        ],
      );
      expect(minted.rowCount).toBe(1);
      const real = await c.query(
        `SELECT 1 FROM public.sessions WHERE id = $1 AND user_id = $2`,
        [minted.rows[0]!.id, ids.teacherA],
      );
      expect(real.rowCount).toBe(1);
      // Drop role so we can inspect the migrator-owned temp shadow table.
      await c.query("RESET ROLE");
      const temp = await c.query(`SELECT 1 FROM pg_temp.sessions WHERE id = $1`, [
        minted.rows[0]!.id,
      ]);
      expect(temp.rowCount).toBe(0);
      await c.query("ROLLBACK");
    } catch (err) {
      try {
        await c.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    } finally {
      c.release();
    }
  });

  it("12. existing legitimate session flows still work", async () => {
    const login = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email: "admin-a@example.com", password: "correct-horse-battery" },
    });
    expect(login.statusCode).toBe(200);
    const token = login.json().token as string;
    const me = await ctx.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    const select = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/select-tenant",
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantId: ids.tenantA },
    });
    expect(select.statusCode).toBe(200);
    const logout = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logout.statusCode).toBe(200);
  });
});
