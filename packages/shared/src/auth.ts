import type { InstitutionType, Role } from "./types";
import { invokeEdge } from "./edge";

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
  // "Other staff". Accounts that were guards or receptionists before
  // 20261028100001 keep the GD-/RC- IDs they were issued.
  staff: "SF",
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

/** How long the sign-in screens wait for a lookup before saying so, rather than sitting on "Searching…". */
const LOOKUP_TIMEOUT_MS = 8000;

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
  const data = await invokeEdge<{ schools: SchoolSearchResult[] }>("search-schools", { query }, { timeoutMs: LOOKUP_TIMEOUT_MS });
  return data.schools;
}

export interface ResolvedLogin {
  /** Masked ("Esther H."): the lookup is public, so it never returns a full name. */
  display_name: string;
  email: string;
}

/** The unified sign-in's login_id -> account lookup, once a school is
 *  picked — calls the anonymous resolve-login-id edge function. Never
 *  handles a password; the caller still authenticates via the returned
 *  email through Supabase's own signInWithPassword. */
export async function resolveLoginId(tenantId: string, loginId: string): Promise<ResolvedLogin> {
  return invokeEdge<ResolvedLogin>("resolve-login-id", { tenant_id: tenantId, login_id: loginId }, { timeoutMs: LOOKUP_TIMEOUT_MS });
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
    // the visitor log for those who keep it, notices for everyone else (App.tsx StaffHome)
    case "staff": return `/s/${slug}/staff`;
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
    { to: "/platform/curriculum", label: "Curriculum", icon: "grid" },
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
    { to: "admin/exams", label: "Exams", icon: "table" },
    { to: "admin/papers", label: "Exams & tests", icon: "check" },
    { to: "admin/materials", label: "Learning materials", icon: "book" },
    { to: "admin/report-cards", label: "Report cards", icon: "receipt" },
    { to: "admin/fees", label: "Fees", icon: "receipt" },
    { to: "admin/announcements", label: "Announcements", icon: "megaphone" },
    { to: "admin/activities", label: "Sports & activities", icon: "trophy" },
    { to: "admin/chats", label: "Chats", icon: "chat" },
    { to: "admin/leave", label: "Leave requests", icon: "flag" },
    { to: "admin/visitors", label: "Visitors", icon: "people" },
    { to: "admin/medical", label: "Sick bay", icon: "pulse" },
    { to: "admin/inventory", label: "Inventory", icon: "box" },
    { to: "admin/fleet", label: "Fleet", icon: "pulse" },
    { to: "admin/reports", label: "Reports", icon: "chart" },
    { to: "admin/performance", label: "Performance", icon: "chart" },
    { to: "admin/settings", label: "School settings", icon: "gear" },
    { to: "admin/access", label: "Access & roles", icon: "people" },
    { to: "admin/account", label: "My account", icon: "pencil" },
  ],
  teacher: [
    { to: "teacher/attendance", label: "Attendance", icon: "check" },
    { to: "teacher/gradebook", label: "Gradebook", icon: "table" },
    { to: "teacher/homework", label: "Homework", icon: "pencil" },
    { to: "teacher/materials", label: "Learning materials", icon: "book" },
    { to: "teacher/exams", label: "Exams & tests", icon: "check" },
    { to: "teacher/report-cards", label: "Report cards", icon: "receipt" },
    { to: "teacher/performance", label: "Performance", icon: "chart" },
    { to: "teacher/timetable", label: "Timetable", icon: "clock" },
    { to: "teacher/classes", label: "My classes", icon: "people" },
    { to: "teacher/sections", label: "My sections", icon: "people" },
    { to: "teacher/messages", label: "Messages", icon: "chat" },
    { to: "teacher/chats", label: "Chats", icon: "chat" },
    { to: "teacher/notices", label: "Notices", icon: "bell" },
    { to: "teacher/activities", label: "Sports & activities", icon: "trophy" },
    { to: "teacher/buses", label: "Buses", icon: "pulse" },
    { to: "teacher/leave", label: "Leave", icon: "flag" },
    { to: "teacher/visitors", label: "Visitors", icon: "people" },
    { to: "teacher/items", label: "My items", icon: "box" },
    { to: "teacher/account", label: "Account", icon: "pencil" },
  ],
  parent: [
    { to: "parent", label: "Home", icon: "home" },
    { to: "parent/fees", label: "Fees", icon: "receipt" },
    { to: "parent/results", label: "Results", icon: "chart" },
    { to: "parent/homework", label: "Homework", icon: "pencil" },
    { to: "parent/materials", label: "Learning materials", icon: "book" },
    { to: "parent/activities", label: "Sports & activities", icon: "trophy" },
    { to: "parent/bus", label: "Bus", icon: "pulse" },
    { to: "parent/inbox", label: "Inbox", icon: "chat" },
    { to: "parent/chats", label: "Chats", icon: "chat" },
    { to: "parent/items", label: "Issued items", icon: "box" },
    { to: "parent/health", label: "Health", icon: "pulse" },
    { to: "parent/settings", label: "Account", icon: "gear" },
  ],
  student: [
    { to: "student", label: "Today", icon: "home" },
    { to: "student/timetable", label: "Timetable", icon: "clock" },
    { to: "student/work", label: "Work", icon: "pencil" },
    { to: "student/materials", label: "Learning materials", icon: "book" },
    { to: "student/exams", label: "Exams & tests", icon: "check" },
    { to: "student/results", label: "Results", icon: "chart" },
    { to: "student/activities", label: "Sports & activities", icon: "trophy" },
    { to: "student/study-helper", label: "Ask Bloom", icon: "chat" },
    { to: "student/fees", label: "Fees", icon: "receipt" },
    { to: "student/notices", label: "Notices", icon: "bell" },
    { to: "student/chats", label: "Chats", icon: "chat" },
    { to: "student/items", label: "My items", icon: "box" },
  ],
  // A driver's screen is a single full-screen page (start/end trip), not a
  // console — this exists only so Record<Role, ...> stays exhaustive.
  driver: [
    { to: "driver", label: "Trip", icon: "pulse" },
  ],
  // Other staff. Visitors only for those holding the visitors admin area
  // (adminAreas.ts); StaffShell hides it from the rest.
  staff: [
    { to: "staff/visitors", label: "Visitors", icon: "people" },
    { to: "staff/notices", label: "Notices", icon: "bell" },
    { to: "staff/chats", label: "Chats", icon: "chat" },
    { to: "staff/items", label: "My items", icon: "box" },
    { to: "staff/account", label: "Account", icon: "pencil" },
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
