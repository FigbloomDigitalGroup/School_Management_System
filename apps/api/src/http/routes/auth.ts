import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/pool.js";
import { validationError } from "../errors.js";
import { requireSessionAuth } from "../middleware/authContext.js";
import { buildAuthzContext } from "../../modules/rbac/authorize.js";
import { AppError } from "../errors.js";
import { clientIp } from "../clientIp.js";
import {
  changePassword,
  loginWithEmail,
  loginWithLoginId,
  logout,
  selectTenant,
} from "../../modules/auth/service.js";
import { listMembershipsForUser } from "../../modules/tenancy/context.js";
import { assertPasswordChangeNotRequired } from "../middleware/authContext.js";

// Bounded inputs: nothing oversized reaches the rate limiter, the DB or scrypt (AUD-13).
const EmailLoginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
});

const LoginIdSchema = z.object({
  tenantId: z.string().uuid(),
  loginId: z.string().min(1).max(32),
  password: z.string().min(1).max(256),
});

const SelectTenantSchema = z.object({
  tenantId: z.string().uuid(),
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});

export async function registerAuthRoutes(
  app: FastifyInstance,
  db: Db,
  config: AppConfig,
): Promise<void> {
  app.post("/v1/auth/login/email", async (request, reply) => {
    const parsed = EmailLoginSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("Invalid email login payload");
    const result = await loginWithEmail(db, config, {
      ...parsed.data,
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
    const parsed = LoginIdSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("Invalid login-id payload");
    const result = await loginWithLoginId(db, config, {
      ...parsed.data,
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
    const auth = await requireSessionAuth(db, request);
    await logout(
      db,
      auth.session,
      clientIp(request),
    );
    return reply.send({ ok: true });
  });

  app.get("/v1/auth/me", async (request) => {
    const auth = await requireSessionAuth(db, request);
    const memberships = await listMembershipsForUser(db, auth.user.id);
    // Authorization context is best-effort here: if the session's school is no
    // longer usable (membership archived, school suspended) the caller still
    // learns who they are and what they can switch to (AUD-06).
    let authz: Awaited<ReturnType<typeof buildAuthzContext>> | null = null;
    try {
      authz = await buildAuthzContext(db, {
        userId: auth.user.id,
        tenantId: auth.session.active_tenant_id,
      });
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
      authz: authz
        ? { role: authz.role, tenantId: authz.tenantId, isSuperAdmin: authz.isSuperAdmin }
        : null,
    };
  });

  app.post("/v1/auth/select-tenant", async (request, reply) => {
    const auth = await requireSessionAuth(db, request);
    assertPasswordChangeNotRequired(auth.user, request);
    const parsed = SelectTenantSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("tenantId is required");
    const session = await selectTenant(
      db,
      auth.session,
      parsed.data.tenantId,
      clientIp(request),
    );
    return reply.send({
      activeTenantId: session.active_tenant_id,
      activeOrganizationId: session.active_organization_id,
    });
  });

  app.post("/v1/auth/password/change", async (request, reply) => {
    const auth = await requireSessionAuth(db, request);
    const parsed = ChangePasswordSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("currentPassword and newPassword are required");
    const user = await changePassword(db, config, {
      session: auth.session,
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.newPassword,
      ip: clientIp(request),
    });
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
