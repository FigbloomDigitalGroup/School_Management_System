import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { acquireClient } from "./db/tenantTransaction.js";
import { assertRuntimeRole } from "./db/roleAssert.js";
import { buildApp } from "./app.js";

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
    const app = await buildApp(config, pool);
    await app.listen({ host: config.host, port: config.port });
    console.log(`figbloom-api listening on http://${config.host}:${config.port}`);

    const shutdown = async () => {
      await app.close();
      await pool.end();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (err) {
    await pool.end().catch(() => undefined);
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
