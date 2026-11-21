import pg from "pg";
import { loadDotEnvForLocal } from "../src/config.js";
import { assertDisposableMarker, assertIsolatedTestDatabase, describeTarget } from "./support/testTarget.js";

/**
 * Runs once before any test file. Fails the whole run (closed) unless the destructive target is an
 * explicitly designated, marker-verified disposable database. Logs the identity, never credentials.
 */
export default async function globalSetup(): Promise<void> {
  loadDotEnvForLocal();
  const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  assertIsolatedTestDatabase(ownerUrl);
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1, connectionTimeoutMillis: 5000 });
  try {
    await assertDisposableMarker(pool);
    console.log(`[test-target] destructive tests will run against ${describeTarget(ownerUrl!)} (marker verified)`);
  } finally {
    await pool.end();
  }
}
