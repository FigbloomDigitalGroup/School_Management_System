import type { InstitutionType, Role } from "./types";

/**
 * Four ways in, matched to who is signing in:
 *  - staff    email + password
 *  - parent   phone + 6-digit SMS code (most have no working email)
 *  - student  admission number + PIN (issued by the school, no email at all)
 *  - platform email + password + TOTP
 */

export type SignInMethod = "staff_password" | "parent_otp" | "student_pin" | "platform";

export const METHOD_FOR: Record<Role, SignInMethod> = {
  super_admin: "platform",
  school_admin: "staff_password",
  teacher: "staff_password",
  driver: "staff_password",
  parent: "parent_otp",
  student: "student_pin",
  // A customer-held credential that can see data across several schools
  // (FIG-331) warrants at least the bar Figbloom's own staff meet, not the
  // weaker staff_password every other staff role gets.
  org_admin: "platform",
};

export const OTP_LENGTH = 6;
export const OTP_TTL_SECONDS = 300;
export const OTP_RESEND_AFTER_SECONDS = 30;
export const PIN_LENGTH = 4;

export function validateOtp(raw: string): { ok: boolean; message: string } {
  const v = raw.replace(/\s/g, "");
  if (v.length < OTP_LENGTH) return { ok: false, message: "" };
  if (!/^\d{6}$/.test(v)) return { ok: false, message: "The code is six numbers." };
  return { ok: true, message: "" };
}

/**
 * Students have no email or phone on file, so sign-in derives a synthetic
 * Supabase auth address from the admission number instead of looking one up —
 * the same admission number always maps to the same address, tenant-scoped so
 * two schools can each have their own "4102". The PIN is the account password.
 */
export function studentLoginEmail(admissionNo: string, tenantSlug: string): string {
  return `adm${admissionNo}@students.${tenantSlug}.figbloom.internal`;
}

export function validatePin(raw: string): { ok: boolean; message: string } {
  if (!/^\d{4}$/.test(raw)) return { ok: false, message: "Your PIN is four numbers." };
  if (/^(\d)\1{3}$/.test(raw)) return { ok: false, message: "Pick a PIN that is not four of the same number." };
  if (raw === "1234" || raw === "0000") return { ok: false, message: "That PIN is too easy to guess." };
  return { ok: true, message: "" };
}

/**
 * FIG-396/397: a short, school-assigned alphanumeric login_id (e.g.
 * "TC-0001") is replacing email/phone/admission-number as the sign-in
 * credential for every role except org_admin/super_admin. One prefix per
 * role, scoped per tenant (profiles.login_id is unique(tenant_id, login_id),
 * the same shape students.admission_no already used) -- two schools can
 * each assign their own "TC-0001".
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
 * Generalizes studentLoginEmail() to every login_id-based role: none of them
 * have a real email on file, so sign-in derives a synthetic Supabase auth
 * address from the assigned ID instead of looking one up. Tenant-scoped for
 * the same reason login_id itself is -- two schools can each have "TC-0001".
 */
export function loginIdEmail(loginId: string, tenantSlug: string): string {
  return `${loginId.toLowerCase()}@login.${tenantSlug}.figbloom.internal`;
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
    { to: "admin/courses", label: "Courses", icon: "grid" },
    { to: "admin/fees", label: "Fees", icon: "receipt" },
    { to: "admin/announcements", label: "Announcements", icon: "megaphone" },
    { to: "admin/fleet", label: "Fleet", icon: "pulse" },
    { to: "admin/reports", label: "Reports", icon: "chart" },
    { to: "admin/settings", label: "School settings", icon: "gear" },
  ],
  teacher: [
    { to: "teacher/attendance", label: "Attendance", icon: "check" },
    { to: "teacher/gradebook", label: "Gradebook", icon: "table" },
    { to: "teacher/timetable", label: "Timetable", icon: "clock" },
    { to: "teacher/classes", label: "My classes", icon: "people" },
    { to: "teacher/sections", label: "My sections", icon: "people" },
    { to: "teacher/messages", label: "Messages", icon: "chat" },
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
