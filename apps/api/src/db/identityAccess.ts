import type pg from "pg";
import { createIdentityHandle, type IdentityDb } from "./sql.js";
import {
  acquireClient,
  DEFAULT_ACQUIRE_TIMEOUT_MS,
  DEFAULT_TRANSACTION_LIMITS,
  guardedRollback,
  type TransactionLimits,
} from "./tenantTransaction.js";
import { applyTransactionLimits, setUserContextOnly } from "./tenantContext.js";

/**
 * Identity / pre-tenant database access (AD-3).
 *
 * Never sets a tenant context. The only context it may set is app.user_id alone
 * (self-read of school_memberships). Login by login id needs no context at all:
 * it reads credentials through an exact-key definer function (migration 011),
 * so the Stage C "request tenant as scoping key" window no longer exists.
 *
 * Without a matching context, tenant RLS returns zero rows.
 * Statements here are autocommit unless a scoped helper starts a transaction,
 * so rate-limit writes and failed-login events survive later rollbacks.
 */
export async function withIdentityAccess<T>(
  pool: pg.Pool,
  fn: (db: IdentityDb) => Promise<T>,
  opts?: { acquireTimeoutMs?: number },
): Promise<T> {
  const client = await acquireClient(pool, opts?.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS);
  try {
    return await fn(createIdentityHandle(client));
  } finally {
    client.release();
  }
}

/**
 * Short read-only-intent transaction that sets app.user_id so the caller can
 * read their own school_memberships (login by email, /auth/me, select-tenant).
 */
export async function withIdentityUserScope<T>(
  pool: pg.Pool,
  userId: string,
  fn: (db: IdentityDb) => Promise<T>,
  opts?: { acquireTimeoutMs?: number; limits?: TransactionLimits },
): Promise<T> {
  const client = await acquireClient(pool, opts?.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS);
  const limits = opts?.limits ?? DEFAULT_TRANSACTION_LIMITS;
  try {
    await client.query("BEGIN");
    await applyTransactionLimits(client, limits);
    await setUserContextOnly(client, userId);
    try {
      const result = await fn(createIdentityHandle(client));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      return await guardedRollback(client, err);
    }
  } finally {
    client.release();
  }
}
