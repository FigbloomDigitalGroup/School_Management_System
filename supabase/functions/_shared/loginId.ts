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
};

export function formatLoginId(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(4, "0")}`;
}

export function loginIdEmail(loginId: string, tenantSlug: string): string {
  return `${loginId.toLowerCase()}@login.${tenantSlug}.figbloom.internal`;
}
