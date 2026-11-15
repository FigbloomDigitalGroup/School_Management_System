import pg from "pg";
import type { SqlClient } from "./sql.js";
import { describeError, logError } from "../log.js";

const { Pool } = pg;

/** Query surface for modules. Not a raw driver client. */
export type Db = SqlClient;

/** Runtime or migration pool. Constructed at the entrypoint and passed explicitly. */
export type AppPool = pg.Pool;

/** Session-level limits installed on every new connection (WP-A1 review R-01). */
export interface BaselineLimits {
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  idleInTransactionSessionTimeoutMs: number;
}

export interface CreatePoolOptions {
  connectionString: string;
  max?: number;
  applicationName: string;
  /** pg connection checkout backstop. The request path also races acquireClient. */
  connectionTimeoutMillis?: number;
  /**
   * Baseline session limits for the autocommit identity path (login, session lookup, rate
   * limiting, readiness). Tenant transactions override them with SET LOCAL for their own
   * duration and revert to this baseline afterwards. Omit only for the migration pool.
   */
  baseline?: BaselineLimits;
  /**
   * Client-side per-query read timeout. Backstop for a stalled network, where the server's
   * own timers cannot fire. Must exceed every server-side statement timeout.
   */
  queryTimeoutMs?: number;
}

function limitValue(name: string, value: number): string {
  if (!Number.isInteger(value) || value <= 0 || value > 120_000) {
    throw new Error(`Invalid connection limit ${name}`);
  }
  return String(value);
}

/**
 * A new pool every call. There is no process-wide singleton: the API and
 * migrate hold different credentials and must not share a pool.
 */
export function createPool(opts: CreatePoolOptions): pg.Pool {
  const baseline = opts.baseline;
  const values = baseline
    ? [
        limitValue("statementTimeoutMs", baseline.statementTimeoutMs),
        limitValue("lockTimeoutMs", baseline.lockTimeoutMs),
        limitValue("idleInTransactionSessionTimeoutMs", baseline.idleInTransactionSessionTimeoutMs),
      ]
    : undefined;
  const config: pg.PoolConfig & {
    verify?: (client: pg.PoolClient, done: (err?: Error) => void) => void;
  } = {
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 2_000,
    application_name: opts.applicationName,
    ...(opts.queryTimeoutMs ? { query_timeout: opts.queryTimeoutMs } : {}),
    // Runs once per NEW connection, before it is handed out. A failure destroys the
    // connection and fails the checkout, so a connection without limits is never used.
    // Session-level (not startup parameters) so poolers that reject unknown startup
    // parameters still work; the values are identical for every client of this pool.
    ...(values
      ? {
          verify: (client: pg.PoolClient, done: (err?: Error) => void) => {
            client
              .query(
                `SELECT set_config('statement_timeout', $1, false),
                        set_config('lock_timeout', $2, false),
                        set_config('idle_in_transaction_session_timeout', $3, false)`,
                values,
              )
              .then(() => done(), (err: Error) => done(err));
          },
        }
      : {}),
  };
  const pool = new Pool(config);
  pool.on("error", (err) => {
    logError("db_idle_client_error", describeError(err));
  });
  return pool;
}

/** Pool options for the API process: every limit comes from configuration (WP-A1 review R-01). */
export function runtimePoolOptions(
  config: {
    databaseUrl: string;
    poolMax: number;
    applicationName: string;
    poolAcquireTimeoutMs: number;
    identityStatementTimeoutMs: number;
    identityLockTimeoutMs: number;
    idleInTransactionSessionTimeoutMs: number;
    clientQueryTimeoutMs: number;
  },
  overrides: { connectionString?: string; applicationName?: string } = {},
): CreatePoolOptions {
  return {
    connectionString: overrides.connectionString ?? config.databaseUrl,
    max: config.poolMax,
    applicationName: overrides.applicationName ?? config.applicationName,
    connectionTimeoutMillis: config.poolAcquireTimeoutMs,
    baseline: {
      statementTimeoutMs: config.identityStatementTimeoutMs,
      lockTimeoutMs: config.identityLockTimeoutMs,
      idleInTransactionSessionTimeoutMs: config.idleInTransactionSessionTimeoutMs,
    },
    queryTimeoutMs: config.clientQueryTimeoutMs,
  };
}
