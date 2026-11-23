import { loadConfig, loadDotEnvForLocal } from "./config.js";
import { createPool, runtimePoolOptions } from "./db/pool.js";
import { acquireClient } from "./db/tenantTransaction.js";
import { assertRuntimeRole } from "./db/roleAssert.js";
import { startServer } from "./server.js";
import { describeError, logError, logInfo } from "./log.js";

async function main(): Promise<void> {
  loadDotEnvForLocal();
  const config = loadConfig();
  const pool = createPool(runtimePoolOptions(config));
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
  logInfo("listening", { outcome: "ready" });

  const stop = (reason: string) => {
    void server.shutdown(reason).then((code) => process.exit(code));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  // An unhandled failure leaves the process in an unknown state: stop serving and exit non-zero.
  const fatal = (kind: string, err: unknown) => {
    logError(kind, describeError(err));
    void server.shutdown(kind).then(() => process.exit(1));
  };
  process.on("unhandledRejection", (err) => fatal("unhandledRejection", err));
  process.on("uncaughtException", (err) => fatal("uncaughtException", err));
}

main().catch((err) => {
  // Our own configuration and role-assertion errors name the violated property, never a value.
  // Anything else (a driver error) is reported by class and SQLSTATE only.
  const safe = err instanceof Error && /^(Invalid (API|migrate) config|Unsafe runtime role)/.test(err.message);
  logError("startup_failed", { ...(safe ? { reason: (err as Error).message } : {}), ...describeError(err) });
  process.exitCode = 1;
});
