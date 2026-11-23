#!/usr/bin/env node
/**
 * Owner-run provisioning and housekeeping for the session-mint HMAC (migrations 014/015).
 *
 *   node scripts/session-hmac.mjs provision --key-id <id> (--generate-to <file> | --from-env)
 *   node scripts/session-hmac.mjs rotate    --key-id <new-id> (--generate-to <file> | --from-env)
 *   node scripts/session-hmac.mjs retire    --key-id <old-id>
 *   node scripts/session-hmac.mjs status
 *   node scripts/session-hmac.mjs verify               (checks SESSION_MINT_HMAC_KEY against the database)
 *   node scripts/session-hmac.mjs purge-nonces [--batch N] [--max-batches M]
 *
 * Connection: MIGRATION_DATABASE_URL (the migrator/owner role). The runtime role cannot run any
 * of these functions. Nothing here reads DATABASE_URL.
 *
 * Secret handling:
 *   - --generate-to: 48 random bytes from crypto.randomBytes (CSPRNG) written base64url to a NEW
 *     file (exclusive create, mode 0600). The secret is never printed.
 *   - --from-env: the secret is read from SESSION_MINT_HMAC_KEY (provision) or
 *     SESSION_MINT_HMAC_KEY_NEW (rotate). It never appears in argv.
 *   - Output and error text never contain the secret. Database errors are reduced to the
 *     function's own static message (or a generic line).
 *   - The documented local/test development key is refused.
 *
 * Provisioning is idempotent for the exact same key and refuses to replace an existing one.
 * Rotation adds a second active key (both verify); retire removes the old one afterwards.
 * Neither affects existing sessions (they are validated by token hash, not by the HMAC).
 */
import { createHmac, randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, unlinkSync, writeSync } from "node:fs";
import pg from "pg";

// Keep identical to LOCAL_SESSION_MINT_HMAC_KEY in src/modules/auth/sessionProof.ts
// (a test asserts they match). It is a documented development key, refused here.
const LOCAL_DEV_KEY = "figbloom-local-session-mint-hmac-key-do-not-use-in-prod";

function fail(message, code = 1) {
  process.stderr.write(`session-hmac: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { flags: new Set(), values: {} };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) fail(`unexpected argument "${a}"`);
    const name = a.slice(2);
    if (["from-env"].includes(name)) opts.flags.add(name);
    else {
      const v = rest[++i];
      if (v === undefined || v.startsWith("--")) fail(`--${name} needs a value`);
      opts.values[name] = v;
    }
  }
  return { command, ...opts };
}

function validateKeyId(id) {
  if (!id || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) fail("--key-id must be 1-64 characters of [A-Za-z0-9._-]");
  return id;
}

function validateSecret(secret) {
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 256) {
    fail("the secret must be 32-256 characters");
  }
  if (secret === LOCAL_DEV_KEY) fail("refusing the documented local/test development key");
  if (/\s/.test(secret)) fail("the secret must not contain whitespace");
}

/** Returns { secret, file } where file is set only when generated. */
function obtainSecret({ flags, values }, envName) {
  if (flags.has("from-env") === Boolean(values["generate-to"])) {
    fail("choose exactly one of --from-env or --generate-to <file>");
  }
  if (flags.has("from-env")) {
    const secret = process.env[envName];
    if (!secret) fail(`${envName} is not set`);
    validateSecret(secret);
    return { secret, file: null };
  }
  const file = values["generate-to"];
  if (existsSync(file)) fail("refusing to overwrite an existing file");
  const secret = randomBytes(48).toString("base64url"); // 64 characters
  let fd;
  try {
    fd = openSync(file, "wx", 0o600); // exclusive create, owner-only on POSIX
    writeSync(fd, secret + "\n");
  } catch {
    fail("could not create the output file");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return { secret, file };
}

async function connect() {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) fail("MIGRATION_DATABASE_URL is required (the migrator/owner connection)");
  const client = new pg.Client({ connectionString: url, application_name: "figbloom-session-hmac" });
  try {
    await client.connect();
  } catch {
    fail("could not connect to the database");
  }
  return client;
}

/** Runs one owner function that takes a secret. Never echoes parameters or driver detail. */
async function callWithSecret(client, sql, params) {
  await client.query("BEGIN");
  try {
    // Best effort: keep bound parameters out of the server log for this transaction. Needs a
    // privileged role; if it is not allowed the operator must ensure statement logging is off.
    await client.query("SAVEPOINT quiet");
    try {
      await client.query("SELECT set_config('log_parameter_max_length', '0', true)");
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT quiet");
    }
    await client.query(sql, params);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    // Our functions raise static messages with SQLSTATE P0001; anything else is reduced.
    const message = err && err.code === "P0001" && typeof err.message === "string" ? err.message : "database error";
    throw new Error(message);
  }
}

function describeNoSecret(file) {
  if (file) {
    process.stdout.write(
      `secret written to ${file} (mode 0600 where supported). Move it into your secret manager as ` +
        `SESSION_MINT_HMAC_KEY, then securely delete the file.\n`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { command } = args;
  if (!command) fail("usage: provision | rotate | retire | status | verify | purge-nonces");

  if (command === "provision" || command === "rotate") {
    const keyId = validateKeyId(args.values["key-id"]);
    const envName = command === "provision" ? "SESSION_MINT_HMAC_KEY" : "SESSION_MINT_HMAC_KEY_NEW";
    const { secret, file } = obtainSecret(args, envName);
    const client = await connect();
    try {
      const fn = command === "provision" ? "auth_install_session_hmac_secret" : "auth_rotate_session_hmac_secret";
      await callWithSecret(client, `SELECT public.${fn}($1::text, $2::text)`, [keyId, secret]);
      process.stdout.write(`${command}: ok (key id ${keyId})\n`);
      describeNoSecret(file);
    } catch (err) {
      if (file) {
        try {
          unlinkSync(file);
        } catch {
          /* best effort: the file holds a secret the database never accepted */
        }
      }
      fail(`${command} failed: ${err.message}`);
    } finally {
      await client.end().catch(() => undefined);
    }
    return;
  }

  const client = await connect();
  try {
    if (command === "retire") {
      const keyId = validateKeyId(args.values["key-id"]);
      try {
        await client.query("SELECT public.auth_retire_session_hmac_secret($1::text)", [keyId]);
      } catch (err) {
        fail(`retire failed: ${err && err.code === "P0001" ? err.message : "database error"}`);
      }
      process.stdout.write(`retire: ok (key id ${keyId})\n`);
    } else if (command === "status") {
      const keys = await client.query(
        "SELECT key_id, created_at, revoked_at FROM public.auth_session_hmac_secrets ORDER BY created_at",
      );
      const nonces = await client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE expires_at < now() AND consumed_at < now() - interval '1 hour')::int AS purgeable
           FROM public.auth_session_proof_nonces`,
      );
      process.stdout.write(`keys: ${keys.rowCount}\n`);
      for (const k of keys.rows) {
        process.stdout.write(
          `  ${k.key_id}  created ${new Date(k.created_at).toISOString()}  ${k.revoked_at ? "retired " + new Date(k.revoked_at).toISOString() : "ACTIVE"}\n`,
        );
      }
      process.stdout.write(`nonces: ${nonces.rows[0].total} (purgeable ${nonces.rows[0].purgeable})\n`);
    } else if (command === "verify") {
      const key = process.env.SESSION_MINT_HMAC_KEY;
      if (!key) fail("SESSION_MINT_HMAC_KEY is not set");
      validateSecret(key);
      const nonce = randomBytes(24).toString("base64url");
      const mac = createHmac("sha256", key).update(`v1|selftest|${nonce}`, "utf8").digest("hex");
      const res = await client.query("SELECT public.auth_session_hmac_status($1::text, $2::text) AS status", [
        nonce,
        mac,
      ]);
      const status = res.rows[0].status;
      process.stdout.write(`verify: ${status}\n`);
      if (status !== "ok") process.exitCode = 2;
    } else if (command === "purge-nonces") {
      const batch = Number(args.values.batch ?? 1000);
      const maxBatches = Number(args.values["max-batches"] ?? 50);
      if (!Number.isInteger(batch) || batch < 1 || batch > 10000) fail("--batch must be 1-10000");
      if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 1000) fail("--max-batches must be 1-1000");
      let total = 0;
      for (let i = 0; i < maxBatches; i++) {
        const r = await client.query("SELECT public.auth_purge_session_proof_nonces($1::int) AS n", [batch]);
        const n = r.rows[0].n;
        total += n;
        if (n < batch) break;
      }
      process.stdout.write(`purge-nonces: removed ${total}\n`);
    } else {
      fail(`unknown command "${command}"`);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch(() => fail("unexpected error"));
