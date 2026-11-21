import type { Db } from "../../db/pool.js";
import { conflict, forbidden, notFound, validationError } from "../../http/errors.js";

/**
 * Operator workflow for unmatched provider callbacks (migration 074). Every rule (operator-only, reason + evidence on resolution,
 * no money movement, evidence preserved, reopen on contradictory evidence, audit) lives in the SECURITY DEFINER functions; this
 * module only maps their outcomes onto safe API errors. Operators are platform super administrators (a quarantined callback has
 * no school).
 */
export type UnmatchedResolution = "provider_confirmed_not_ours" | "provider_confirmed_failed" | "duplicate_of_settled" | "other_evidenced";

function mapDb(err: unknown): never {
  const code = (err as { code?: string } | null)?.code;
  if (code === "42501") throw forbidden("Insufficient permissions");
  if (code === "55000") throw conflict("The case is not in a state that allows this action");
  if (code === "22023") throw validationError("Invalid request");
  throw err;
}

/** Reads the single scalar column `v` of a statement the CALLER wrote as a literal (the boundary detector must see every query). */
async function scalar<T>(run: () => Promise<{ rows: unknown[] }>): Promise<T> {
  try {
    const r = await run();
    return (r.rows[0] as Record<string, unknown>)["v"] as T;
  } catch (err) {
    return mapDb(err);
  }
}

export async function listUnmatched(
  db: Db,
  q: { status?: string | null; owner?: string | null; unassigned?: boolean; minAgeMinutes?: number | null; severity?: string | null; limit?: number },
): Promise<Record<string, unknown>[]> {
  try {
    const r = await db.query(`SELECT * FROM public.finance_unmatched_list($1::text, $2::uuid, $3::boolean, $4::int, $5::text, $6::int)`, [
      q.status ?? null,
      q.owner ?? null,
      q.unassigned ?? false,
      q.minAgeMinutes ?? null,
      q.severity ?? null,
      q.limit ?? 50,
    ]);
    return r.rows as Record<string, unknown>[];
  } catch (err) {
    return mapDb(err);
  }
}

export async function getUnmatched(db: Db, caseId: string): Promise<Record<string, unknown>> {
  const v = await scalar<Record<string, unknown> | null>(() => db.query(`SELECT public.finance_unmatched_get($1::uuid) AS v`, [caseId]));
  if (!v) throw notFound("Case not found");
  return v;
}

export async function assignUnmatched(db: Db, caseId: string, ownerUserId: string | null): Promise<void> {
  if (!(await scalar<boolean>(() => db.query(`SELECT public.finance_unmatched_assign($1::uuid, $2::uuid) AS v`, [caseId, ownerUserId])))) throw notFound("Case not found");
}

export async function noteUnmatched(db: Db, caseId: string, note: string): Promise<void> {
  if (!(await scalar<boolean>(() => db.query(`SELECT public.finance_unmatched_add_note($1::uuid, $2::text) AS v`, [caseId, note])))) throw notFound("Case not found");
}

export async function retryUnmatched(db: Db, caseId: string): Promise<{ outcome: string }> {
  const outcome = await scalar<string | null>(() => db.query(`SELECT public.finance_unmatched_retry($1::uuid) AS v`, [caseId]));
  if (!outcome) throw notFound("Case not found");
  return { outcome };
}

export async function escalateUnmatched(db: Db, caseId: string, reason: string): Promise<void> {
  if (!(await scalar<boolean>(() => db.query(`SELECT public.finance_unmatched_escalate($1::uuid, $2::text) AS v`, [caseId, reason])))) throw conflict("Only an open case can be escalated");
}

export async function resolveUnmatched(db: Db, caseId: string, input: { resolution: UnmatchedResolution; reason: string; evidence: string }): Promise<void> {
  if (!(await scalar<boolean>(() => db.query(`SELECT public.finance_unmatched_resolve($1::uuid, $2::text, $3::text, $4::text) AS v`, [caseId, input.resolution, input.reason, input.evidence])))) {
    throw notFound("Case not found");
  }
}

export async function reopenUnmatched(db: Db, caseId: string, reason: string): Promise<void> {
  if (!(await scalar<boolean>(() => db.query(`SELECT public.finance_unmatched_reopen($1::uuid, $2::text) AS v`, [caseId, reason])))) throw notFound("Case not found");
}
