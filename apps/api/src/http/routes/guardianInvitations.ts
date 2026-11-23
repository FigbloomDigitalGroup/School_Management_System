import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { withIdentityAccess, withIdentityUserScope } from "../../db/identityAccess.js";
import { consumeAuthToken } from "../../modules/auth/rateLimit.js";
import { rateLimitBucketForIp } from "../../modules/auth/rateLimitBuckets.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import {
  acceptGuardianInvitation,
  createGuardianInvitation,
  listGuardianInvitations,
  myGuardianLinks,
  previewGuardianInvitation,
  recordGuardianDelivery,
  revokeGuardianAccountLink,
  revokeGuardianInvitation,
} from "../../modules/account/guardianLinking.js";
import { assertRecentAuth } from "../../modules/auth/reauth.js";
import { getAccountNotifier } from "../../modules/account/notifier.js";
import { clientIp } from "../clientIp.js";
import { requireSessionAuth } from "../middleware/authContext.js";
import { assertUuid, inTenant } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

/**
 * Guardian invitation and account linking (migration 073). Invitation-based ONLY: nothing links a login to a guardian record
 * because a phone number, e-mail or name matches. School administrators (identity.accounts.manage) issue invitations; the
 * invited person proves the token and the invited contact and explicitly confirms the relationship.
 */
const Token = z.string().min(20).max(200);
const CreateBody = z.strictObject({ learner_id: z.guid(), method: z.enum(["email", "sms"]) });
const PreviewBody = z.strictObject({ token: Token });
const AcceptBody = z.strictObject({
  token: Token,
  contact: z.string().min(3).max(254),
  confirm: z.boolean(),
  password: z.string().min(1).max(256).optional(),
  full_name: z.string().min(1).max(160).optional(),
});
const UnlinkBody = z.strictObject({ reason: z.string().min(3).max(300) });
const ListQuery = z.strictObject({
  status: z.enum(["pending", "accepted", "revoked", "expired", "superseded"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const GUARDIAN_INVITATION_REQUEST_SCHEMAS = {
  "POST /v1/tenants/{tenantId}/guardians/{guardianId}/invitations": CreateBody,
  "POST /v1/guardian-invitations/preview": PreviewBody,
  "POST /v1/guardian-invitations/accept": AcceptBody,
  "POST /v1/tenants/{tenantId}/guardians/{guardianId}/account-link/revoke": UnlinkBody,
} as const;

export async function registerGuardianInvitationRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  const config = () => app.appConfig;
  const opts = () => ({ acquireTimeoutMs: config().poolAcquireTimeoutMs });

  app.post("/v1/tenants/:tenantId/guardians/:guardianId/invitations", async (request, reply) => {
    const params = request.params as { tenantId: string; guardianId: string };
    assertUuid(params.guardianId, "guardianId");
    const body = parseOrThrow(CreateBody, request.body, "learner_id and method are required");
    const created = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "identity.accounts.manage", { ip, deferAudit: true });
      return createGuardianInvitation(tx, { tenantId: params.tenantId, guardianId: params.guardianId, learnerId: body.learner_id, method: body.method });
    });
    let delivery: "sent" | "not_configured" | "failed" = "not_configured";
    try {
      delivery = await getAccountNotifier().send({ kind: "guardian_invitation", email: "", token: created.token, tenantId: params.tenantId });
    } catch {
      delivery = "failed";
    }
    if (delivery !== "not_configured") {
      await inTenant(app, pool, request, params.tenantId, async ({ tx }) =>
        recordGuardianDelivery(tx, { tenantId: params.tenantId, invitationId: created.invitationId, status: delivery }),
      );
    }
    return reply.status(201).send({
      invitation: {
        id: created.invitationId,
        method: body.method,
        expires_at: created.expiresAt.toISOString(),
        delivery,
        ...(delivery !== "sent" ? { token: created.token } : {}),
      },
    });
  });

  app.get("/v1/tenants/:tenantId/guardian-invitations", async (request) => {
    const params = request.params as { tenantId: string };
    const q = parseOrThrow(ListQuery, request.query ?? {}, "invalid filter");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "identity.accounts.manage", { ip, deferAudit: true });
      return { invitations: await listGuardianInvitations(tx, { tenantId: params.tenantId, status: q.status ?? null, limit: q.limit }) };
    });
  });

  app.post("/v1/tenants/:tenantId/guardian-invitations/:invitationId/revoke", async (request) => {
    const params = request.params as { tenantId: string; invitationId: string };
    assertUuid(params.invitationId, "invitationId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "identity.accounts.manage", { ip, deferAudit: true });
      await revokeGuardianInvitation(tx, { tenantId: params.tenantId, invitationId: params.invitationId });
      return { revoked: true };
    });
  });

  app.post("/v1/tenants/:tenantId/guardians/:guardianId/account-link/revoke", async (request) => {
    const params = request.params as { tenantId: string; guardianId: string };
    assertUuid(params.guardianId, "guardianId");
    const body = parseOrThrow(UnlinkBody, request.body, "a reason is required");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "identity.accounts.manage", { ip, deferAudit: true });
      await assertRecentAuth(tx, app.appConfig, auth.session.id);
      await revokeGuardianAccountLink(tx, { tenantId: params.tenantId, guardianId: params.guardianId, reason: body.reason });
      return { revoked: true };
    });
  });

  // Public, rate limited; every failure answers identically.
  app.post("/v1/guardian-invitations/preview", async (request) => {
    const body = parseOrThrow(PreviewBody, request.body, "token is required");
    const ip = clientIp(request);
    return withIdentityAccess(
      pool,
      async (db) => {
        await consumeAuthToken(db, config(), rateLimitBucketForIp("guardian_invite:ip", ip));
        const p = await previewGuardianInvitation(db, body.token);
        return {
          valid: p !== null,
          ...(p ? { school_name: p.school_name, relationship: p.relationship, contact_method: p.contact_method, existing_account: p.existing_account } : {}),
        };
      },
      opts(),
    );
  });

  app.post("/v1/guardian-invitations/accept", async (request) => {
    const body = parseOrThrow(AcceptBody, request.body, "token, contact and confirm are required");
    const ip = clientIp(request);
    return withIdentityAccess(
      pool,
      async (db) => {
        await consumeAuthToken(db, config(), rateLimitBucketForIp("guardian_invite:ip", ip));
        let sessionUserId: string | null = null;
        if (request.headers.authorization) {
          try {
            sessionUserId = (await requireSessionAuth(db, request)).user.id;
          } catch {
            sessionUserId = null;
          }
        }
        const r = await acceptGuardianInvitation(db, {
          token: body.token,
          contact: body.contact,
          confirm: body.confirm,
          password: body.password ?? null,
          fullName: body.full_name ?? null,
          sessionUserId,
        });
        return { status: "accepted", tenant_id: r.tenantId };
      },
      opts(),
    );
  });

  app.get("/v1/me/guardian-links", async (request) => {
    const user = await withIdentityAccess(pool, async (db) => (await requireSessionAuth(db, request)).user, opts());
    const links = await withIdentityUserScope(pool, user.id, (db) => myGuardianLinks(db), opts());
    return { links };
  });
}
