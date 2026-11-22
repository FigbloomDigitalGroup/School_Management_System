import type { Tx } from "../../db/sql.js";

/**
 * The school's "today" as a calendar date (YYYY-MM-DD), derived from the school's own timezone (tenants.timezone, default
 * Africa/Nairobi, validated by migration 023). This is the ONE authoritative definition of "today" for school business rules:
 * the database session clock (CURRENT_DATE) and the server's UTC date are NOT school dates and must not be used for them.
 * Mirrors the SQL twin finance_school_today(tenant) used by finance, reporting, attendance and sign-out rules.
 */
export async function schoolToday(tx: Tx, tenantId: string): Promise<string> {
  const r = await tx.query<{ d: string }>(
    `SELECT (now() AT TIME ZONE COALESCE((SELECT t.timezone FROM public.tenants t WHERE t.id = $1), 'Africa/Nairobi'))::date::text AS d`,
    [tenantId],
  );
  return r.rows[0]!.d;
}
