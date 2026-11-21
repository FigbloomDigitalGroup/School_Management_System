import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runCycle } from "../src/worker/runtime.js";
import { financeHarness, type Json } from "./support/financeHarness.js";

/**
 * Stage 11 F-8 adversarial proof: a compromised figbloom_worker credential must not be able to
 * manufacture financial settlements. Every prohibited path is exercised as the real worker login
 * (not a detector, not an application-layer check alone).
 */
describe("Stage 11 F-8: worker settlement authority boundary", () => {
  const h = financeHarness();

  async function pendingPrompt(amount = 100_000): Promise<{ payment: Json; checkout: string; invoiceId: string }> {
    const invoiceId = await h.freshInvoice(1_000_000);
    const started = await h.startPrompt(invoiceId, amount);
    return { payment: started.payment, checkout: started.checkout, invoiceId };
  }

  async function leaseJob(paymentId: string, workerName = "f8-worker", attempts = 1): Promise<string> {
    const job = (await h.jobOf(paymentId))!;
    await h.owner(
      `UPDATE jobs SET status = 'leased', attempts = $2, leased_by = $3, lease_token = $3, lease_started_at = now(), lease_expires_at = now() + interval '2 minutes'
        WHERE id = $1`,
      [job.id, attempts, workerName],
    );
    return job.id as string;
  }

  async function plantCallbackReceipt(paymentId: string, checkout: string, receipt: string): Promise<void> {
    // Committed authenticated-callback evidence (asApp always rolls back). Owner insert matches what the
    // callback route persists before settle; the worker still cannot plant source=callback itself.
    await h.owner(
      `INSERT INTO finance_mpesa_events
         (tenant_id, payment_id, checkout_request_id, source, result_code, receipt, outcome)
       VALUES ($1, $2, $3, 'callback', 0, $4, 'callback_received')`,
      [h.A(), paymentId, checkout, receipt],
    );
  }

  it("unauthorized direct payment updates are privilege-denied for the worker", async () => {
    const { payment } = await pendingPrompt();
    const attacks = [
      `UPDATE finance_payments SET status = 'success', mpesa_receipt = 'INVENTEDF8RECEIPT1' WHERE id = '${payment.id}'`,
      `UPDATE finance_payments SET status = 'timeout', failure_reason = 'timeout' WHERE id = '${payment.id}'`,
      `UPDATE finance_payments SET status = 'failed', failure_reason = 'cancelled' WHERE id = '${payment.id}'`,
    ];
    for (const sql of attacks) {
      expect(await h.asApp(h.A(), (c) => h.sqlState(c.query(sql)), h.workerPool), sql).toBe("42501");
    }
    expect((await h.payment(payment.id)).status).toBe("pending");
    expect((await h.payment(payment.id)).mpesa_receipt).toBeNull();
  });

  it("cross-tenant GUC manipulation cannot settle another school's pending prompt", async () => {
    const bLearner = (
      await h.owner<{ id: string }>(
        `INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, $2, 'F8 B', 'male') RETURNING id`,
        [h.ids.tenantB, "F8B" + randomUUID().slice(0, 6)],
      )
    )[0]!.id;
    const y = (
      await h.owner<{ id: string }>(
        `INSERT INTO academic_years (tenant_id, label, starts_on, ends_on) VALUES ($1, $2, '2020-01-01', '2030-12-31') RETURNING id`,
        [h.ids.tenantB, "F8Y" + randomUUID().slice(0, 4)],
      )
    )[0]!.id;
    const t = (
      await h.owner<{ id: string }>(
        `INSERT INTO academic_terms (tenant_id, academic_year_id, index, label, starts_on, ends_on) VALUES ($1, $2, 1, 'T', '2020-01-01', '2030-12-31') RETURNING id`,
        [h.ids.tenantB, y],
      )
    )[0]!.id;
    const fi = (
      await h.owner<{ id: string }>(
        `INSERT INTO finance_fee_items (tenant_id, term_id, name, amount_minor) VALUES ($1, $2, 'B', 1000000) RETURNING id`,
        [h.ids.tenantB, t],
      )
    )[0]!.id;
    const inv = (
      await h.owner<{ id: string }>(
        `INSERT INTO finance_invoices (tenant_id, learner_id, term_id, due_on) VALUES ($1, $2, $3, '2030-12-31') RETURNING id`,
        [h.ids.tenantB, bLearner, t],
      )
    )[0]!.id;
    await h.owner(`INSERT INTO finance_invoice_lines (tenant_id, invoice_id, fee_item_id, name, amount_minor) VALUES ($1, $2, $3, 'B', 1000000)`, [
      h.ids.tenantB,
      inv,
      fi,
    ]);
    const bPay = (
      await h.owner<{ id: string }>(
        `INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status, msisdn, checkout_request_id)
         VALUES ($1, $2, 100000, 'mpesa', 'pending', '254700000099', $3) RETURNING id`,
        [h.ids.tenantB, inv, "ws_CO_F8B_" + randomUUID().slice(0, 8)],
      )
    )[0]!.id;
    const paidBefore = (await h.owner<{ paid_minor: string }>(`SELECT paid_minor FROM finance_invoices WHERE id = $1`, [inv]))[0]!.paid_minor;

    // Freely choose tenant B's GUC and attempt the historical F-8 attack.
    expect(
      await h.asApp(h.ids.tenantB, (c) =>
        h.sqlState(
          c.query(`UPDATE finance_payments SET status = 'success', mpesa_receipt = 'CROSSF8RECEIPT01' WHERE id = $1`, [bPay]),
        ),
      h.workerPool),
    ).toBe("42501");
    expect(
      await h.asApp(h.ids.tenantB, (c) =>
        h.sqlState(c.query(`UPDATE finance_payments SET status = 'timeout', failure_reason = 'timeout' WHERE id = $1`, [bPay])),
      h.workerPool),
    ).toBe("42501");

    const after = (await h.owner<{ status: string; mpesa_receipt: string | null; paid_minor: string }>(
      `SELECT p.status, p.mpesa_receipt, i.paid_minor FROM finance_payments p JOIN finance_invoices i ON i.id = p.invoice_id WHERE p.id = $1`,
      [bPay],
    ))[0]!;
    expect(after.status).toBe("pending");
    expect(after.mpesa_receipt).toBeNull();
    expect(after.paid_minor).toBe(paidBefore);
  });

  it("invented receipts and missing callback evidence cannot succeed via the privileged function", async () => {
    const { payment, checkout } = await pendingPrompt();
    const jobId = await leaseJob(payment.id, "f8-evidence");
    const invented = await h.asApp(h.A(), (c) =>
      h.sqlState(
        c.query(`SELECT public.finance_worker_settle_payment($1, 'f8-evidence', 1, $2, 'success', 'INVENTEDRECEIPT99', NULL)`, [
          jobId,
          payment.id,
        ]),
      ),
    h.workerPool);
    expect(invented).toBe("42501");
    expect((await h.payment(payment.id)).status).toBe("pending");

    // status_query (worker-plantable) is not success evidence
    await h.asApp(h.A(), async (c) => {
      await c.query(
        `INSERT INTO finance_mpesa_events (tenant_id, payment_id, checkout_request_id, source, result_code, receipt, outcome)
         VALUES ($1, $2, $3, 'status_query', 0, 'PLANTEDQUERYRCP1', 'provider_pending')`,
        [h.A(), payment.id, checkout],
      );
    }, h.workerPool);
    expect(
      await h.asApp(h.A(), (c) =>
        h.sqlState(
          c.query(`SELECT public.finance_worker_settle_payment($1, 'f8-evidence', 1, $2, 'success', 'PLANTEDQUERYRCP1', NULL)`, [
            jobId,
            payment.id,
          ]),
        ),
      h.workerPool),
    ).toBe("42501");
    expect((await h.payment(payment.id)).status).toBe("pending");
  });

  it("forged callback evidence cannot be planted by the worker", async () => {
    const { payment, checkout } = await pendingPrompt();
    expect(
      await h.asApp(h.A(), (c) =>
        h.sqlState(
          c.query(
            `INSERT INTO finance_mpesa_events
               (tenant_id, payment_id, checkout_request_id, source, result_code, receipt, outcome)
             VALUES ($1, $2, $3, 'callback', 0, 'FORGEDCALLBACK01', 'callback_received')`,
            [h.A(), payment.id, checkout],
          ),
        ),
      h.workerPool),
    ).toBe("42501");
  });

  it("expired, stolen and stale fencing tokens cannot settle", async () => {
    const { payment, checkout } = await pendingPrompt();
    await plantCallbackReceipt(payment.id, checkout, "LEASEDF8RECEIPT1");
    const jobId = (await h.jobOf(payment.id))!.id as string;

    await h.owner(
      `UPDATE jobs SET status = 'leased', attempts = 1, leased_by = 'holder', lease_token = 'holder', lease_started_at = now(), lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [jobId],
    );
    expect(
      await h.asApp(h.A(), (c) =>
        h.sqlState(
          c.query(`SELECT public.finance_worker_settle_payment($1, 'holder', 1, $2, 'success', 'LEASEDF8RECEIPT1', NULL)`, [
            jobId,
            payment.id,
          ]),
        ),
      h.workerPool),
    ).toBe("42501");

    await h.owner(
      `UPDATE jobs SET status = 'leased', attempts = 2, leased_by = 'holder', lease_token = 'holder', lease_started_at = now(), lease_expires_at = now() + interval '2 minutes' WHERE id = $1`,
      [jobId],
    );
    // Stolen lease identity
    expect(
      await h.asApp(h.A(), (c) =>
        h.sqlState(
          c.query(`SELECT public.finance_worker_settle_payment($1, 'thief', 2, $2, 'success', 'LEASEDF8RECEIPT1', NULL)`, [
            jobId,
            payment.id,
          ]),
        ),
      h.workerPool),
    ).toBe("42501");
    // Stale fencing token
    expect(
      await h.asApp(h.A(), (c) =>
        h.sqlState(
          c.query(`SELECT public.finance_worker_settle_payment($1, 'holder', 1, $2, 'success', 'LEASEDF8RECEIPT1', NULL)`, [
            jobId,
            payment.id,
          ]),
        ),
      h.workerPool),
    ).toBe("42501");
    expect((await h.payment(payment.id)).status).toBe("pending");
  });

  it("the function refuses a payment that is not the one named by the leased job", async () => {
    const a = await pendingPrompt();
    const b = await pendingPrompt();
    await plantCallbackReceipt(b.payment.id, b.checkout, "WRONGPAYRECEIPT1");
    const jobId = await leaseJob(a.payment.id, "f8-bind");
    expect(
      await h.asApp(h.A(), (c) =>
        h.sqlState(
          c.query(`SELECT public.finance_worker_settle_payment($1, 'f8-bind', 1, $2, 'success', 'WRONGPAYRECEIPT1', NULL)`, [
            jobId,
            b.payment.id,
          ]),
        ),
      h.workerPool),
    ).toBe("42501");
    expect((await h.payment(a.payment.id)).status).toBe("pending");
    expect((await h.payment(b.payment.id)).status).toBe("pending");
  });

  /** Commit a worker-tenant transaction (asApp always rolls back). */
  async function workerCommit<T>(fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
    const c = await h.workerPool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [h.A()]);
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  it("duplicate settlement is idempotent; a second success with the same receipt does not double-credit", async () => {
    const { payment, checkout, invoiceId } = await pendingPrompt(100_000);
    await plantCallbackReceipt(payment.id, checkout, "IDEMF8RECEIPT001");
    const jobId = await leaseJob(payment.id, "f8-idem");
    const first = await workerCommit(async (c) => {
      const r = await c.query<{ finance_worker_settle_payment: string }>(
        `SELECT public.finance_worker_settle_payment($1, 'f8-idem', 1, $2, 'success', 'IDEMF8RECEIPT001', NULL) AS finance_worker_settle_payment`,
        [jobId, payment.id],
      );
      return r.rows[0]!.finance_worker_settle_payment;
    });
    expect(first).toBe("settled_success");
    expect((await h.payment(payment.id)).status).toBe("success");
    const paid = (await h.invoice(invoiceId)).paid_minor as number;

    const second = await workerCommit(async (c) => {
      const r = await c.query<{ finance_worker_settle_payment: string }>(
        `SELECT public.finance_worker_settle_payment($1, 'f8-idem', 1, $2, 'success', 'IDEMF8RECEIPT001', NULL) AS finance_worker_settle_payment`,
        [jobId, payment.id],
      );
      return r.rows[0]!.finance_worker_settle_payment;
    });
    expect(second).toBe("already_settled");
    expect((await h.invoice(invoiceId)).paid_minor).toBe(paid);
  });

  it("figbloom_app cannot execute the worker settlement function; legitimate held-lease success still works for the worker", async () => {
    const { payment, checkout } = await pendingPrompt();
    await plantCallbackReceipt(payment.id, checkout, "APPCALLF8RCP0001");
    const jobId = await leaseJob(payment.id, "f8-ok");
    expect(
      await h.asApp(h.A(), (c) =>
        h.sqlState(
          c.query(`SELECT public.finance_worker_settle_payment($1, 'f8-ok', 1, $2, 'success', 'APPCALLF8RCP0001', NULL)`, [
            jobId,
            payment.id,
          ]),
        ),
      ),
    ).toBe("42501");

    const ok = await workerCommit(async (c) => {
      const r = await c.query<{ finance_worker_settle_payment: string }>(
        `SELECT public.finance_worker_settle_payment($1, 'f8-ok', 1, $2, 'success', 'APPCALLF8RCP0001', NULL) AS finance_worker_settle_payment`,
        [jobId, payment.id],
      );
      return r.rows[0]!.finance_worker_settle_payment;
    });
    expect(ok).toBe("settled_success");
    expect((await h.payment(payment.id))).toMatchObject({ status: "success", mpesa_receipt: "APPCALLF8RCP0001" });
  });

  it("unauthorized audit manipulation remains bounded; worker cannot forge settlement-authority audit rows (F8-B)", async () => {
    expect(
      await h.asApp(h.A(), (c) =>
        h.sqlState(
          c.query(
            `INSERT INTO security_audit_events (tenant_id, event_type, detail)
             VALUES ($1, 'finance.mpesa.settled', jsonb_build_object('actingVia', 'worker', 'forged', true))`,
            [h.A()],
          ),
        ),
      h.workerPool),
    ).toBe("42501");
    expect(
      await h.asApp(h.A(), (c) =>
        h.sqlState(
          c.query(
            `INSERT INTO security_audit_events (tenant_id, event_type, detail)
             VALUES ($1, 'finance.payment.unapplied', jsonb_build_object('actingVia', 'worker', 'forged', true))`,
            [h.A()],
          ),
        ),
      h.workerPool),
    ).toBe("42501");
    // Disallowed non-worker type or another tenant is also refused.
    expect(
      await h.asApp(h.A(), (c) =>
        h.sqlState(
          c.query(
            `INSERT INTO security_audit_events (tenant_id, event_type, detail)
             VALUES ($1, 'finance.payment.recorded', jsonb_build_object('actingVia', 'worker'))`,
            [h.A()],
          ),
        ),
      h.workerPool),
    ).toBe("42501");
    expect(
      await h.asApp(h.A(), (c) =>
        h.sqlState(
          c.query(
            `INSERT INTO security_audit_events (tenant_id, event_type, detail)
             VALUES ($1, 'job.succeeded', jsonb_build_object('actingVia', 'worker'))`,
            [h.ids.tenantB],
          ),
        ),
      h.workerPool),
    ).toBe("42501");
  });

  it("end-to-end worker settle credits only when a stored callback receipt exists", async () => {
    const { payment, checkout } = await pendingPrompt();
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    await h.makeDue(payment.id);
    // No callback yet: provider success cannot credit.
    expect(await h.cycle()).toEqual(["retry"]);
    expect((await h.payment(payment.id)).status).toBe("pending");

    // Callback arrives while provider query is unavailable (503): callback_received evidence is stored, payment stays pending.
    h.fake.queries.set(checkout, "throw");
    expect((await h.sendCallback(h.callbackBody(checkout, 0, { amount: 1000, receipt: "E2EF8RECEIPT0001" }))).statusCode).toBe(503);
    expect((await h.payment(payment.id)).status).toBe("pending");
    await h.makeDue(payment.id);
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    expect(await h.cycle()).toEqual(["succeeded"]);
    expect((await h.payment(payment.id))).toMatchObject({ status: "success", mpesa_receipt: "E2EF8RECEIPT0001" });
    const settled = (await h.auditOf("finance.mpesa.settled")).find((e) => e.detail.paymentId === payment.id)!;
    expect(settled.detail).toMatchObject({ actingVia: "worker", outcome: "success", receiptBasis: "stored_callback" });
  });

  it("F8-A: figbloom_worker holds zero UPDATE privileges on jobs and cannot forge or manipulate job leases", async () => {
    const tblUpd = await h.owner<{ upd: boolean }>(
      `SELECT has_table_privilege('figbloom_worker', 'public.jobs', 'UPDATE') AS upd`,
    );
    expect(tblUpd[0]!.upd).toBe(false);
    const colPrivs = await h.owner<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE grantee = 'figbloom_worker' AND table_schema = 'public' AND table_name = 'jobs' AND privilege_type = 'UPDATE'`,
    );
    expect(colPrivs).toEqual([]);

    const { payment } = await pendingPrompt();
    const job = (await h.jobOf(payment.id))!;

    // Queued job: all direct UPDATE attempts fail with 42501
    const queuedAttacks = [
      `UPDATE jobs SET status = 'leased', leased_by = 'forger', lease_token = 'forger', lease_started_at = now(), lease_expires_at = now() + interval '5 minutes' WHERE id = '${job.id}'`,
      `UPDATE jobs SET status = 'queued', run_after = now() WHERE id = '${job.id}'`,
      `UPDATE jobs SET status = 'dead', finished_at = now(), last_error_code = 'forged' WHERE id = '${job.id}'`,
      `UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = '${job.id}'`,
    ];
    for (const sql of queuedAttacks) {
      expect(await h.asApp(h.A(), (c) => h.sqlState(c.query(sql)), h.workerPool), sql).toBe("42501");
    }

    // Leased job (attempts >= 1): direct UPDATE still fails with 42501 (cannot manufacture or hijack lease)
    await leaseJob(payment.id, "real-worker", 1);
    const leasedAttacks = [
      `UPDATE jobs SET leased_by = 'forger', lease_token = 'forger', lease_started_at = now(), lease_expires_at = now() + interval '5 minutes' WHERE id = '${job.id}'`,
      `UPDATE jobs SET status = 'queued', run_after = now(), lease_expires_at = NULL, leased_by = NULL WHERE id = '${job.id}'`,
      `UPDATE jobs SET status = 'succeeded', finished_at = now(), lease_expires_at = NULL, leased_by = NULL WHERE id = '${job.id}'`,
      `UPDATE jobs SET status = 'dead', finished_at = now(), lease_expires_at = NULL, leased_by = NULL, last_error_code = 'forged' WHERE id = '${job.id}'`,
    ];
    for (const sql of leasedAttacks) {
      expect(await h.asApp(h.A(), (c) => h.sqlState(c.query(sql)), h.workerPool), sql).toBe("42501");
    }
    // Forger cannot settle using a forged lease
    expect(
      await h.asApp(
        h.A(),
        (c) =>
          h.sqlState(
            c.query(`SELECT public.finance_worker_settle_payment($1, 'forger', 1, $2, 'failed', NULL, 'cancelled')`, [
              job.id,
              payment.id,
            ]),
          ),
        h.workerPool,
      ),
    ).toBe("42501");

    // figbloom_app cannot execute any worker lifecycle function
    for (const fnSql of [
      `SELECT public.jobs_assert_lease($1, 'real-worker', 1)`,
      `SELECT public.jobs_complete($1, 'real-worker', 1)`,
      `SELECT public.jobs_retry($1, 'real-worker', 1, 10, 'err')`,
      `SELECT public.jobs_dead($1, 'real-worker', 1, 'err', 'permanent_error')`,
      `SELECT public.jobs_extend_lease($1, 'real-worker', 1, 30)`,
    ]) {
      expect(await h.asApp(h.A(), (c) => h.sqlState(c.query(fnSql, [job.id]))), fnSql).toBe("42501");
    }

    // Lifecycle functions refuse wrong worker, stale attempt, missing job ID, or non-leased status
    const missingId = randomUUID();
    for (const [label, fnSql, args] of [
      ["assert wrong worker", `SELECT public.jobs_assert_lease($1, 'thief', 1) AS ok`, [job.id]],
      ["assert stale attempt", `SELECT public.jobs_assert_lease($1, 'real-worker', 99) AS ok`, [job.id]],
      ["complete wrong worker", `SELECT public.jobs_complete($1, 'thief', 1) AS ok`, [job.id]],
      ["retry wrong worker", `SELECT public.jobs_retry($1, 'thief', 1, 15, 'err') AS ok`, [job.id]],
      ["dead wrong worker", `SELECT public.jobs_dead($1, 'thief', 1, 'err') AS ok`, [job.id]],
      ["complete missing id", `SELECT public.jobs_complete($1, 'real-worker', 1) AS ok`, [missingId]],
    ] as const) {
      const ok = await h.asApp(
        h.A(),
        async (c) => (await c.query<{ ok: boolean }>(fnSql, [...args])).rows[0]!.ok,
        h.workerPool,
      );
      expect(ok, label).toBe(false);
    }

    // Mid-handler lease steal: ctx.fenced() calls jobs_assert_lease and aborts side effects when stolen
    await h.owner(`UPDATE jobs SET status = 'queued', attempts = 0, leased_by = NULL, lease_expires_at = NULL, run_after = now() - interval '1 second' WHERE id = $1`, [job.id]);
    let sideEffectExecuted = false;
    const outcome = await runCycle(h.workerPool, {
      workerName: "w-1",
      leaseSeconds: 30,
      handlers: {
        "mpesa.stk_settle": async (ctx) => {
          await h.owner(`UPDATE jobs SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [ctx.jobId]);
          const stolen = await h.workerPool.query(`SELECT attempts FROM public.jobs_claim('w-2', 30, ARRAY['mpesa.stk_settle'])`);
          expect(stolen.rows[0]!.attempts).toBe(2);
          await ctx.fenced(async () => {
            sideEffectExecuted = true;
          });
        },
      },
    });
    expect(outcome).toBe("lease_lost");
    expect(sideEffectExecuted).toBe(false);
  });

  it("F8-C: finance_worker_settle_payment and mpesa handler distinguish already_settled replay from conflicting terminal state", async () => {
    // (a) Payment already terminal 'failed'; worker requests 'success' with a stored callback receipt -> 'conflict'
    const a = await pendingPrompt();
    await plantCallbackReceipt(a.payment.id, a.checkout, "CONFLICTRCPT0001");
    await h.owner(`UPDATE finance_payments SET status = 'failed', failure_reason = 'cancelled' WHERE id = $1`, [a.payment.id]);
    const jobA = await leaseJob(a.payment.id, "f8-conflict-a", 1);
    const resA = await workerCommit(async (c) => {
      const r = await c.query<{ outcome: string }>(
        `SELECT public.finance_worker_settle_payment($1, 'f8-conflict-a', 1, $2, 'success', 'CONFLICTRCPT0001', NULL) AS outcome`,
        [jobA, a.payment.id],
      );
      return r.rows[0]!.outcome;
    });
    expect(resA).toBe("conflict");
    expect((await h.payment(a.payment.id)).status).toBe("failed");
    const conflictAuditsA = (await h.auditOf("finance.mpesa.settlement_conflict")).filter(
      (e) => e.detail.paymentId === a.payment.id,
    );
    expect(conflictAuditsA.length).toBeGreaterThanOrEqual(1);

    // (b) Payment settled 'success' with 'RCPT_ONE':
    //     - exact replay ('success', 'RCPT_ONE') -> 'already_settled'
    //     - different receipt ('RCPT_TWO') -> 'conflict'
    //     - lowercase/untrimmed receipt ('rcpt_one') -> 'conflict'
    //     - failure request ('failed', 'cancelled') -> 'conflict'
    const b = await pendingPrompt();
    await plantCallbackReceipt(b.payment.id, b.checkout, "RCPTONE001");
    await plantCallbackReceipt(b.payment.id, b.checkout, "RCPTTWO002");
    const jobB = await leaseJob(b.payment.id, "f8-conflict-b", 1);
    expect(
      await workerCommit(async (c) =>
        (
          await c.query<{ outcome: string }>(
            `SELECT public.finance_worker_settle_payment($1, 'f8-conflict-b', 1, $2, 'success', 'RCPTONE001', NULL) AS outcome`,
            [jobB, b.payment.id],
          )
        ).rows[0]!.outcome,
      ),
    ).toBe("settled_success");
    expect(
      await workerCommit(async (c) =>
        (
          await c.query<{ outcome: string }>(
            `SELECT public.finance_worker_settle_payment($1, 'f8-conflict-b', 1, $2, 'success', 'RCPTONE001', NULL) AS outcome`,
            [jobB, b.payment.id],
          )
        ).rows[0]!.outcome,
      ),
    ).toBe("already_settled");
    expect(
      await workerCommit(async (c) =>
        (
          await c.query<{ outcome: string }>(
            `SELECT public.finance_worker_settle_payment($1, 'f8-conflict-b', 1, $2, 'success', 'RCPTTWO002', NULL) AS outcome`,
            [jobB, b.payment.id],
          )
        ).rows[0]!.outcome,
      ),
    ).toBe("conflict");
    expect(
      await workerCommit(async (c) =>
        (
          await c.query<{ outcome: string }>(
            `SELECT public.finance_worker_settle_payment($1, 'f8-conflict-b', 1, $2, 'success', 'rcptone001', NULL) AS outcome`,
            [jobB, b.payment.id],
          )
        ).rows[0]!.outcome,
      ),
    ).toBe("conflict");
    expect(
      await workerCommit(async (c) =>
        (
          await c.query<{ outcome: string }>(
            `SELECT public.finance_worker_settle_payment($1, 'f8-conflict-b', 1, $2, 'failed', NULL, 'cancelled') AS outcome`,
            [jobB, b.payment.id],
          )
        ).rows[0]!.outcome,
      ),
    ).toBe("conflict");
    expect((await h.payment(b.payment.id))).toMatchObject({ status: "success", mpesa_receipt: "RCPTONE001" });

    // (c) End-to-end via runCycle / h.cycle() when payment is already in conflicting terminal 'failed' state
    const cPrompt = await pendingPrompt();
    await plantCallbackReceipt(cPrompt.payment.id, cPrompt.checkout, "CYCLECONFLICT001");
    await h.owner(`UPDATE finance_payments SET status = 'failed', failure_reason = 'cancelled' WHERE id = $1`, [cPrompt.payment.id]);
    await h.owner(`UPDATE jobs SET run_after = now() + interval '1 day' WHERE status = 'queued'`);
    await h.makeDue(cPrompt.payment.id);
    h.fake.queries.set(cPrompt.checkout, { done: true, resultCode: 0 });
    expect(await h.cycle()).toEqual(["dead"]);
    expect((await h.payment(cPrompt.payment.id)).status).toBe("failed");
    expect((await h.jobOf(cPrompt.payment.id))!).toMatchObject({
      status: "dead",
      last_error_code: "settlement_conflict",
    });
    const evs = await h.owner<{ outcome: string }>(
      `SELECT outcome FROM finance_mpesa_events WHERE payment_id = $1 AND outcome = 'evidence_conflict'`,
      [cPrompt.payment.id],
    );
    expect(evs.length).toBeGreaterThanOrEqual(1);
  });

  it("F8-D, M3-A & M3-C: DEFINER search_path/temp-table immunity, bounded jobs_extend_lease, and lease_exhausted recovery", async () => {
    // (a) F8-D: pg_proc metadata and temp-table shadow attack immunity
    const procs = await h.owner<{ proname: string; prosecdef: boolean; proconfig: string[]; has_public: boolean }>(
      `SELECT p.proname,
              p.prosecdef,
              p.proconfig,
              EXISTS (
                SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                 WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
              ) AS has_public
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('finance_worker_settle_payment', 'jobs_claim', 'jobs_assert_lease', 'jobs_complete', 'jobs_retry', 'jobs_dead', 'jobs_extend_lease')`,
    );
    expect(procs).toHaveLength(7);
    for (const p of procs) {
      expect(p.prosecdef, p.proname).toBe(true);
      expect(p.proconfig, p.proname).toEqual(["search_path=pg_catalog, pg_temp"]);
      expect(p.has_public, p.proname).toBe(false);
    }

    // Temp-table shadow attack on finance_mpesa_events as figbloom_worker
    const { payment, checkout } = await pendingPrompt();
    const jobId = await leaseJob(payment.id, "f8-shadow", 1);
    const dbName = (await h.owner<{ d: string }>(`SELECT current_database() AS d`))[0]!.d;
    await h.owner(`GRANT TEMPORARY ON DATABASE ${dbName} TO figbloom_worker`);
    try {
      const shadowState = await h.asApp(
        h.A(),
        async (c) => {
          await c.query(`SET LOCAL search_path = pg_temp, public`);
          await c.query(`CREATE TEMP TABLE finance_mpesa_events (LIKE public.finance_mpesa_events INCLUDING DEFAULTS)`);
          await c.query(
            `INSERT INTO pg_temp.finance_mpesa_events (tenant_id, payment_id, checkout_request_id, source, result_code, receipt, outcome)
             VALUES ($1, $2, $3, 'callback', 0, 'SHADOWRECEIPT001', 'callback_received')`,
            [h.A(), payment.id, checkout],
          );
          return h.sqlState(
            c.query(`SELECT public.finance_worker_settle_payment($1, 'f8-shadow', 1, $2, 'success', 'SHADOWRECEIPT001', NULL)`, [
              jobId,
              payment.id,
            ]),
          );
        },
        h.workerPool,
      );
      expect(shadowState).toBe("42501");
    } finally {
      await h.owner(`REVOKE TEMPORARY ON DATABASE ${dbName} FROM figbloom_worker`);
    }

    // (b) M3-A: jobs_extend_lease extends only an active, matching lease within 5..3600s
    const beforeExp = (await h.owner<{ lease_expires_at: Date }>(`SELECT lease_expires_at FROM jobs WHERE id = $1`, [jobId]))[0]!.lease_expires_at;
    const extended = await workerCommit(async (c) =>
      (await c.query<{ ok: boolean }>(`SELECT public.jobs_extend_lease($1, 'f8-shadow', 1, 60) AS ok`, [jobId])).rows[0]!.ok,
    );
    expect(extended).toBe(true);
    const afterExp = (await h.owner<{ lease_expires_at: Date }>(`SELECT lease_expires_at FROM jobs WHERE id = $1`, [jobId]))[0]!.lease_expires_at;
    expect(afterExp.getTime()).toBeGreaterThan(beforeExp.getTime() + 50_000);
    // Out-of-range extension rejected (22023)
    expect(await h.asApp(h.A(), (c) => h.sqlState(c.query(`SELECT public.jobs_extend_lease($1, 'f8-shadow', 1, 0)`, [jobId])), h.workerPool)).toBe("22023");
    expect(await h.asApp(h.A(), (c) => h.sqlState(c.query(`SELECT public.jobs_extend_lease($1, 'f8-shadow', 1, 86400)`, [jobId])), h.workerPool)).toBe("22023");
    // Stolen/stale/expired lease rejected (42501)
    expect(await h.asApp(h.A(), (c) => h.sqlState(c.query(`SELECT public.jobs_extend_lease($1, 'thief', 1, 30)`, [jobId])), h.workerPool)).toBe("42501");
    expect(await h.asApp(h.A(), (c) => h.sqlState(c.query(`SELECT public.jobs_extend_lease($1, 'f8-shadow', 2, 30)`, [jobId])), h.workerPool)).toBe("42501");
    await h.owner(`UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [jobId]);
    expect(await h.asApp(h.A(), (c) => h.sqlState(c.query(`SELECT public.jobs_extend_lease($1, 'f8-shadow', 1, 30)`, [jobId])), h.workerPool)).toBe("42501");

    // (c) M3-C: lease_exhausted dead job leaves payment pending, raised by reconciliation, and recoverable by operator/callback
    const exh = await pendingPrompt();
    const exhJob = (await h.jobOf(exh.payment.id))!;
    await h.owner(
      `UPDATE jobs SET status = 'queued', lease_expires_at = NULL, leased_by = NULL, run_after = now() + interval '1 day'
        WHERE status IN ('queued', 'leased') AND id <> $1`,
      [exhJob.id],
    );
    await h.owner(
      `UPDATE jobs SET status = 'leased', attempts = max_attempts, leased_by = 'crashed-worker', lease_token = 'crashed-worker', lease_started_at = now(), lease_expires_at = now() - interval '1 minute' WHERE id = $1`,
      [exhJob.id],
    );
    expect(await h.cycle()).toEqual([]);
    expect((await h.jobOf(exh.payment.id))!).toMatchObject({ status: "dead", last_error_code: "lease_exhausted" });
    expect((await h.payment(exh.payment.id)).status).toBe("pending");
    await h.owner(`ALTER TABLE finance_payments DISABLE TRIGGER finance_payments_guard`);
    try {
      await h.owner(`UPDATE finance_payments SET created_at = now() - interval '2 hours' WHERE id = $1`, [exh.payment.id]);
    } finally {
      await h.owner(`ALTER TABLE finance_payments ENABLE TRIGGER finance_payments_guard`);
    }
    const reconRun = await h.post("/reconciliation-runs", { stale_after_minutes: 30 });
    expect([200, 201]).toContain(reconRun.statusCode);
    expect((reconRun.json().findings as Json[]).some((f) => f.kind === "stale_pending_prompt" && f.subject_id === exh.payment.id)).toBe(true);
    h.fake.queries.set(exh.checkout, { done: true, resultCode: 0 });
    const opRes = await h.post(`/payments/${exh.payment.id}/mpesa-reconciliation`, {
      action: "settle_success",
      receipt: "EXHRECONRCPT1",
      note: "Reconciled after worker lease exhaustion",
    });
    expect(opRes.statusCode).toBe(200);
    expect((await h.payment(exh.payment.id))).toMatchObject({ status: "success", mpesa_receipt: "EXHRECONRCPT1" });
  });
});
