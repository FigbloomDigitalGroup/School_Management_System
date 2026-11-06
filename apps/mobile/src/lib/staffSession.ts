import type { AdminArea } from "@figbloom/shared";

/**
 * A teacher, a school admin or another member of staff who signed in: people whose screens are all live data
 * (rosters, registers, the school's own records), so nothing is saved for them and, with no signal, they get the
 * "No connection" page. Not part of AppSession, which is what the phone can save and reopen.
 */
export interface StaffSession {
  role: "teacher" | "school_admin" | "staff";
  accent: string;
  profileId: string;
  tenantId: string;
  fullName: string;
  country: string;
  /** The admin console areas this person holds. A school admin has all of it by role, so this is empty for them. */
  adminAreas: AdminArea[];
  /** The school, for the admin home and the link to its web console. */
  school: { name: string; slug: string };
  /** The person's own title at the school ("Deputy principal"), when they have one. */
  title: string | null;
}
