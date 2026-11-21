# Financial reconciliation and worker operations runbook (migrations 065, 071)

**Principle:** provider evidence is authoritative; timeouts, dead jobs, delayed or missing callbacks, a missing checkout id or a failed provider query never settle or fail a payment. They create observable, owned, aged **cases**.

## What raises a case (worker sweep, every 5 minutes; also the manual `POST …/reconciliation-runs`)
| Case kind | Meaning | Recovery |
|---|---|---|
| `dead_settlement_job` | the settle job went dead while the payment is still pending | operator reconciles against the provider (`POST …/payments/:id/mpesa-reconciliation`), or resolves with evidence |
| `paid_unconfirmed_no_callback` | the provider query said paid but no authenticated callback receipt is stored | operator reconciliation (typed receipt must match provider callbacks and may not sit in the unmatched quarantine); never auto-credited |
| `prompt_never_sent` | pending prompt **without** a checkout id | `POST …/payments/:id/withdraw-unacknowledged-prompt` with reason **and** evidence (refused if the provider acknowledged it or any provider evidence exists) |
| `stale_pending_prompt` | old pending prompt with a checkout id | provider reconciliation |

A resolved case is **re-raised only when newer evidence exists than its resolution** (`reopened_count` increments). Open cases older than 24 h are **escalated once** (`escalated_at`, audit `finance.reconciliation.case_escalated`). Cases have an owner queue (`finance`), an optional owner person (`POST …/reconciliation-findings/:id/assign`), `age_minutes`, `last_evaluated_at`. Resolution requires a reason; payment-evidence cases also require **evidence** (stored, audited). Operators need `resource.finance.administer`; the worker cannot decide outcomes.

A callback that arrives for a withdrawn prompt carries a checkout id nothing knows, so it lands in the unmatched-callback quarantine; the platform status shows its count (there is no per-row operator surface yet — owner-only table; **open item**).

## Worker observability
`GET /v1/platform/ops/status` (super administrators): per-worker `last_seen_age_seconds` (heartbeat every 30 s), `last_sweep_age_seconds`, queue depth (`queued_due`, `queued_future`, `leased`, `retrying`), `dead`, `oldest_due_lag_seconds`, reconciliation backlog (`open_cases`, `escalated_open`, `unassigned_open`, `oldest_open_age_seconds`), `unmatched_callbacks` — counts and ages only, no payloads/PII. **Alert delivery is an external dependency** (no provider): an operator or monitor must poll this endpoint; a stopped worker shows as a growing heartbeat age and queue lag.

## Lease policy (owner decision 6.9, M3-A)
Default lease **300 s**. Startup **rejects** `WORKER_LEASE_SECONDS` below 1.25 × the worst-case handler time `2·MPESA_HTTP_TIMEOUT + 8·STATEMENT_TIMEOUT + 4·POOL_ACQUIRE_TIMEOUT` (defaults 10 s / 15 s / 2 s → 148 s → minimum 185 s; the previous 120 s default was **below** this bound). Money-affecting writes are fenced by lease token + attempt; no handler renews its lease, and the evidence shows none needs to at these timeouts. If a future handler can exceed the bound, extend with the bounded `jobs_extend_lease` (cap 3600 s from claim) rather than raising the lease unboundedly. Shutdown abandons an in-flight job until its lease expires (burns one attempt; a job at max attempts goes dead and the payment then appears as a `dead_settlement_job` case).

## Import previews
Unapplied previews expire after **7 days** (engineering default; owner-approved interim; a formal retention policy may supersede it) and are redacted by the same worker maintenance (every 5 minutes). Expired previews cannot be applied.

## Worker housekeeping (migration 078)
`runMaintenance` (every 5 minutes) runs four steps and ATTEMPTS ALL OF THEM even if one fails (a failing step is reported afterwards as `MaintenanceError`, class codes only, and the heartbeat outcome becomes `maintenance_partial`): import-preview expiry, reconciliation sweep, unmatched-callback sweep, and `worker_housekeeping`. The housekeeping function is worker-only, non-overlapping (a transaction-scoped advisory lock; a concurrent run records `skipped` instead of queueing), bounded (≤ 1,000 rows per operation per run) and failure-isolated (each operation in its own sub-transaction). It removes only: idempotency keys expired > 1 day; idle rate buckets > 1 day; consumed expired proof nonces; account tokens whose used/revoked/expiry moment is > 30 days old; guardian invitations closed > 90 days ago that are expired/revoked/superseded (pending-but-expired ones are first marked `expired`). It never touches accepted invitations (the provenance of a live link), audit events, jobs, payments, events or reconciliation cases. Status is on `worker_heartbeats` and in `GET /v1/platform/ops/status` → `maintenance[]` (age, outcome, failed operation names). A run that deleted something or failed writes one `worker.housekeeping.run` audit row; idle runs write none.

## M-9 (operator reconciliation authority)
The settlement transaction calls `finance_assert_administer_actor(tenant)` first: live account, live school-administrator membership (or platform super administrator) and active school are read with `FOR SHARE` locks in the same transaction that settles, so a revocation committed earlier is refused and one racing it waits until the settlement commits. `resource.finance.administer` is held only by those two (not delegable), which is exactly what the function checks.
