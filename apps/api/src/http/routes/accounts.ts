import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { withIdentityAccess, withIdentityUserScope } from "../../db/identityAccess.js";
import { consumeAuthToken } from "../../modules/auth/rateLimit.js";
import { rateLimitBucketForIp } from "../../modules/auth/rateLimitBuckets.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import {
  acceptInvitation,
  adminIssueReset,
  completePasswordReset,
  createInvitation,
  deactivateMembership,
  provisionSchool,
  requestPasswordReset,
  revokeInvitation,
} from "../../modules/account/service.js";
import { assertRecentAuth } from "../../modules/auth/reauth.js";
import { getAccountNotifier } from "../../modules/account/notifier.js";
import { clientIp } from "../clientIp.js";
import { forbidden, notFound, unauthorized } from "../errors.js";
import { requireSessionAuth } from "../middleware/authContext.js";
import { assertUuid, inTenant } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

/**
 * Account lifecycle (acceptance programme 6.1): school provisioning (super administrator), staff invitations, invitation
 * acceptance, password recovery, administrator-issued resets and membership deactivation. There is NO public account creation:
 * every account is created by accepting an invitation issued by an authorised person. Tokens are returned ONCE, only to the
 * authorised issuer and only when no delivery provider is configured; they are never logged (the access log carries no bodies).
 */
const Email = z.string().min(3).max(254);
const Role = z.enum(["school_admin", "teacher", "staff", "driver"]);
const ProvisionBody = z.strictObject({
  organization_id: z.guid().optional(),
  organization_name: z.string().min(2).max(160).optional(),
  school_name: z.string().min(2).max(160),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,35}$/),
  admin_email: Email,
  admin_name: z.string().min(1).max(160).optional(),
});
const InviteBody = z.strictObject({ email: Email, role: Role, full_name: z.string().min(1).max(160).optional() });
const AcceptBody = z.strictObject({ token: z.string().min(20).max(200), password: z.string().min(1).max(256), full_name: z.string().min(1).max(160).optional() });
const ResetRequestBody = z.strictObject({ email: Email });
const ResetCompleteBody = z.strictObject({ token: z.string().min(20).max(200), password: z.string().min(1).max(256) });

export const ACCOUNT_REQUEST_SCHEMAS = {
  "POST /v1/platform/schools": ProvisionBody,
  "POST /v1/tenants/{tenantId}/invitations": InviteBody,
  "POST /v1/invitations/accept": AcceptBody,
  "POST /v1/auth/password-reset/request": ResetRequestBody,
  "POST /v1/auth/password-reset/complete": ResetCompleteBody,
} as const;

export async function registerAccountRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  const config = () => app.appConfig;
  const opts = () => ({ acquireTimeoutMs: config().poolAcquireTimeoutMs });

  app.post("/v1/platform/schools", async (request, reply) => {
    const body = parseOrThrow(ProvisionBody, request.body, "invalid school details");
    const out = await withIdentityAccess(pool, async (db) => {
      const { user, session } = await requireSessionAuth(db, request);
      return Object.assign({}, user, { sessionId: session.id });
    }, opts());
    const created = await withIdentityUserScope(
      pool,
      out.id,
      async (db) => {
        await assertRecentAuth(db, config(), out.sessionId);
        return provisionSchool(db, {
          organizationId: body.organization_id ?? null,
          organizationName: body.organization_name ?? null,
          schoolName: body.school_name,
          slug: body.slug,
          adminEmail: body.admin_email,
          adminName: body.admin_name ?? null,
        });
      },
      opts(),
    );
    const delivery = await getAccountNotifier().send({ kind: "invitation", email: body.admin_email.toLowerCase(), token: created.token, tenantId: created.tenantId });
    return reply.status(201).send({
      school: { tenant_id: created.tenantId, organization_id: created.organizationId },
      invitation: { id: created.invitationId, role: "school_admin", expires_at: created.expiresAt.toISOString(), delivery, ...(delivery === "not_configured" ? { token: created.token } : {}) },
    });
  });

  app.post("/v1/tenants/:tenantId/invitations", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(InviteBody, request.body, "email and role are required");
    const created = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "identity.accounts.manage", { ip, deferAudit: true });
      if (body.role === "school_admin") await assertRecentAuth(tx, app.appConfig, auth.session.id);
      return createInvitation(tx, { tenantId: params.tenantId, email: body.email, role: body.role, fullName: body.full_name ?? null });
    });
    const delivery = await getAccountNotifier().send({ kind: "invitation", email: body.email.toLowerCase(), token: created.token, tenantId: params.tenantId });
    return reply.status(201).send({
      invitation: { id: created.invitationId, role: body.role, expires_at: created.expiresAt.toISOString(), delivery, ...(delivery === "not_configured" ? { token: created.token } : {}) },
    });
  });

  app.post("/v1/tenants/:tenantId/invitations/:invitationId/revoke", async (request) => {
    const params = request.params as { tenantId: string; invitationId: string };
    assertUuid(params.invitationId, "invitationId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "identity.accounts.manage", { ip, deferAudit: true });
      await revokeInvitation(tx, { tenantId: params.tenantId, invitationId: params.invitationId });
      return { revoked: true };
    });
  });

  // Public. A NEW person sets a password; an EXISTING account must send its own bearer token (login_required otherwise).
  app.post("/v1/invitations/accept", async (request) => {
    const body = parseOrThrow(AcceptBody, request.body, "token and password are required");
    const ip = clientIp(request);
    return withIdentityAccess(
      pool,
      async (db) => {
        await consumeAuthToken(db, config(), rateLimitBucketForIp("invite_accept:ip", ip));
        let sessionUserId: string | null = null;
        if (request.headers.authorization) {
          try {
            sessionUserId = (await requireSessionAuth(db, request)).user.id;
          } catch {
            sessionUserId = null;
          }
        }
        const r = await acceptInvitation(db, { token: body.token, password: body.password, fullName: body.full_name ?? null, sessionUserId });
        if (r.outcome === "login_required") throw unauthorized("Sign in to the existing account to accept this invitation");
        return { status: "accepted", tenant_id: r.tenantId };
      },
      opts(),
    );
  });

  // Public, enumeration-safe: always 202 with the same body; per-IP and per-address rate limits.
  app.post("/v1/auth/password-reset/request", async (request, reply) => {
    const body = parseOrThrow(ResetRequestBody, request.body, "email is required");
    const ip = clientIp(request);
    const issued = await withIdentityAccess(
      pool,
      async (db) => {
        await consumeAuthToken(db, config(), rateLimitBucketForIp("reset_request:ip", ip));
        await consumeAuthToken(db, config(), `reset_request:email:${body.email.trim().toLowerCase()}`);
        return requestPasswordReset(db, body.email);
      },
      opts(),
    );
    if (issued) await getAccountNotifier().send({ kind: "password_reset", email: issued.email, token: issued.token });
    return reply.status(202).send({ status: "accepted" });
  });

  app.post("/v1/auth/password-reset/complete", async (request) => {
    const body = parseOrThrow(ResetCompleteBody, request.body, "token and password are required");
    const ip = clientIp(request);
    await withIdentityAccess(
      pool,
      async (db) => {
        await consumeAuthToken(db, config(), rateLimitBucketForIp("reset_complete:ip", ip));
        await completePasswordReset(db, { token: body.token, password: body.password });
      },
      opts(),
    );
    return { status: "ok" };
  });

  app.post("/v1/tenants/:tenantId/members/:userId/password-reset", async (request, reply) => {
    const params = request.params as { tenantId: string; userId: string };
    assertUuid(params.userId, "userId");
    const issued = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "identity.accounts.manage", { ip, deferAudit: true });
      await assertRecentAuth(tx, app.appConfig, auth.session.id);
      return adminIssueReset(tx, { tenantId: params.tenantId, userId: params.userId });
    });
    if (!issued) throw notFound("Member not found");
    return reply.status(201).send({ reset: { expires_at: issued.expiresAt.toISOString(), delivery: "not_configured", token: issued.token } });
  });

  app.post("/v1/tenants/:tenantId/members/:userId/deactivate", async (request) => {
    const params = request.params as { tenantId: string; userId: string };
    assertUuid(params.userId, "userId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "identity.accounts.manage", { ip, deferAudit: true });
      await assertRecentAuth(tx, app.appConfig, auth.session.id);
      const ok = await deactivateMembership(tx, { tenantId: params.tenantId, userId: params.userId });
      if (!ok) throw notFound("Active member not found");
      return { deactivated: true };
    });
  });
}

void forbidden;
