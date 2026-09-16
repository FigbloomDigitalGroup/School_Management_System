import { roleLabel, status } from "@figbloom/shared";
import type { HigherEdSubtype, Tenant } from "@figbloom/shared";
import type { ReactNode } from "react";

export type Tone = "ok" | "warn" | "info" | "muted";

const TONE: Record<Tone, { background: string; color: string }> = {
  ok: { background: status.okBg, color: status.okInk },
  warn: { background: status.warnBg, color: status.warnInk },
  info: { background: status.infoBg, color: status.infoInk },
  muted: { background: status.mutedBg, color: status.mutedInk },
};

/** Status colours are system-owned — never the tenant accent. Red means the
 *  same thing in every school. */
export function Badge({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className="inline-block rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold whitespace-nowrap"
      style={TONE[tone]}
    >
      {children}
    </span>
  );
}

const ROLE_TONE = {
  super_admin: "info", school_admin: "info", teacher: "ok", parent: "muted", student: "muted", driver: "ok", org_admin: "info",
} as const;

const ROLE_LABEL = {
  super_admin: "Platform", school_admin: "Admin", teacher: "Teacher", parent: "Parent", student: "Student", driver: "Driver", org_admin: "Org admin",
} as const;

/** Descriptive only (FIG-357 v1) — a label, not yet a functional distinction. */
export const HIGHER_ED_SUBTYPE_LABEL: Record<HigherEdSubtype, string> = {
  university: "University", college: "College", short_course: "Short-course school", tvet: "TVET",
};

/** Descriptive + real nav/route gating for Fleet/Bus (FIG-358 v1) — attendance
 *  and timetable stay roll-call/fixed-grid regardless of this value. */
export const DELIVERY_MODE_LABEL: Record<"in_person" | "online" | "hybrid", string> = {
  in_person: "In-person", online: "Online", hybrid: "Hybrid",
};

/** `tenant` is only needed to resolve "Teacher"->"Lecturer" etc for higher-ed
 *  tenants; platform-wide screens with no tenant in scope get the K-12 default. */
export function RoleBadge({ role, tenant }: { role: keyof typeof ROLE_LABEL; tenant?: Pick<Tenant, "institution_type" | "role_labels"> }) {
  const label = tenant && (role === "teacher" || role === "student" || role === "parent")
    ? roleLabel(tenant, role)
    : ROLE_LABEL[role];
  return <Badge tone={ROLE_TONE[role]}>{label}</Badge>;
}
