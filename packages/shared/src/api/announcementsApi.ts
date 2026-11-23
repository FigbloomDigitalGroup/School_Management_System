import { yearGroupsOf, yearSortKey } from "../levels";
import type { AnnouncementDraft, AnnouncementsData, ChannelFlags, RecentAnnouncement } from "../adminAnnouncements";
import type { ClassGroup } from "../types";
import { apiClient } from "./client";
import { isApiError } from "./errors";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import type { components } from "./schema";
import { classGroupFromApi, currentAcademicYear } from "./setupApi";

/**
 * Announcements on apps/api (FIG-1891): the API side of adminAnnouncements.ts.
 *
 * Differences from Supabase, handled here rather than in the screens:
 *  - Creating an announcement always makes a draft; sending now creates it and then calls POST .../publish.
 *  - Publishing enqueues push notifications on the server when "push" is among the channels, so sendAnnouncementPush is a no-op.
 *  - The API requires "in_app" among channels; SMS and email are deferred on the server (skipped_no_provider) and hidden by capabilities.
 *  - Account-level reach counts (profiles by role, linked guardian/student accounts per class) are not exposed by the API yet, so
 *    headcounts are zeroed here and hidden by announcementsCapabilities().reachCounts.
 *  - A teacher holding only the communication area may not read academic years or classes (403); the composer degrades cleanly to an
 *    empty class list so school-wide and role announcements still work.
 */

type ApiAnnouncement = components["schemas"]["CommunicationsAnnouncement"];
type ApiChannel = "in_app" | "push" | "sms" | "email";

const byYear = (a: Pick<ClassGroup, "level" | "form_level" | "name">, b: Pick<ClassGroup, "level" | "form_level" | "name">) =>
  yearSortKey(a.level, a.form_level) - yearSortKey(b.level, b.form_level) || a.name.localeCompare(b.name);

export function recentAnnouncementFromApi(a: Pick<ApiAnnouncement, "id" | "subject" | "published_at">): RecentAnnouncement {
  return { id: a.id, subject: a.subject, published_at: a.published_at };
}

/** The channels to send to the API: always includes `in_app` (required by the server). */
export function activeApiChannels(flags: ChannelFlags): ApiChannel[] {
  const out: ApiChannel[] = ["in_app"];
  if (flags.push) out.push("push");
  if (flags.sms) out.push("sms");
  if (flags.email) out.push("email");
  return out;
}

async function listClassesForComposer(tenantId: string): Promise<Pick<ClassGroup, "id" | "name" | "level" | "form_level">[]> {
  try {
    const year = await currentAcademicYear(tenantId);
    const rows = await listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/classes", {
        path: { tenantId },
        query: { academicYearId: year?.id, active: true, limit: API_PAGE_LIMIT, cursor },
        tenantId,
      });
      return { items: r.classes, page: r.page };
    });
    return rows
      .map((c) => {
        const g = classGroupFromApi(c, tenantId);
        return { id: g.id, name: g.name, level: g.level, form_level: g.form_level };
      })
      .sort(byYear);
  } catch (err) {
    if (isApiError(err) && err.code === "forbidden") return [];
    throw err;
  }
}

export async function apiFetchAnnouncementsData(tenantId: string): Promise<AnnouncementsData> {
  const [classes, recentRes] = await Promise.all([
    listClassesForComposer(tenantId),
    apiClient().get("/v1/tenants/{tenantId}/communications/announcements", {
      path: { tenantId },
      query: { published: "true", limit: 5 },
      tenantId,
    }),
  ]);

  const recent = recentRes.announcements
    .map(recentAnnouncementFromApi)
    .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""))
    .slice(0, 5);

  return {
    classes,
    byRole: { everyone: 0, parents: 0, students: 0, teachers: 0, staff: 0 },
    reachByYear: new Map(),
    years: yearGroupsOf(classes),
    reachByClass: new Map(),
    recent,
  };
}

export async function apiInsertAnnouncement(tenantId: string, draft: AnnouncementDraft, publishNow: boolean): Promise<string> {
  const created = await apiClient().post("/v1/tenants/{tenantId}/communications/announcements", {
    path: { tenantId },
    body: {
      subject: draft.subject.trim(),
      body: draft.body.trim(),
      audience: draft.audience as Record<string, unknown>,
      channels: activeApiChannels(draft.channels),
    },
    tenantId,
  });
  const id = created.announcement.id;
  if (publishNow) await apiPublishAnnouncement(tenantId, id);
  return id;
}

export async function apiPublishAnnouncement(tenantId: string, announcementId: string): Promise<void> {
  await apiClient().post("/v1/tenants/{tenantId}/communications/announcements/{announcementId}/publish", {
    path: { tenantId, announcementId },
    tenantId,
  });
}
