import type { MyProfile } from "../profile";
import type { NotificationPreferences } from "../notificationPreferences";
import { apiMe } from "./authApi";
import { apiClient } from "./client";
import { viewOfMe } from "./sessionApi";

/**
 * The signed-in person's own account on apps/api: the API side of profile.ts and notificationPreferences.ts.
 *
 * The API has no endpoint to change one's own name, phone or photo, and `GET /v1/auth/me` carries neither a phone nor a photo,
 * so the profile here is what the server says about who is signed in (name, email, the sign-in ID in this school) and
 * nothing is invented for the rest (accountCapabilities() hides the edit form).
 */

/** Who is signed in, in the shape the account screen reads. `phone`, `alt_phone` and `avatar_url` are null: the API does not say. */
export async function apiFetchMyProfile(): Promise<MyProfile> {
  const me = viewOfMe(await apiMe());
  const tenantId = apiClient().activeTenant();
  const membership = (tenantId ? me.memberships.find((m) => m.tenantId === tenantId) : null) ?? me.memberships[0] ?? null;
  return {
    full_name: me.user.full_name,
    phone: null,
    alt_phone: null,
    avatar_url: null,
    login_id: membership?.loginId ?? null,
    email: me.user.email,
  };
}

// ---------------------------------------------------------------- notification choices

type ApiPreferences = {
  fee_reminders: boolean;
  absence_today: boolean;
  results_published: boolean;
  general_notices: boolean;
  chat_messages: boolean;
};

const COLUMNS: Record<keyof NotificationPreferences, keyof ApiPreferences> = {
  feeReminders: "fee_reminders",
  absenceToday: "absence_today",
  resultsPublished: "results_published",
  generalNotices: "general_notices",
  chatMessages: "chat_messages",
};

export function notificationPreferencesFromApi(p: ApiPreferences): NotificationPreferences {
  return {
    feeReminders: p.fee_reminders,
    absenceToday: p.absence_today,
    resultsPublished: p.results_published,
    generalNotices: p.general_notices,
    chatMessages: p.chat_messages,
  };
}

/** What a person has chosen, or the product's defaults when they never chose (the server answers either). */
export async function apiFetchNotificationPreferences(): Promise<NotificationPreferences> {
  const res = await apiClient().get("/v1/me/notification-preferences", { tenantId: null });
  return notificationPreferencesFromApi(res.preferences);
}

/** Changes only the channels named, so two tabs flipping different switches never overwrite each other. Answers the saved choices. */
export async function apiSetNotificationPreferences(patch: Partial<Record<keyof NotificationPreferences, boolean>>): Promise<NotificationPreferences> {
  const body: Partial<ApiPreferences> = {};
  for (const [key, value] of Object.entries(patch) as [keyof NotificationPreferences, boolean | undefined][]) {
    if (value !== undefined) body[COLUMNS[key]] = value;
  }
  const res = await apiClient().patch("/v1/me/notification-preferences", { body, tenantId: null });
  return notificationPreferencesFromApi(res.preferences);
}
