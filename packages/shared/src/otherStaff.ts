import { audienceIncludes } from "./audience";
import { formatWhen } from "./parentData";
import type { NoticeInfo } from "./studentData";
import { supabase } from "./supabase";
import type { Audience, Profile } from "./types";

/**
 * Other staff (role "staff", 20261028100001): everyone at a school who isn't
 * a teacher, an admin or a driver. One role; the job is profiles.staff_title.
 * Those the office gives the visitor log (handles_visitors) keep the gate and
 * reception's work too.
 */

/** Offered when the office adds or edits other staff; any other title can be typed. */
export const STAFF_TITLE_SUGGESTIONS = [
  "Librarian", "Matron", "Nurse", "Receptionist", "Guard", "Secretary", "Lab technician", "Cook", "Groundsman", "Accounts clerk",
] as const;

/** Whether this person keeps the visitor log: other staff the office has given it. */
export function handlesVisitors(profile: Pick<Profile, "role" | "handles_visitors">): boolean {
  return profile.role === "staff" && !!profile.handles_visitors;
}

/**
 * The notices other staff read: everything addressed to them, "All staff"
 * included. The database already returns only those (audience_reaches); the
 * same rule is applied here so a stale row never shows.
 */
export async function fetchStaffNotices(profileId: string): Promise<NoticeInfo[]> {
  const [{ data, error }, { data: reads, error: readsError }] = await Promise.all([
    supabase()
      .from("announcements")
      .select("id, subject, body, created_at, audience, profiles!announcements_author_id_fkey(full_name, role)")
      .not("published_at", "is", null)
      .order("created_at", { ascending: false }),
    supabase().from("announcement_reads").select("announcement_id").eq("profile_id", profileId),
  ]);
  if (error) throw new Error(error.message);
  if (readsError) throw new Error(readsError.message);

  const readIds = new Set((reads ?? []).map((r) => r.announcement_id as string));
  const viewer = { profileId, role: "staff" as const, classIds: [], years: [] };

  return ((data ?? []) as unknown as {
    id: string; subject: string; body: string; created_at: string;
    audience: Audience | null;
    profiles: { full_name: string; role: string } | null;
  }[])
    .filter((a) => audienceIncludes(a.audience, viewer))
    .map((a) => ({
      id: a.id,
      subject: a.subject,
      // other staff can't read profiles, so the author is always "the office" to them
      from: a.profiles?.role === "teacher" ? (a.profiles?.full_name ?? "A teacher") : "School office",
      when: formatWhen(a.created_at),
      unread: !readIds.has(a.id),
      body: a.body,
    }));
}
