import type { ClassMessageRecipients } from "../teacherData";
import { formatWhen } from "../parentData";
import type { NoticeInfo } from "../studentData";
import type { Announcement, Audience } from "../types";
import { apiClient } from "./client";
import { staffDirectory, type Directory } from "./directoryApi";
import { inboxPage } from "./inboxApi";
import { API_PAGE_LIMIT } from "./paging";
import { activeTenantId } from "./peopleApi";
import type { components } from "./schema";

/**
 * Notices on apps/api: the API side of the inbox functions in teacherData.ts and otherStaff.ts, the teacher's own
 * "Sent by you" list, and sending a message to a class.
 *
 *  - The inbox (`GET /communications/announcements/inbox`) answers the published announcements that reach the signed-in
 *    person (the whole school, their role, them by name, the classes they teach) and those they wrote, newest first. A notice
 *    is not marked read in it, so `unread` is false for every notice here and the screens show no unread dot or badge
 *    (noticesCapabilities().readState); opening one still tells the server (`POST .../read`), for when it does.
 *  - A notice has `author_id`, not a name. "You" for your own; the staff directory's teacher name when it can be read; else
 *    "School office" (the office is who writes nearly every notice).
 *  - Sending is `POST /communications/announcements` then `.../publish`, which needs `resource.announcement.write`: the school
 *    office and the Communication area, not a teacher as such (canMessageClasses). A class audience reaches the teachers of
 *    that class; parents and learners are not reached until their accounts are linked (FIG-1869).
 *  - A draft cannot be read back by a teacher, so "Sent by you" shows published notices only.
 */

type ApiAnnouncement = components["schemas"]["CommunicationsAnnouncement"];

/** How many notices the inbox reads: the newest of them, as a person looks no further back. */
export const INBOX_NOTICES = 400;

/** The newest `max` notices of the inbox, newest first. */
export async function apiListInbox(tenantId: string, max: number = INBOX_NOTICES): Promise<ApiAnnouncement[]> {
  const all: ApiAnnouncement[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50 && all.length < max; i++) {
    const r = await inboxPage(tenantId, cursor, Math.min(API_PAGE_LIMIT, max - all.length));
    all.push(...r.announcements);
    cursor = r.page.next_cursor ?? undefined;
    if (!cursor) break;
  }
  return all;
}

export function noticeFromApi(a: ApiAnnouncement, me: string | undefined, directory: Directory | null): NoticeInfo {
  const author = directory?.get(a.author_id);
  return {
    id: a.id,
    subject: a.subject,
    from: a.author_id === me ? "You" : author?.role === "teacher" ? author.name : "School office",
    when: formatWhen(a.published_at ?? a.created_at),
    unread: false,
    body: a.body,
  };
}

export async function apiFetchNotices(): Promise<NoticeInfo[]> {
  const tenantId = activeTenantId();
  const [rows, directory] = await Promise.all([apiListInbox(tenantId), staffDirectory(tenantId)]);
  const me = apiClient().session()?.userId;
  return rows
    .slice()
    .sort((a, b) => (b.published_at ?? b.created_at).localeCompare(a.published_at ?? a.created_at))
    .map((a) => noticeFromApi(a, me, directory));
}

export async function apiMarkNoticeRead(announcementId: string): Promise<void> {
  const tenantId = activeTenantId();
  await apiClient().post("/v1/tenants/{tenantId}/communications/announcements/{announcementId}/read", {
    path: { tenantId, announcementId }, tenantId,
  });
}

/** What a person wrote, published, newest first, at most 20 (as the Supabase list stops). */
export async function apiFetchSentByMe(authorId: string): Promise<Announcement[]> {
  const tenantId = activeTenantId();
  const rows = await apiListInbox(tenantId);
  return rows
    .filter((a) => a.author_id === authorId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 20)
    .map((a) => ({
      id: a.id, tenant_id: a.tenant_id, author_id: a.author_id, subject: a.subject, body: a.body,
      audience: a.audience as unknown as Audience, channels: a.channels, published_at: a.published_at, created_at: a.created_at,
    }));
}

/** A message to one class. `draft` leaves it unpublished (nothing on the API build needs that yet: files wait on storage). */
export async function apiSendClassMessage(
  tenantId: string, classId: string, recipients: ClassMessageRecipients, subject: string, body: string, draft: boolean,
): Promise<string> {
  const created = await apiClient().post("/v1/tenants/{tenantId}/communications/announcements", {
    path: { tenantId },
    body: {
      subject: subject.trim(),
      body: body.trim(),
      audience: { kind: "class", class_id: classId, recipients },
      channels: ["in_app"],
    },
    tenantId,
  });
  const id = created.announcement.id;
  if (!draft) {
    await apiClient().post("/v1/tenants/{tenantId}/communications/announcements/{announcementId}/publish", {
      path: { tenantId, announcementId: id }, tenantId,
    });
  }
  return id;
}
