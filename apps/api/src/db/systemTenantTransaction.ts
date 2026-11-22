import type pg from "pg";
import { createTxHandle, type Tx } from "./sql.js";
import { applyTransactionLimits, setTenantContext } from "./tenantContext.js";
import { acquireClient, guardedRollback, DEFAULT_TRANSACTION_LIMITS, type TransactionLimits } from "./tenantTransaction.js";
import { releaseClient } from "./clientHealth.js";

/**
 * A tenant-scoped transaction with NO user session (Stage 11): the M-Pesa callback (figbloom_app pool)
 * and worker jobs (figbloom_worker pool). The tenant MUST come from trusted server state (the
 * provider-checkout lookup or a claimed job row), never from request input. Context is set with
 * set_config(..., true): transaction-local, so COMMIT, ROLLBACK or a dropped connection clears it and a
 * pooled connection never carries it to the next caller. RLS applies as usual.
 */
export async function withSystemTenantTransaction<T>(
  pool: pg.Pool,
  input: { tenantId: string; userId?: string | null; limits?: TransactionLimits; acquireTimeoutMs?: number },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await acquireClient(pool, input.acquireTimeoutMs ?? 2_000);
  let result: T;
  try {
    await client.query("BEGIN");
    await applyTransactionLimits(client, input.limits ?? DEFAULT_TRANSACTION_LIMITS);
    await setTenantContext(client, { tenantId: input.tenantId, userId: input.userId ?? null });
    result = await fn(createTxHandle(client, { tenantId: input.tenantId, userId: input.userId ?? "" }));
    await client.query("COMMIT");
  } catch (err) {
    try {
      await guardedRollback(client, err);
    } finally {
      releaseClient(client);
    }
    throw err;
  }
  releaseClient(client);
  return result;
}
