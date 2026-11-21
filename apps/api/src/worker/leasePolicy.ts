/**
 * Worker lease safety guard (owner decision 6.9: a bounded configuration guard instead of production lease renewal).
 *
 * A lease must outlive the WORST-CASE duration of one handler run, otherwise a second worker can legitimately reclaim
 * the job while the first is still working (duplicate provider calls; money-affecting writes are fenced, but the
 * provider is not). The settlement handler makes at most HTTP_CALLS provider requests (token + status query), at most
 * DB_STATEMENTS statements each bounded by the statement timeout, and TX_STARTS transactions each bounded by the pool
 * acquire timeout. The lease must exceed that worst case by SAFETY_FACTOR. With the shipped defaults
 * (http 10 s, statement 15 s, acquire 2 s): 2*10 + 8*15 + 4*2 = 148 s, x1.25 = 185 s, hence the 300 s default lease.
 * The constants are conservative upper bounds read from worker/handlers.ts and finance/mpesa.ts (settle path).
 */
export const LEASE_HTTP_CALLS = 2;
export const LEASE_DB_STATEMENTS = 8;
export const LEASE_TX_STARTS = 4;
export const LEASE_SAFETY_FACTOR = 1.25;

export function worstCaseHandlerSeconds(i: { mpesaHttpTimeoutMs: number; statementTimeoutMs: number; poolAcquireTimeoutMs: number }): number {
  return (
    (LEASE_HTTP_CALLS * i.mpesaHttpTimeoutMs + LEASE_DB_STATEMENTS * i.statementTimeoutMs + LEASE_TX_STARTS * i.poolAcquireTimeoutMs) / 1000
  );
}

export function minimumSafeLeaseSeconds(i: { mpesaHttpTimeoutMs: number; statementTimeoutMs: number; poolAcquireTimeoutMs: number }): number {
  return Math.ceil(worstCaseHandlerSeconds(i) * LEASE_SAFETY_FACTOR);
}

/** Returns an error message when the lease is unsafe for the configured timeouts, else null. */
export function leasePolicyViolation(i: {
  leaseSeconds: number;
  mpesaHttpTimeoutMs: number;
  statementTimeoutMs: number;
  poolAcquireTimeoutMs: number;
}): string | null {
  const min = minimumSafeLeaseSeconds(i);
  if (i.leaseSeconds < min) {
    return `WORKER_LEASE_SECONDS=${i.leaseSeconds} is below the safe minimum ${min}s for the configured timeouts (worst-case handler ${worstCaseHandlerSeconds(i)}s x ${LEASE_SAFETY_FACTOR}); raise the lease or lower MPESA_HTTP_TIMEOUT_MS / WORKER_STATEMENT_TIMEOUT_MS`;
  }
  return null;
}
