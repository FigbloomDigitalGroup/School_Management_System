import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import {
  createAnnouncement,
  getAnnouncement,
  listAnnouncementDeliveries,
  listAnnouncements,
  listVisiblePublished,
  markRead,
  publishAnnouncement,
  type AnnouncementChannel,
} from "../../modules/communications/announcements.js";
import { notFound } from "../errors.js";
import { assertUuid, inTenant, pageFrom } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

const Audience = z.record(z.string(), z.unknown());
const Channels = z.array(z.enum(["in_app", "push", "sms", "email"])).min(1);

const CreateBody = z.strictObject({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
  audience: Audience.default({ kind: "whole_school" }),
  channels: Channels.default(["in_app", "push"]),
});

export const COMMUNICATIONS_REQUEST_SCHEMAS = {
  "POST /v1/tenants/{tenantId}/communications/announcements": CreateBody,
} as const;

const P = "/v1/tenants/:tenantId/communications";

export async function registerCommunicationsRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.post(`${P}/announcements`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(CreateBody, request.body, "subject and body are required");
    const announcement = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.announcement.write", { ip, deferAudit: true });
      return createAnnouncement(tx, {
        tenantId: params.tenantId,
        authorId: auth.user.id,
        subject: body.subject,
        body: body.body,
        audience: body.audience,
        channels: body.channels as AnnouncementChannel[],
      });
    });
    return reply.status(201).send({ announcement });
  });

  app.get(`${P}/announcements`, async (request) => {
    const params = request.params as { tenantId: string };
    const q = request.query as { published?: string };
    const page = pageFrom(request);
    const publishedOnly = q.published === "true" || q.published === "1";
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.announcement.read", { ip, deferAudit: true });
      return listAnnouncements(tx, {
        tenantId: params.tenantId,
        publishedOnly,
        limit: page.limit,
        rawCursor: page.rawCursor,
      });
    });
  });

  app.get(`${P}/announcements/inbox`, async (request) => {
    const params = request.params as { tenantId: string };
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth }) => {
      // Authenticated school members may read announcements addressed to them without composer rights.
      return listVisiblePublished(tx, {
        tenantId: params.tenantId,
        userId: auth.user.id,
        limit: page.limit,
        rawCursor: page.rawCursor,
      });
    });
  });

  app.get(`${P}/announcements/:announcementId`, async (request) => {
    const params = request.params as { tenantId: string; announcementId: string };
    assertUuid(params.announcementId, "announcementId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.announcement.read", { ip, deferAudit: true });
      const announcement = await getAnnouncement(tx, params.tenantId, params.announcementId);
      if (!announcement) throw notFound("Announcement not found");
      const deliveries = await listAnnouncementDeliveries(tx, params.tenantId, params.announcementId);
      return { announcement, deliveries };
    });
  });

  app.post(`${P}/announcements/:announcementId/publish`, async (request) => {
    const params = request.params as { tenantId: string; announcementId: string };
    assertUuid(params.announcementId, "announcementId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.announcement.write", { ip, deferAudit: true });
      const announcement = await publishAnnouncement(tx, {
        tenantId: params.tenantId,
        announcementId: params.announcementId,
        actorUserId: auth.user.id,
      });
      return { announcement };
    });
  });

  app.post(`${P}/announcements/:announcementId/read`, async (request, reply) => {
    const params = request.params as { tenantId: string; announcementId: string };
    assertUuid(params.announcementId, "announcementId");
    await inTenant(app, pool, request, params.tenantId, async ({ tx, auth }) => {
      await markRead(tx, {
        tenantId: params.tenantId,
        announcementId: params.announcementId,
        userId: auth.user.id,
      });
    });
    return reply.status(204).send();
  });
}
