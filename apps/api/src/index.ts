import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { acquireClient } from "./db/tenantTransaction.js";
import { assertRuntimeRole } from "./db/roleAssert.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool({
    connectionString: config.databaseUrl,
    max: config.poolMax,
    applicationName: config.applicationName,
    connectionTimeoutMillis: config.poolAcquireTimeoutMs,
  });
  try {
    const client = await acquireClient(pool, config.poolAcquireTimeoutMs);
    try {
      await assertRuntimeRole(client, { expectedRole: config.runtimeRole });
    } finally {
      client.release();
    }
  } catch (err) {
    await pool.end().catch(() => undefined);
    throw err;
  }

  const server = await startServer(config, pool);
  console.log(`figbloom-api listening on http://${config.host}:${config.port}`);

  const stop = (reason: string) => {
    void server.shutdown(reason).then((code) => process.exit(code));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  // An unhandled failure leaves the process in an unknown state: stop serving and exit non-zero.
  const fatal = (kind: string, err: unknown) => {
    console.error(`[api] ${kind}:`, err instanceof Error ? err.name : "non-error");
    void server.shutdown(kind).then(() => process.exit(1));
  };
  process.on("unhandledRejection", (err) => fatal("unhandledRejection", err));
  process.on("uncaughtException", (err) => fatal("uncaughtException", err));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
