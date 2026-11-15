import type pg from "pg";

/**
 * Transaction-local tenant / user context for RLS (AD-2 / AD-3).
 * Always uses set_config(..., is_local=true) so a pooled connection cannot
 * leak context after COMMIT or ROLLBACK.
 *
 * There is no application-controlled bypass or owner GUC. Policies must not
 * read a mode setting. A client that sets one changes nothing.
 */
export async function setTenantContext(
  client: pg.PoolClient,
  input: { tenantId?: string | null; userId?: string | null },
): Promise<void> {
  await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [input.tenantId ?? ""]);
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [input.userId ?? ""]);
}

/** Phase 1: authenticated user only. Tenant stays empty until authorisation passes. */
export async function setUserContextOnly(client: pg.PoolClient, userId: string): Promise<void> {
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
  await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [""]);
}

function timeoutMs(name: string, value: number): string {
  if (!Number.isInteger(value) || value <= 0 || value > 120_000) {
    throw new Error(`Invalid transaction limit ${name}`);
  }
  return String(value);
}

/**
 * Per-transaction server limits (AD-6).
 * SET LOCAL via set_config is pooler-safe in transaction mode. Startup
 * parameters are not used because some poolers reject them.
 * These are not an acquisition timeout and not a whole-request deadline.
 */
export async function applyTransactionLimits(
  client: pg.PoolClient,
  limits: {
    statementTimeoutMs: number;
    lockTimeoutMs: number;
    idleInTransactionSessionTimeoutMs: number;
  },
  /** Per-transaction application_name token so an abort can address exactly this transaction (F-C3). */
  applicationName?: string,
): Promise<void> {
  // One statement: three limits (and optionally the cancel token), transaction-local.
  const values = [
    timeoutMs("statementTimeoutMs", limits.statementTimeoutMs),
    timeoutMs("lockTimeoutMs", limits.lockTimeoutMs),
    timeoutMs("idleInTransactionSessionTimeoutMs", limits.idleInTransactionSessionTimeoutMs),
  ];
  if (applicationName === undefined) {
    await client.query(
      `SELECT set_config('statement_timeout', $1, true),
              set_config('lock_timeout', $2, true),
              set_config('idle_in_transaction_session_timeout', $3, true)`,
      values,
    );
    return;
  }
  await client.query(
    `SELECT set_config('statement_timeout', $1, true),
            set_config('lock_timeout', $2, true),
            set_config('idle_in_transaction_session_timeout', $3, true),
            set_config('application_name', $4, true)`,
    [...values, applicationName],
  );
}
