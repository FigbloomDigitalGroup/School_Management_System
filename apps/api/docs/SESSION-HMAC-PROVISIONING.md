# Session-mint HMAC: provisioning, rotation and housekeeping

> Applies to migrations 014 and 015. Owner-run procedure. **Nothing here has been run against a shared or production environment**; this document and `scripts/session-hmac.mjs` are tested against a disposable local PostgreSQL only (`test/sessionHmac.provisioning.test.ts`, `test/sessionProof.nonces.test.ts`).

## What the secret protects

Since migration 014 the runtime role (`figbloom_app`) cannot write `sessions`. Every session mint, revoke, revoke-all and tenant switch goes through a `SECURITY DEFINER` function that requires an HMAC proof signed with a secret the database holds and the API process also holds (`SESSION_MINT_HMAC_KEY`). That stops SQL-injection-level abuse of the runtime role from minting a session for another user. It does **not** protect against a compromise of the API process itself, which holds the key.

Without a database secret that matches the application's key, every proof fails and **nobody can log in**. The system fails closed.

## Deployment is not ready until the self-test says so

`GET /readyz` runs a self-test (`auth_session_hmac_status`) in addition to the database check. It answers 503 `{"status":"unavailable","reason":"configuration"}` when:

- the database has no active secret (migration 014/015 applied but not provisioned), or
- the application's `SESSION_MINT_HMAC_KEY` does not match the database.

The specific cause (`no_secret` / `mismatch`) is logged, never the key. Liveness (`/livez`) is unaffected. Do not route traffic to an instance until `/readyz` is 200. The same check is available to an operator as `session-hmac.mjs verify`.

Staging and production also refuse to start with the documented local/test development key, and the script refuses to install it.

## Prerequisites

- `MIGRATION_DATABASE_URL`: the migrator/owner connection (TLS verified outside loopback). The runtime role cannot run any of these functions. Do not put this variable in the API process.
- Node 20+ and `npm ci` done in this repository (the script uses `pg`).
- A secret manager for the application key.

Ensure statement parameter logging is off for the migrator session (`log_statement` not `all`, or `log_parameter_max_length = 0`). The script tries to set `log_parameter_max_length = 0` for its transaction but that needs a privileged role; if it cannot, it carries on and the operator must have disabled parameter logging. The key is sent to the database as a bound parameter, never in argv or in the SQL text.

## 1. First-time provisioning (once per environment)

```
cd apps/api
node scripts/session-hmac.mjs provision --key-id prod-1 --generate-to /secure/path/session-hmac.key
```

- 48 bytes from the operating system CSPRNG, base64url, written to a **new** file (exclusive create, mode 0600 on POSIX). It refuses to overwrite a file. On Windows the mode is not enforced: put the file in a directory only the operator can read.
- The secret is never printed. The script prints `provision: ok (key id prod-1)` and where the file is.
- Load the file's contents into the secret manager as `SESSION_MINT_HMAC_KEY` for the API, then securely delete the file.
- If the database refuses (for example a secret already exists), the generated file is deleted and the exit code is 1.

To supply a secret you generated elsewhere, export it only in the script's environment and use `--from-env` (the variable is `SESSION_MINT_HMAC_KEY`):

```
SESSION_MINT_HMAC_KEY="$(secret-manager read ...)" node scripts/session-hmac.mjs provision --key-id prod-1 --from-env
```

Properties:

- **Repeatable**: running it again with the same key id and the same secret is a no-op (exit 0).
- **Never silently rotates**: a different secret, or a different key id while one is active, fails with `session hmac secret already provisioned; use rotate`, and the stored secret is unchanged.
- Secrets must be 32 to 256 characters with no whitespace.

Then verify before sending traffic:

```
SESSION_MINT_HMAC_KEY=... node scripts/session-hmac.mjs verify   # verify: ok  (exit 0)
curl -fsS https://<instance>/readyz                              # 200
```

`verify: mismatch` or `verify: no_secret` exit with code 2.

## 2. Rotation (no downtime, no session impact)

Existing sessions are validated by token hash only; the HMAC is used for creating and changing sessions. Rotation therefore **never invalidates an active session**. It only decides which API instances can mint or revoke.

1. Add a second active key. Both verify from now on:
   ```
   node scripts/session-hmac.mjs rotate --key-id prod-2 --generate-to /secure/path/session-hmac-2.key
   ```
2. Put the new secret in the secret manager and redeploy every API instance with it. During the roll, instances with the old key and instances with the new key both work.
3. When `/readyz` is 200 on every instance with the new key (and `verify` with the new key says ok), retire the old key:
   ```
   node scripts/session-hmac.mjs retire --key-id prod-1
   ```

Rules the database enforces: rotation needs exactly one active key (finish the previous rotation first), a key id can never be reused, and the last active key cannot be retired. If an instance still holds the retired key, its logins, logouts and tenant switches fail and its `/readyz` turns 503 until it is redeployed; existing sessions keep working.

Emergency rotation after a suspected key exposure: run steps 1 to 3 immediately; the old key stops working at step 3. Consider also revoking sessions if the exposure included the application process, because the old key could already have been used to mint sessions.

## 3. Status

```
node scripts/session-hmac.mjs status
```
Lists key ids, creation and retirement times, and how many replay nonces exist and are purgeable. It never prints a secret.

## 4. Nonce housekeeping (operator-scheduled)

Each login, refresh, revoke and tenant switch records a one-time proof nonce. Replay protection needs a nonce only for the proof's validity (60 seconds, plus 5 seconds of clock skew); rows are kept for one day. `auth_purge_session_proof_nonces` removes a row only when **both** its stored expiry has passed **and** it is more than an hour old, in bounded batches that skip rows locked by concurrent work. A proof can therefore never be replayed because its nonce was purged: by the time a row is eligible, the proof's age window has long closed (verified by `test/sessionProof.nonces.test.ts`).

```
node scripts/session-hmac.mjs purge-nonces --batch 1000 --max-batches 50
```

- Owner: the platform operator, run as the migrator, like the idempotency-key cleanup in `OPERATIONS.md`. The runtime role cannot execute it and the API has no in-process timer.
- Schedule: hourly is ample. At one row per authentication the table is small; daily is acceptable if the platform has no hourly scheduler.
- Each call deletes at most `--batch` rows (1 to 10000) and the script stops after `--max-batches` or the first short batch, so a run is short and never holds a long transaction.

## Not provided by this repository

- Provisioning in any shared or production environment, and storing the key in your secret manager.
- A scheduler for the purge.
- Backups: the secret is stored in plaintext in `auth_session_hmac_secrets` (owner-only), so database backups and the migrator credential are as sensitive as the application key.
