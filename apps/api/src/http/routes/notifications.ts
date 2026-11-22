import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import {
  getNotificationOutboxDetail,
  getUnreadNotificationCount,
  listMyNotifications,
  listNotificationOutbox,
  markAllNotificationsRead,
  markNotificationRead,
  sendAdminNotification,
  type NotificationCategory,
} from "../../modules/notifications/service.js";
import { validationError } from "../errors.js";
import { assertUuid, inTenant, pageFrom } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

const CATEGORIES = ["transport", "medication", "finance", "attendance", "academics", "announcement", "general"] as const;
const CHANNELS = ["in_app", "push", "sms", "email"] as const;

const ReadAllBody = z.strictObject({
  category: z.enum(CATEGORIES).optional(),
});

const AdminSendBody = z.strictObject({
  category: z.enum(CATEGORIES),
  recipient_user_ids: z.array(z.guid()).min(1).max(500),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  channels: z.array(z.enum(CHANNELS)).min(1).max(4).optional(),
  idempotency_key: z.string().min(1).max(200),
});

export const NOTIFICATION_REQUEST_SCHEMAS = {
  "POST /v1/tenants/{tenantId}/notifications/read-all": ReadAllBody,
  "POST /v1/tenants/{tenantId}/notifications/outbox": AdminSendBody,
} as const;

const P = "/v1/tenants/:tenantId/notifications";

export async function registerNotificationRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.get(P, async (request) => {
    const params = request.params as { tenantId: string };
    const q = request.query as { unread_only?: string; category?: string };
    let category: NotificationCategory | undefined;
    if (q.category !== undefined && q.category !== "") {
      if (!(CATEGORIES as readonly string[]).includes(q.category)) {
        throw validationError("Invalid notification category");
      }
      category = q.category as NotificationCategory;
    }
    const unreadOnly = q.unread_only === "true";
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth }) => {
      return listMyNotifications(tx, {
        tenantId: params.tenantId,
        userId: auth.user.id,
        unreadOnly,
        category,
        limit: page.limit,
        rawCursor: page.rawCursor,
      });
    });
  });

  app.get(`${P}/unread-count`, async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth }) => {
      const unread_count = await getUnreadNotificationCount(tx, params.tenantId, auth.user.id);
      return { unread_count };
    });
  });

  app.post(`${P}/:notificationId/read`, async (request) => {
    const params = request.params as { tenantId: string; notificationId: string };
    assertUuid(params.notificationId, "notificationId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth }) => {
      const notification = await markNotificationRead(tx, {
        tenantId: params.tenantId,
        userId: auth.user.id,
        notificationId: params.notificationId,
      });
      return { notification };
    });
  });

  app.post(`${P}/read-all`, async (request) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(ReadAllBody, request.body ?? {}, "invalid body");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth }) => {
      const marked_count = await markAllNotificationsRead(tx, {
        tenantId: params.tenantId,
        userId: auth.user.id,
        category: body.category,
      });
      return { marked_count };
    });
  });

  app.post(`${P}/outbox`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.notifications.admin", { ip, deferAudit: true });
      const body = parseOrThrow(AdminSendBody, request.body, "category, recipient_user_ids, title, body and idempotency_key are required");
      return sendAdminNotification(tx, {
        tenantId: params.tenantId,
        actorUserId: auth.user.id,
        category: body.category,
        recipientUserIds: body.recipient_user_ids,
        title: body.title,
        body: body.body,
        channels: body.channels,
        idempotencyKey: body.idempotency_key,
        ip,
      });
    });
    return reply.status(out.created ? 201 : 200).send({ outbox_id: out.outboxId, created: out.created });
  });

  app.get(`${P}/outbox`, async (request) => {
    const params = request.params as { tenantId: string };
    const q = request.query as { status?: string; category?: string };
    if (q.status !== undefined && !["queued", "processing", "completed", "partial", "failed", "dead"].includes(q.status)) {
      throw validationError("Invalid outbox status");
    }
    if (q.category !== undefined && !(CATEGORIES as readonly string[]).includes(q.category)) {
      throw validationError("Invalid outbox category");
    }
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.notifications.admin", { ip, deferAudit: true });
      return listNotificationOutbox(tx, {
        tenantId: params.tenantId,
        status: q.status,
        category: q.category,
        limit: page.limit,
        rawCursor: page.rawCursor,
      });
    });
  });

  app.get(`${P}/outbox/:outboxId`, async (request) => {
    const params = request.params as { tenantId: string; outboxId: string };
    assertUuid(params.outboxId, "outboxId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.notifications.admin", { ip, deferAudit: true });
      return getNotificationOutboxDetail(tx, params.tenantId, params.outboxId);
    });
  });
}
