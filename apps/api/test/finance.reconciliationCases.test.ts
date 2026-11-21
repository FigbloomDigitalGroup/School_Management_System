import { randomUUID } from "node:crypto";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { financeHarness, PASSWORD } from "./support/financeHarness.js";

/**
 * Acceptance programme 6.3: a dead job is not a dead financial workflow. Reconciliation CASES are raised by the worker
 * sweep, owned, aged, escalated, re-raised on new evidence, resolved with evidence; unacknowledged prompts have an audited
 * recovery path; the platform status endpoint exposes worker and backlog health. Nothing here settles a payment by itself.
 */
describe("financial reconciliation cases, recovery and worker observability", () => {
  const h = financeHarness();
  const F = (p: string) => `/v1/tenants/${h.A()}/finance${p}`;
  const api = (method: "GET" | "POST", path: string, payload?: unknown, token = h.admin) => h.call(method, F(path), token, payload, { "x-tenant-id": h.A() });

  async function workerTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await h.workerPool.connect();
    try {
      await c.query("BEGIN");
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
  const sweep = () => workerTx((c) => c.query<{ n: number }>(`SELECT public.finance_reconciliation_sweep('rc-worker', 5) AS n`)).then((r) => r.rows[0]!.n);
  async function pending() {
    const inv = await h.freshInvoice(1_000_000);
    const p = await h.startPrompt(inv, 100_000);
    return { id: p.payment.id as string, checkout: p.checkout, inv };
  }
  const cases = (id: string, kind: string) => h.owner(`SELECT * FROM finance_reconciliation_findings WHERE subject_id = $1 AND kind = $2 ORDER BY created_at`, [id, kind]);
  const statusQueryPaid = (pid: string, checkout: string) =>
    h.owner(`INSERT INTO finance_mpesa_events (tenant_id, payment_id, checkout_request_id, source, result_code, outcome) VALUES ($1, $2, $3, 'status_query', 0, 'provider_pending')`, [h.A(), pid, checkout]);

  it("a dead settlement job raises an OPEN, aged case for the still-pending payment; the sweep is idempotent and audited", async () => {
    const p = await pending();
    await h.owner(`UPDATE jobs SET status = 'dead', finished_at = now(), lease_expires_at = NULL, leased_by = NULL, last_error_code = 'provider_pending' WHERE idempotency_key = $1`, [`settle:${p.id}`]);
    expect(await sweep()).toBeGreaterThanOrEqual(1);
    const rows = await cases(p.id, "dead_settlement_job");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "open", owner_user_id: null, reopened_count: 0, owner_queue: "finance" });
    expect(rows[0]!.last_evaluated_at).toBeTruthy();
    expect((await h.owner(`SELECT source, started_by FROM finance_reconciliation_runs WHERE id = $1`, [rows[0]!.run_id]))[0]).toMatchObject({ source: "sweep", started_by: null });
    expect((await h.auditOf("finance.reconciliation.case_raised")).filter((e) => e.detail.findingId === rows[0]!.id)).toHaveLength(1);
    await sweep();
    expect(await cases(p.id, "dead_settlement_job")).toHaveLength(1); // no duplicate
    expect((await h.payment(p.id)).status).toBe("pending"); // a dead job NEVER fails the payment
  });

  it("provider query said paid but no authenticated callback receipt is stored: a case is raised and the payment stays pending", async () => {
    const p = await pending();
    await statusQueryPaid(p.id, p.checkout);
    await sweep();
    expect(await cases(p.id, "paid_unconfirmed_no_callback")).toHaveLength(1);
    expect((await h.payment(p.id)).status).toBe("pending");
    // once an authenticated success callback exists the premise no longer holds: no NEW case is raised for another payment state
    const q = await pending();
    await statusQueryPaid(q.id, q.checkout);
    await h.owner(`INSERT INTO finance_mpesa_events (tenant_id, payment_id, checkout_request_id, source, result_code, receipt, outcome) VALUES ($1, $2, $3, 'callback', 0, 'PAIDCBRCPT01', 'callback_received')`, [h.A(), q.id, q.checkout]);
    await sweep();
    expect(await cases(q.id, "paid_unconfirmed_no_callback")).toHaveLength(0);
  });

  it("resolving needs evidence for these kinds; a resolved case is NOT re-raised without newer evidence, and IS re-raised with it", async () => {
    const p = await pending();
    await statusQueryPaid(p.id, p.checkout);
    await sweep();
    const f = (await cases(p.id, "paid_unconfirmed_no_callback"))[0]!;
    expect((await api("POST", `/reconciliation-findings/${f.id}/resolve`, { note: "checked statement" })).statusCode).toBe(400); // evidence missing
    const ok = await api("POST", `/reconciliation-findings/${f.id}/resolve`, { note: "checked statement", evidence: "M-Pesa statement line 14, receipt QWE123, customer called" });
    expect(ok.statusCode, JSON.stringify(ok.json())).toBe(200);
    expect(ok.json().finding).toMatchObject({ status: "resolved", resolution_evidence: expect.stringContaining("statement") });
    await sweep();
    expect(await cases(p.id, "paid_unconfirmed_no_callback")).toHaveLength(1); // same evidence: stays resolved
    await new Promise((r) => setTimeout(r, 30));
    await statusQueryPaid(p.id, p.checkout); // NEW contradictory evidence after the resolution
    await sweep();
    const all = await cases(p.id, "paid_unconfirmed_no_callback");
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ status: "open", reopened_count: 1 });
  });

  it("an open case older than 24 h is escalated exactly once and audited", async () => {
    const p = await pending();
    await h.owner(`UPDATE jobs SET status = 'dead', finished_at = now(), lease_expires_at = NULL, leased_by = NULL, last_error_code = 'x' WHERE idempotency_key = $1`, [`settle:${p.id}`]);
    await sweep();
    const f = (await cases(p.id, "dead_settlement_job"))[0]!;
    // test-only aging: the identity guard makes created_at immutable, so suspend it for this one fixture update
    await h.owner(`ALTER TABLE finance_reconciliation_findings DISABLE TRIGGER finance_reconciliation_findings_guard`);
    await h.owner(`UPDATE finance_reconciliation_findings SET created_at = now() - interval '25 hours' WHERE id = $1`, [f.id]);
    await h.owner(`ALTER TABLE finance_reconciliation_findings ENABLE TRIGGER finance_reconciliation_findings_guard`);
    await sweep();
    const esc = (await h.owner(`SELECT escalated_at FROM finance_reconciliation_findings WHERE id = $1`, [f.id]))[0]!;
    expect(esc.escalated_at).toBeTruthy();
    await sweep();
    expect((await h.auditOf("finance.reconciliation.case_escalated")).filter((e) => e.detail.findingId === f.id)).toHaveLength(1);
    const list = await api("GET", `/reconciliation-findings?status=open`);
    const mine = list.json().findings.find((x: { id: string }) => x.id === f.id);
    expect(mine).toMatchObject({ escalated_at: expect.any(String), owner_user_id: null });
    expect(mine.age_minutes).toBeGreaterThanOrEqual(24 * 60);
  });

  it("case ownership: assign to an active staff member, refuse non-staff and resolved cases, finance administrators only", async () => {
    const p = await pending();
    await statusQueryPaid(p.id, p.checkout);
    await sweep();
    const f = (await cases(p.id, "paid_unconfirmed_no_callback"))[0]!;
    const teacher = await h.login({ tenantId: h.A(), loginId: "TC-0001", password: PASSWORD });
    expect((await api("POST", `/reconciliation-findings/${f.id}/assign`, { owner_user_id: h.ids.adminA }, teacher)).statusCode).toBe(403);
    expect((await api("POST", `/reconciliation-findings/${f.id}/assign`, { owner_user_id: h.ids.parentA })).statusCode).toBe(400);
    expect((await api("POST", `/reconciliation-findings/${f.id}/assign`, { owner_user_id: randomUUID() })).statusCode).toBe(400);
    const ok = await api("POST", `/reconciliation-findings/${f.id}/assign`, { owner_user_id: h.ids.adminA });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().finding).toMatchObject({ id: f.id, owner_user_id: h.ids.adminA });
    expect((await api("POST", `/reconciliation-findings/${f.id}/assign`, { owner_user_id: null })).json().finding.owner_user_id).toBeNull();
    await api("POST", `/reconciliation-findings/${f.id}/resolve`, { note: "done here", evidence: "evidence reference 1" });
    expect((await api("POST", `/reconciliation-findings/${f.id}/assign`, { owner_user_id: h.ids.adminA })).statusCode).toBe(409);
    expect((await h.auditOf("finance.reconciliation.assigned")).length).toBeGreaterThanOrEqual(2);
  });

  it("an unacknowledged prompt (no checkout id) is recoverable: attested, evidenced, audited; refused when the provider knows it", async () => {
    const inv = await h.freshInvoice(1_000_000);
    const mk = async (checkout: string | null) =>
      (await h.owner<{ id: string }>(`INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status, msisdn, checkout_request_id) VALUES ($1, $2, 100000, 'mpesa', 'pending', '254712345678', $3) RETURNING id`, [h.A(), inv, checkout]))[0]!.id;
    const id = await mk(null);
    const teacher = await h.login({ tenantId: h.A(), loginId: "TC-0001", password: PASSWORD });
    const w = (payment: string, body: unknown, token = h.admin) => api("POST", `/payments/${payment}/withdraw-unacknowledged-prompt`, body, token);
    expect((await w(id, { reason: "never sent", evidence: "x" })).statusCode).toBe(400); // evidence too short
    expect((await w(id, { reason: "never sent", evidence: "M-Pesa portal shows no STK request for this account" }, teacher)).statusCode).toBe(403);
    expect((await w(randomUUID(), { reason: "never sent", evidence: "portal check 2026" })).statusCode).toBe(404);
    // a settled/other state is refused
    const ack = await mk("ws_CO_ACKED_" + randomUUID().slice(0, 6)).catch(() => null);
    if (ack) expect((await w(ack, { reason: "never sent", evidence: "portal check 2026" })).statusCode).toBe(409); // provider acknowledged it
    const ok = await w(id, { reason: "STK never sent", evidence: "M-Pesa portal shows no STK request for this account on that day" });
    expect(ok.statusCode, JSON.stringify(ok.json())).toBe(200);
    expect(ok.json().result).toMatchObject({ payment_id: id, status: "cancelled", failure_reason: "operator_withdrawn" });
    expect((await h.payment(id)).status).toBe("cancelled");
    const ev = (await h.auditOf("finance.mpesa.prompt_withdrawn")).filter((e) => e.detail.paymentId === id);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.actor_user_id).toBe(h.ids.adminA);
    expect(ev[0]!.detail).toMatchObject({ reason: "STK never sent", actingVia: "operator" });
    expect((await w(id, { reason: "again", evidence: "portal check again" })).statusCode).toBe(409); // already final: no double action
    expect((await h.invoice(inv)).paid_minor).toBe(0); // no money moved
  });

  it("withdrawal is refused when ANY provider evidence exists for the payment (an operator cannot override provider evidence)", async () => {
    const p = await pending(); // has a checkout id, so first path (409); plant checkout-less + event case via owner
    const inv = await h.freshInvoice(1_000_000);
    const id = (await h.owner<{ id: string }>(`INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status, msisdn) VALUES ($1, $2, 100000, 'mpesa', 'pending', '254712345678') RETURNING id`, [h.A(), inv]))[0]!.id;
    expect((await api("POST", `/payments/${p.id}/withdraw-unacknowledged-prompt`, { reason: "nope", evidence: "portal says so" })).statusCode).toBe(409);
    await h.owner(`INSERT INTO finance_mpesa_events (tenant_id, payment_id, checkout_request_id, source, result_code, receipt, outcome) VALUES ($1, $2, 'ws_CO_PLANT', 'callback', 0, 'WDRAWBLOCK01', 'callback_received')`, [h.A(), id]);
    expect((await api("POST", `/payments/${id}/withdraw-unacknowledged-prompt`, { reason: "nope", evidence: "portal says so" })).statusCode).toBe(409);
    expect((await h.payment(id)).status).toBe("pending");
  });

  it("platform status: super administrators only; shows worker liveness, queue and backlog as counts/ages; nothing sensitive", async () => {
    await workerTx((c) => c.query(`SELECT public.worker_heartbeat('rc-worker', 'alive')`));
    await sweep();
    const su = await h.login({ email: "super@example.com", password: PASSWORD });
    const r = await h.call("GET", "/v1/platform/ops/status", su, undefined, {});
    expect(r.statusCode).toBe(200);
    const s = r.json().status;
    expect(s.workers.find((x: { worker: string }) => x.worker === "rc-worker")).toMatchObject({ last_seen_age_seconds: expect.any(Number), last_cycle_outcome: expect.anything() });
    expect(s.queue).toEqual(expect.objectContaining({ queued_due: expect.anything(), dead: expect.anything(), leased: expect.anything() }));
    expect(s.reconciliation.open_cases).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(s)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|254\d{9}|payload/);
    expect((await h.call("GET", "/v1/platform/ops/status", h.admin, undefined, {})).statusCode).toBe(403);
    expect((await h.ctx.app.inject({ method: "GET", url: "/v1/platform/ops/status" })).statusCode).toBe(401);
  });

  it("the sweep and heartbeat are executable only by the worker role; the worker cannot write cases or heartbeats directly", async () => {
    const code = (p: Promise<unknown>) => h.sqlState(p);
    expect(await h.asApp(h.A(), (c) => code(c.query(`SELECT public.finance_reconciliation_sweep('x', 5)`)))).toBe("42501");
    expect(await h.asApp(h.A(), (c) => code(c.query(`SELECT public.worker_heartbeat('x', 'y')`)))).toBe("42501");
    expect(await h.asApp(h.A(), (c) => code(c.query(`SELECT * FROM worker_heartbeats`)))).toBe("42501");
    expect(await workerTx((c) => code(c.query(`INSERT INTO worker_heartbeats (worker_name) VALUES ('forged')`)))).toBe("42501");
    expect(await workerTx((c) => code(c.query(`INSERT INTO finance_reconciliation_findings (tenant_id, run_id, kind, subject_type, subject_id, detail) VALUES ($1, gen_random_uuid(), 'dead_settlement_job', 'payment', gen_random_uuid(), '{}')`, [h.A()])))).toBe("42501");
    expect(await workerTx((c) => code(c.query(`SELECT public.finance_reconciliation_sweep('x', 1)`)))).toBe("22023"); // stale minutes bounded
  });
});
