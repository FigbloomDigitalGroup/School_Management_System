import { apiClient } from "./client";
import { POLL_MS, pollChanges } from "./poll";

/**
 * The announcements inbox call and its poll, on their own so that parentData.ts (which holds `subscribeAnnouncements`) can use
 * the poll without importing noticesApi.ts, which needs parentData's `formatWhen`.
 */

/** A change check asks for this many newest. */
const CHANGE_CHECK_NOTICES = 50;

export async function inboxPage(tenantId: string, cursor: string | undefined, limit: number, signal?: AbortSignal) {
  return apiClient().get("/v1/tenants/{tenantId}/communications/announcements/inbox", {
    path: { tenantId }, query: { limit, cursor }, tenantId, signal,
  });
}

/** "A notice came in or changed": the newest notices' ids and publish times, every half minute. */
export function apiPollAnnouncements(tenantId: string, onChange: () => void): () => void {
  return pollChanges(
    async (signal) => (await inboxPage(tenantId, undefined, CHANGE_CHECK_NOTICES, signal)).announcements.map((a) => `${a.id}:${a.published_at ?? ""}`),
    () => onChange(),
    { intervalMs: POLL_MS.list },
  );
}
