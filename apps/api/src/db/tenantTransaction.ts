import type pg from "pg";
import { createIdentityHandle, createTxHandle, type IdentityDb, type Tx } from "./sql.js";
import { applyTransactionLimits, setTenantContext, setUserContextOnly } from "./tenantContext.js";
import { getDenialAudit, poolAcquireTimeoutError, type DenialAuditPayload } from "./errors.js";
import { recordSecurityEvent } from "../modules/audit/audit.js";
import { describeError, logError } from "../log.js";
import { isConnectionFailure, markPoisoned, releaseClient } from "./clientHealth.js";
import { randomUUID } from "node:crypto";
import {
  APPLICATION_NAME_PREFIX,
  cancelBackendQuery,
  cancelToken,
  isQueryCanceled,
  RequestAbortedError,
} from "./cancel.js";

export interface TransactionLimits {
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  idleInTransactionSessionTimeoutMs: number;
}

export const DEFAULT_TRANSACTION_LIMITS: TransactionLimits = {
  statementTimeoutMs: 15_000,
  lockTimeoutMs: 5_000,
  idleInTransactionSessionTimeoutMs: 15_000,
};

export const DEFAULT_ACQUIRE_TIMEOUT_MS = 2_000;

export interface TenantTransactionInput {
  userId: string;
  /** Candidate tenant. Not an authorisation claim until `authorize` returns. */
  requestedTenantId: string;
  /**
   * Runs after app.user_id is set and before app.tenant_id is set.
   * May read identity-plane tables and the caller's own school_memberships.
   */
  authorize: (db: IdentityDb) => Promise<void>;
  limits?: TransactionLimits;
  acquireTimeoutMs?: number;
  ip?: string | null;
  /**
   * Fires when the HTTP client goes away before the response is finished (F-C3).
   * The in-flight statement is cancelled in PostgreSQL, the transaction rolls
   * back and the connection is released. Not set for non-HTTP callers.
   */
  signal?: AbortSignal;
}

/**
 * Acquire a pool client with a hard timeout (AD-6). This is not a transaction timeout.
 */
export async function acquireClient(pool: pg.Pool, acquireTimeoutMs: number): Promise<pg.PoolClient> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clientPromise = pool.connect();
  try {
    const client = await Promise.race([
      clientPromise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(poolAcquireTimeoutError()), acquireTimeoutMs);
      }),
    ]);
    return client;
  } catch (err) {
    // If connect wins the race after the timer fired, release it.
    void clientPromise.then((client) => client.release()).catch(() => undefined);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** ROLLBACK that never hides the original error. */
export async function guardedRollback(client: pg.PoolClient, original: unknown): Promise<never> {
  // A stalled or dead connection cannot take a ROLLBACK (it would queue behind the stuck
  // statement). Destroy it instead: closing the socket ends the transaction on the server.
  if (isConnectionFailure(original)) {
    markPoisoned(client);
    throw original;
  }
  try {
    await client.query("ROLLBACK");
  } catch (rollbackErr) {
    markPoisoned(client);
    const primary = original instanceof Error ? original.message : String(original);
    const secondary = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
    const wrapped = new Error(`Transaction failed (${primary}); rollback also failed (${secondary})`);
    const denial = getDenialAudit(original);
    if (denial) {
      (wrapped as { denialAudit?: DenialAuditPayload }).denialAudit = denial;
    }
    throw wrapped;
  }
  throw original;
}

function refuseContextChange(queryTextOrConfig: string | pg.QueryConfig): void {
  const text =
    typeof queryTextOrConfig === "string"
      ? queryTextOrConfig
      : String((queryTextOrConfig as { text?: string }).text ?? "");
  const upper = text.trim().toUpperCase();
  if (
    upper.startsWith("BEGIN") ||
    upper.startsWith("START TRANSACTION") ||
    upper.startsWith("SAVEPOINT") ||
    upper.startsWith("COMMIT") ||
    upper.startsWith("ROLLBACK") ||
    /SET_CONFIG\(\s*'APP\.(TENANT_ID|USER_ID)'/i.test(text) ||
    /SET\s+(LOCAL\s+|SESSION\s+)?app\.(tenant_id|user_id)/i.test(text)
  ) {
    throw new Error("Nested transaction or tenant re-scope is refused on Tx handles");
  }
}

async function persistDenialAudit(
  pool: pg.Pool,
  err: unknown,
  ip: string | null | undefined,
): Promise<void> {
  const denial = getDenialAudit(err);
  if (!denial) return;
  try {
    const identity = createIdentityHandle(pool);
    await recordSecurityEvent(identity, {
      eventType: denial.eventType,
      actorUserId: denial.actorUserId,
      tenantId: denial.tenantId,
      detail: denial.detail,
      ip: denial.ip ?? ip ?? null,
    });
  } catch (auditErr) {
    // The denial is still returned as 403; the failed audit write must stay visible (class + SQLSTATE only).
    logError("denial_audit_write_failed", { outcome: "after_rollback", ...describeError(auditErr) });
  }
}

/**
 * Sole tenant-scoped transaction (AD-3).
 *
 * 1. Acquire (bounded) → BEGIN → SET LOCAL limits.
 * 2. Set app.user_id only.
 * 3. Authorise the candidate tenant.
 * 4. Set app.tenant_id once. The handle exposes query only.
 * 5. Caller work (permissions + business) uses that context.
 * 6. COMMIT. Any error rolls back. Denial audits are written after release,
 *    on the autocommit identity path, so they survive the rollback.
 *
 * Residual: a SQL-injection bug could still call set_config. All application
 * SQL stays parameterised, and pg is importable only inside src/db.
 */
export async function withTenantTransaction<T>(
  pool: pg.Pool,
  input: TenantTransactionInput,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const limits = input.limits ?? DEFAULT_TRANSACTION_LIMITS;
  const acquireTimeoutMs = input.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const client = await acquireClient(pool, acquireTimeoutMs);

  let failure: unknown;
  let result: T | undefined;
  // Cancellation is only legal while this transaction is open and before COMMIT starts.
  let cancellable = false;
  let onAbort: (() => void) | undefined;
  try {
    await client.query("BEGIN");
    const signal = input.signal;
    if (signal) {
      const token = cancelToken(APPLICATION_NAME_PREFIX, randomUUID());
      await applyTransactionLimits(client, limits, token);
      const processId = (client as unknown as { processID?: number }).processID;
      cancellable = true;
      onAbort = () => {
        if (cancellable && typeof processId === "number") {
          void cancelBackendQuery(pool, processId, token);
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    } else {
      await applyTransactionLimits(client, limits);
    }
    await setUserContextOnly(client, input.userId);

    try {
      await input.authorize(createIdentityHandle(client));
    } catch (err) {
      await guardedRollback(client, err);
    }

    await setTenantContext(client, {
      userId: input.userId,
      tenantId: input.requestedTenantId,
    });

    const tx = createTxHandle(client, {
      tenantId: input.requestedTenantId,
      userId: input.userId,
    });
    const originalQuery = tx.query.bind(tx);
    tx.query = (async (queryTextOrConfig, values) => {
      refuseContextChange(queryTextOrConfig);
      return originalQuery(queryTextOrConfig, values);
    }) as Tx["query"];

    try {
      result = await fn(tx);
      // A request abandoned before COMMIT has no effect.
      if (input.signal?.aborted) throw new RequestAbortedError();
      cancellable = false;
      await client.query("COMMIT");
    } catch (err) {
      cancellable = false;
      await guardedRollback(
        client,
        input.signal?.aborted && isQueryCanceled(err) ? new RequestAbortedError() : err,
      );
    }
  } catch (err) {
    if (isConnectionFailure(err)) markPoisoned(client);
    failure = input.signal?.aborted && isQueryCanceled(err) ? new RequestAbortedError() : err;
  } finally {
    cancellable = false;
    if (onAbort && input.signal) input.signal.removeEventListener("abort", onAbort);
    releaseClient(client);
  }

  if (failure !== undefined) {
    await persistDenialAudit(pool, failure, input.ip);
    throw failure;
  }
  return result as T;
}
