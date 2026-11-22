# Test database safety (fail-closed)

The API test suite runs `DROP SCHEMA public CASCADE` on its target (`resetDatabase`, `migrate.*` tests). On
2026-11-20 an interrupted run did exactly that to the development stack's `figbloom_api` database (port 58322),
because the old guard accepted any loopback host with a database called `figbloom_api` and `apps/api/.env` pointed
there. The guard is now structural. A destructive target is accepted only if **all** of these hold:

1. loopback host and database name `figbloom_api`;
2. the port is not a development/default port (`5432, 54322, 58322, 15432, 25432`);
3. the **process environment** explicitly designates it: `FIGBLOOM_TEST_DB_DESIGNATION=<host>:<port>/<db>`
   (never inferred from `.env`);
4. the database carries the marker `COMMENT ON DATABASE … IS 'figbloom:disposable-test-db:v1'`, verified over the
   live connection before any destructive statement (`test/support/testTarget.ts`, vitest `globalSetup`).

Every check fails closed (missing URL, wrong port, undesignated, unmarked). The identity is logged without
credentials: `[test-target] destructive tests will run against 127.0.0.1:59822/figbloom_api (marker verified)`.
There is no default URL left in any test file.

## One-time designation (operator action, throwaway databases only)

```
MIGRATION_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/figbloom_api node apps/api/scripts/designate-test-db.mjs
```
The script itself refuses development ports. Never designate a database whose contents you need.

## Safe test command

```
cd apps/api
export FIGBLOOM_TEST_DB_DESIGNATION=127.0.0.1:59822/figbloom_api
export MIGRATION_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:59822/figbloom_api
export DATABASE_URL=postgresql://figbloom_app:<placeholder>@127.0.0.1:59822/figbloom_api   # the suite sets the role's test password itself
npx vitest run
```
Process-environment variables take precedence over `apps/api/.env` (`config.ts`), so the `.env` values are never
used for a destructive run. Do **not** point these at the dev stack; the guard will refuse it.
