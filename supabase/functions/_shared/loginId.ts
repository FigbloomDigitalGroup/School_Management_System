/**
 * Mirrors ROLE_ID_PREFIX/formatLoginId/loginIdEmail in packages/shared/src/auth.ts.
 * Edge functions run on Deno and have no relative import path into the
 * workspace's packages/shared, so this is a deliberate, minimal duplicate —
 * keep it in sync with packages/shared/src/auth.ts by hand.
 */

export const ROLE_ID_PREFIX: Record<string, string> = {
  school_admin: "AD",
  teacher: "TC",
  parent: "PT",
  student: "ST",
  driver: "BD",
  guard: "GD",
  receptionist: "RC",
};

export function formatLoginId(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(4, "0")}`;
}

export function loginIdEmail(loginId: string, tenantSlug: string): string {
  return `${loginId.toLowerCase()}@login.${tenantSlug}.figbloom.internal`;
}

/**
 * The next free login ID for a role at a school: one past the highest number
 * already issued (next_login_number, 20261022000003), never "how many exist"
 * -- which reissued an existing ID after any account was deleted, and capped
 * out at the first 1000 rows. Throws if the lookup fails, so the caller can
 * refuse rather than guess.
 */
// deno-lint-ignore no-explicit-any
export async function nextLoginId(admin: any, tenantId: string, role: string): Promise<string> {
  const prefix = ROLE_ID_PREFIX[role];
  if (!prefix) throw new Error(`No login ID prefix for role "${role}"`);
  const { data, error } = await admin.rpc("next_login_number", { p_tenant_id: tenantId, p_role: role });
  if (error || typeof data !== "number") throw new Error(error?.message ?? "next_login_number returned nothing");
  return formatLoginId(prefix, data);
}
