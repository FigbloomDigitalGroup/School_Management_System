/**
 * Admin areas (20261031000000): a teacher or other staff member can hold
 * parts of the admin console (people, fees, ...), granted by a full admin.
 * The functions here run as the service role, where has_perm() has no
 * auth.uid() to answer for, so they read staff_permissions directly with
 * the same rule: the holder is a teacher or other staff member at that
 * school. Full admins (school_admin, org admins, super admins) are checked
 * by each function the way it always did.
 */

export type AdminArea =
  | "people" | "fees" | "academics" | "attendance" | "transport" | "communication"
  | "inventory" | "activities" | "visitors" | "medical" | "leave" | "audit";

export interface Caller {
  id: string;
  role?: string | null;
  tenant_id?: string | null;
}

/** The areas of the school roles this person holds there (school_roles, staff_role_assignments). */
// deno-lint-ignore no-explicit-any
async function roleAreas(admin: any, profileId: string, tenantId: string | null): Promise<string[] | null> {
  let held = admin.from("staff_role_assignments").select("role_id").eq("profile_id", profileId);
  if (tenantId) held = held.eq("tenant_id", tenantId);
  const { data: assignments, error } = await held;
  if (error) return null;
  const ids = ((assignments ?? []) as { role_id: string }[]).map((a) => a.role_id);
  if (!ids.length) return [];
  let roles = admin.from("school_roles").select("areas").in("id", ids);
  if (tenantId) roles = roles.eq("tenant_id", tenantId);
  const { data, error: rolesError } = await roles;
  if (rolesError) return null;
  return ((data ?? []) as { areas: string[] | null }[]).flatMap((r) => r.areas ?? []);
}

/** Whether a teacher or other staff member holds this area at this school, directly or through a school role. */
// deno-lint-ignore no-explicit-any
export async function holdsArea(admin: any, caller: Caller, tenantId: string, area: AdminArea): Promise<boolean> {
  if (caller.role !== "teacher" && caller.role !== "staff") return false;
  if (!tenantId || caller.tenant_id !== tenantId) return false;
  const { data, error } = await admin.from("staff_permissions")
    .select("area").eq("profile_id", caller.id).eq("tenant_id", tenantId).eq("area", area).maybeSingle();
  if (!error && data) return true;
  return (await roleAreas(admin, caller.id, tenantId))?.includes(area) ?? false;
}

/**
 * Whether this person holds any admin area at all, directly or through a
 * role: a password reset never lets a people-area holder take over an
 * account with access of its own. Fails closed (a lookup error answers yes).
 */
// deno-lint-ignore no-explicit-any
export async function holdsAnyArea(admin: any, profileId: string): Promise<boolean> {
  const { data, error } = await admin.from("staff_permissions").select("area").eq("profile_id", profileId).limit(1);
  if (error || (data ?? []).length > 0) return true;
  const fromRoles = await roleAreas(admin, profileId, null);
  return fromRoles === null || fromRoles.length > 0;
}
