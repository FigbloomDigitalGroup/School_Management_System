import type pg from "pg";

/**
 * Pooled-connection health (WP-A1 review R-01).
 *
 * A timeout or a dead socket can leave a pooled connection in a state nobody can describe:
 * a statement still running on the server, a ROLLBACK queued behind it, a half-read reply.
 * Returning such a connection to the pool hands the next request a stalled backend, and a
 * pool whose clients are all stalled never recovers by itself.
 *
 * Rule: a connection that failed at the CLIENT level, or that still has work in flight when
 * its owner is done with it, is destroyed (pool.release(true)), never reused. Closing the
 * socket also ends any open transaction on the server. An ordinary database error
 * (SQLSTATE, including our own cancel and statement_timeout, 57014) leaves the connection
 * clean and it goes back to the pool.
 */
const poisoned = new WeakSet<object>();
const inFlight = new WeakMap<object, number>();

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** True for everything except a clean database error: read timeouts, resets, closed sockets, class 08 and 57P. */
export function isClientLevelFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return true;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && SQLSTATE.test(code)) {
    return code.startsWith("08") || code.startsWith("57P");
  }
  return true;
}

const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"]);

/**
 * A failure of the connection itself, as opposed to a clean database error or an application error
 * thrown by business code. Used where the thrown value may be either (transaction wrappers).
 */
export function isConnectionFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (isClientTimeout(err)) return true;
  const e = err as { code?: unknown; message?: unknown };
  if (typeof e.code === "string") {
    if (NETWORK_CODES.has(e.code)) return true;
    if (SQLSTATE.test(e.code)) return e.code.startsWith("08") || e.code.startsWith("57P");
  }
  return typeof e.message === "string" && /^Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error/i.test(e.message);
}

/** The driver's client-side read timeout (pg `query_timeout`). The server may still be running the statement. */
export function isClientTimeout(err: unknown): boolean {
  return err instanceof Error && err.message === "Query read timeout";
}

export function markPoisoned(client: object): void {
  poisoned.add(client);
}

export function isPoisoned(client: object): boolean {
  return poisoned.has(client);
}

/** Track one query on a pooled client: counts it while pending and poisons the client on a client-level failure. */
export async function trackQuery<T>(client: object, run: () => Promise<T>): Promise<T> {
  inFlight.set(client, (inFlight.get(client) ?? 0) + 1);
  try {
    return await run();
  } catch (err) {
    if (isClientLevelFailure(err)) markPoisoned(client);
    throw err;
  } finally {
    const n = (inFlight.get(client) ?? 1) - 1;
    if (n <= 0) inFlight.delete(client);
    else inFlight.set(client, n);
  }
}

/** Return the client to the pool, or destroy it when it must not be reused. Safe to call exactly once. */
export function releaseClient(client: pg.PoolClient): void {
  const unsafe = poisoned.has(client) || (inFlight.get(client) ?? 0) > 0;
  poisoned.delete(client);
  inFlight.delete(client);
  if (unsafe) client.release(true);
  else client.release();
}

/** Test seam: how many queries are tracked as pending on this client. */
export function pendingQueries(client: object): number {
  return inFlight.get(client) ?? 0;
}
