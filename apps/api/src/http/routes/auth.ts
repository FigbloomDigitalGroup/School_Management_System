import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loginEmailString, uuidString } from "../schemas.js";
import type { AppConfig } from "../../config.js";
import type { AppPool } from "../../db/pool.js";
import { withIdentityAccess, withIdentityUserScope } from "../../db/identityAccess.js";
import { AppError } from "../errors.js";
import { requireSessionAuth } from "../middleware/authContext.js";
import { buildAuthzContext } from "../../modules/rbac/authorize.js";
import { clientIp } from "../clientIp.js";
import { assertRecentAuth } from "../../modules/auth/reauth.js";
import { challengeMfa, disableTotp, enrollTotp, regenerateRecoveryCodes, verifyAndActivateTotp } from "../../modules/auth/mfa.js";
import { guardMfaAttempt, loadMfaState, recordMfaFailure } from "../../modules/auth/mfaPolicy.js";
import type { IdentityDb } from "../../db/sql.js";
import {
  changePassword,
  loginWithEmail,
  loginWithLoginId,
  logout,
  selectTenant,
} from "../../modules/auth/service.js";
import {
  AUTH_ME_MEMBERSHIP_HARD_CAP,
  listMembershipsForUser,
} from "../../modules/tenancy/context.js";
import { assertPasswordChangeNotRequired } from "../middleware/authContext.js";
import { parseOrThrow } from "../validation.js";
import { stampReauthenticated } from "../../modules/auth/reauth.js";
import { verifyReauthPassword } from "../../modules/auth/service.js";
import { conflict } from "../errors.js";

// Bounded inputs: nothing oversized reaches the rate limiter, the DB or scrypt (AUD-13).
const EmailLoginSchema = z.object({
  email: loginEmailString,
  password: z.string().min(1).max(256),
});

const LoginIdSchema = z.object({
  tenantId: uuidString,
  loginId: z.string().min(1).max(32),
  password: z.string().min(1).max(256),
});

const SelectTenantSchema = z.object({
  tenantId: uuidString,
});

const ReauthSchema = z.strictObject({ password: z.string().min(1).max(256) });

const MfaTotpCodeBody = z.strictObject({ code: z.string().regex(/^\d{6}$/) });
const MfaChallengeBody = z.strictObject({
  code: z.string().regex(/^\d{6}$/).optional(),
  recovery_code: z.string().min(6).max(64).optional(),
});
const MfaAdminResetBody = z.strictObject({
  user_id: uuidString,
  reason: z.string().min(5).max(500),
});

export const MFA_REQUEST_SCHEMAS = {
  "POST /v1/auth/mfa/totp/verify": MfaTotpCodeBody,
  "POST /v1/auth/mfa/challenge": MfaChallengeBody,
  "POST /v1/auth/mfa/recovery-codes/regenerate": MfaTotpCodeBody,
  "POST /v1/auth/mfa/admin-reset": MfaAdminResetBody,
  "POST /v1/auth/mfa/disable": MfaTotpCodeBody,
} as const;

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});

export async function registerAuthRoutes(
  app: FastifyInstance,
  pool: AppPool,
  config: AppConfig,
): Promise<void> {
  app.post("/v1/auth/login/email", async (request, reply) => {
    const parsed = parseOrThrow(EmailLoginSchema, request.body, "Invalid email login payload");
    const result = await loginWithEmail(pool, config, {
      ...parsed,
      ip: clientIp(request),
      userAgent: request.headers["user-agent"] ?? null,
    });
    return reply.send({
      token: result.token,
      expiresAt: result.session.expires_at,
      user: result.user,
      activeTenantId: result.session.active_tenant_id,
    });
  });

  app.post("/v1/auth/login/login-id", async (request, reply) => {
    const parsed = parseOrThrow(LoginIdSchema, request.body, "Invalid login-id payload");
    const result = await loginWithLoginId(pool, config, {
      ...parsed,
      ip: clientIp(request),
      userAgent: request.headers["user-agent"] ?? null,
    });
    return reply.send({
      token: result.token,
      expiresAt: result.session.expires_at,
      user: result.user,
      activeTenantId: result.session.active_tenant_id,
    });
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    await withIdentityAccess(
      pool,
      async (db) => {
        const auth = await requireSessionAuth(db, request);
        await logout(db, config, auth.session, clientIp(request));
      },
      { acquireTimeoutMs: config.poolAcquireTimeoutMs },
    );
    return reply.send({ ok: true });
  });

  app.get("/v1/auth/me", async (request) => {
    const auth = await withIdentityAccess(
      pool,
      (db) => requireSessionAuth(db, request),
      { acquireTimeoutMs: config.poolAcquireTimeoutMs },
    );
    const memberships = await withIdentityUserScope(
      pool,
      auth.user.id,
      (db) => listMembershipsForUser(db, auth.user.id),
      { acquireTimeoutMs: config.poolAcquireTimeoutMs },
    );
    // FIG-1621 / N-4: never silently omit authorised memberships. Return the full
    // ordered set up to AUTH_ME_MEMBERSHIP_HARD_CAP; overflow is an explicit conflict,
    // not a truncated 200. Tie-breaker is membership id (ORDER BY created_at, id).
    if (memberships.length > AUTH_ME_MEMBERSHIP_HARD_CAP) {
      throw conflict(
        `Membership count exceeds the supported /auth/me bound of ${AUTH_ME_MEMBERSHIP_HARD_CAP}`,
      );
    }
    // Authorization context is best-effort here: if the session's school is no
    // longer usable (membership archived, school suspended) the caller still
    // learns who they are and what they can switch to (AUD-06).
    let authz: Awaited<ReturnType<typeof buildAuthzContext>> | null = null;
    try {
      authz = await withIdentityUserScope(
        pool,
        auth.user.id,
        (db) =>
          buildAuthzContext(db, {
            userId: auth.user.id,
            tenantId: auth.session.active_tenant_id,
          }),
        { acquireTimeoutMs: config.poolAcquireTimeoutMs },
      );
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
    }
    return {
      user: auth.user,
      session: {
        id: auth.session.id,
        activeTenantId: authz?.tenantId ?? null,
        expiresAt: auth.session.expires_at,
      },
      memberships: memberships.map((m) => ({
        tenantId: m.tenant_id,
        role: m.role,
        loginId: m.login_id,
        tenantStatus: m.tenant_status,
      })),
      membershipsComplete: true,
      authz: authz
        ? { role: authz.role, tenantId: authz.tenantId, isSuperAdmin: authz.isSuperAdmin }
        : null,
    };
  });

  app.post("/v1/auth/select-tenant", async (request, reply) => {
    const auth = await withIdentityAccess(
      pool,
      (db) => requireSessionAuth(db, request),
      { acquireTimeoutMs: config.poolAcquireTimeoutMs },
    );
    assertPasswordChangeNotRequired(auth.user, request);
    const parsed = parseOrThrow(SelectTenantSchema, request.body, "tenantId is required");
    const session = await selectTenant(
      pool,
      config,
      auth.session,
      parsed.tenantId,
      clientIp(request),
    );
    return reply.send({
      activeTenantId: session.active_tenant_id,
      activeOrganizationId: session.active_organization_id,
    });
  });

  // Sensitive-action re-authentication (migration 077): confirm the password to open a short window in which administrator
  // resets, deactivation, financial and unmatched-callback resolutions and similar actions are accepted.
  app.post("/v1/auth/reauth", async (request) => {
    const auth = await withIdentityAccess(pool, (db) => requireSessionAuth(db, request), { acquireTimeoutMs: config.poolAcquireTimeoutMs });
    const parsed = parseOrThrow(ReauthSchema, request.body, "password is required");
    await withIdentityAccess(
      pool,
      (db) => verifyReauthPassword(db, config, { userId: auth.user.id, password: parsed.password, ip: clientIp(request) }),
      { acquireTimeoutMs: config.poolAcquireTimeoutMs },
    );
    await withIdentityUserScope(pool, auth.user.id, (db) => stampReauthenticated(db, auth.session.id), { acquireTimeoutMs: config.poolAcquireTimeoutMs });
    return { ok: true, valid_for_seconds: config.sensitiveReauthWindowSeconds };
  });

  app.post("/v1/auth/password/change", async (request, reply) => {
    const auth = await withIdentityAccess(
      pool,
      (db) => requireSessionAuth(db, request),
      { acquireTimeoutMs: config.poolAcquireTimeoutMs },
    );
    const parsed = parseOrThrow(
      ChangePasswordSchema,
      request.body,
      "currentPassword and newPassword are required",
    );
    const user = await withIdentityAccess(
      pool,
      (db) =>
        changePassword(db, config, {
          session: auth.session,
          currentPassword: parsed.currentPassword,
          newPassword: parsed.newPassword,
          ip: clientIp(request),
        }),
      { acquireTimeoutMs: config.poolAcquireTimeoutMs },
    );
    return reply.send({
      ok: true,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        must_change_password: user.must_change_password,
        platform_role: user.platform_role,
      },
    });
  });

  /**
   * Run one MFA attempt: throttle first (committed), run the attempt in its own transaction, and on a failed
   * code (401) persist the failure counter and audit event in a separate committed transaction.
   */
  async function mfaAttempt<T>(request: import("fastify").FastifyRequest, userId: string, method: string, fn: (db: IdentityDb) => Promise<T>): Promise<T> {
    await withIdentityUserScope(pool, userId, (db) => guardMfaAttempt(db, config, userId), { acquireTimeoutMs: config.poolAcquireTimeoutMs });
    try {
      return await withIdentityUserScope(pool, userId, fn, { acquireTimeoutMs: config.poolAcquireTimeoutMs });
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 401) {
        await withIdentityUserScope(pool, userId, (db) => recordMfaFailure(db, userId, method, clientIp(request)), { acquireTimeoutMs: config.poolAcquireTimeoutMs });
      }
      throw err;
    }
  }

  app.get("/v1/auth/mfa/status", async (request) => {
    const auth = await withIdentityAccess(pool, (db) => requireSessionAuth(db, request), { acquireTimeoutMs: config.poolAcquireTimeoutMs });
    const state = await withIdentityAccess(pool, (db) => loadMfaState(db, config, auth.session.id, auth.user.id), { acquireTimeoutMs: config.poolAcquireTimeoutMs });
    return { ...state, enforcement: config.mfaEnforcement, next: state.required && !state.assured ? (state.enrolled ? "challenge" : "enroll") : "none" };
  });

  app.post("/v1/auth/mfa/recovery-codes/regenerate", async (request) => {
    const auth = await withIdentityAccess(pool, (db) => requireSessionAuth(db, request), { acquireTimeoutMs: config.poolAcquireTimeoutMs });
    const body = parseOrThrow(z.strictObject({ code: z.string().regex(/^\d{6}$/) }), request.body, "6-digit TOTP code is required");
    return mfaAttempt(request, auth.user.id, "totp", async (db) => {
      await assertRecentAuth(db, config, auth.session.id);
      return regenerateRecoveryCodes(db, config, { userId: auth.user.id, code: body.code, ip: clientIp(request) });
    });
  });

  app.post("/v1/auth/mfa/admin-reset", async (request) => {
    const auth = await withIdentityAccess(pool, (db) => requireSessionAuth(db, request), { acquireTimeoutMs: config.poolAcquireTimeoutMs });
    const body = parseOrThrow(z.strictObject({ user_id: uuidString, reason: z.string().min(5).max(500) }), request.body, "user_id and reason are required");
    return withIdentityUserScope(
      pool,
      auth.user.id,
      async (db) => {
        await assertRecentAuth(db, config, auth.session.id);
        try {
          const r = await db.query<{ n: number }>(`SELECT public.mfa_admin_reset($1::uuid, $2::text) AS n`, [body.user_id, body.reason]);
          return { reset: true, factorsDisabled: r.rows[0]!.n };
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === "42501") throw new AppError(403, "forbidden", "Not authorised to reset this account");
          if (code === "22023") throw new AppError(400, "validation_error", "A reason of 5-500 characters is required");
          throw err;
        }
      },
      { acquireTimeoutMs: config.poolAcquireTimeoutMs },
    );
  });

  app.post("/v1/auth/mfa/totp/enroll", async (request) => {
    const auth = await withIdentityAccess(
      pool,
      (db) => requireSessionAuth(db, request),
      { acquireTimeoutMs: config.poolAcquireTimeoutMs },
    );
    // Enrolment mints a secret and eight Argon2id-hashed recovery codes: it needs a recently confirmed password (a
    // stolen bearer token alone must not claim a privileged account's factor) and shares the MFA throttle.
    await withIdentityUserScope(pool, auth.user.id, (db) => guardMfaAttempt(db, config, auth.user.id, "enroll"), { acquireTimeoutMs: config.poolAcquireTimeoutMs });
    return withIdentityUserScope(
      pool,
      auth.user.id,
      async (db) => {
        await assertRecentAuth(db, config, auth.session.id);
        return enrollTotp(db, config, {
          userId: auth.user.id,
          accountLabel: auth.user.email ?? auth.user.id,
          ip: clientIp(request),
        });
      },
      { acquireTimeoutMs: config.poolAcquireTimeoutMs },
    );
  });

  app.post("/v1/auth/mfa/totp/verify", async (request) => {
    const auth = await withIdentityAccess(
      pool,
      (db) => requireSessionAuth(db, request),
      { acquireTimeoutMs: config.poolAcquireTimeoutMs },
    );
    const body = parseOrThrow(
      z.strictObject({ code: z.string().regex(/^\d{6}$/) }),
      request.body,
      "6-digit TOTP code is required",
    );
    return mfaAttempt(request, auth.user.id, "totp", (db) =>
      verifyAndActivateTotp(db, config, {
        userId: auth.user.id,
        sessionId: auth.session.id,
        code: body.code,
        ip: clientIp(request),
      }),
    );
  });

  app.post("/v1/auth/mfa/challenge", async (request) => {
    const auth = await withIdentityAccess(
      pool,
      (db) => requireSessionAuth(db, request),
      { acquireTimeoutMs: config.poolAcquireTimeoutMs },
    );
    const body = parseOrThrow(
      z.strictObject({
        code: z.string().regex(/^\d{6}$/).optional(),
        recovery_code: z.string().min(6).max(64).optional(),
      }),
      request.body,
      "code or recovery_code is required",
    );
    return mfaAttempt(request, auth.user.id, body.code ? "totp" : "recovery_code", (db) =>
      challengeMfa(db, config, {
        userId: auth.user.id,
        sessionId: auth.session.id,
        code: body.code,
        recoveryCode: body.recovery_code,
        ip: clientIp(request),
      }),
    );
  });

  app.post("/v1/auth/mfa/disable", async (request) => {
    const auth = await withIdentityAccess(
      pool,
      (db) => requireSessionAuth(db, request),
      { acquireTimeoutMs: config.poolAcquireTimeoutMs },
    );
    const body = parseOrThrow(
      z.strictObject({ code: z.string().regex(/^\d{6}$/) }),
      request.body,
      "6-digit TOTP code is required",
    );
    return mfaAttempt(request, auth.user.id, "totp", async (db) => {
      await assertRecentAuth(db, config, auth.session.id);
      return disableTotp(db, config, {
        userId: auth.user.id,
        code: body.code,
        ip: clientIp(request),
      });
    });
  });
}
