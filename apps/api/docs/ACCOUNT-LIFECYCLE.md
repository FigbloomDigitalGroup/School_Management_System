# Account lifecycle, authentication and session policy (migrations 068, 069, 072)

## Principles
* **No public account creation, no default administrator, no default password, no backdoor.** Every account is created by accepting an invitation issued by an authorised person, by the one-time bootstrap below, or by a super administrator approving an organisation sign-up request (below): the public sign-up route stores a *request* and creates no account.
* Tokens (invitation, password reset, bootstrap setup) are 32 random bytes; only the **SHA-256** is stored (`account_tokens.token_hash`). They are **single-use, expiring (invitation 72 h, reset 30 min; hard cap 14 days by CHECK), revocable**, and never logged or audited in clear. The table is owner-only; all operations are SECURITY DEFINER functions with a fixed `search_path`, executable only by `figbloom_app`, whose actor/tenant come from the transaction GUCs set by the server (never from a request).
* **Delivery is an external dependency.** No email/SMS provider is wired. `AccountNotifier` (`src/modules/account/notifier.ts`) defaults to `not_configured`; the API then returns the token **once** to the authorised issuer so it can be delivered out of band. Self-service reset requests never return a token, so they cannot complete until a provider is configured.

## Flows
| Flow | Endpoint | Who | Notes |
|---|---|---|---|
| First platform administrator | `node scripts/bootstrap-admin.mjs` (operator, owner connection) | operator with `FIGBLOOM_BOOTSTRAP_CONFIRM=yes` | refuses if any super administrator exists or the e-mail is taken; creates an `invited` account with an **unusable** credential and prints a 30-minute setup token once; the person sets their own password through `/v1/auth/password-reset/complete` |
| Provision a school | `POST /v1/platform/schools` | super administrator (DB-enforced) | creates organisation (or uses one) + school (`onboarding`) + the initial school-administrator **invitation** |
| Invite staff | `POST /v1/tenants/:t/invitations` | `identity.accounts.manage` (school administrator); `school_admin` invitations only by a super administrator | teacher/staff/driver; no duplicate open invitation; expired ones are retired automatically |
| Revoke invitation | `POST …/invitations/:id/revoke` | same | permanent |
| Accept invitation | `POST /v1/invitations/accept` | public, rate limited | new person sets an Argon2id password; **an existing account must present its own bearer token** (an emailed token alone never attaches a school to someone else's login); all failure causes answer identically; school becomes `active` when its first administrator accepts |
| Request reset | `POST /v1/auth/password-reset/request` | public, rate limited | always `202` with the same body; a newer request revokes the older token |
| Complete reset | `POST /v1/auth/password-reset/complete` | public, rate limited | replaces the hash (Argon2id), clears the forced-change flag, **revokes every session** |
| Ask for an organisation | `POST /v1/signup/organizations`, `POST /v1/signup/organizations/verify` | public, rate limited, off unless `ORG_SIGNUP_ENABLED` | stores a request and e-mails a link to prove the mailbox; no account, organisation or school exists until a super administrator approves (`docs/ORG-SIGNUP.md`) |
| Approve or reject a request | `POST /v1/platform/org-signups/:id/approve`, `/reject`, `/reissue-setup` | super administrator (`platform.org_signups.manage`, re-authentication) | approving creates the organisation, an `invited` administrator with an `org_admin` membership and a 7-day password link (a password-reset token) sent to the confirmed address |
| Administrator reset | `POST …/members/:userId/password-reset` | school administrator | own-school members only; never yourself or a platform administrator |
| Deactivate | `POST …/members/:userId/deactivate` | school administrator | archives the membership, revokes sessions acting in that school (all sessions if it was their last); never yourself or a platform administrator |

Audit events: `platform.bootstrap`, `platform.school.provisioned`, `account.invitation.created|revoked|accepted`, `directory.staff.linked_on_invitation`, `auth.password.reset_requested|reset_issued|reset|rehashed`, `account.membership.deactivated` (no token material in any detail).

### Staff record link (104)

Class teachers, teaching assignments and timetables name a **staff record**, and a staff record reaches an account only
through `staff_members.user_id`. Since migration 104, accepting a staff invitation links the record when the match is
certain: exactly **one** active, unlinked staff record of the inviting school has the invited e-mail (case-insensitive),
and the account has no staff record in that school yet. Then `user_id` is set in the same transaction and
`directory.staff.linked_on_invitation` (invitation id, staff id) is audited. Anything else (no record, two records with that
e-mail, the record already linked to someone, the account already linked, an archived record, a record in another school)
links nothing, and a People administrator sets `userId` on the record as before. No new power: whoever can set a staff
record's e-mail can already set its `userId`, and the `staff_members_check_user_link` trigger (022) still requires an
active membership of the same school. The invitation itself does not take a staff id.

## Password hashing (068)
Argon2id via `node:crypto` (`crypto.argon2`, Node ≥ 24.7 — `engines` raised; **no silent fallback**). Parameters m=47104 KiB, t=1, p=1, 32-byte tag, 16-byte salt (OWASP first choice; ≈45 ms on the development machine; benchmark on the deployment hardware before launch). The legacy scrypt format stays verifiable; after a **successful** login against a legacy/weaker hash the API stores a fresh Argon2id hash through `auth_rehash_password` — a compare-and-swap on the exact hash verified, Argon2id-only (no downgrade), audited without hash material. Concurrent logins therefore cannot corrupt or downgrade a hash. Verification caps stored parameters (≤256 MiB, ≤10 passes) so a corrupt row cannot demand unbounded memory; concurrent memory is bounded by the libuv pool (4 threads) and the login token buckets. No forced resets.

## Sessions (069)
Absolute lifetime **8 h** (`SESSION_TTL_SECONDS` > 28800 is rejected at startup; new sessions are also constrained by a CHECK). Idle timeout enforced **inside `auth_touch_session` on every request**: **15 min** for staff/administrators (any non-parent school role, organisation or platform role), **30 min** for guardians (parent-only accounts); an idle-expired session can never be revived. `last_seen_at` is written at most every `SESSION_LAST_SEEN_INTERVAL_SECONDS` (default 60, max 120). Revocation: logout, password change/reset, membership deactivation, disabled user (rejected on every request). Login is throttled by progressive per-IP and per-account token buckets (no permanent lockout, so an attacker cannot lock a victim out).

**Operational note:** an existing local `apps/api/.env` with `SESSION_TTL_SECONDS=43200` now fails startup by design — set it to 28800 or remove it.

## Sensitive-action re-authentication coverage (migration 077 + residual closure)
Required (`reauth_required` when the session was not created or password-confirmed within 5 minutes): administrator password reset, membership deactivation, school provisioning, school-administrator invitation, guardian-link revocation, finance finding resolution, unacknowledged-prompt withdrawal, operator M-Pesa reconciliation, unmatched-callback resolve/reopen, **organization-delegation grant/revoke, guardian-access grant/revoke, staff-area changes, and a change of the school name or timezone** (the timezone defines every school-local date). Authorization is always evaluated before freshness, so an unauthorized caller never learns anything about re-authentication. The evidence is a stamp on ONE session (bound to the session id and its user, expiring with the window), so it cannot be replayed on another session. **Deliberately not gated:** ordinary school-profile content (county, country, level, contacts, logo key), invitations of non-administrator roles, staff/learner/guardian directory edits, and all reads; none changes who holds authority or the school's identity or clock.
