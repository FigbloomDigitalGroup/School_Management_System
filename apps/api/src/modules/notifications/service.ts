import type { Tx, TxOrIdentity } from "../../db/sql.js";
import { notFound, validationError } from "../../http/errors.js";
import type { PageInfo } from "../../http/pagination.js";
import { pageQuery } from "../academics/pagination.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { PermanentJobError, RetryableJobError, type JobContext } from "../../worker/runtime.js";
import { getPushProvider, type PushProvider } from "./pushProvider.js";

export type NotificationCategory =
  | "transport"
  | "medication"
  | "finance"
  | "attendance"
  | "academics"
  | "announcement"
  | "general";

export type NotificationChannel = "in_app" | "push" | "sms" | "email";

export interface OutboxEntry {
  id: string;
  tenant_id: string;
  event_type: string;
  category: NotificationCategory;
  idempotency_key: string;
  recipient_user_ids: string[];
  title: string;
  body: string;
  channels: NotificationChannel[];
  metadata: Record<string, unknown>;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error_code: string | null;
  created_by: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface InAppNotification {
  id: string;
  tenant_id: string;
  outbox_id: string | null;
  recipient_user_id: string;
  category: NotificationCategory;
  event_type: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

export interface DeliveryAttemptRow {
  id: string;
  outbox_id: string;
  notification_id: string | null;
  recipient_user_id: string;
  channel: NotificationChannel;
  provider: string;
  device_token_id: string | null;
  attempt_number: number;
  status: string;
  provider_message_id: string | null;
  error_code: string | null;
  created_at: string;
}

const OUTBOX_COLS = `id, tenant_id, event_type, category, idempotency_key, recipient_user_ids, title, body, channels, metadata, status, attempts, max_attempts, last_error_code, created_by, created_at, processed_at`;
const NOTIF_COLS = `id, tenant_id, outbox_id, recipient_user_id, category, event_type, title, body, metadata, read_at, created_at`;
const ATTEMPT_COLS = `id, outbox_id, notification_id, recipient_user_id, channel, provider, device_token_id, attempt_number, status, provider_message_id, error_code, created_at`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Transactional outbox writer: records a durable notification_outbox row AND enqueues a
 * tenant-isolated `notification.dispatch` job inside the SAME database transaction as the
 * triggering domain mutation. Idempotent on `(tenant_id, idempotency_key)`.
 */
export async function enqueueNotificationEvent(
  tx: Tx,
  input: {
    tenantId: string;
    eventType: string;
    category: NotificationCategory;
    idempotencyKey: string;
    recipientUserIds: string[];
    title: string;
    body: string;
    channels?: NotificationChannel[];
    metadata?: Record<string, unknown>;
    createdBy?: string | null;
    maxAttempts?: number;
  },
): Promise<{ outboxId: string; created: boolean }> {
  const uniqueRecipients = [...new Set(input.recipientUserIds)].filter((id) => UUID_RE.test(id));
  if (uniqueRecipients.length === 0) {
    throw validationError("At least one valid recipient user ID is required");
  }
  const channels = input.channels && input.channels.length > 0 ? [...new Set(input.channels)] : (["in_app", "push"] as NotificationChannel[]);
  const res = await tx.query<{ id: string }>(
    `INSERT INTO notification_outbox (
       tenant_id, event_type, category, idempotency_key, recipient_user_ids,
       title, body, channels, metadata, max_attempts, created_by
     ) VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7, $8::text[], $9::jsonb, $10, $11)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [
      input.tenantId,
      input.eventType.trim(),
      input.category,
      input.idempotencyKey.trim(),
      uniqueRecipients,
      input.title.trim(),
      input.body.trim(),
      channels,
      JSON.stringify(input.metadata ?? {}),
      input.maxAttempts ?? 5,
      input.createdBy ?? null,
    ],
  );
  const inserted = res.rows[0];
  if (!inserted) {
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM notification_outbox WHERE tenant_id = $1 AND idempotency_key = $2`,
      [input.tenantId, input.idempotencyKey.trim()],
    );
    return { outboxId: existing.rows[0]!.id, created: false };
  }

  await tx.query(
    `INSERT INTO jobs (tenant_id, job_type, payload, idempotency_key, enqueued_by_user_id)
     VALUES ($1, 'notification.dispatch', $2::jsonb, $3, $4)
     ON CONFLICT (tenant_id, job_type, idempotency_key) DO NOTHING`,
    [
      input.tenantId,
      JSON.stringify({ outboxId: inserted.id }),
      `notif:${inserted.id}`,
      input.createdBy ?? null,
    ],
  );

  return { outboxId: inserted.id, created: true };
}

function preferenceAllows(
  category: NotificationCategory,
  prefs: {
    fee_reminders: boolean;
    absence_today: boolean;
    results_published: boolean;
    general_notices: boolean;
    chat_messages: boolean;
  },
): boolean {
  // Transport and medication safety/safeguarding alerts cannot be silently muted by general preference flags.
  if (category === "transport" || category === "medication") return true;
  if (category === "finance") return prefs.fee_reminders;
  if (category === "attendance") return prefs.absence_today;
  if (category === "academics") return prefs.results_published;
  if (category === "announcement" || category === "general") return prefs.general_notices;
  return true;
}

/**
 * Worker handler for `notification.dispatch`.
 * Runs under tenant RLS via `ctx.inTenant`; external push calls occur OUTSIDE DB transactions;
 * idempotent across retries and duplicate worker executions.
 */
export async function processNotificationOutboxJob(
  ctx: JobContext,
  overrideProvider?: PushProvider,
): Promise<void> {
  const outboxId = ctx.payload.outboxId;
  if (typeof outboxId !== "string" || !UUID_RE.test(outboxId)) {
    throw new PermanentJobError("invalid_payload");
  }

  const pushProvider = overrideProvider ?? getPushProvider();

  // Step 1: Load outbox, resolve valid tenant recipients, create in-app notifications idempotently,
  // and gather pending push targets (skipping already-delivered devices on retry).
  const plan = await ctx.inTenant(async (tx) => {
    const outboxRes = await tx.query<OutboxEntry>(
      `SELECT ${OUTBOX_COLS} FROM notification_outbox WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, outboxId],
    );
    const outbox = outboxRes.rows[0];
    if (!outbox) throw new PermanentJobError("outbox_not_found");
    if (outbox.status === "completed") return { alreadyDone: true as const };

    await tx.query(
      `UPDATE notification_outbox SET status = 'processing', attempts = $3 WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, outboxId, ctx.attempt],
    );

    const validRes = await tx.query<{
      user_id: string;
      fee_reminders: boolean;
      absence_today: boolean;
      results_published: boolean;
      general_notices: boolean;
      chat_messages: boolean;
    }>(`SELECT * FROM public.notification_worker_resolve_recipients($1::uuid[])`, [outbox.recipient_user_ids]);
    const validMap = new Map(validRes.rows.map((r) => [r.user_id, r]));

    // Previously delivered devices / channels for this outbox (for idempotent retry)
    const priorRes = await tx.query<{
      recipient_user_id: string;
      channel: string;
      device_token_id: string | null;
      status: string;
    }>(
      `SELECT recipient_user_id, channel, device_token_id, status
         FROM notification_delivery_attempts
        WHERE tenant_id = $1 AND outbox_id = $2`,
      [ctx.tenantId, outboxId],
    );
    const alreadyDeliveredKey = new Set(
      priorRes.rows
        .filter((r) => r.status === "delivered" || r.status === "not_configured" || r.status === "skipped_preference" || r.status === "invalid_recipient")
        .map((r) => `${r.recipient_user_id}:${r.channel}:${r.device_token_id ?? ""}`),
    );

    const notifByUser = new Map<string, string>();
    const eligiblePushUsers: string[] = [];
    let anyInvalidRecipient = false;

    for (const uid of outbox.recipient_user_ids) {
      const prefs = validMap.get(uid);
      if (!prefs) {
        anyInvalidRecipient = true;
        const key = `${uid}:in_app:`;
        if (!alreadyDeliveredKey.has(key)) {
          await tx.query(
            `INSERT INTO notification_delivery_attempts (
               tenant_id, outbox_id, recipient_user_id, channel, provider, attempt_number, status, error_code
             ) VALUES ($1, $2, $3, 'in_app', 'internal', $4, 'invalid_recipient', 'recipient_not_in_tenant')`,
            [ctx.tenantId, outboxId, uid, ctx.attempt],
          );
        }
        continue;
      }

      const allowedByPref = preferenceAllows(outbox.category, prefs);

      if (outbox.channels.includes("in_app")) {
        const sourceEventKey = `${outbox.idempotency_key}:in_app`;
        const ins = await tx.query<{ id: string }>(
          `INSERT INTO notifications (
             tenant_id, outbox_id, recipient_user_id, category, event_type, title, body, metadata, source_event_key
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
           ON CONFLICT (tenant_id, recipient_user_id, source_event_key) DO NOTHING
           RETURNING id`,
          [
            ctx.tenantId,
            outbox.id,
            uid,
            outbox.category,
            outbox.event_type,
            outbox.title,
            outbox.body,
            JSON.stringify(outbox.metadata),
            sourceEventKey,
          ],
        );
        let notifId = ins.rows[0]?.id;
        if (!notifId) {
          const ex = await tx.query<{ id: string }>(
            `SELECT id FROM notifications WHERE tenant_id = $1 AND recipient_user_id = $2 AND source_event_key = $3`,
            [ctx.tenantId, uid, sourceEventKey],
          );
          notifId = ex.rows[0]?.id;
        }
        if (notifId) notifByUser.set(uid, notifId);

        const inAppKey = `${uid}:in_app:`;
        if (!alreadyDeliveredKey.has(inAppKey)) {
          await tx.query(
            `INSERT INTO notification_delivery_attempts (
               tenant_id, outbox_id, notification_id, recipient_user_id, channel, provider, attempt_number, status
             ) VALUES ($1, $2, $3, $4, 'in_app', 'internal', $5, 'delivered')`,
            [ctx.tenantId, outboxId, notifId ?? null, uid, ctx.attempt],
          );
        }
      }

      if (outbox.channels.includes("push")) {
        if (!allowedByPref) {
          const prefKey = `${uid}:push:`;
          if (!alreadyDeliveredKey.has(prefKey)) {
            await tx.query(
              `INSERT INTO notification_delivery_attempts (
                 tenant_id, outbox_id, notification_id, recipient_user_id, channel, provider, attempt_number, status
               ) VALUES ($1, $2, $3, $4, 'push', $5, $6, 'skipped_preference')`,
              [ctx.tenantId, outboxId, notifByUser.get(uid) ?? null, uid, pushProvider.name, ctx.attempt],
            );
          }
        } else {
          eligiblePushUsers.push(uid);
        }
      }

      // Deferred channels: SMS and email are honestly recorded as not_configured (owner decision D-4)
      for (const deferredChannel of ["sms", "email"] as const) {
        if (outbox.channels.includes(deferredChannel)) {
          const defKey = `${uid}:${deferredChannel}:`;
          if (!alreadyDeliveredKey.has(defKey)) {
            await tx.query(
              `INSERT INTO notification_delivery_attempts (
                 tenant_id, outbox_id, notification_id, recipient_user_id, channel, provider, attempt_number, status, error_code
               ) VALUES ($1, $2, $3, $4, $5, 'not_configured', $6, 'not_configured', 'channel_deferred_owner_decision')`,
              [ctx.tenantId, outboxId, notifByUser.get(uid) ?? null, uid, deferredChannel, ctx.attempt],
            );
          }
        }
      }
    }

    const pushTargets: Array<{
      deviceTokenId: string;
      userId: string;
      token: string;
      platform: "android" | "ios";
      notificationId: string | null;
    }> = [];

    if (eligiblePushUsers.length > 0) {
      const devRes = await tx.query<{ id: string; user_id: string; token: string; platform: "android" | "ios" }>(
        `SELECT id, user_id, token, platform FROM public.notification_worker_active_devices($1::uuid[])`,
        [eligiblePushUsers],
      );
      for (const dev of devRes.rows) {
        const devKey = `${dev.user_id}:push:${dev.id}`;
        if (!alreadyDeliveredKey.has(devKey)) {
          pushTargets.push({
            deviceTokenId: dev.id,
            userId: dev.user_id,
            token: dev.token,
            platform: dev.platform,
            notificationId: notifByUser.get(dev.user_id) ?? null,
          });
        }
      }
    }

    return {
      alreadyDone: false as const,
      outbox,
      pushTargets,
      anyInvalidRecipient,
      validRecipientCount: validMap.size,
    };
  });

  if (plan.alreadyDone) return;

  // Step 2: Execute external push calls OUTSIDE any DB transaction
  const pushResults: Array<{
    target: (typeof plan.pushTargets)[number];
    status: "delivered" | "failed" | "not_configured" | "invalid_token";
    provider: string;
    messageId: string | null;
    errorCode: string | null;
    retryable: boolean;
  }> = [];

  for (const target of plan.pushTargets) {
    const res = await pushProvider.send({
      token: target.token,
      platform: target.platform,
      title: plan.outbox.title,
      body: plan.outbox.body,
      data: {
        category: plan.outbox.category,
        event_type: plan.outbox.event_type,
        outbox_id: plan.outbox.id,
      },
    });
    if (res.status === "delivered") {
      pushResults.push({ target, status: "delivered", provider: res.provider, messageId: res.messageId, errorCode: null, retryable: false });
    } else if (res.status === "not_configured") {
      pushResults.push({ target, status: "not_configured", provider: res.provider, messageId: null, errorCode: "push_provider_not_configured", retryable: false });
    } else if (res.status === "invalid_token") {
      pushResults.push({ target, status: "invalid_token", provider: res.provider, messageId: null, errorCode: res.errorCode, retryable: false });
    } else if (res.status === "retryable_error") {
      pushResults.push({ target, status: "failed", provider: res.provider, messageId: null, errorCode: res.errorCode, retryable: true });
    } else {
      pushResults.push({ target, status: "failed", provider: res.provider, messageId: null, errorCode: res.errorCode, retryable: false });
    }
  }

  // Step 3: Record push delivery attempts, auto-revoke invalid tokens, and update outbox status
  const retryableFailure = pushResults.find((r) => r.retryable);
  const permanentFailure = pushResults.find((r) => r.status === "failed" && !r.retryable);
  const isFinalAttempt = ctx.attempt >= plan.outbox.max_attempts;

  await ctx.fenced(async (tx) => {
    for (const r of pushResults) {
      await tx.query(
        `INSERT INTO notification_delivery_attempts (
           tenant_id, outbox_id, notification_id, recipient_user_id, channel, provider,
           device_token_id, attempt_number, status, provider_message_id, error_code
         ) VALUES ($1, $2, $3, $4, 'push', $5, $6, $7, $8, $9, $10)`,
        [
          ctx.tenantId,
          outboxId,
          r.target.notificationId,
          r.target.userId,
          r.provider,
          r.target.deviceTokenId,
          ctx.attempt,
          r.status,
          r.messageId,
          r.errorCode,
        ],
      );
      if (r.status === "invalid_token") {
        await tx.query(`SELECT public.device_tokens_mark_invalid($1, $2)`, [
          r.target.deviceTokenId,
          r.errorCode ?? "invalid_token",
        ]);
      }
    }

    let nextStatus: string;
    let lastError: string | null = null;
    if (retryableFailure) {
      nextStatus = isFinalAttempt ? "dead" : "failed";
      lastError = retryableFailure.errorCode ?? "push_retryable_error";
    } else if (permanentFailure || plan.anyInvalidRecipient) {
      nextStatus = plan.validRecipientCount > 0 ? "partial" : "failed";
      lastError = permanentFailure?.errorCode ?? "invalid_recipient";
    } else {
      nextStatus = "completed";
    }

    await tx.query(
      `UPDATE notification_outbox
          SET status = $3,
              last_error_code = $4,
              processed_at = CASE WHEN $3 IN ('completed', 'partial', 'dead') THEN now() ELSE processed_at END
        WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, outboxId, nextStatus, lastError],
    );
  });

  if (retryableFailure) {
    throw new RetryableJobError(retryableFailure.errorCode ?? "push_delivery_failed");
  }
}

// ---------------------------------------------------------------------------
// User in-app notification queries (own-recipient enforced by RLS + WHERE)
// ---------------------------------------------------------------------------

export async function listMyNotifications(
  tx: Tx,
  input: {
    tenantId: string;
    userId: string;
    unreadOnly?: boolean;
    category?: NotificationCategory;
    limit: number;
    rawCursor: unknown;
  },
): Promise<{ notifications: InAppNotification[]; page: PageInfo }> {
  const params: unknown[] = [input.tenantId, input.userId];
  const parts = ["tenant_id = $1", "recipient_user_id = $2"];
  if (input.unreadOnly) {
    parts.push("read_at IS NULL");
  }
  if (input.category) {
    params.push(input.category);
    parts.push(`category = $${params.length}`);
  }
  const res = await pageQuery<InAppNotification>(
    tx,
    `SELECT ${NOTIF_COLS} FROM notifications WHERE ${parts.join(" AND ")}`,
    params,
    { name: "created_at", expr: "q.created_at", type: "timestamptz", dir: "desc" },
    { limit: input.limit, rawCursor: input.rawCursor },
  );
  return { notifications: res.rows, page: res.page };
}

export async function getUnreadNotificationCount(tx: Tx, tenantId: string, userId: string): Promise<number> {
  const res = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND recipient_user_id = $2 AND read_at IS NULL`,
    [tenantId, userId],
  );
  return res.rows[0]?.n ?? 0;
}

export async function markNotificationRead(
  tx: Tx,
  input: { tenantId: string; userId: string; notificationId: string },
): Promise<InAppNotification> {
  const res = await tx.query<InAppNotification>(
    `UPDATE notifications
        SET read_at = COALESCE(read_at, now())
      WHERE tenant_id = $1 AND recipient_user_id = $2 AND id = $3
      RETURNING ${NOTIF_COLS}`,
    [input.tenantId, input.userId, input.notificationId],
  );
  if (!res.rows[0]) throw notFound("Notification not found");
  return res.rows[0];
}

export async function markAllNotificationsRead(
  tx: Tx,
  input: { tenantId: string; userId: string; category?: NotificationCategory },
): Promise<number> {
  const params: unknown[] = [input.tenantId, input.userId];
  let extra = "";
  if (input.category) {
    params.push(input.category);
    extra = ` AND category = $${params.length}`;
  }
  const res = await tx.query(
    `UPDATE notifications SET read_at = now() WHERE tenant_id = $1 AND recipient_user_id = $2 AND read_at IS NULL${extra}`,
    params,
  );
  return res.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Admin operational visibility (outbox & delivery attempts)
// ---------------------------------------------------------------------------

export async function listNotificationOutbox(
  tx: Tx,
  input: {
    tenantId: string;
    status?: string;
    category?: string;
    limit: number;
    rawCursor: unknown;
  },
): Promise<{ outbox: OutboxEntry[]; page: PageInfo }> {
  const params: unknown[] = [input.tenantId];
  const parts = ["tenant_id = $1"];
  if (input.status) {
    params.push(input.status);
    parts.push(`status = $${params.length}`);
  }
  if (input.category) {
    params.push(input.category);
    parts.push(`category = $${params.length}`);
  }
  const res = await pageQuery<OutboxEntry>(
    tx,
    `SELECT ${OUTBOX_COLS} FROM notification_outbox WHERE ${parts.join(" AND ")}`,
    params,
    { name: "created_at", expr: "q.created_at", type: "timestamptz", dir: "desc" },
    { limit: input.limit, rawCursor: input.rawCursor },
  );
  return { outbox: res.rows, page: res.page };
}

export async function getNotificationOutboxDetail(
  tx: Tx,
  tenantId: string,
  outboxId: string,
): Promise<{ outbox: OutboxEntry; attempts: DeliveryAttemptRow[] }> {
  const outRes = await tx.query<OutboxEntry>(
    `SELECT ${OUTBOX_COLS} FROM notification_outbox WHERE tenant_id = $1 AND id = $2`,
    [tenantId, outboxId],
  );
  const outbox = outRes.rows[0];
  if (!outbox) throw notFound("Notification outbox entry not found");
  const attRes = await tx.query<DeliveryAttemptRow>(
    `SELECT ${ATTEMPT_COLS} FROM notification_delivery_attempts WHERE tenant_id = $1 AND outbox_id = $2 ORDER BY created_at DESC, id`,
    [tenantId, outboxId],
  );
  return { outbox, attempts: attRes.rows };
}

// ---------------------------------------------------------------------------
// Device token revocation (own user only)
// ---------------------------------------------------------------------------

export async function revokeMyDeviceToken(
  tx: TxOrIdentity,
  tokenId: string,
  reason = "user_revoked",
): Promise<boolean> {
  const res = await tx.query<{ ok: boolean }>(`SELECT public.device_tokens_revoke($1, $2) AS ok`, [tokenId, reason]);
  return Boolean(res.rows[0]?.ok);
}

export async function sendAdminNotification(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    category: NotificationCategory;
    recipientUserIds: string[];
    title: string;
    body: string;
    channels?: NotificationChannel[];
    idempotencyKey: string;
    ip?: string | null;
  },
): Promise<{ outboxId: string; created: boolean }> {
  const out = await enqueueNotificationEvent(tx, {
    tenantId: input.tenantId,
    eventType: "admin.manual_notice",
    category: input.category,
    idempotencyKey: input.idempotencyKey,
    recipientUserIds: input.recipientUserIds,
    title: input.title,
    body: input.body,
    channels: input.channels,
    createdBy: input.actorUserId,
  });
  await recordSecurityEvent(tx, {
    eventType: "notifications.outbox.enqueued",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    ip: input.ip,
    detail: { outboxId: out.outboxId, category: input.category, recipientCount: input.recipientUserIds.length },
  });
  return out;
}
