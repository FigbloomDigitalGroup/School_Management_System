import type { TxOrIdentity } from "../../db/sql.js";
import { recordSecurityEvent } from "../audit/audit.js";

export interface NotificationPreferences {
  fee_reminders: boolean;
  absence_today: boolean;
  results_published: boolean;
  general_notices: boolean;
  chat_messages: boolean;
  updated_at: string | null;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  fee_reminders: true,
  absence_today: true,
  results_published: true,
  general_notices: false,
  chat_messages: true,
  updated_at: null,
};

const COLS = `fee_reminders, absence_today, results_published, general_notices, chat_messages, updated_at`;

export async function getMyNotificationPreferences(tx: TxOrIdentity, userId: string): Promise<NotificationPreferences> {
  const res = await tx.query<NotificationPreferences>(
    `SELECT ${COLS} FROM notification_preferences WHERE user_id = $1`,
    [userId],
  );
  return res.rows[0] ?? { ...DEFAULT_NOTIFICATION_PREFERENCES };
}

export async function patchMyNotificationPreferences(
  tx: TxOrIdentity,
  userId: string,
  patch: Partial<Omit<NotificationPreferences, "updated_at">>,
  ip?: string | null,
): Promise<NotificationPreferences> {
  const res = await tx.query<NotificationPreferences>(
    `INSERT INTO notification_preferences (
       user_id, fee_reminders, absence_today, results_published, general_notices, chat_messages, updated_at
     ) VALUES (
       $1,
       COALESCE($2::boolean, true),
       COALESCE($3::boolean, true),
       COALESCE($4::boolean, true),
       COALESCE($5::boolean, false),
       COALESCE($6::boolean, true),
       now()
     )
     ON CONFLICT (user_id) DO UPDATE SET
       fee_reminders = COALESCE($2::boolean, notification_preferences.fee_reminders),
       absence_today = COALESCE($3::boolean, notification_preferences.absence_today),
       results_published = COALESCE($4::boolean, notification_preferences.results_published),
       general_notices = COALESCE($5::boolean, notification_preferences.general_notices),
       chat_messages = COALESCE($6::boolean, notification_preferences.chat_messages),
       updated_at = now()
     RETURNING ${COLS}`,
    [
      userId,
      patch.fee_reminders ?? null,
      patch.absence_today ?? null,
      patch.results_published ?? null,
      patch.general_notices ?? null,
      patch.chat_messages ?? null,
    ],
  );
  await recordSecurityEvent(tx, {
    eventType: "communications.notification_preferences.updated",
    actorUserId: userId,
    tenantId: null,
    ip,
    detail: { updatedFields: Object.keys(patch).sort() },
  });
  return res.rows[0]!;
}

export async function registerDeviceToken(
  tx: TxOrIdentity,
  input: { userId: string; token: string; platform: "android" | "ios" },
): Promise<{ id: string }> {
  const res = await tx.query<{ id: string }>(`SELECT public.device_tokens_register($1, $2, $3) AS id`, [
    input.userId,
    input.token,
    input.platform,
  ]);
  return { id: res.rows[0]!.id };
}

export async function listMyDeviceTokens(
  tx: TxOrIdentity,
  userId: string,
): Promise<Array<{ id: string; platform: string; created_at: string }>> {
  const res = await tx.query<{ id: string; platform: string; created_at: string }>(
    `SELECT id, platform, created_at FROM device_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return res.rows;
}

export async function deleteMyDeviceToken(tx: TxOrIdentity, userId: string, tokenId: string): Promise<boolean> {
  const res = await tx.query(`DELETE FROM device_tokens WHERE user_id = $1 AND id = $2`, [userId, tokenId]);
  return (res.rowCount ?? 0) > 0;
}
