/**
 * Admin areas (20261030000000): a teacher or other staff member can hold
 * parts of the admin console (people, fees, ...), granted by a full admin.
 * The functions here run as the service role, where has_perm() has no
 * auth.uid() to answer for, so they read staff_permissions directly with
 * the same rule: the holder is a teacher or other staff member at that
 * school. Full admins (school_admin, org admins, super admins) are checked
 * by each function the way it always did.
 */

export type AdminArea =
  | "people" | "fees" | "academics" | "attendance" | "transport" | "communication"
  | "inventory" | "activities" | "visitors" | "medical" | "leave";

export interface Caller {
  id: string;
  role?: string | null;
  tenant_id?: string | null;
}

// deno-lint-ignore no-explicit-any
export async function holdsArea(admin: any, caller: Caller, tenantId: string, area: AdminArea): Promise<boolean> {
  if (caller.role !== "teacher" && caller.role !== "staff") return false;
  if (!tenantId || caller.tenant_id !== tenantId) return false;
  const { data, error } = await admin.from("staff_permissions")
    .select("area").eq("profile_id", caller.id).eq("tenant_id", tenantId).eq("area", area).maybeSingle();
  return !error && !!data;
}

/** Whether this person holds any admin area at all: a password reset never lets a people-area holder take over one. */
// deno-lint-ignore no-explicit-any
export async function holdsAnyArea(admin: any, profileId: string): Promise<boolean> {
  const { data, error } = await admin.from("staff_permissions").select("area").eq("profile_id", profileId).limit(1);
  return !!error || (data ?? []).length > 0;
}
