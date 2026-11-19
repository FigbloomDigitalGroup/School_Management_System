import type { AppPool } from "../db/pool.js";
import type { Tx } from "../db/sql.js";
import { createIdentityHandle } from "../db/sql.js";
import { withSystemTenantTransaction } from "../db/systemTenantTransaction.js";
import { recordSecurityEvent } from "../modules/audit/audit.js";
import { logError, logInfo } from "../log.js";

/**
 * Tenant-isolated job runtime (docs/WORKER-ISOLATION-PROPOSAL.md; migration 036).
 *
 * One cycle:
 *   1. claim   jobs_claim() (SECURITY DEFINER, the only cross-tenant step): returns ids only, leases one
 *              due job under FOR UPDATE SKIP LOCKED, skips suspended schools. Committed on its own.
 *   2. load    the payload is read in a transaction whose app.tenant_id is the CLAIMED tenant, under RLS:
 *              a job row that is not that tenant's is invisible and the job is not run.
 *   3. run     the handler receives a transaction factory bound to that tenant; it cannot choose another.
 *              External calls happen between transactions, never inside one.
 *   4. record  success, or failure in a separate tenant-scoped transaction: retry with exponential backoff
 *              and jitter, or 'dead' after max attempts (still bound to its tenant). Audited with
 *              actingVia "worker". A crashed attempt's lease expires and the job is claimable again.
 */
export class RetryableJobError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export class PermanentJobError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface JobContext {
  jobId: string;
  tenantId: string;
  attempt: number;
  payload: Record<string, unknown>;
  enqueuedByUserId: string | null;
  /** A transaction scoped to THIS job's tenant (RLS applies). The only way a handler reaches tenant data. */
  inTenant<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

export type CycleOutcome = "idle" | "succeeded" | "retry" | "dead" | "rejected";

export function backoffSeconds(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30 * 2 ** Math.max(attempt - 1, 0), 3_600);
  return Math.max(5, Math.round(base * (0.5 + random())));
}

const SAFE_CODE = /^[a-z0-9_.:-]{1,80}$/;

export async function runCycle(
  pool: AppPool,
  opts: { workerName: string; leaseSeconds: number; handlers: Record<string, JobHandler>; random?: () => number },
): Promise<CycleOutcome> {
  const types = Object.keys(opts.handlers);
  const claimed = await createIdentityHandle(pool).query<{ id: string; tenant_id: string; job_type: string; attempts: number }>(
    `SELECT id, tenant_id, job_type, attempts FROM jobs_claim($1, $2, $3::text[])`,
    [opts.workerName, opts.leaseSeconds, types],
  );
  const job = claimed.rows[0];
  if (!job) return "idle";

  const inTenant = <T>(fn: (tx: Tx) => Promise<T>) => withSystemTenantTransaction(pool, { tenantId: job.tenant_id }, fn);

  const loaded = await inTenant((tx) =>
    tx.query<{ payload: Record<string, unknown>; enqueued_by_user_id: string | null; max_attempts: number }>(
      `SELECT payload, enqueued_by_user_id, max_attempts FROM jobs WHERE id = $1 AND tenant_id = $2 AND status = 'leased' AND leased_by = $3`,
      [job.id, job.tenant_id, opts.workerName],
    ),
  );
  const row = loaded.rows[0];
  if (!row) {
    // Not visible under its own tenant, or the lease moved: never run it, never fall back to an unscoped read.
    logError("job_rejected", { job_id: job.id, reason: "not_visible_under_claimed_tenant" });
    return "rejected";
  }
  const handler = opts.handlers[job.job_type];
  const ctx: JobContext = {
    jobId: job.id,
    tenantId: job.tenant_id,
    attempt: job.attempts,
    payload: row.payload,
    enqueuedByUserId: row.enqueued_by_user_id,
    inTenant,
  };

  try {
    if (!handler) throw new PermanentJobError("unknown_job_type");
    await handler(ctx);
    await inTenant(async (tx) => {
      await tx.query(
        `UPDATE jobs SET status = 'succeeded', finished_at = now(), lease_expires_at = NULL, leased_by = NULL, last_error_code = NULL
          WHERE id = $1 AND status = 'leased' AND leased_by = $2`,
        [job.id, opts.workerName],
      );
    });
    logInfo("job_succeeded", { job_id: job.id, job_type: job.job_type, attempt: job.attempts });
    return "succeeded";
  } catch (err) {
    const permanent = err instanceof PermanentJobError;
    const rawCode = err instanceof RetryableJobError || err instanceof PermanentJobError ? err.code : "unexpected_error";
    const code = SAFE_CODE.test(rawCode) ? rawCode : "unexpected_error";
    const dead = permanent || job.attempts >= row.max_attempts;
    await inTenant(async (tx) => {
      if (dead) {
        await tx.query(
          `UPDATE jobs SET status = 'dead', finished_at = now(), lease_expires_at = NULL, leased_by = NULL, last_error_code = $3
            WHERE id = $1 AND status = 'leased' AND leased_by = $2`,
          [job.id, opts.workerName, code],
        );
      } else {
        await tx.query(
          `UPDATE jobs SET status = 'queued', run_after = now() + make_interval(secs => $4), lease_expires_at = NULL,
                  leased_by = NULL, last_error_code = $3
            WHERE id = $1 AND status = 'leased' AND leased_by = $2`,
          [job.id, opts.workerName, code, backoffSeconds(job.attempts, opts.random)],
        );
      }
      await recordSecurityEvent(tx, {
        eventType: dead ? "job.dead" : "job.retry_scheduled",
        actorUserId: row.enqueued_by_user_id,
        tenantId: job.tenant_id,
        detail: { jobId: job.id, jobType: job.job_type, attempt: job.attempts, errorCode: code, actingVia: "worker" },
      });
    });
    // Log the code only: never the payload, provider data or another tenant's identifiers.
    logError(dead ? "job_dead" : "job_retry", { job_id: job.id, job_type: job.job_type, attempt: job.attempts, error_code: code });
    if (!(err instanceof RetryableJobError) && !(err instanceof PermanentJobError)) {
      logError("job_unexpected_error", { job_id: job.id, error_class: err instanceof Error ? err.name : typeof err });
    }
    return dead ? "dead" : "retry";
  }
}
