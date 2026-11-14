import type pg from "pg";
import { createIdentityHandle, type IdentityDb } from "./sql.js";
import {
  acquireClient,
  DEFAULT_ACQUIRE_TIMEOUT_MS,
  DEFAULT_TRANSACTION_LIMITS,
  guardedRollback,
  type TransactionLimits,
} from "./tenantTransaction.js";
import { applyTransactionLimits, setTenantContext, setUserContextOnly } from "./tenantContext.js";

/**
 * Identity / pre-tenant database access (AD-3).
 *
 * Never sets a general tenant context for business data. It may set:
 * - app.user_id alone (self-read of school_memberships), or
 * - a one-shot scoping key for login-by-login-id (the request tenant UUID as
 *   app.tenant_id for that lookup only — a scoping key, not an authorisation claim).
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

/**
 * Login-by-login-id scoping. Sets the request tenant UUID as app.tenant_id
 * for the membership lookup only. Password verification remains the decision.
 */
export async function withLoginIdTenantScope<T>(
  pool: pg.Pool,
  input: { tenantId: string; limits?: TransactionLimits; acquireTimeoutMs?: number },
  fn: (db: IdentityDb) => Promise<T>,
): Promise<T> {
  const client = await acquireClient(pool, input.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS);
  const limits = input.limits ?? DEFAULT_TRANSACTION_LIMITS;
  try {
    await client.query("BEGIN");
    await applyTransactionLimits(client, limits);
    await setTenantContext(client, { tenantId: input.tenantId, userId: null });
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
