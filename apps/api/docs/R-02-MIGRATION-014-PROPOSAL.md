# Proposed migration 014 — HMAC session-mint containment (OD-1)

> **Superseded by implementation.** OD-1 approved in-session; see `R-02-MIGRATION-014.md` and `migrations/014_session_mint_hmac_containment.sql`. This file is retained as the design sketch that was approved.

## Goal

Revoke direct `INSERT`/`UPDATE` on `sessions` from `figbloom_app`. All session writes go through hardened `SECURITY DEFINER` functions that require an HMAC proof the SQL-injection attacker does not have.

## Schema / privilege changes

1. Owner-only table (or config) holding the HMAC verification key material (never granted to `figbloom_app` for `SELECT` of the raw secret if stored in-DB — prefer app config + DB-side verification via a definer that reads an owner-only secret table).
2. Functions (names illustrative):
   - `auth_mint_session(p_user_id uuid, p_token_hash text, p_expires_at timestamptz, p_proof text, p_ip text, p_minted_by text)`
   - `auth_touch_session(p_session_id uuid, p_proof text, …)` as needed
   - `auth_revoke_session(p_session_id uuid, p_proof text, …)` as needed
3. `REVOKE INSERT, UPDATE ON sessions FROM figbloom_app` (retain `SELECT` only if still required for session validation; prefer definer reads if feasible).
4. `GRANT EXECUTE` on the new functions to `figbloom_app` only; `REVOKE ALL … FROM PUBLIC`.
5. Each function: `SECURITY DEFINER`, migrator owner, `SET search_path = pg_catalog, pg_temp`, schema-qualified names, constant-time proof compare, short proof validity window, reject replays (nonce or issued_at bound).
6. Audit mint with initiating actor identity available to the definer (app passes actor context in proof claims), mark IP as client-supplied, store `minted_by`.

## Application changes

- Login / refresh / logout paths mint and revoke only via the new functions, computing HMAC in Node with the process secret.
- No business endpoint retains the ability to insert sessions via raw SQL.

## Tests (required before merge)

- `figbloom_app` cannot `INSERT` into `sessions`.
- Mint without valid proof refused; expired / replayed proof refused.
- Login and refresh still work end-to-end.
- Unauthorized role cannot `EXECUTE` the functions.
- Temp-table / search-path shadowing attacks fail.
- Full auth, session, RLS, grants, and securityDefiner suites green.
- Document residual: full process compromise still wins.

## Rollback

Migration 015 restores `INSERT, UPDATE` on `sessions` to `figbloom_app` and drops or disables the proof requirement — only if OD-1 explicitly authorises rollback.

## Numbering note

If OD-1 is approved, this becomes migration `014_…`. Do not reuse 014 for unrelated indexes while OD-1 is open; index work uses a later number or waits.
