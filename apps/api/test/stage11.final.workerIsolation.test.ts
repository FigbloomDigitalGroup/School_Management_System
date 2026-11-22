import { randomUUID } from "node:crypto";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { callbackAmountToMinor } from "../src/modules/finance/mpesa.js";
import { financeHarness, type Json } from "./support/financeHarness.js";

/**
 * Remediation, cross-cutting worker-isolation proof (review F-9, F-13 and adversarial scenarios 4, 5, 10, 11, 12, 15):
 * the database, not the application's own WHERE clauses, keeps one school's rows away from the worker, and the catalogue
 * detector that guards that is itself proven to fail when a policy is weakened.
 */
describe("Stage 11 remediation: worker isolation proof", () => {
  const h = financeHarness();

  /** Every policy that applies to figbloom_worker (named for it, or for PUBLIC) whose predicate is unconditional. */
  async function unconditionalWorkerPolicies(c: pg.PoolClient | pg.Pool): Promise<string[]> {
    const r = await c.query<{ tablename: string; policyname: string; qual: string | null; with_check: string | null; cmd: string }>(
      `SELECT tablename, policyname, qual, with_check, cmd FROM pg_policies
        WHERE schemaname = 'public' AND (roles @> ARRAY['figbloom_worker']::name[] OR roles @> ARRAY['public']::name[])`,
    );
    // unconditional: literally true, or any disjunction with an always-true arm (OR true, OR 1=1)
    const isTrue = (x: string | null) => x !== null && (/^\(?\s*true\s*\)?$/i.test(x.trim()) || /\bor\s*\(?\s*(true|1\s*=\s*1)\b/i.test(x) || /\b(true|1\s*=\s*1)\s*\)?\s*or\b/i.test(x));
    return r.rows
      .filter((p) => isTrue(p.qual) || isTrue(p.with_check) || (p.qual === null && p.with_check === null))
      .map((p) => `${p.tablename}.${p.policyname}`);
  }

  it("every table the worker role can touch has RLS ENABLED and FORCED and a worker policy bound to the current tenant", async () => {
    const tables = (await h.owner<{ table_name: string }>("SELECT DISTINCT table_name FROM information_schema.role_table_grants WHERE grantee = 'figbloom_worker' AND table_schema = 'public'")).map((r) => r.table_name);
    expect(tables.length).toBeGreaterThan(5);
    const problems: string[] = [];
    for (const t of tables) {
      if (t === "security_audit_events") continue; // append-only and shared by every role: no RLS by design, guarded by the worker-scope trigger (migrations 041-044) and tested in the batch 1 suite
      const cls = (await h.owner<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = ('public.' || $1)::regclass", [t]))[0]!;
      if (!cls.relrowsecurity) problems.push(`${t}: RLS not enabled`);
      if (!cls.relforcerowsecurity) problems.push(`${t}: RLS not forced`);
      const pol = await h.owner<{ policyname: string; qual: string | null; with_check: string | null }>(
        "SELECT policyname, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 AND roles @> ARRAY['figbloom_worker']::name[]",
        [t],
      );
      if (pol.length === 0) problems.push(`${t}: no policy for figbloom_worker`);
      for (const p of pol) {
        if (!/app_current_tenant_id\(\)/.test(p.qual ?? "")) problems.push(`${t}.${p.policyname}: USING is not bound to the current tenant`);
        if (!/app_current_tenant_id\(\)/.test(p.with_check ?? "")) problems.push(`${t}.${p.policyname}: WITH CHECK is not bound to the current tenant`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("no policy applicable to the worker is unconditional (the detector is clean on the real schema)", async () => {
    expect(await unconditionalWorkerPolicies(h.ctx.pool)).toEqual([]);
  });

  it("MUTATION: the detector flags a worker policy weakened to USING (true), and a weakened policy really exposes another school's rows", async () => {
    const c = await h.ctx.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("ALTER POLICY finance_payments_worker ON finance_payments USING (true) WITH CHECK (true)");
      expect(await unconditionalWorkerPolicies(c)).toContain("finance_payments.finance_payments_worker");
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
    expect(await unconditionalWorkerPolicies(h.ctx.pool)).toEqual([]); // restored by the rollback
  });

  it("MUTATION: the detector also flags a tenant predicate weakened with an always-true arm (OR true / OR 1=1)", async () => {
    for (const weakened of ["(tenant_id = app_current_tenant_id()) OR true", "tenant_id = app_current_tenant_id() OR 1=1"]) {
      const c = await h.ctx.pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(`ALTER POLICY jobs_worker ON jobs USING (${weakened}) WITH CHECK (${weakened})`);
        expect(await unconditionalWorkerPolicies(c), weakened).toContain("jobs.jobs_worker");
        await c.query("ROLLBACK");
      } finally {
        c.release();
      }
    }
    expect(await unconditionalWorkerPolicies(h.ctx.pool)).toEqual([]);
  });

  /** A real, pending M-Pesa payment of ANOTHER school (tenant B), seeded by the owner. */
  async function tenantBPayment(): Promise<{ paymentId: string; invoiceId: string }> {
    const B = h.ids.tenantB;
    const o = h.owner;
    const y = (await o<{ id: string }>("INSERT INTO academic_years (tenant_id, label, starts_on, ends_on) VALUES ($1, $2, '2020-01-01', '2030-12-31') RETURNING id", [B, "B" + randomUUID().slice(0, 6)]))[0]!.id;
    const t = (await o<{ id: string }>("INSERT INTO academic_terms (tenant_id, academic_year_id, index, label, starts_on, ends_on) VALUES ($1, $2, 1, 'B1', '2020-01-01', '2030-12-31') RETURNING id", [B, y]))[0]!.id;
    const l = (await o<{ id: string }>("INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, $2, 'B Learner', 'male') RETURNING id", [B, "B" + randomUUID().slice(0, 6)]))[0]!.id;
    const fi = (await o<{ id: string }>("INSERT INTO finance_fee_items (tenant_id, term_id, name, amount_minor) VALUES ($1, $2, 'B', 1000000) RETURNING id", [B, t]))[0]!.id;
    const inv = (await o<{ id: string }>("INSERT INTO finance_invoices (tenant_id, learner_id, term_id, due_on) VALUES ($1, $2, $3, '2030-12-31') RETURNING id", [B, l, t]))[0]!.id;
    await o("INSERT INTO finance_invoice_lines (tenant_id, invoice_id, fee_item_id, name, amount_minor) VALUES ($1, $2, $3, 'B', 1000000)", [B, inv, fi]);
    const p = (await o<{ id: string }>("INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status, msisdn, checkout_request_id) VALUES ($1, $2, 100000, 'mpesa', 'pending', '254700000000', $3) RETURNING id", [B, inv, "ws_CO_B_" + randomUUID().slice(0, 8)]))[0]!.id;
    return { paymentId: p, invoiceId: inv };
  }

  it("under tenant A's context the worker (and the app) cannot read or write school B's rows by id, with no tenant filter in the SQL", async () => {
    const b = await tenantBPayment();
    const bJob = (await h.owner<{ id: string }>("INSERT INTO jobs (tenant_id, job_type, payload, idempotency_key, run_after) VALUES ($1, 'mpesa.stk_settle', $2::jsonb, $3, now() + interval '1 day') RETURNING id", [h.ids.tenantB, JSON.stringify({ paymentId: b.paymentId }), "settle:" + b.paymentId]))[0]!.id;
    for (const [name, pool] of [["worker", h.workerPool], ["app", h.ctx.runtimePool]] as const) {
      await h.asApp(
        h.A(),
        async (c) => {
          const n = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rowCount;
          expect(await n("SELECT 1 FROM finance_payments WHERE id = $1", [b.paymentId]), `${name} read payment`).toBe(0);
          expect(await n("SELECT 1 FROM finance_invoices WHERE id = $1", [b.invoiceId]), `${name} read invoice`).toBe(0);
          expect(await n("SELECT 1 FROM jobs WHERE id = $1", [bJob]), `${name} read job`).toBe(0);
          if (name === "worker") {
            // F-8: direct payment/invoice UPDATE is privilege-denied, not merely RLS-filtered.
            await c.query("SAVEPOINT f8_pay");
            expect(await h.sqlState(c.query("UPDATE finance_payments SET status = 'failed', failure_reason = 'cancelled' WHERE id = $1", [b.paymentId])), "worker update payment").toBe("42501");
            await c.query("ROLLBACK TO SAVEPOINT f8_pay");
            await c.query("SAVEPOINT f8_inv");
            expect(await h.sqlState(c.query("UPDATE finance_invoices SET updated_at = now() WHERE id = $1", [b.invoiceId])), "worker update invoice").toBe("42501");
            await c.query("ROLLBACK TO SAVEPOINT f8_inv");
            await c.query("SAVEPOINT f8_job");
            expect(await h.sqlState(c.query("UPDATE jobs SET status = 'queued' WHERE id = $1", [bJob])), "worker update job").toBe("42501");
            await c.query("ROLLBACK TO SAVEPOINT f8_job");
            // writing a row FOR school B while in A's context is refused by RLS WITH CHECK
            await c.query("SAVEPOINT s");
            const code = await h.sqlState(c.query("INSERT INTO finance_mpesa_events (tenant_id, payment_id, checkout_request_id, source, outcome) VALUES ($1, $2, 'x', 'status_query', 'provider_pending')", [h.ids.tenantB, b.paymentId]));
            expect(code, "worker cross-tenant insert").toBe("42501");
            await c.query("ROLLBACK TO SAVEPOINT s");
          } else {
            expect(await n("UPDATE finance_payments SET status = 'failed', failure_reason = 'cancelled' WHERE id = $1", [b.paymentId]), `${name} update payment`).toBe(0);
            expect(await n("UPDATE finance_invoices SET updated_at = now() WHERE id = $1", [b.invoiceId]), `${name} update invoice`).toBe(0);
          }
        },
        pool,
      );
    }
    // B's data was never touched
    expect((await h.owner<{ status: string }>("SELECT status FROM finance_payments WHERE id = $1", [b.paymentId]))[0]!.status).toBe("pending");
  });

  it("interleaved jobs of two schools through a worker pool of ONE connection each run under their own tenant", async () => {
    const b = await tenantBPayment();
    await h.owner("INSERT INTO jobs (tenant_id, job_type, payload, idempotency_key, run_after) VALUES ($1, 'mpesa.stk_settle', $2::jsonb, $3, now() - interval '1 second')", [h.ids.tenantB, JSON.stringify({ paymentId: b.paymentId }), "settle:" + b.paymentId]);
    const bCheckout = (await h.owner<{ checkout_request_id: string }>("SELECT checkout_request_id FROM finance_payments WHERE id = $1", [b.paymentId]))[0]!.checkout_request_id;
    const inv = await h.freshInvoice(1_000_000);
    const a = await h.startPrompt(inv, 100_000);
    await h.owner("UPDATE jobs SET run_after = now() + interval '1 day' WHERE status = 'queued' AND tenant_id = $1", [h.A()]);
    await h.makeDue(a.payment.id);
    // N-1: the lease is not evidence. A final failure needs a stored authenticated failure callback.
    await h.owner("INSERT INTO finance_mpesa_events (tenant_id, payment_id, checkout_request_id, source, result_code, outcome) VALUES ($1, $2, $3, 'callback', 1032, 'callback_received')", [h.ids.tenantB, b.paymentId, bCheckout]);
    await h.owner("INSERT INTO finance_mpesa_events (tenant_id, payment_id, checkout_request_id, source, result_code, outcome) VALUES ($1, $2, $3, 'callback', 1037, 'callback_received')", [h.A(), a.payment.id, a.checkout]);
    h.fake.queries.set(bCheckout, { done: true, resultCode: 1032 });
    h.fake.queries.set(a.checkout, { done: true, resultCode: 1037 });
    expect(await h.cycle()).toEqual(["succeeded", "succeeded"]); // both ran, one connection, two tenants
    expect((await h.owner<{ status: string }>("SELECT status FROM finance_payments WHERE id = $1", [b.paymentId]))[0]!.status).toBe("cancelled");
    expect((await h.payment(a.payment.id)).status).toBe("timeout");
    // each school's audit trail names only its own tenant; neither saw the other's rows
    const evB = await h.auditOf("job.succeeded", h.ids.tenantB);
    expect(evB.length).toBeGreaterThan(0);
    expect(evB.every((e) => e.tenant_id === h.ids.tenantB)).toBe(true);
    expect((await h.owner("SELECT 1 FROM finance_mpesa_events WHERE payment_id = $1 AND tenant_id <> $2", [b.paymentId, h.ids.tenantB]))).toHaveLength(0);
    expect((await h.owner("SELECT 1 FROM finance_mpesa_events WHERE payment_id = $1 AND tenant_id <> $2", [a.payment.id, h.A()]))).toHaveLength(0);
  });

  it("a finished (dead) job is immutable for every role", async () => {
    const inv = await h.freshInvoice(300_000);
    const { payment } = await h.startPrompt(inv, 100_000);
    const jobId = (await h.jobOf(payment.id))!.id as string;
    await h.owner("UPDATE jobs SET status = 'leased', attempts = 1, leased_by = 'w', lease_token = 'w', lease_started_at = now(), lease_expires_at = now() + interval '1 minute' WHERE id = $1", [jobId]);
    await h.owner("UPDATE jobs SET status = 'dead', finished_at = now(), lease_expires_at = NULL, leased_by = NULL, last_error_code = 'x' WHERE id = $1", [jobId]);
    expect(await h.sqlState(h.ctx.pool.query("UPDATE jobs SET status = 'queued' WHERE id = $1", [jobId]))).toBe("23514"); // owner
    expect(await h.asApp(h.A(), (c) => h.sqlState(c.query("UPDATE jobs SET status = 'queued' WHERE id = $1", [jobId])))).toBe("42501"); // app: no UPDATE at all
    expect(await h.asApp(h.A(), (c) => h.sqlState(c.query("UPDATE jobs SET status = 'queued', run_after = now() WHERE id = $1", [jobId])), h.workerPool)).toBe("42501"); // F8-A: worker has no direct UPDATE on jobs
    expect(
      await h.asApp(
        h.A(),
        async (c) => (await c.query<{ ok: boolean }>("SELECT public.jobs_retry($1, 'w', 1, 10, 'retry_err') AS ok", [jobId])).rows[0]?.ok,
        h.workerPool,
      ),
    ).toBe(false); // DEFINER also refuses to revive a finished job
    expect((await h.jobOf(payment.id))!.status).toBe("dead");
  });

  it("callbackAmountToMinor: exact string parsing, no binary floating-point money math", () => {
    expect(callbackAmountToMinor("10.5")).toBe(1050);
    expect(callbackAmountToMinor(10.5)).toBe(1050);
    expect(callbackAmountToMinor(10)).toBe(1000);
    expect(callbackAmountToMinor("10")).toBe(1000);
    expect(callbackAmountToMinor(" 7.05 ")).toBe(705);
    expect(callbackAmountToMinor(0.1 + 0.2)).toBeNull(); // 0.30000000000000004 is not a money amount
    expect(callbackAmountToMinor("10.555")).toBeNull();
    expect(callbackAmountToMinor(1e21)).toBeNull();
    expect(callbackAmountToMinor(-1)).toBeNull();
    expect(callbackAmountToMinor("-1")).toBeNull();
    expect(callbackAmountToMinor("1e3")).toBeNull();
    expect(callbackAmountToMinor(Number.NaN)).toBeNull();
    expect(callbackAmountToMinor(Number.POSITIVE_INFINITY)).toBeNull();
    expect(callbackAmountToMinor(null)).toBeNull();
    expect(callbackAmountToMinor({})).toBeNull();
    expect(callbackAmountToMinor(1_000_000_000)).toBeNull(); // beyond the accepted range
  });

  it("a Fees-area writer cannot resolve a reconciliation finding (administer is required); an administrator can", async () => {
    const inv = await h.freshInvoice(300_000);
    const { payment } = await h.startPrompt(inv, 100_000);
    await h.owner("ALTER TABLE finance_payments DISABLE TRIGGER finance_payments_guard");
    try {
      await h.owner("UPDATE finance_payments SET created_at = now() - interval '3 hours' WHERE id = $1", [payment.id]);
    } finally {
      await h.owner("ALTER TABLE finance_payments ENABLE TRIGGER finance_payments_guard");
    }
    const run = await h.post("/reconciliation-runs", { stale_after_minutes: 30 });
    const f = (run.json().findings as Json[]).find((x) => x.kind === "stale_pending_prompt" && x.subject_id === payment.id)!;
    await h.owner("INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'fees') ON CONFLICT DO NOTHING", [h.A(), h.ids.teacherA]);
    try {
      const denied = await h.post(`/reconciliation-findings/${f.id}/resolve`, { note: "A fees writer must not resolve alarms" }, h.teacher);
      expect(denied.statusCode).toBe(403);
    } finally {
      await h.owner("DELETE FROM staff_area_grants WHERE user_id = $1 AND area = 'fees'", [h.ids.teacherA]);
    }
    expect((await h.get(`/reconciliation-findings?status=open`)).json().findings.some((x: Json) => x.id === f.id)).toBe(true); // still open
    expect((await h.post(`/reconciliation-findings/${f.id}/resolve`, { note: "Parent confirmed the payment by phone", evidence: "Provider portal statement checked by finance" })).statusCode).toBe(200);
  });

  it("a file-only proof (no transaction code, no amount) binds to the payment the office records: documented behaviour, the office verifies the file", async () => {
    const inv = await h.freshInvoice(300_000);
    const proof = (await h.post("/proofs", { invoice_id: inv, file: { file_name: "slip.png", content_type: "image/png", byte_size: 4096 } })).json().proof;
    expect(proof).toMatchObject({ status: "pending", txn_code: null, txn_amount_minor: null });
    const paid = await h.post("/payments", { invoice_id: inv, amount_minor: 100_000, method: "cash", proof_id: proof.id });
    expect(paid.statusCode, paid.body).toBe(201); // nothing in a file can be bound automatically
    expect((await h.get(`/proofs/${proof.id}`)).json().proof).toMatchObject({ status: "confirmed", payment_id: paid.json().payment.id });
  });
});
