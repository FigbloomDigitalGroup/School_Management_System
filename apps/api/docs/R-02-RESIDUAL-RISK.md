# R-02 residual risk — session minting and password setter (WP-A1)

> Status: documentation correction + OD-1 containment (2026-11-16). Risk owner: **Ancel**.  
> Migration 013 is **not** edited. Containment migration **014 is implemented** (`014_session_mint_hmac_containment.sql`).  
> Residual after 014: full application-process compromise still wins (process holds `SESSION_MINT_HMAC_KEY`). SQL-injection-level arbitrary session INSERT as `figbloom_app` is contained.

## What migration 013 actually achieved

`figbloom_app` has **no** table-level `UPDATE` on `users` and **no** `SELECT` on `users.password_hash`. The only password-hash write path is:

`public.auth_change_own_password(session_id, expected_hash, new_hash, ip)`

Verified properties:

- `SECURITY DEFINER`, migrator-owned, `search_path = pg_catalog, pg_temp`, schema-qualified.
- Takes a **session id**, not a user id; the account is derived from the session row.
- Unknown / revoked / expired / disabled-user sessions → `false`, no write.
- New hash must be well-formed `scrypt$…` (plaintext refused).
- Compare-and-swap under row lock (`FOR UPDATE OF u`); concurrent changes cannot both win.
- Other sessions revoked and `auth.password.changed` audit insert are atomic with the hash change.
- API call site passes the authenticated session’s own id, never a client-chosen user id.

This correctly contains **API-level mistakes** (forgotten filters, buggy handlers) that previously could have issued a direct `UPDATE users.password_hash`.

## What the previous documentation got wrong

Earlier text claimed the residual chain “needs a known user id, cannot be done in bulk, is bounded to one account per call, and always leaves the audit row” in a way that implied the attacker is identified and that user ids are a secret. Independent probes as `figbloom_app` (rolled back) showed:

1. **`users` is fully readable** for the granted non-secret columns (ids, emails, names, phones). There is no RLS on `users`.
2. **`platform_roles` reveals the super-admin user id.**
3. **`figbloom_app` can `INSERT` into `sessions` for any `user_id`** (including super admin), choosing the token hash. That alone is full impersonation of that account — no password change required.
4. With a minted session, `auth_password_credential(victim)` + `auth_change_own_password` can change that account’s password.
5. The audit row for a password change names the **victim** as `actor_user_id` and carries a **caller-supplied** IP. It is evidence of an event, not attribution of the initiating attacker.

Therefore: user ids are not a meaningful secret; session minting is the primary residual; audit attribution may identify the victim rather than the initiating actor.

## Actual authority of `figbloom_app` (relevant subset)

| Capability | Result |
|---|---|
| Direct `UPDATE` / `SELECT password_hash` on `users` | Denied |
| `SELECT` non-secret `users` columns / `platform_roles` | Allowed (ids readable, including super admin) |
| `SELECT` on `sessions` | Allowed (validation reads) |
| Direct `INSERT` / `UPDATE` on `sessions` | **Denied** after migration 014 |
| Session mint/revoke/touch/set-tenant definers | Executable only with valid HMAC proof (or touch by token hash) |
| Credential read definers / password setter | Executable with exact keys |
| `CREATE TABLE` / `CREATE ROLE` / audit table DML beyond INSERT | Denied |

## Verified atomic password-setting mechanism

See above. Retained and still required. It removes the durable primitive of a silent bulk hash overwrite without a session.

## Residual risk after migration 014 (plain statement)

Under the approved threat model (“arbitrary SQL executing as the runtime role” **without** the process HMAC secret), a compromised `figbloom_app` SQL path **cannot** directly `INSERT`/`UPDATE` `sessions`. Mint/revoke/set-tenant require a valid short-lived HMAC proof.

A **fully compromised application process** (attacker holds `SESSION_MINT_HMAC_KEY`) can still mint sessions and remains outside the database containment model. That residual is accepted and documented; see `R-02-MIGRATION-014.md`.

## Containment delivered (OD-1)

Implemented as migration 014. Rollback = forward migration 015 restoring grants only if explicitly authorised. Tests: `test/r02.sessionMint.test.ts` (as `figbloom_app`).

## Production-data restriction

Real school data still requires Ancel’s acceptance of the **process-compromise** residual and the remaining programme gates (F-008, CI, etc.). The pre-014 “arbitrary session INSERT as figbloom_app” residual is closed.
