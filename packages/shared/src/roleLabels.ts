import type { Tenant } from "./types";

/**
 * Per-tenant display labels for roles/relationships that read differently
 * across institution types ("Teacher" vs "Lecturer"). This is presentation
 * only — Role itself (the enum used for routing/RLS) never changes.
 *
 * "class_teacher" is the K-12 homeroom-owner concept, not a role — it has no
 * default for higher_ed because higher-ed screens don't render it at all
 * (there is no homeroom-equivalent; see teacher/Classes.tsx and
 * admin/Classes.tsx, which are K-12-only screens).
 */
export type RoleLabelKey = "teacher" | "class_teacher" | "student" | "parent";

const DEFAULTS_BY_TYPE: Record<Tenant["institution_type"], Record<RoleLabelKey, string>> = {
  k12: { teacher: "Teacher", class_teacher: "Class teacher", student: "Student", parent: "Parent" },
  higher_ed: { teacher: "Lecturer", class_teacher: "Class teacher", student: "Student", parent: "Guardian" },
};

export function roleLabel(tenant: Pick<Tenant, "institution_type" | "role_labels">, key: RoleLabelKey): string {
  return tenant.role_labels?.[key] ?? DEFAULTS_BY_TYPE[tenant.institution_type][key];
}

export const isHigherEd = (tenant: Pick<Tenant, "institution_type">): boolean =>
  tenant.institution_type === "higher_ed";
