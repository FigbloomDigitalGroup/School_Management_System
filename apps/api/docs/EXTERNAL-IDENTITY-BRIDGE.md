# External identity bridge contract (D-14)

**Status:** IMPLEMENTED (local model) · VERIFIED with unit/integration tests · hosted Supabase wiring **EXTERNAL DEPENDENCY**

## Model

| Table | Purpose |
|---|---|
| `external_identities` | `(provider, subject)` → `user_id`; unique subject; one active supabase link per user |
| `external_identity_link_events` | Append-ish history of link operations |

Provider enum today: `supabase_auth` only.

## Invariants

1. Matching email **never** proves identity.
2. Linking requires `verified: true` from the bridge caller.
3. Subject collision with another user ⇒ 409 conflict (takeover protection).
4. Second active supabase link for same user ⇒ 409.
5. Legacy Supabase Auth login flows remain untouched in `apps/web` / mobile.
6. No destructive user migration in this programme.

## Hosted dependency (not performed here)

- Authorized mapping of production `auth.users.id` subjects.
- Dual-run session exchange adapter (Phase 9).
- Reconciliation / rollback runbook execution against hosted data.

Local foundations are sufficient for a safe future dual-run bridge.
