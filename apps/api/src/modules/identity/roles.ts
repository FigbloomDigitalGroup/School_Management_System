/** Business roles retained from the Phase 0 / legacy inventory. Do not invent new ones here. */
export const SCHOOL_ROLES = [
  "school_admin",
  "teacher",
  "parent",
  "student",
  "driver",
  "staff",
] as const;

export const PLATFORM_ROLES = ["super_admin"] as const;
export const ORG_ROLES = ["org_admin"] as const;

export type SchoolRole = (typeof SCHOOL_ROLES)[number];
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
export type OrgRole = (typeof ORG_ROLES)[number];
export type AppRole = SchoolRole | PlatformRole | OrgRole;

/** Retired gate roles from legacy — never assign in the replacement API. */
export const RETIRED_ROLES = ["guard", "receptionist"] as const;

export const ADMIN_AREAS = [
  "people",
  "fees",
  "academics",
  "attendance",
  "transport",
  "communication",
  "inventory",
  "activities",
  "visitors",
  "medical",
  "leave",
  "audit",
] as const;

export type AdminArea = (typeof ADMIN_AREAS)[number];

export function isAdminArea(value: string): value is AdminArea {
  return (ADMIN_AREAS as readonly string[]).includes(value);
}

export function isSchoolRole(value: string): value is SchoolRole {
  return (SCHOOL_ROLES as readonly string[]).includes(value);
}

export function mayHoldAdminAreas(role: string): boolean {
  return role === "teacher" || role === "staff";
}
