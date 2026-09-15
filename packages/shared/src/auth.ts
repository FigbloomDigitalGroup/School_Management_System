import type { Role } from "./types";

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

/** Landing route per role. Tenant-scoped roles get the /s/<slug> prefix. */
export function homeRouteFor(role: Role, slug: string | null): string {
  switch (role) {
    case "super_admin": return "/platform/tenants";
    case "school_admin": return `/s/${slug}/admin`;
    case "teacher": return `/s/${slug}/teacher/attendance`;
    case "parent": return `/s/${slug}/parent`;
    case "student": return `/s/${slug}/student`;
    case "driver": return `/s/${slug}/driver`;
  }
}

export const NAV: Record<Role, { to: string; label: string; icon: string }[]> = {
  super_admin: [
    { to: "/platform/tenants", label: "Tenants", icon: "table" },
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
    { to: "student/notices", label: "Notices", icon: "bell" },
  ],
  // A driver's screen is a single full-screen page (start/end trip), not a
  // console — this exists only so Record<Role, ...> stays exhaustive.
  driver: [
    { to: "driver", label: "Trip", icon: "pulse" },
  ],
};
