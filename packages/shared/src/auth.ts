import type { InstitutionType, Role } from "./types";
import { supabase } from "./supabase";

/**
 * Two ways in (FIG-396, replacing an earlier four-tab/SMS-OTP scheme):
 *  - org_admin/super_admin  real email + password (the only two roles ever
 *    provisioned by email -- self-service signup or a formal staff invite)
 *  - everyone else          pick their school, then a school-assigned,
 *    alphanumeric login_id (e.g. "TC-0001") + password -- no email, no SMS
 *    OTP. One prefix per role, scoped per tenant (profiles.login_id is
 *    unique(tenant_id, login_id), the same shape students.admission_no
 *    used before this) -- two schools can each assign their own "TC-0001".
 */
export const ROLE_ID_PREFIX: Partial<Record<Role, string>> = {
  school_admin: "AD",
  teacher: "TC",
  parent: "PT",
  student: "ST",
  driver: "BD",
};

/** Zero-pads to 4 digits, e.g. formatLoginId("TC", 1) -> "TC-0001". */
export function formatLoginId(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(4, "0")}`;
}

/**
 * None of the login_id-based roles have a real email on file, so sign-in
 * derives a synthetic Supabase auth address from the assigned ID instead of
 * looking one up. Tenant-scoped for the same reason login_id itself is --
 * two schools can each have "TC-0001".
 */
export function loginIdEmail(loginId: string, tenantSlug: string): string {
  return `${loginId.toLowerCase()}@login.${tenantSlug}.figbloom.internal`;
}

export interface SchoolSearchResult {
  id: string;
  name: string;
  slug: string;
  county: string | null;
}

/** The unified sign-in's "type your school's name" step — calls the
 *  anonymous search-schools edge function, since RLS has no pre-auth SELECT
 *  on tenants. Shared between web and mobile, which both need it. */
export async function searchSchools(query: string): Promise<SchoolSearchResult[]> {
  const { data, error } = await supabase().functions.invoke<{ schools: SchoolSearchResult[] } | { error: string }>(
    "search-schools",
    { body: { query } },
  );
  if (error) {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const body = (await ctx.json()) as { error?: string };
        if (body?.error) throw new Error(body.error);
      } catch (e) {
        if (e instanceof Error && e.message) throw e;
      }
    }
    throw new Error(error.message);
  }
  if (data && "error" in data) throw new Error(data.error);
  return (data as { schools: SchoolSearchResult[] }).schools;
}

export interface ResolvedLogin {
  full_name: string;
  email: string;
}

/** The unified sign-in's login_id -> account lookup, once a school is
 *  picked — calls the anonymous resolve-login-id edge function. Never
 *  handles a password; the caller still authenticates via the returned
 *  email through Supabase's own signInWithPassword. */
export async function resolveLoginId(tenantId: string, loginId: string): Promise<ResolvedLogin> {
  const { data, error } = await supabase().functions.invoke<(ResolvedLogin & { ok: true }) | { error: string }>(
    "resolve-login-id",
    { body: { tenant_id: tenantId, login_id: loginId } },
  );
  if (error) {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const body = (await ctx.json()) as { error?: string };
        if (body?.error) throw new Error(body.error);
      } catch (e) {
        if (e instanceof Error && e.message) throw e;
      }
    }
    throw new Error(error.message);
  }
  if (data && "error" in data) throw new Error(data.error);
  return data as ResolvedLogin;
}

/**
 * Landing route per role. Tenant-scoped roles get the /s/<slug> prefix.
 * A higher-ed teacher (lecturer) lands on "my sections" rather than
 * Attendance — class-based screens (Attendance/Gradebook/Timetable/
 * Messages) are all keyed off teaching_assignments/class_id, which no
 * higher-ed tenant ever populates, so Attendance would just be empty.
 */
export function homeRouteFor(role: Role, slug: string | null, institutionType?: InstitutionType): string {
  switch (role) {
    case "super_admin": return "/platform/tenants";
    case "school_admin": return `/s/${slug}/admin`;
    case "teacher": return institutionType === "higher_ed" ? `/s/${slug}/teacher/sections` : `/s/${slug}/teacher/attendance`;
    case "parent": return `/s/${slug}/parent`;
    case "student": return `/s/${slug}/student`;
    case "driver": return `/s/${slug}/driver`;
    // Not tenant-scoped at all — `slug` here is actually the org's own slug
    // (SignIn.tsx resolves it from organization_admins, not tenants, for
    // this role). Not /platform/*: that's staff-only and would just bounce
    // them straight back here.
    case "org_admin": return `/org/${slug}/dashboard`;
  }
}

export const NAV: Record<Role, { to: string; label: string; icon: string }[]> = {
  super_admin: [
    { to: "/platform/tenants", label: "Tenants", icon: "table" },
    { to: "/platform/organizations", label: "Organizations", icon: "people" },
    { to: "/platform/health", label: "System health", icon: "pulse" },
    { to: "/platform/usage", label: "Usage & capacity", icon: "gauge" },
    { to: "/platform/incidents", label: "Incidents", icon: "flag" },
    { to: "/platform/subscriptions", label: "Subscriptions", icon: "cycle" },
    { to: "/platform/invoices", label: "Invoices", icon: "receipt" },
    { to: "/platform/impersonation", label: "Impersonation log", icon: "mask" },
    { to: "/platform/audit", label: "Audit trail", icon: "gear" },
  ],
  school_admin: [
    { to: "admin", label: "Dashboard", icon: "home" },
    { to: "admin/people", label: "Students & staff", icon: "people" },
    { to: "admin/classes", label: "Classes", icon: "grid" },
    { to: "admin/subjects", label: "Subjects", icon: "grid" },
    { to: "admin/courses", label: "Courses", icon: "grid" },
    { to: "admin/fees", label: "Fees", icon: "receipt" },
    { to: "admin/announcements", label: "Announcements", icon: "megaphone" },
    { to: "admin/leave", label: "Leave requests", icon: "flag" },
    { to: "admin/fleet", label: "Fleet", icon: "pulse" },
    { to: "admin/reports", label: "Reports", icon: "chart" },
    { to: "admin/settings", label: "School settings", icon: "gear" },
    { to: "admin/account", label: "My account", icon: "pencil" },
  ],
  teacher: [
    { to: "teacher/attendance", label: "Attendance", icon: "check" },
    { to: "teacher/gradebook", label: "Gradebook", icon: "table" },
    { to: "teacher/timetable", label: "Timetable", icon: "clock" },
    { to: "teacher/classes", label: "My classes", icon: "people" },
    { to: "teacher/sections", label: "My sections", icon: "people" },
    { to: "teacher/messages", label: "Messages", icon: "chat" },
    { to: "teacher/notices", label: "Notices", icon: "bell" },
    { to: "teacher/leave", label: "Leave", icon: "flag" },
    { to: "teacher/account", label: "Account", icon: "pencil" },
  ],
  parent: [
    { to: "parent", label: "Home", icon: "home" },
    { to: "parent/fees", label: "Fees", icon: "receipt" },
    { to: "parent/results", label: "Results", icon: "chart" },
    { to: "parent/bus", label: "Bus", icon: "pulse" },
    { to: "parent/inbox", label: "Inbox", icon: "chat" },
    { to: "parent/settings", label: "Account", icon: "gear" },
  ],
  student: [
    { to: "student", label: "Today", icon: "home" },
    { to: "student/timetable", label: "Timetable", icon: "clock" },
    { to: "student/work", label: "Work", icon: "pencil" },
    { to: "student/results", label: "Results", icon: "chart" },
    { to: "student/fees", label: "Fees", icon: "receipt" },
    { to: "student/notices", label: "Notices", icon: "bell" },
  ],
  // A driver's screen is a single full-screen page (start/end trip), not a
  // console — this exists only so Record<Role, ...> stays exhaustive.
  driver: [
    { to: "driver", label: "Trip", icon: "pulse" },
  ],
  // Relative, same as every tenant-scoped role's items — NavLink resolves
  // them against the current /org/<slug>/ location, so no manual slug
  // substitution is needed (mirrors how "admin", "teacher/attendance" etc.
  // resolve under /s/<slug>/ for the tenant-scoped roles above).
  org_admin: [
    { to: "dashboard", label: "Dashboard", icon: "home" },
    { to: "schools", label: "Schools", icon: "table" },
    { to: "admins", label: "Admins", icon: "people" },
    { to: "audit", label: "Audit log", icon: "gear" },
  ],
};
