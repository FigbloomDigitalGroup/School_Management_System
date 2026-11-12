import { loadConfig } from "./config.js";
import { createPool, closePool } from "./db/pool.js";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  const app = await buildApp(config, pool);

  await app.listen({ host: config.host, port: config.port });
  console.log(`figbloom-api listening on http://${config.host}:${config.port}`);

  const shutdown = async () => {
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
