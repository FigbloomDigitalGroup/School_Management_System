# Function and SECURITY DEFINER inventory (Stage D)

Status: implemented and tested through the real `figbloom_app` login (migrations 010 and 011). Not independently verified.

Source of truth: the **live catalogue** of a freshly migrated database (`test/securityDefiner.test.ts` reads `pg_proc`, ACLs and `pg_trigger`; it fails if a function exists that is not listed here, so a new function cannot arrive without a reviewer deciding its owner, `search_path` and `EXECUTE` grants). Extension-owned functions (`pgcrypto`, installed in `public` by the platform image, owner `supabase_admin`) are not application functions and are excluded by `pg_depend`.

## Contract

Every application function: owner = the migrator (the owner of the tables it touches); `SET search_path = pg_catalog, pg_temp` (pg_temp explicitly **last**, `public` deliberately absent so an unqualified reference fails instead of being hijacked); every table, function and type outside `pg_catalog` schema-qualified; `EXECUTE` revoked from `PUBLIC` and granted only as listed. Functions created later by the migrator are not `PUBLIC`-executable by default.

## Inventory (after migrations 010, 011 and 013)

| Function | Kind | Touches | Caller | `EXECUTE` | Risk before | Remediation |
|---|---|---|---|---|---|---|
| `security_audit_events_guard()` | DEFINER trigger (004) | `NEW`/`OLD` only | trigger on `security_audit_events` | none | Low (`search_path = public`, no table refs) | fixed `search_path`; revoked from PUBLIC and the runtime role |
| `school_memberships_on_archive()` | DEFINER trigger (004) | `staff_area_grants`, `school_role_assignments`, `security_audit_events` | trigger on `school_memberships.archived_at` | none | **Medium (latent)**: `search_path = public` leaves `pg_temp` implicitly first, so a caller able to fire it could shadow those tables with temp tables, leave real grants in place and hide the audit row (proved, NC-D1). Not reachable by `figbloom_app` today (no `UPDATE` on `school_memberships`) | qualified `public.*`, `pg_catalog, pg_temp`, no PUBLIC `EXECUTE` |
| `guardian_links_active_learner_guard()` | DEFINER trigger (008) | `learners` (`FOR SHARE`) | trigger on `guardian_links` | none | Low (`public, pg_temp` worked only because the real table exists) | qualified `public.learners`, `pg_catalog, pg_temp` |
| `auth_credential_by_email(text)` | DEFINER (011) | `users` | login by e-mail | `figbloom_app` | new | exact key, one account, hardened (NC-D3) |
| `auth_credential_by_login_id(uuid,text)` | DEFINER (011) | `school_memberships`, `users` | login by login id | `figbloom_app` | new | exact key, no tenant context needed (closes F-C1) |
| `auth_password_credential(uuid)` | DEFINER (011) | `users` | password change | `figbloom_app` | new | exact key |
| `auth_change_own_password(uuid,text,text,inet)` | DEFINER (013) | `sessions`, `users`, `security_audit_events` | password change (the only write path to `users.password_hash`) | `figbloom_app` | the runtime role held column `UPDATE (password_hash)` on a table without RLS: arbitrary-account overwrite, no audit (review R-02) | account derived from a valid session, compare-and-swap on the verified hash, scrypt-shaped input only, revokes other sessions and audits in the same call; `UPDATE` on `users` revoked from the runtime role |
| `prune_idempotency_keys(interval,integer)` | INVOKER (013) | `idempotency_keys` | owner-run housekeeping (not an API call) | none | n/a (new; the table had no cleanup, review R-04) | qualified, fixed `search_path`, batch-bounded, not executable by the runtime role |
| `app_current_tenant_id()` | INVOKER, STABLE | GUC `app.tenant_id` | RLS policies (`TO figbloom_app`) | `figbloom_app` | `PUBLIC` could execute | fixed `search_path`, PUBLIC revoked |
| `app_current_user_id()` | INVOKER, STABLE | GUC `app.user_id` | `school_memberships` self-read policy | `figbloom_app` | `PUBLIC` could execute | same |
| `consume_rate_token(text,numeric,numeric,numeric,integer)` | INVOKER | `auth_rate_buckets` | API rate limiter | `figbloom_app` | unqualified table: caller's temp table could replace the bucket (proved, NC-D2) | qualified `public.auth_rate_buckets`, fixed `search_path` |
| `prune_rate_buckets(interval)` | INVOKER | `auth_rate_buckets` | housekeeping (not an API call) | none | unqualified | qualified, fixed `search_path` |
| `schema_migration_checksum_audit_append_only()` | trigger, **created by the migration runner** (`ensureBootstrap`) | none | trigger on `schema_migration_checksum_audit` | none | `PUBLIC` `EXECUTE`, no `search_path` | changed in the bootstrap SQL (idempotent on every run) rather than a migration, because that is where the object lives |

Ownership: all of the above are owned by the migrator; the runtime role owns nothing. Each DEFINER trigger function is owned by the owner of the table it guards (asserted).

## Evidence

- `test/securityDefiner.test.ts` (12): completeness, owner, `search_path`, grantees, definer-owner = table-owner, runtime role executes only the four credential definers (three reads, one audited write), default-ACL probe, unqualified reference fails loudly, guardian-guard regression under a temp `learners` shadow, and NC-D1 / NC-D2 (the historical 004 and 003 definitions, taken from the migration files, are hijacked; the hardened ones are not).
- `test/credentialAccess.test.ts` (9): exact-key behaviour, no tenant context at login, EXECUTE limits, temp `users` shadow ignored, NC-D3 negative control, end-to-end logins.
- `test/passwordHash.security.test.ts`, `test/grants.matrix.test.ts`: the runtime role cannot read `users.password_hash` by any statement; column-level grant matrix; no table-level `users` privilege.
- The shadowing tests grant `TEMPORARY` to the attacker explicitly. Nothing relies on `REVOKE TEMPORARY`, which a managed host may not allow.

## Not changed

Migrations 001-009 are byte-identical. `pgcrypto` (platform-owned, `PUBLIC` `EXECUTE`) is out of scope. A role that can set `app.tenant_id` itself (arbitrary SQL as `figbloom_app`) remains the documented RLS residual (see `TENANT-ISOLATION.md`).
