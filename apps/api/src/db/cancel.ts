import pg from "pg";
import { AppError } from "../http/errors.js";

/**
 * F-C3: request abort -> PostgreSQL query cancellation.
 *
 * Cancelling a JavaScript promise does NOT stop the server-side statement: a
 * client that disconnects mid-request would otherwise leave its query running
 * until statement_timeout and keep its transaction (and pooled connection)
 * busy. When the HTTP socket closes before the response is finished, the
 * request's AbortSignal fires and this module asks PostgreSQL to cancel the
 * in-flight statement; the transaction then rolls back through the normal
 * guarded path and the connection is released.
 *
 * The cancel is addressed by backend pid AND a per-transaction application_name
 * token (set with SET LOCAL semantics, so it disappears when the transaction
 * ends). A backend that has already finished this transaction and been reused
 * for another request carries a different (or no) token and is never cancelled.
 */
export class RequestAbortedError extends AppError {
  constructor() {
    // Never delivered: the socket is already closed. 499 keeps it out of 5xx dashboards.
    super(499, "internal_error", "Client closed the request", false);
    this.name = "RequestAbortedError";
  }
}

export const APPLICATION_NAME_PREFIX = "figbloom-api";

export function cancelToken(applicationName: string, requestToken: string): string {
  return `${applicationName}:${requestToken}`.slice(0, 63);
}

/** Best effort. Uses a short-lived side connection so a saturated pool cannot block the cancel. */
export async function cancelBackendQuery(
  pool: pg.Pool,
  processId: number,
  applicationNameToken: string,
): Promise<boolean> {
  const options = pool.options as { connectionString?: string; ssl?: unknown };
  const side = new pg.Client({
    connectionString: options.connectionString,
    ssl: options.ssl as pg.ClientConfig["ssl"],
    connectionTimeoutMillis: 2_000,
    application_name: "figbloom-api-cancel",
  });
  try {
    await side.connect();
    const r = await side.query<{ cancelled: boolean }>(
      `SELECT pg_cancel_backend(pid) AS cancelled
         FROM pg_stat_activity
        WHERE pid = $1 AND application_name = $2`,
      [processId, applicationNameToken],
    );
    return r.rows[0]?.cancelled === true;
  } catch {
    return false;
  } finally {
    await side.end().catch(() => undefined);
  }
}

/** PostgreSQL SQLSTATE for query_canceled (our own cancel or statement_timeout). */
export function isQueryCanceled(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: unknown }).code === "57014";
}
