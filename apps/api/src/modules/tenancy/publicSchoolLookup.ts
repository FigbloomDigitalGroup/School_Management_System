import type { IdentityDb } from "../../db/sql.js";

/**
 * Public school lookup by its exact address (docs/PUBLIC-SCHOOL-LOOKUP.md): the one thing the web needs to turn `/s/<slug>`
 * into the school id that `POST /v1/auth/login/login-id` takes. Exact match only: no list, no search, no prefix.
 */

/** The shape of a school address (the `tenants.slug` CHECK). Anything else is refused before the database is touched. */
export const SCHOOL_SLUG_PATTERN = "^[a-z0-9-]{3,40}$";
export const SCHOOL_SLUG_RE = new RegExp(SCHOOL_SLUG_PATTERN);

/**
 * The school statuses a person can sign in to, as on Supabase (`supabase/functions/_shared/signInStatuses.ts`): active, on
 * trial, or with an overdue invoice. A school that is onboarding, stalled in setup or suspended is "not found", with exactly
 * the same answer as an address nobody has.
 */
export const LOOKUP_SCHOOL_STATUSES = ["active", "trial", "overdue"] as const;

/**
 * One indexed read (`tenants.slug` is UNIQUE) whatever the answer, and the status filter is inside the same statement, so a
 * school that is not open for sign-in never leaves the database: unknown and not-open take the same path from here on.
 * Only the id and the name are selected. `tenants` is an identity-plane table the runtime role already reads with no tenant
 * context (the login-id path does the same), so this needs no definer function and no new grant.
 */
export async function findSchoolBySlug(db: IdentityDb, slug: string): Promise<{ tenant_id: string; name: string } | null> {
  const r = await db.query<{ tenant_id: string; name: string }>(
    `SELECT t.id AS tenant_id, t.name FROM tenants t WHERE t.slug = $1 AND t.status IN ('active', 'trial', 'overdue')`,
    [slug],
  );
  const row = r.rows[0];
  return row ? { tenant_id: row.tenant_id, name: row.name } : null;
}
