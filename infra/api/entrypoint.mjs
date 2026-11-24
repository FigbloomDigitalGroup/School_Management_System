#!/usr/bin/env node
// Container entrypoint for the FigBloom API image. apps/api itself is unchanged: this file only turns what ECS
// injects (database host, port and name, plus the ONE password a process may hold) into the connection string
// that process reads, then starts it.
//
//   api                 the HTTP API as figbloom_app            (sets DATABASE_URL only)
//   worker              the background worker as figbloom_worker (sets WORKER_DATABASE_URL only)
//   release             as the owner: migrate, verify, give both runtime roles their login password,
//                       install the session-mint key if the database has none, then verify it.
//                       Runs before every API and worker task starts (an ECS init container) and is idempotent.
//   bootstrap-admin     as the owner: create the first platform administrator (needs BOOTSTRAP_ADMIN_EMAIL and
//                       FIGBLOOM_BOOTSTRAP_CONFIRM=yes; prints a single-use 30-minute setup token)
//   session-hmac ARGS   as the owner: apps/api/scripts/session-hmac.mjs (status, verify, rotate, retire, purge-nonces)
//
// Secrets never go in argv and nothing here prints one. A child process gets only the variables it needs.
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { setRolePasswords } from "./ops/rolePasswords.mjs";

const API_DIR = fileURLToPath(new URL("../../apps/api/", import.meta.url));
const DEFAULT_CA = fileURLToPath(new URL("../../certs/rds-global-bundle.pem", import.meta.url));

/** Every variable that holds a secret. Removed from any environment that does not need it. */
const SECRET_VARS = [
  "OWNER_DB_USERNAME",
  "OWNER_DB_PASSWORD",
  "APP_DB_PASSWORD",
  "WORKER_DB_PASSWORD",
  "SESSION_MINT_HMAC_KEY",
  "IDEMPOTENCY_FINGERPRINT_KEY",
  "MFA_ENCRYPTION_KEY",
  "DATABASE_URL",
  "WORKER_DATABASE_URL",
  "MIGRATION_DATABASE_URL",
];

function die(message, code = 1) {
  process.stderr.write(`entrypoint: ${message}\n`);
  process.exit(code);
}

function required(name) {
  const value = process.env[name];
  if (!value) die(`${name} is not set`);
  return value;
}

/** postgresql://user:pass@host:port/db with verified TLS against the RDS certificate bundle. */
function dbUrl(user, password) {
  const host = required("DB_HOST");
  const port = process.env.DB_PORT || "5432";
  const name = required("DB_NAME");
  const ca = process.env.DB_SSL_ROOT_CERT || DEFAULT_CA;
  return (
    `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(name)}` +
    `?sslmode=verify-full&sslrootcert=${encodeURIComponent(ca)}`
  );
}

/** The current environment without any secret, plus `extra`. */
function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of SECRET_VARS) delete env[name];
  return { ...env, ...extra };
}

/** Runs node on a file inside apps/api and stops the entrypoint if it fails. Returns its stdout when captured. */
function runNode(relPath, args, env, { capture = false } = {}) {
  const result = spawnSync(process.execPath, [join(API_DIR, relPath), ...args], {
    cwd: API_DIR,
    env,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
  if (result.error) die(`could not start ${relPath}`);
  return { status: result.status ?? 1, stdout: capture ? result.stdout : "" };
}

function mustSucceed({ status }, what) {
  if (status !== 0) die(`${what} failed (exit ${status})`, status || 1);
}

/** Replace this process's environment with `next`, so the in-process API/worker sees nothing else. */
function replaceEnv(next) {
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, next);
}

async function release() {
  const ownerUrl = dbUrl(required("OWNER_DB_USERNAME"), required("OWNER_DB_PASSWORD"));
  const appPassword = required("APP_DB_PASSWORD");
  const workerPassword = required("WORKER_DB_PASSWORD");
  const hmacKey = required("SESSION_MINT_HMAC_KEY");
  const keyId = process.env.SESSION_HMAC_KEY_ID || "prod-1";
  const ownerEnv = childEnv({ MIGRATION_DATABASE_URL: ownerUrl });

  mustSucceed(runNode("dist/db/migrate.js", [], ownerEnv), "migrate");
  mustSucceed(runNode("dist/db/migrate.js", ["--verify"], ownerEnv), "migrate --verify");
  await setRolePasswords(ownerUrl, [
    ["figbloom_app", appPassword],
    ["figbloom_worker", workerPassword],
  ]);

  // Install the session-mint key only when the database has none. A mismatch is never "fixed" here:
  // rotation is a deliberate operator step (apps/api/docs/SESSION-HMAC-PROVISIONING.md).
  const hmacEnv = { ...ownerEnv, SESSION_MINT_HMAC_KEY: hmacKey };
  let check = runNode("scripts/session-hmac.mjs", ["verify"], hmacEnv, { capture: true });
  if (check.stdout.includes("verify: no_secret")) {
    mustSucceed(runNode("scripts/session-hmac.mjs", ["provision", "--key-id", keyId, "--from-env"], hmacEnv), "session-hmac provision");
    check = runNode("scripts/session-hmac.mjs", ["verify"], hmacEnv, { capture: true });
  }
  if (check.status !== 0 || !check.stdout.includes("verify: ok")) {
    die(`the session-mint key in the secret store does not match the database (${check.stdout.trim() || "no answer"})`, 2);
  }
  process.stdout.write("release: ok\n");
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  switch (mode) {
    case "api": {
      const url = dbUrl("figbloom_app", required("APP_DB_PASSWORD"));
      const keep = {
        SESSION_MINT_HMAC_KEY: required("SESSION_MINT_HMAC_KEY"),
        IDEMPOTENCY_FINGERPRINT_KEY: required("IDEMPOTENCY_FINGERPRINT_KEY"),
        MFA_ENCRYPTION_KEY: required("MFA_ENCRYPTION_KEY"),
      };
      replaceEnv(childEnv({ ...keep, DATABASE_URL: url }));
      await import(pathToFileURL(join(API_DIR, "dist/index.js")).href);
      return;
    }
    case "worker": {
      const url = dbUrl("figbloom_worker", required("WORKER_DB_PASSWORD"));
      replaceEnv(childEnv({ WORKER_DATABASE_URL: url }));
      await import(pathToFileURL(join(API_DIR, "dist/worker/index.js")).href);
      return;
    }
    case "release":
      await release();
      return;
    case "bootstrap-admin": {
      const ownerUrl = dbUrl(required("OWNER_DB_USERNAME"), required("OWNER_DB_PASSWORD"));
      mustSucceed(runNode("scripts/bootstrap-admin.mjs", [], childEnv({ MIGRATION_DATABASE_URL: ownerUrl })), "bootstrap-admin");
      return;
    }
    case "session-hmac": {
      const ownerUrl = dbUrl(required("OWNER_DB_USERNAME"), required("OWNER_DB_PASSWORD"));
      const extra = { MIGRATION_DATABASE_URL: ownerUrl };
      if (process.env.SESSION_MINT_HMAC_KEY) extra.SESSION_MINT_HMAC_KEY = process.env.SESSION_MINT_HMAC_KEY;
      if (process.env.SESSION_MINT_HMAC_KEY_NEW) extra.SESSION_MINT_HMAC_KEY_NEW = process.env.SESSION_MINT_HMAC_KEY_NEW;
      const { status } = runNode("scripts/session-hmac.mjs", args, childEnv(extra));
      process.exitCode = status;
      return;
    }
    default:
      die(`unknown mode "${mode ?? ""}" (api | worker | release | bootstrap-admin | session-hmac)`, 64);
  }
}

main().catch((err) => {
  // Driver errors can quote connection details; print the class and code only.
  die(`failed: ${err instanceof Error ? err.name : typeof err}${err && err.code ? ` (${err.code})` : ""}${err instanceof Error && /^(role|the password)/.test(err.message) ? `: ${err.message}` : ""}`);
});
