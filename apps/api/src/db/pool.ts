import pg from "pg";
import type { AppConfig } from "../config.js";

const { Pool } = pg;

export type Db = pg.Pool | pg.PoolClient;

let pool: pg.Pool | null = null;

export function createPool(config: AppConfig): pg.Pool {
  if (pool) return pool;
  pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  // An idle client error must not become an unhandled 'error' event (process crash).
  pool.on("error", (err) => console.error("[api] idle pg client error:", err.message));
  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error("Database pool not initialised");
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}

export async function withTransaction<T>(
  db: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
