import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import type { AppPool } from "../src/db/pool.js";
import { MaintenanceError, runMaintenance } from "../src/worker/runtime.js";
import { financeHarness, PASSWORD } from "./support/financeHarness.js";

/**
 * Residual closure workstream 1 (migration 078): worker housekeeping. Bounded, non-overlapping, failure-isolated retention cleanup
 * that removes only expired/terminal records past their retention window, never touches money, reconciliation, audit or job rows,
 * and is observable on the worker heartbeat / platform status. Executed as the real figbloom_worker login.
 */
describe("worker housekeeping (migration 078)", () => {
  const h = financeHarness();
  const pool = () => h.workerPool as unknown as AppPool;
  const A = () => h.A();
  const hk = async () => (await h.workerPool.query<{ r: Record<string, any> }>(`SELECT public.worker_housekeeping('hk-worker') AS r`)).rows[0]!.r;
  const hex = () => randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const count = async (sql: string, p: unknown[] = []) => (await h.owner<{ n: number }>(sql, p))[0]!.n;

  async function seedOld() {
    const mk = randomUUID().slice(0, 8);
    // idempotency keys: one long expired, one expired an hour ago (inside the 1-day grace), one still valid
    const key = (name: string, interval: string) =>
      h.owner(`INSERT INTO idempotency_keys (tenant_id, actor_user_id, idempotency_key, route, fingerprint, expires_at) VALUES ($1, $2, $3, 'POST /x', $4, now() + ${interval}::interval)`, [A(), h.ids.adminA, `${name}-${mk}-12345678`, hex().slice(0, 64)]);
    await key("old", "'-3 days'");
    await key("recent", "'-1 hour'");
    await key("valid", "'1 day'");
    // rate buckets: idle 3 days vs just used
    await h.owner(`INSERT INTO auth_rate_buckets (bucket_key, tokens, last_refill) VALUES ($1, 5, now() - interval '3 days'), ($2, 1, now())`, [`hk-old-${mk}`, `hk-new-${mk}`]);
    // proof nonces: consumed and long expired vs still valid
    await h.owner(`INSERT INTO auth_session_proof_nonces (nonce, purpose, consumed_at, expires_at) VALUES ($1, 'mint', now() - interval '3 days', now() - interval '2 days'), ($2, 'mint', now(), now() + interval '1 hour')`, [`hk-old-nonce-${mk}0000`, `hk-new-nonce-${mk}0000`]);
    // account tokens: used 40 days ago (purge), used yesterday (keep), still-valid pending (keep), expired 40 days ago (purge)
    let n = 0;
    const tok = (state: string) =>
      h.owner(`INSERT INTO account_tokens (kind, token_hash, tenant_id, email, role, created_by, created_at, expires_at, used_at) VALUES ('invitation', $1, $2, $3, 'teacher', $4, ${state})`, [hex().slice(0, 64), A(), `hk-${mk}-${++n}@example.com`, h.ids.adminA]);
    await tok(`now() - interval '41 days', now() - interval '38 days', now() - interval '40 days'`); // used long ago
    await tok(`now() - interval '3 days', now() - interval '1 hour', now() - interval '1 day'`); // used yesterday
    await tok(`now(), now() + interval '2 days', NULL`); // pending and valid
    await tok(`now() - interval '45 days', now() - interval '41 days', NULL`); // expired long ago, never used
    return mk;
  }

  async function guardianInvitation(status: string, closedDaysAgo: number | null, expired = false) {
    const learner = (await h.owner(`INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, $2, 'HK Learner', 'male') RETURNING id`, [A(), "HK" + randomUUID().slice(0, 8)]))[0]!.id;
    const g = (await h.owner(`INSERT INTO guardians (tenant_id, full_name, email) VALUES ($1, 'HK Guardian', 'hkg@example.com') RETURNING id`, [A()]))[0]!.id;
    await h.owner(`INSERT INTO guardian_links (tenant_id, guardian_id, learner_id, relationship) VALUES ($1, $2, $3, 'mother')`, [A(), g, learner]);
    const created = expired || closedDaysAgo ? "now() - interval '200 days'" : "now()";
    const expires = expired || closedDaysAgo ? "now() - interval '195 days'" : "now() + interval '1 day'";
    const id = (await h.owner(
      `INSERT INTO guardian_invitations (tenant_id, guardian_id, learner_id, contact_method, contact_value, token_hash, status, created_at, expires_at, closed_at)
       VALUES ($1, $2, $3, 'email', 'hkg@example.com', $4, $5, ${created}, ${expires}, ${closedDaysAgo ? `now() - interval '${closedDaysAgo} days'` : "NULL"}) RETURNING id`,
      [A(), g, learner, hex().slice(0, 64), status],
    ))[0]!.id as string;
    return { id, guardian: g, learner };
  }

  it("removes expired and terminal records past retention and keeps everything still valid, recent or required", async () => {
    const mk = await seedOld();
    const expiredPending = await guardianInvitation("pending", null, true); // pending but past expiry: becomes 'expired', not deleted yet
    const oldRevoked = await guardianInvitation("revoked", 120);
    const recentRevoked = await guardianInvitation("revoked", 5);
    const validPending = await guardianInvitation("pending", null);

    const out = await hk();
    expect(out.outcome).toBe("ok");
    expect(out.failed).toEqual([]);
    expect(out.idempotency_keys).toBeGreaterThanOrEqual(1);
    expect(out.rate_buckets).toBeGreaterThanOrEqual(1);
    expect(out.proof_nonces).toBeGreaterThanOrEqual(1);
    expect(out.account_tokens).toBeGreaterThanOrEqual(2);

    expect(await count(`SELECT count(*)::int AS n FROM idempotency_keys WHERE idempotency_key LIKE $1`, [`%-${mk}-12345678`])).toBe(2); // recent + valid kept
    expect(await count(`SELECT count(*)::int AS n FROM idempotency_keys WHERE idempotency_key = $1`, [`old-${mk}-12345678`])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM auth_rate_buckets WHERE bucket_key = $1`, [`hk-old-${mk}`])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM auth_rate_buckets WHERE bucket_key = $1`, [`hk-new-${mk}`])).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM auth_session_proof_nonces WHERE nonce LIKE $1`, [`hk-%-nonce-${mk}0000`])).toBe(1); // only the live one
    expect(await count(`SELECT count(*)::int AS n FROM account_tokens WHERE email LIKE $1`, [`hk-${mk}-%@example.com`])).toBe(2); // used yesterday + pending valid
    // guardian invitations
    expect((await h.owner(`SELECT status FROM guardian_invitations WHERE id = $1`, [expiredPending.id]))[0]!.status).toBe("expired");
    expect(await count(`SELECT count(*)::int AS n FROM guardian_invitations WHERE id = $1`, [oldRevoked.id])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM guardian_invitations WHERE id = $1`, [recentRevoked.id])).toBe(1);
    expect((await h.owner(`SELECT status FROM guardian_invitations WHERE id = $1`, [validPending.id]))[0]!.status).toBe("pending");
  });

  it("never deletes an ACCEPTED invitation (the provenance of a live link) even when old", async () => {
    const inv = await guardianInvitation("pending", null);
    const user = (await h.owner(`INSERT INTO users (email, password_hash, full_name, status) VALUES ($1, 'x', 'HK Parent', 'active') RETURNING id`, [`hk-${randomUUID().slice(0, 6)}@example.com`]))[0]!.id;
    await h.owner(`UPDATE guardian_invitations SET status = 'accepted', accepted_at = now() - interval '300 days', accepted_by = $2, contact_verification = 'token_and_contact_echo', closed_at = now() - interval '300 days' WHERE id = $1`, [inv.id, user]);
    await h.owner(`INSERT INTO guardian_accounts (tenant_id, guardian_id, user_id, invitation_id) VALUES ($1, $2, $3, $4)`, [A(), inv.guardian, user, inv.id]);
    const out = await hk();
    expect(out.failed).toEqual([]); // not even attempted (a rejected attempt would show up as a failed operation)
    expect(await count(`SELECT count(*)::int AS n FROM guardian_invitations WHERE id = $1`, [inv.id])).toBe(1);
  });

  it("never touches money, reconciliation, audit or job rows, grants the worker no financial authority, and is tenant-neutral", async () => {
    await seedOld();
    const inv = await h.freshInvoice(1_000_000);
    const p = await h.startPrompt(inv, 100_000);
    const snap = async () => ({
      pay: await count(`SELECT count(*)::int AS n FROM finance_payments`),
      inv: await count(`SELECT count(*)::int AS n FROM finance_invoices`),
      ev: await count(`SELECT count(*)::int AS n FROM finance_mpesa_events`),
      fi: await count(`SELECT count(*)::int AS n FROM finance_reconciliation_findings`),
      jobs: await count(`SELECT count(*)::int AS n FROM jobs`),
      um: await count(`SELECT count(*)::int AS n FROM finance_unmatched_cases`),
      audit: await count(`SELECT count(*)::int AS n FROM security_audit_events WHERE event_type <> 'worker.housekeeping.run'`),
      learners: await count(`SELECT count(*)::int AS n FROM learners`),
      memberships: await count(`SELECT count(*)::int AS n FROM school_memberships`),
    });
    const before = await snap();
    const paymentBefore = await h.payment(p.payment.id);
    await hk();
    expect(await snap()).toEqual(before);
    expect(await h.payment(p.payment.id)).toEqual(paymentBefore);
    // the worker did not gain privileges: it still cannot write the ledger directly
    await expect(h.workerPool.query(`UPDATE finance_payments SET status = 'success'`)).rejects.toMatchObject({ code: "42501" });
    await expect(h.workerPool.query(`DELETE FROM idempotency_keys`)).rejects.toMatchObject({ code: "42501" });
    await expect(h.workerPool.query(`DELETE FROM account_tokens`)).rejects.toMatchObject({ code: "42501" });
    // the application role cannot run it
    await expect(h.asApp(A(), (c) => c.query(`SELECT public.worker_housekeeping('app')`))).rejects.toMatchObject({ code: "42501" });
  });

  it("is idempotent and bounded: a second run changes nothing; a backlog larger than one batch is cleared across runs, never in one unbounded statement", async () => {
    await h.owner(`INSERT INTO auth_rate_buckets (bucket_key, tokens, last_refill) SELECT 'hk-bulk-' || g, 1, now() - interval '5 days' FROM generate_series(1, 1500) g`);
    const first = await hk();
    expect(first.rate_buckets).toBe(1000); // exactly one batch
    const second = await hk();
    expect(second.rate_buckets).toBeGreaterThanOrEqual(500);
    await hk();
    expect(await count(`SELECT count(*)::int AS n FROM auth_rate_buckets WHERE bucket_key LIKE 'hk-bulk-%'`)).toBe(0);
    const idle = await hk();
    expect(idle.idempotency_keys + idle.rate_buckets + idle.proof_nonces + idle.account_tokens + idle.guardian_invitations_deleted).toBe(0);
  });

  it("a failing operation is recorded and does NOT skip the others; the heartbeat shows the partial outcome and the audit trail records it", async () => {
    const mk = randomUUID().slice(0, 8);
    await h.owner(`INSERT INTO auth_rate_buckets (bucket_key, tokens, last_refill) VALUES ($1, 1, now() - interval '9 days')`, [`hk-iso-${mk}`]);
    await h.owner(`CREATE FUNCTION public.zz_hk_fail() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'injected'; END $f$`);
    await h.owner(`CREATE TRIGGER zz_hk_fail BEFORE DELETE ON public.account_tokens FOR EACH ROW EXECUTE FUNCTION public.zz_hk_fail()`);
    await h.owner(`INSERT INTO account_tokens (kind, token_hash, tenant_id, email, role, created_by, created_at, expires_at, used_at) VALUES ('invitation', $1, $2, 'hk-fail@example.com', 'teacher', $3, now() - interval '60 days', now() - interval '58 days', now() - interval '59 days')`, [hex().slice(0, 64), A(), h.ids.adminA]);
    try {
      const out = await hk();
      expect(out.failed).toEqual(["account_tokens"]);
      expect(out.outcome).toBe("partial");
      expect(await count(`SELECT count(*)::int AS n FROM auth_rate_buckets WHERE bucket_key = $1`, [`hk-iso-${mk}`])).toBe(0); // the unrelated cleanup still ran
      expect(await count(`SELECT count(*)::int AS n FROM account_tokens WHERE email = 'hk-fail@example.com'`)).toBe(1); // the failed op rolled back whole
      const beat = (await h.owner(`SELECT last_maintenance_outcome, last_maintenance_detail FROM worker_heartbeats WHERE worker_name = 'hk-worker'`))[0]!;
      expect(beat.last_maintenance_outcome).toBe("partial");
      expect(beat.last_maintenance_detail.failed).toEqual(["account_tokens"]);
      expect(JSON.stringify(beat.last_maintenance_detail)).not.toMatch(/injected/); // names only, never messages
      expect((await h.owner(`SELECT 1 FROM security_audit_events WHERE event_type = 'worker.housekeeping.run' AND detail->>'outcome' = 'partial'`)).length).toBeGreaterThanOrEqual(1);
      // observable on the platform status endpoint
      const su = (await h.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "super@example.com", password: PASSWORD } })).json().token as string;
      const status = (await h.call("GET", "/v1/platform/ops/status", su)).json().status;
      const m = (status.maintenance as { worker: string; outcome: string; failed: string[]; last_maintenance_age_seconds: number }[]).find((x) => x.worker === "hk-worker");
      expect(m).toMatchObject({ outcome: "partial", failed: ["account_tokens"] });
      expect(m!.last_maintenance_age_seconds).toBeLessThan(60);
    } finally {
      await h.owner(`DROP TRIGGER zz_hk_fail ON public.account_tokens`);
      await h.owner(`DROP FUNCTION public.zz_hk_fail()`);
    }
    // recovery: once the cause is gone the next run completes and records ok
    const recovered = await hk();
    expect(recovered.outcome).toBe("ok");
    expect(await count(`SELECT count(*)::int AS n FROM account_tokens WHERE email = 'hk-fail@example.com'`)).toBe(0);
  });

  it("concurrent invocation: the second run skips (overlap) instead of queueing or double-deleting", async () => {
    const second = new pg.Pool({ connectionString: (h.workerPool as unknown as { connectionString: string }).connectionString, max: 1 });
    const first = await h.workerPool.connect();
    try {
      await first.query("BEGIN");
      await first.query(`SELECT public.worker_housekeeping('hk-a')`); // holds the advisory lock until COMMIT
      const overlap = (await second.query<{ r: Record<string, string> }>(`SELECT public.worker_housekeeping('hk-b') AS r`)).rows[0]!.r;
      expect(overlap).toEqual({ skipped: "overlap" });
      await first.query("COMMIT");
      expect((await second.query<{ r: Record<string, string> }>(`SELECT public.worker_housekeeping('hk-b') AS r`)).rows[0]!.r.outcome).toBe("ok");
      expect((await h.owner(`SELECT last_maintenance_outcome FROM worker_heartbeats WHERE worker_name = 'hk-b'`))[0]!.last_maintenance_outcome).toBe("ok");
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      first.release();
      await second.end();
    }
  });

  it("interruption: a run that is rolled back (worker killed mid-run) deletes nothing and the next run completes it; it never touches job leases", async () => {
    const mk = randomUUID().slice(0, 8);
    await h.owner(`INSERT INTO auth_rate_buckets (bucket_key, tokens, last_refill) VALUES ($1, 1, now() - interval '9 days')`, [`hk-int-${mk}`]);
    const jobsBefore = await h.owner(`SELECT id, status, leased_by, lease_expires_at, attempts FROM jobs ORDER BY id`);
    const c = await h.workerPool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT public.worker_housekeeping('hk-int')`);
      await c.query("ROLLBACK"); // the process died before COMMIT
    } finally {
      c.release();
    }
    expect(await count(`SELECT count(*)::int AS n FROM auth_rate_buckets WHERE bucket_key = $1`, [`hk-int-${mk}`])).toBe(1);
    await hk();
    expect(await count(`SELECT count(*)::int AS n FROM auth_rate_buckets WHERE bucket_key = $1`, [`hk-int-${mk}`])).toBe(0);
    expect(await h.owner(`SELECT id, status, leased_by, lease_expires_at, attempts FROM jobs ORDER BY id`)).toEqual(jobsBefore); // lease/ownership untouched
  });

  it("runMaintenance dispatches housekeeping, returns its counts, and a failing step is attempted-around then reported (MaintenanceError) without skipping the rest", async () => {
    const mk = randomUUID().slice(0, 8);
    await h.owner(`INSERT INTO auth_rate_buckets (bucket_key, tokens, last_refill) VALUES ($1, 1, now() - interval '9 days')`, [`hk-rm-${mk}`]);
    const ok = await runMaintenance(pool(), "hk-rm");
    expect(ok.housekeeping).toMatchObject({ outcome: "ok" });
    expect(await count(`SELECT count(*)::int AS n FROM auth_rate_buckets WHERE bucket_key = $1`, [`hk-rm-${mk}`])).toBe(0);
    // break the reconciliation sweep (a dependency of an EARLIER step) and prove housekeeping still ran
    await h.owner(`INSERT INTO auth_rate_buckets (bucket_key, tokens, last_refill) VALUES ($1, 1, now() - interval '9 days')`, [`hk-rm2-${mk}`]);
    await h.owner(`ALTER FUNCTION public.finance_reconciliation_sweep(text, integer) RENAME TO finance_reconciliation_sweep_off`);
    try {
      let err: unknown;
      try {
        await runMaintenance(pool(), "hk-rm");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(MaintenanceError);
      expect((err as MaintenanceError).failed).toEqual(["reconciliation_sweep:42883"]);
      expect(await count(`SELECT count(*)::int AS n FROM auth_rate_buckets WHERE bucket_key = $1`, [`hk-rm2-${mk}`])).toBe(0); // housekeeping ran anyway
      expect((await h.owner(`SELECT last_cycle_outcome FROM worker_heartbeats WHERE worker_name = 'hk-rm'`))[0]!.last_cycle_outcome).toBe("maintenance_partial");
    } finally {
      await h.owner(`ALTER FUNCTION public.finance_reconciliation_sweep_off(text, integer) RENAME TO finance_reconciliation_sweep`);
    }
  });
});
