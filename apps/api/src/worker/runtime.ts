import type { AppPool } from "../db/pool.js";
import type { Tx } from "../db/sql.js";
import { createIdentityHandle } from "../db/sql.js";
import { withSystemTenantTransaction } from "../db/systemTenantTransaction.js";
import { logError, logInfo, logWarn } from "../log.js";

/**
 * Tenant-isolated job runtime (docs/WORKER-ISOLATION-PROPOSAL.md; migrations 036, 040, 041).
 *
 * One cycle:
 *   1. claim   jobs_claim() (SECURITY DEFINER, the only cross-tenant step): returns ids only, leases one
 *              due job under FOR UPDATE SKIP LOCKED, skips suspended schools. Committed on its own. The
 *              claim increments `attempts`; that number is the FENCING TOKEN of this lease: every later
 *              state change of the job requires the same `attempts` and `leased_by`.
 *   2. load    the payload is read in a transaction whose app.tenant_id is the CLAIMED tenant, under RLS:
 *              a job row that is not that tenant's (or whose lease moved) is invisible and the job is not run.
 *   3. run     the handler receives a transaction factory bound to that tenant; it cannot choose another.
 *              External calls happen between transactions, never inside one. Handlers must be idempotent:
 *              a stale worker (lease lost) may still finish its side effects, so they must be safe to repeat.
 *   4. record  success, or failure in a separate tenant-scoped transaction: retry with exponential backoff
 *              and jitter, or 'dead' after max attempts (still bound to its tenant). A transition is
 *              AUDITED (actingVia "worker", no user actor) only when its conditional UPDATE changed exactly
 *              one row. If it changed none the lease was lost: nothing is recorded, nothing is claimed.
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
/** Raised by `ctx.fenced` when this attempt no longer holds the job's lease. */
export class LeaseLostError extends Error {
  constructor() {
    super("lease_lost");
  }
}

export interface JobContext {
  jobId: string;
  jobType: string;
  tenantId: string;
  attempt: number;
  /** The worker name that holds this lease (fencing identity for finance_worker_settle_payment). */
  /** Secret per-claim lease token (issued by jobs_claim). Never logged; never read from the table. */
  leaseToken: string;
  payload: Record<string, unknown>;
  enqueuedByUserId: string | null;
  /** A transaction scoped to THIS job's tenant (RLS applies). The only way a handler reaches tenant data. */
  inTenant<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Like inTenant, but the transaction first locks the job row via jobs_assert_lease() and proves this
   * attempt still holds an active, non-expired lease (leased_by AND attempts, the fencing token). A stale
   * worker therefore cannot perform a side effect, or write its audit row, after losing the lease.
   */
  fenced<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Extends this attempt's active lease by `extraSeconds` (5..3600, default `leaseSeconds`) via
   * jobs_extend_lease() (M3-A). Throws LeaseLostError if the lease expired or was lost.
   */
  extendLease(extraSeconds?: number): Promise<boolean>;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

export type CycleOutcome = "idle" | "succeeded" | "retry" | "dead" | "rejected" | "lease_lost";

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
  const claimed = await createIdentityHandle(pool).query<{ id: string; tenant_id: string; job_type: string; attempts: number; lease_token: string }>(
    `SELECT id, tenant_id, job_type, attempts, lease_token FROM jobs_claim($1, $2, $3::text[])`,
    [opts.workerName, opts.leaseSeconds, types],
  );
  const job = claimed.rows[0];
  if (!job) return "idle";

  const inTenant = <T>(fn: (tx: Tx) => Promise<T>) => withSystemTenantTransaction(pool, { tenantId: job.tenant_id }, fn);

  const loaded = await inTenant((tx) =>
    tx.query<{ payload: Record<string, unknown>; enqueued_by_user_id: string | null; max_attempts: number }>(
      `SELECT payload, enqueued_by_user_id, max_attempts FROM public.jobs_load_leased($1, $2, $3)`,
      [job.id, job.lease_token, job.attempts],
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
    jobType: job.job_type,
    tenantId: job.tenant_id,
    attempt: job.attempts,
    leaseToken: job.lease_token,
    payload: row.payload,
    enqueuedByUserId: row.enqueued_by_user_id,
    inTenant,
    fenced: <T>(fn: (tx: Tx) => Promise<T>) =>
      inTenant(async (tx) => {
        const held = await tx.query<{ ok: boolean }>(
          `SELECT public.jobs_assert_lease($1, $2, $3) AS ok`,
          [job.id, job.lease_token, job.attempts],
        );
        if (!held.rows[0]?.ok) throw new LeaseLostError();
        return fn(tx);
      }),
    extendLease: (extraSeconds = opts.leaseSeconds) =>
      inTenant(async (tx) => {
        try {
          const res = await tx.query<{ ok: boolean }>(
            `SELECT public.jobs_extend_lease($1, $2, $3, $4) AS ok`,
            [job.id, job.lease_token, job.attempts, extraSeconds],
          );
          if (!res.rows[0]?.ok) throw new LeaseLostError();
          return true;
        } catch (err) {
          if ((err as { code?: string }).code === "42501") throw new LeaseLostError();
          throw err;
        }
      }),
  };

  let failure: unknown;
  let failed = false;
  try {
    if (!handler) throw new PermanentJobError("unknown_job_type");
    await handler(ctx);
  } catch (err) {
    failed = true;
    failure = err;
  }

  if (!failed) {
    const recorded = await inTenant(async (tx) => {
      const res = await tx.query<{ ok: boolean }>(
        `SELECT public.jobs_complete($1, $2, $3) AS ok`,
        [job.id, job.lease_token, job.attempts],
      );
      return Boolean(res.rows[0]?.ok);
    });
    if (!recorded) {
      logWarn("job_lease_lost", { job_id: job.id, job_type: job.job_type, attempt: job.attempts });
      return "lease_lost";
    }
    logInfo("job_succeeded", { job_id: job.id, job_type: job.job_type, attempt: job.attempts });
    return "succeeded";
  }

  const permanent = failure instanceof PermanentJobError;
  const rawCode = failure instanceof RetryableJobError || failure instanceof PermanentJobError ? failure.code : "unexpected_error";
  const code = SAFE_CODE.test(rawCode) ? rawCode : "unexpected_error";
  const dead = permanent || job.attempts >= row.max_attempts;
  const transitioned = await inTenant(async (tx) => {
    const res = dead
      ? await tx.query<{ ok: boolean }>(
          `SELECT public.jobs_dead($1, $2, $3, $4, $5) AS ok`,
          [job.id, job.lease_token, job.attempts, code, permanent ? "permanent_error" : "max_attempts"],
        )
      : await tx.query<{ ok: boolean }>(
          `SELECT public.jobs_retry($1, $2, $3, $4, $5) AS ok`,
          [job.id, job.lease_token, job.attempts, backoffSeconds(job.attempts, opts.random), code],
        );
    return Boolean(res.rows[0]?.ok);
  });
  if (!transitioned) {
    logWarn("job_lease_lost", { job_id: job.id, job_type: job.job_type, attempt: job.attempts });
    return "lease_lost";
  }
  // Log the code only: never the payload, provider data or another tenant's identifiers.
  logError(dead ? "job_dead" : "job_retry", { job_id: job.id, job_type: job.job_type, attempt: job.attempts, error_code: code });
  if (!(failure instanceof RetryableJobError) && !(failure instanceof PermanentJobError)) {
    logError("job_unexpected_error", { job_id: job.id, error_class: failure instanceof Error ? failure.name : typeof failure });
  }
  return dead ? "dead" : "retry";
}

/**
 * Periodic maintenance (autocommit, worker-only, cross-tenant by design): redact expired import previews (N-8) and sweep
 * for unresolved financial cases (raise / re-raise / escalate; migration 071). Returns the counts.
 */
export interface MaintenanceResult {
  previewsRedacted: number;
  casesRaised: number;
  unmatchedEvaluated: number;
  unmatchedEscalated: number;
  /** Counts per housekeeping operation (migration 078), or null when the housekeeping call itself failed. */
  housekeeping: Record<string, unknown> | null;
}

/** Raised AFTER every maintenance step was attempted, so one failing step never skips the others. */
export class MaintenanceError extends Error {
  constructor(
    readonly failed: string[],
    readonly partial: MaintenanceResult,
  ) {
    super("maintenance finished with failed steps");
    this.name = "MaintenanceError";
  }
}

export async function runMaintenance(pool: AppPool, workerName: string): Promise<MaintenanceResult> {
  const h = createIdentityHandle(pool);
  const failed: string[] = [];
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      failed.push(name + ":" + ((err as { code?: string } | null)?.code ?? "error")); // class only: never a message
      return undefined;
    }
  };
  const prev = await step("import_previews", () => h.query<{ n: number }>(`SELECT public.import_batches_expire_due(200) AS n`));
  const sweep = await step("reconciliation_sweep", () => h.query<{ n: number }>(`SELECT public.finance_reconciliation_sweep($1, 60) AS n`, [workerName]));
  const um = await step("unmatched_sweep", () => h.query<{ evaluated: number; escalated: number }>(`SELECT evaluated, escalated FROM public.finance_unmatched_sweep($1)`, [workerName]));
  // Bounded, non-overlapping, failure-isolated retention cleanup (migration 078). It records its own status on the heartbeat row.
  const hk = await step("housekeeping", () => h.query<{ r: Record<string, unknown> }>(`SELECT public.worker_housekeeping($1) AS r`, [workerName]));
  const result: MaintenanceResult = {
    previewsRedacted: prev?.rows[0]?.n ?? 0,
    casesRaised: sweep?.rows[0]?.n ?? 0,
    unmatchedEvaluated: um?.rows[0]?.evaluated ?? 0,
    unmatchedEscalated: um?.rows[0]?.escalated ?? 0,
    housekeeping: hk?.rows[0]?.r ?? null,
  };
  if (failed.length > 0) {
    await recordHeartbeat(pool, workerName, "maintenance_partial").catch(() => undefined);
    throw new MaintenanceError(failed, result);
  }
  return result;
}

/** Liveness signal for the platform status endpoint (counts and ages only; no payloads). */
export async function recordHeartbeat(pool: AppPool, workerName: string, outcome: string): Promise<void> {
  await createIdentityHandle(pool).query(`SELECT public.worker_heartbeat($1, $2)`, [workerName, outcome]);
}
