import pg from "pg";
import type { SqlClient } from "./sql.js";
import { describeError, logError } from "../log.js";

const { Pool } = pg;

/** Query surface for modules. Not a raw driver client. */
export type Db = SqlClient;

/** Runtime or migration pool. Constructed at the entrypoint and passed explicitly. */
export type AppPool = pg.Pool;

export interface CreatePoolOptions {
  connectionString: string;
  max?: number;
  applicationName: string;
  /** pg connection checkout backstop. The request path also races acquireClient. */
  connectionTimeoutMillis?: number;
}

/**
 * A new pool every call. There is no process-wide singleton: the API and
 * migrate hold different credentials and must not share a pool.
 */
export function createPool(opts: CreatePoolOptions): pg.Pool {
  const pool = new Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 2_000,
    application_name: opts.applicationName,
  });
  pool.on("error", (err) => {
    logError("db_idle_client_error", describeError(err));
  });
  return pool;
}
