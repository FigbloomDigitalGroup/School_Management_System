import { supabase } from "./supabase";

/**
 * The parent "how we reach you" channel toggles (FIG-872) — real persistence
 * behind what used to be a decorative <Switch> on mobile and web. One row
 * per profile, created lazily: a profile with no row yet reads as these
 * defaults rather than failing.
 */
export interface NotificationPreferences {
  feeReminders: boolean;
  absenceToday: boolean;
  resultsPublished: boolean;
  generalNotices: boolean;
  /** Push for a new chat message (chat-push); on unless turned off. */
  chatMessages: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  feeReminders: true,
  absenceToday: true,
  resultsPublished: true,
  generalNotices: false,
  chatMessages: true,
};

interface Row {
  fee_reminders: boolean;
  absence_today: boolean;
  results_published: boolean;
  general_notices: boolean;
  chat_messages: boolean;
}

function fromRow(row: Row): NotificationPreferences {
  return {
    feeReminders: row.fee_reminders,
    absenceToday: row.absence_today,
    resultsPublished: row.results_published,
    generalNotices: row.general_notices,
    chatMessages: row.chat_messages,
  };
}

export async function fetchMyNotificationPreferences(profileId: string): Promise<NotificationPreferences> {
  const { data, error } = await supabase()
    .from("notification_preferences")
    .select("fee_reminders, absence_today, results_published, general_notices, chat_messages")
    .eq("profile_id", profileId)
    .maybeSingle<Row>();
  if (error) throw error;
  return data ? fromRow(data) : DEFAULT_NOTIFICATION_PREFERENCES;
}

/** Upserts just the one channel that changed, so two tabs flipping different switches never clobber each other. */
export async function setMyNotificationPreference(
  profileId: string,
  patch: Partial<Record<keyof NotificationPreferences, boolean>>,
): Promise<void> {
  const columns: Record<keyof NotificationPreferences, keyof Row> = {
    feeReminders: "fee_reminders",
    absenceToday: "absence_today",
    resultsPublished: "results_published",
    generalNotices: "general_notices",
    chatMessages: "chat_messages",
  };
  const row: Record<string, boolean | string> = { profile_id: profileId, updated_at: new Date().toISOString() };
  for (const [key, value] of Object.entries(patch) as [keyof NotificationPreferences, boolean | undefined][]) {
    if (value !== undefined) row[columns[key]] = value;
  }
  const { error } = await supabase().from("notification_preferences").upsert(row, { onConflict: "profile_id" });
  if (error) throw error;
}
