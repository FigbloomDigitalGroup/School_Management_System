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
}
