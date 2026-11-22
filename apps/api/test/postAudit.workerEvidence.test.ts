import { randomUUID } from "node:crypto";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { financeHarness } from "./support/financeHarness.js";

/**
 * Post-remediation audit N-1, N-2, N-3 (migration 065). Everything here runs as the REAL figbloom_worker login and
 * obtains its lease through the real jobs_claim() — the earlier F-8 suite planted leases as the table owner, which is
 * why a "legitimate claim, then settle failed with no evidence" path was never exercised.
 */
describe("post-audit: provider evidence, not a lease, decides a payment; lease tokens; no worker audit writes", () => {
  const h = financeHarness();

  async function pending(amount = 100_000) {
    const inv = await h.freshInvoice(1_000_000);
    const p = await h.startPrompt(inv, amount);
    return { id: p.payment.id as string, checkout: p.checkout, inv };
  }

  /** Push every other queued job away, make this payment's job due. */
  async function isolateJob(paymentId: string): Promise<void> {
    await h.owner(`UPDATE jobs SET run_after = now() + interval '1 day' WHERE status = 'queued' AND idempotency_key <> $1`, [`settle:${paymentId}`]);
    await h.makeDue(paymentId);
  }

  type Claimed = { id: string; tenant_id: string; attempts: number; lease_token: string };
  /** A committed worker transaction under a chosen tenant context. */
  async function workerTx<T>(fn: (c: pg.PoolClient) => Promise<T>, tenant = h.A()): Promise<T> {
    const c = await h.workerPool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant]);
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
  async function claim(paymentId: string, label = "pa-worker", seconds = 120): Promise<Claimed> {
    await isolateJob(paymentId);
    const rows = await workerTx(async (c) => (await c.query<Claimed>(`SELECT id, tenant_id, attempts, lease_token FROM jobs_claim($1, $2, ARRAY['mpesa.stk_settle'])`, [label, seconds])).rows);
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }
  const settle = (j: Claimed, paymentId: string, status: string, receipt: string | null, reason: string | null, token = j.lease_token) =>
    workerTx((c) => c.query<{ o: string }>(`SELECT public.finance_worker_settle_payment($1, $2, $3, $4, $5, $6, $7) AS o`, [j.id, token, j.attempts, paymentId, status, receipt, reason]).then((r) => r.rows[0]!.o));
  const state = async (paymentId: string) => (await h.owner(`SELECT status, mpesa_receipt, failure_reason FROM finance_payments WHERE id = $1`, [paymentId]))[0]!;
  const evidence = (paymentId: string, checkout: string, code: number, receipt: string | null = null, tenant = h.A()) =>
    h.owner(
      `INSERT INTO finance_mpesa_events (tenant_id, payment_id, checkout_request_id, source, result_code, receipt, outcome) VALUES ($1, $2, $3, 'callback', $4, $5, 'callback_received')`,
      [tenant, paymentId, checkout, code, receipt],
    );
  const outcomes = async (paymentId: string) => (await h.owner<{ outcome: string }>(`SELECT outcome FROM finance_mpesa_events WHERE payment_id = $1`, [paymentId])).map((r) => r.outcome);
  const sqlState = (p: Promise<unknown>) => h.sqlState(p);

  // ---------------------------------------------------------------- N-1
  it("S1: a worker that legitimately claims the job CANNOT fail the payment without provider evidence (pending, observation recorded)", async () => {
    const p = await pending();
    const j = await claim(p.id);
    for (const [status, reason] of [["failed", "cancelled"], ["cancelled", "cancelled"], ["timeout", "timeout"]] as const) {
      expect(await settle(j, p.id, status, null, reason)).toBe("evidence_required");
    }
    expect(await state(p.id)).toMatchObject({ status: "pending", mpesa_receipt: null, failure_reason: null });
    expect(await outcomes(p.id)).toContain("failure_unconfirmed");
    expect((await h.invoice(p.inv)).paid_minor).toBe(0);
  });

  it("S2/S9/S10/S11: a worker cannot create success without a stored authenticated callback; wrong, missing or foreign receipts are refused", async () => {
    const a = await pending();
    const b = await pending();
    const j = await claim(a.id);
    expect(await sqlState(settle(j, a.id, "success", "NOEVIDENCE01", null))).toBe("42501");
    expect(await sqlState(settle(j, a.id, "success", null, null))).toBe("22023"); // missing receipt
    // a status_query row (all a worker may write) is never success evidence
    await workerTx((c) => c.query(`INSERT INTO finance_mpesa_events (tenant_id, payment_id, checkout_request_id, source, result_code, receipt, outcome) VALUES ($1, $2, $3, 'status_query', 0, 'WORKERPLANT1', 'callback_received')`, [h.A(), a.id, a.checkout]));
    expect(await sqlState(settle(j, a.id, "success", "WORKERPLANT1", null))).toBe("42501");
    // receipt stored for ANOTHER payment cannot credit this one
    await evidence(b.id, b.checkout, 0, "OTHERPAYRCPT1");
    expect(await sqlState(settle(j, a.id, "success", "OTHERPAYRCPT1", null))).toBe("42501");
    // incorrect receipt for the right payment
    await evidence(a.id, a.checkout, 0, "RIGHTRCPT0001");
    expect(await sqlState(settle(j, a.id, "success", "WRONGRCPT0001", null))).toBe("42501");
    expect(await state(a.id)).toMatchObject({ status: "pending" });
    expect((await h.invoice(a.inv)).paid_minor).toBe(0);
  });

  it("S3/S4: valid provider evidence (stored authenticated callbacks) IS processed; the unpaid status/reason are derived from the stored code", async () => {
    const f = await pending();
    const jf = await claim(f.id, "pa-f");
    await evidence(f.id, f.checkout, 1032);
    expect(await sqlState(settle(jf, f.id, "timeout", null, "timeout"))).toBe("22023"); // disagrees with stored code 1032
    expect(await settle(jf, f.id, "cancelled", null, "whatever-worker-says")).toBe("settled_failure");
    expect(await state(f.id)).toMatchObject({ status: "cancelled", failure_reason: "cancelled" });

    const s = await pending();
    const js = await claim(s.id, "pa-s");
    await evidence(s.id, s.checkout, 0, "SUCCESSRCPT01");
    expect(await settle(js, s.id, "success", "SUCCESSRCPT01", null)).toBe("settled_success");
    expect(await state(s.id)).toMatchObject({ status: "success", mpesa_receipt: "SUCCESSRCPT01" });
    expect((await h.invoice(s.inv)).paid_minor).toBe(100_000);
    // S17: a retry after the success changes nothing
    expect(await settle(js, s.id, "success", "SUCCESSRCPT01", null)).toBe("already_settled");
    expect((await h.invoice(s.inv)).paid_minor).toBe(100_000);
  });

  it("S5: a later genuine success callback is NOT lost because a worker earlier tried (and was refused) to fail the payment", async () => {
    const p = await pending();
    const j = await claim(p.id);
    expect(await settle(j, p.id, "failed", null, "cancelled")).toBe("evidence_required");
    await evidence(p.id, p.checkout, 0, "LATESUCCESS01");
    expect(await settle(j, p.id, "success", "LATESUCCESS01", null)).toBe("settled_success");
    expect((await h.invoice(p.inv)).paid_minor).toBe(100_000);
  });

  it("S6/S7: duplicate success and duplicate failure evidence are handled deterministically", async () => {
    const s = await pending();
    const js = await claim(s.id, "pa-dup-s");
    await evidence(s.id, s.checkout, 0, "DUPSUCCESS001");
    await evidence(s.id, s.checkout, 0, "DUPSUCCESS001");
    expect(await settle(js, s.id, "success", "DUPSUCCESS001", null)).toBe("settled_success");
    expect(await settle(js, s.id, "success", "DUPSUCCESS001", null)).toBe("already_settled");
    const f = await pending();
    const jf = await claim(f.id, "pa-dup-f");
    await evidence(f.id, f.checkout, 2001);
    await evidence(f.id, f.checkout, 2001);
    expect(await settle(jf, f.id, "failed", null, "wrong_pin")).toBe("settled_failure");
    expect(await settle(jf, f.id, "failed", null, "wrong_pin")).toBe("already_settled");
    expect(await state(f.id)).toMatchObject({ status: "failed", failure_reason: "wrong_pin" });
  });

  it("S8: conflicting stored evidence (success AND final failure) is preserved, changes nothing and is escalated as settlement_conflict", async () => {
    const p = await pending();
    const j = await claim(p.id);
    await evidence(p.id, p.checkout, 0, "CONFLICTRCPT1");
    await evidence(p.id, p.checkout, 1037);
    expect(await settle(j, p.id, "success", "CONFLICTRCPT1", null)).toBe("conflict");
    expect(await settle(j, p.id, "timeout", null, "timeout")).toBe("conflict");
    expect(await state(p.id)).toMatchObject({ status: "pending" });
    const ev = (await h.auditOf("finance.mpesa.settlement_conflict")).filter((e) => e.detail.paymentId === p.id);
    expect(ev.length).toBeGreaterThanOrEqual(2);
    expect(ev[0]!.detail).toMatchObject({ reason: "contradictory_callbacks", actingVia: "worker" });
    expect((await h.owner(`SELECT count(*)::int AS n FROM finance_mpesa_events WHERE payment_id = $1 AND source = 'callback'`, [p.id]))[0]!.n).toBe(2); // evidence preserved
  });

  it("S12: a lease for tenant A can never settle tenant B's payment, even with matching evidence", async () => {
    const a = await pending();
    const j = await claim(a.id);
    const learner = (await h.owner<{ id: string }>(`INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, $2, 'PA B', 'male') RETURNING id`, [h.ids.tenantB, "PAB" + randomUUID().slice(0, 6)]))[0]!.id;
    const y = (await h.owner<{ id: string }>(`INSERT INTO academic_years (tenant_id, label, starts_on, ends_on) VALUES ($1, $2, '2020-01-01', '2035-12-31') RETURNING id`, [h.ids.tenantB, "PY" + randomUUID().slice(0, 4)]))[0]!.id;
    const t = (await h.owner<{ id: string }>(`INSERT INTO academic_terms (tenant_id, academic_year_id, index, label, starts_on, ends_on) VALUES ($1, $2, 1, 'T', '2020-01-01', '2035-12-31') RETURNING id`, [h.ids.tenantB, y]))[0]!.id;
    const fi = (await h.owner<{ id: string }>(`INSERT INTO finance_fee_items (tenant_id, term_id, name, amount_minor) VALUES ($1, $2, 'B', 1000000) RETURNING id`, [h.ids.tenantB, t]))[0]!.id;
    const inv = (await h.owner<{ id: string }>(`INSERT INTO finance_invoices (tenant_id, learner_id, term_id, due_on) VALUES ($1, $2, $3, '2035-12-31') RETURNING id`, [h.ids.tenantB, learner, t]))[0]!.id;
    await h.owner(`INSERT INTO finance_invoice_lines (tenant_id, invoice_id, fee_item_id, name, amount_minor) VALUES ($1, $2, $3, 'B', 1000000)`, [h.ids.tenantB, inv, fi]);
    const bpay = (await h.owner<{ id: string }>(`INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status, msisdn, checkout_request_id) VALUES ($1, $2, 100000, 'mpesa', 'pending', '254700000077', $3) RETURNING id`, [h.ids.tenantB, inv, "ws_CO_PAB_" + randomUUID().slice(0, 6)]))[0]!.id;
    await evidence(bpay, "ws_CO_PAB_X", 1032, null, h.ids.tenantB);
    expect(await sqlState(settle(j, bpay, "cancelled", null, "cancelled"))).toBe("42501");
    expect((await h.owner(`SELECT status FROM finance_payments WHERE id = $1`, [bpay]))[0]!.status).toBe("pending");
  });

  it("S13/S14: expired and stale (wrong token / wrong fencing attempt) leases settle nothing", async () => {
    const p = await pending();
    const j = await claim(p.id);
    await evidence(p.id, p.checkout, 1032);
    expect(await sqlState(settle(j, p.id, "cancelled", null, null, "not-the-token"))).toBe("42501");
    await h.owner(`UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [j.id]);
    expect(await sqlState(settle(j, p.id, "cancelled", null, null))).toBe("42501");
    expect(await state(p.id)).toMatchObject({ status: "pending" });
    // reclaim: a NEW token; the old holder is stale even though the label is the same
    await h.owner(`UPDATE jobs SET run_after = now() - interval '1 second' WHERE id = $1`, [j.id]);
    const j2 = await claim(p.id);
    expect(j2.lease_token).not.toBe(j.lease_token);
    expect(await sqlState(settle(j, p.id, "cancelled", null, null))).toBe("42501");
    expect(await settle(j2, p.id, "cancelled", null, null)).toBe("settled_failure");
  });

  it("S15: concurrent callback persistence and worker settlement — the worker waits on the lock and then sees the committed evidence", async () => {
    const p = await pending();
    const j = await claim(p.id);
    const owner = await h.ctx.pool.connect();
    try {
      await owner.query("BEGIN");
      await owner.query(`SELECT id FROM finance_invoices WHERE id = $1 FOR UPDATE`, [p.inv]); // the callback route holds the invoice lock
      const worker = settle(j, p.id, "success", "CONCURRENT001", null);
      await new Promise((r) => setTimeout(r, 400));
      await owner.query(`INSERT INTO finance_mpesa_events (tenant_id, payment_id, checkout_request_id, source, result_code, receipt, outcome) VALUES ($1, $2, $3, 'callback', 0, 'CONCURRENT001', 'callback_received')`, [h.A(), p.id, p.checkout]);
      await owner.query("COMMIT");
      expect(await worker).toBe("settled_success");
    } finally {
      await owner.query("ROLLBACK").catch(() => undefined);
      owner.release();
    }
    expect((await h.invoice(p.inv)).paid_minor).toBe(100_000);
  });

  it("S16/S18/S19/S20: crash after evidence, provider success/failure while the worker is down, and an inconclusive provider", async () => {
    // evidence persisted, no worker ran yet; a later worker cycle settles from it (S16)
    const c = await pending();
    await evidence(c.id, c.checkout, 0, "CRASHRECOV001");
    await isolateJob(c.id);
    h.fake.queries.set(c.checkout, { done: true, resultCode: 0 });
    expect(await h.cycle()).toEqual(["succeeded"]);
    expect(await state(c.id)).toMatchObject({ status: "success", mpesa_receipt: "CRASHRECOV001" });
    // provider success / failure delivered by the CALLBACK route while no worker runs (S18/S19)
    const ok = await pending();
    h.fake.queries.set(ok.checkout, { done: true, resultCode: 0 });
    expect((await h.sendCallback(h.callbackBody(ok.checkout, 0, { receipt: "WORKERDOWN001" }))).statusCode).toBe(200);
    expect(await state(ok.id)).toMatchObject({ status: "success" });
    const no = await pending();
    h.fake.queries.set(no.checkout, { done: true, resultCode: 1032 });
    expect((await h.sendCallback(h.callbackBody(no.checkout, 1032))).statusCode).toBe(200);
    expect(await state(no.id)).toMatchObject({ status: "cancelled" });
    // the late worker finds both already settled and changes nothing
    await h.owner(`UPDATE jobs SET run_after = now() - interval '1 second' WHERE status = 'queued'`);
    await h.cycle();
    expect(await state(ok.id)).toMatchObject({ status: "success" });
    expect(await state(no.id)).toMatchObject({ status: "cancelled" });
    // inconclusive provider (S20): still processing, and an unknown code: both stay pending
    const q = await pending();
    h.fake.queries.set(q.checkout, { done: false });
    await isolateJob(q.id);
    expect(await h.cycle()).toEqual(["retry"]);
    expect(await state(q.id)).toMatchObject({ status: "pending" });
    h.fake.queries.set(q.checkout, { done: true, resultCode: 4999 });
    await h.owner(`UPDATE jobs SET run_after = now() - interval '1 second' WHERE idempotency_key = $1`, [`settle:${q.id}`]);
    expect(await h.cycle()).toEqual(["retry"]);
    expect(await state(q.id)).toMatchObject({ status: "pending" });
  });

  it("the invoice balance cannot be moved by the worker role at all", async () => {
    const p = await pending();
    expect(await sqlState(workerTx((c) => c.query(`UPDATE finance_invoices SET paid_minor = 999999999 WHERE id = $1`, [p.inv])))).toBe("42501");
    expect(await sqlState(workerTx((c) => c.query(`INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status) VALUES ($1, $2, 1, 'cash', 'success')`, [h.A(), p.inv])))).toBe("42501");
  });

  // ---------------------------------------------------------------- N-2
  it("N-2: the claim issues an unguessable token the worker and the app cannot read; the label is not a credential", async () => {
    const p = await pending();
    const j = await claim(p.id, "label-is-not-secret");
    expect(j.lease_token).toMatch(/^[0-9a-f]{64}$/);
    expect(await sqlState(workerTx((c) => c.query(`SELECT lease_token FROM jobs`)))).toBe("42501");
    expect(await sqlState(workerTx((c) => c.query(`SELECT * FROM jobs`)))).toBe("42501");
    expect(await sqlState(h.asApp(h.A(), (c) => c.query(`SELECT lease_token FROM jobs`)))).toBe("42501");
    // the readable label ("leased_by") does not open any lifecycle function
    const label = (await workerTx((c) => c.query<{ leased_by: string }>(`SELECT leased_by FROM jobs WHERE id = $1`, [j.id]))).rows[0]!.leased_by;
    expect(label).toBe("label-is-not-secret");
    for (const sql of [
      `SELECT public.jobs_complete($1, $2, $3) AS o`,
      `SELECT public.jobs_extend_lease($1, $2, $3, 60) AS o`,
    ]) {
      const r = await h.sqlState(workerTx((c) => c.query(sql, [j.id, label, j.attempts])));
      expect([null, "42501"]).toContain(r);
    }
    expect((await workerTx((c) => c.query<{ o: boolean }>(`SELECT public.jobs_complete($1, $2, $3) AS o`, [j.id, label, j.attempts]))).rows[0]!.o).toBe(false);
    expect((await h.owner(`SELECT status FROM jobs WHERE id = $1`, [j.id]))[0]!.status).toBe("leased");
  });

  it("N-2: lease renewal is bounded — a lease can never exceed 3600 s from its claim, however often it is renewed", async () => {
    const p = await pending();
    const j = await claim(p.id, "pa-cap", 60);
    const ext = () => workerTx((c) => c.query<{ o: boolean }>(`SELECT public.jobs_extend_lease($1, $2, $3, 3600) AS o`, [j.id, j.lease_token, j.attempts]));
    expect((await ext()).rows[0]!.o).toBe(true);
    const row = (await h.owner<{ gap: number }>(`SELECT extract(epoch FROM (lease_expires_at - lease_started_at))::int AS gap FROM jobs WHERE id = $1`, [j.id]))[0]!;
    expect(row.gap).toBeLessThanOrEqual(3600);
    expect(row.gap).toBeGreaterThan(3500);
    expect(await sqlState(ext())).toBe("42501"); // already at the cap: refused
    expect((await h.owner<{ gap: number }>(`SELECT extract(epoch FROM (lease_expires_at - lease_started_at))::int AS gap FROM jobs WHERE id = $1`, [j.id]))[0]!.gap).toBeLessThanOrEqual(3600);
  });

  it("N-2: complete/retry/dead/assert all require the token; a stale or foreign token never moves the job", async () => {
    const p = await pending();
    const j = await claim(p.id, "pa-life");
    const q = (sql: string, args: unknown[]) => workerTx((c) => c.query<{ o: boolean }>(sql, args)).then((r) => r.rows[0]!.o);
    expect(await q(`SELECT public.jobs_assert_lease($1, $2, $3) AS o`, [j.id, "x".repeat(64), j.attempts])).toBe(false);
    expect(await q(`SELECT public.jobs_retry($1, $2, $3, 5, 'e') AS o`, [j.id, "x".repeat(64), j.attempts])).toBe(false);
    expect(await q(`SELECT public.jobs_dead($1, $2, $3, 'e', 'r') AS o`, [j.id, "x".repeat(64), j.attempts])).toBe(false);
    expect(await q(`SELECT public.jobs_assert_lease($1, $2, $3) AS o`, [j.id, j.lease_token, j.attempts + 1])).toBe(false); // fencing
    expect(await q(`SELECT public.jobs_assert_lease($1, $2, $3) AS o`, [j.id, j.lease_token, j.attempts])).toBe(true);
    expect(await workerTx((c) => c.query(`SELECT public.jobs_assert_lease($1, $2, $3)`, [j.id, j.lease_token, j.attempts]), h.ids.tenantB).then((r) => (r.rows[0] as any).jobs_assert_lease)).toBe(false); // wrong tenant context
    expect(await q(`SELECT public.jobs_complete($1, $2, $3) AS o`, [j.id, j.lease_token, j.attempts])).toBe(true);
    expect(await q(`SELECT public.jobs_complete($1, $2, $3) AS o`, [j.id, j.lease_token, j.attempts])).toBe(false); // finished job is final
    expect((await h.owner(`SELECT lease_token FROM jobs WHERE id = $1`, [j.id]))[0]!.lease_token).toBeNull();
  });

  // ---------------------------------------------------------------- N-3
  it("N-3: the worker cannot write ANY audit event (job.*, finance.* or otherwise); trusted functions still emit them", async () => {
    const p = await pending();
    const j = await claim(p.id, "pa-audit");
    for (const type of ["job.claimed", "job.succeeded", "job.retry_scheduled", "job.dead", "finance.mpesa.settled", "finance.payment.unapplied", "finance.mpesa.settlement_conflict"]) {
      const code = await sqlState(workerTx((c) => c.query(`INSERT INTO security_audit_events (tenant_id, event_type, detail) VALUES ($1, $2, '{"actingVia":"worker"}'::jsonb)`, [h.A(), type])));
      expect(code, type).toBe("42501");
    }
    // the trusted path still produces the event, from persisted job state
    await workerTx((c) => c.query(`SELECT public.jobs_complete($1, $2, $3)`, [j.id, j.lease_token, j.attempts]));
    const ev = (await h.auditOf("job.succeeded")).filter((e) => e.detail.jobId === j.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.detail).toMatchObject({ actingVia: "worker", jobType: "mpesa.stk_settle", attempt: j.attempts });
  });
});
