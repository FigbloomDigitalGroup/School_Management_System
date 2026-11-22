# Migration 014 — HMAC session-mint containment (OD-1 implemented)

> **Implemented** as `migrations/014_session_mint_hmac_containment.sql`.  
> Migrations 001–013 are unchanged. Rollback requires a new forward migration 015 restoring grants (only if explicitly authorised).

## Goal

Revoke direct `INSERT`/`UPDATE` on `sessions` from `figbloom_app`. All session writes go through hardened `SECURITY DEFINER` functions that require an HMAC proof the SQL-injection attacker does not have.

## What shipped

| Object | Role |
|---|---|
| `auth_session_hmac_secrets` | Owner-only secret table (no grants to `figbloom_app`) |
| `auth_session_proof_nonces` | Replay store (nonce primary key) |
| `auth_install_session_hmac_secret` | Migrator/owner installs/rotates secret; not executable by runtime |
| `auth_mint_session` | Only INSERT path; HMAC + principal/tenant binding + audit |
| `auth_touch_session` | Validate + throttled `last_seen_at` |
| `auth_revoke_session` / `auth_revoke_all_user_sessions` | Revoke with HMAC |
| `auth_set_session_tenant` | select-tenant write with HMAC |
| Runtime grants | `figbloom_app`: `SELECT` only on `sessions` |

App config: `SESSION_MINT_HMAC_KEY` (required outside local/test). Local/test uses the documented default and installs it via `auth_install_session_hmac_secret` after migrate (test support).

## Residual risk (unchanged model)

This mitigates **SQL-injection-level abuse of the runtime role**. It does **not** eliminate full application-process compromise (the process holds the HMAC key). See `R-02-RESIDUAL-RISK.md`.

## Operational status (final remediation, migration 015)

| Item | State |
|---|---|
| HMAC secret provisioning | **Procedure and tooling provided and tested locally.** `scripts/session-hmac.mjs`, runbook `SESSION-HMAC-PROVISIONING.md`. Provisioning in a shared or production environment is an owner action that has **not** been performed. |
| Silent rotation | Removed. `auth_install_session_hmac_secret` now refuses to replace an existing secret (idempotent for the identical key); rotation is explicit, with an overlap window, and never affects existing sessions. |
| Readiness | `/readyz` runs an HMAC self-test; 503 `reason: configuration` when the secret is missing or mismatched. |
| Nonce growth | Owner-run bounded purge `auth_purge_session_proof_nonces`; schedule and ownership in the runbook. |
| Tenant eligibility in `auth_set_session_tenant` | Re-checked in the database (015), with the application's rules and the organisation derived from the tenant. `auth_mint_session` is unchanged (membership, platform role or organisation membership, without the suspended-school and active-organisation rules); a login-time mint for a suspended school is governed by the application's login checks, not by this function. |
| Audit actor | `auth.session.minted` records the account being signed in (the database requires actor = principal). It is supplied by the application, not independently derived. |

Migration 014 is unchanged; 015 replaces `auth_install_session_hmac_secret`, `auth_consume_session_proof` and `auth_set_session_tenant` with `CREATE OR REPLACE` (same signatures and ACLs).

## Rollback

Migration 015 (not written) would restore `INSERT, UPDATE` on `sessions` to `figbloom_app` and drop or disable the proof requirement — only if OD-1 explicitly authorises rollback.
