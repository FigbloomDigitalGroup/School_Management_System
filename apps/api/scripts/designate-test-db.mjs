#!/usr/bin/env node
// Operator action: mark a THROWAWAY database as an allowed destructive test target.
//   MIGRATION_DATABASE_URL=postgresql://postgres:***@127.0.0.1:<port>/figbloom_api node scripts/designate-test-db.mjs
// Refuses development/default ports. Never run against a database whose contents you need.
import pg from "pg";

const FORBIDDEN_PORTS = new Set([5432, 54322, 58322, 15432, 25432]);
const MARKER = "figbloom:disposable-test-db:v1";
const raw = process.env.MIGRATION_DATABASE_URL;
if (!raw) {
  console.error("MIGRATION_DATABASE_URL is required");
  process.exit(2);
}
const url = new URL(raw);
const port = Number(url.port || "5432");
const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
if (!loopback || url.pathname !== "/figbloom_api" || FORBIDDEN_PORTS.has(port)) {
  console.error(`Refusing to designate ${url.hostname}:${port}${url.pathname}`);
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: raw, max: 1 });
await pool.query(`COMMENT ON DATABASE figbloom_api IS '${MARKER}'`);
await pool.end();
console.log(`designated ${url.hostname}:${port}${url.pathname} as a disposable test database`);
