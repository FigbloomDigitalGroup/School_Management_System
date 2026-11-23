import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withSystemTenantTransaction } from "../src/db/systemTenantTransaction.js";
import { createPrompt, recordPushOutcome } from "../src/modules/finance/mpesa.js";
import { financeHarness, type Json } from "./support/financeHarness.js";

/**
 * Remediation batch 3: the overpayment policy.
 *   An invoice is never credited beyond its outstanding balance, and a provider-confirmed payment is never
 *   silently discarded: payment.amount_minor (immutable) = applied_minor (reached the invoice) + unapplied_minor
 *   (held on the payment, raised by reconciliation, pending an approved allocation/refund workflow).
 */
describe("Stage 11 remediation batch 3: overpayment policy", () => {
  const h = financeHarness();
  const receipt = () => "R" + randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase();

  /** Settle a pending prompt through the callback (the only path that carries a receipt). */
  async function settle(checkout: string, rcpt = receipt(), amountKes?: number) {
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    const res = await h.sendCallback(h.callbackBody(checkout, 0, { receipt: rcpt, ...(amountKes === undefined ? {} : { amount: amountKes }) }));
    expect(res.statusCode, res.body).toBe(200);
    return rcpt;
  }
  const rowOf = async (paymentId: string) => (await h.owner("SELECT amount_minor, applied_minor, unapplied_minor, status FROM finance_payments WHERE id = $1", [paymentId]))[0]!;

  it("an exact payment applies everything and leaves nothing unapplied", async () => {
    const inv = await h.freshInvoice(1_000_000);
    const { payment, checkout } = await h.startPrompt(inv, 1_000_000);
    await settle(checkout);
    expect(await h.payment(payment.id)).toMatchObject({ status: "success", amount_minor: 1_000_000, applied_minor: 1_000_000, unapplied_minor: 0 });
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 1_000_000, balance_minor: 0, overpaid_minor: 0, status: "paid" });
    expect((await h.auditOf("finance.payment.unapplied")).filter((e) => e.detail.paymentId === payment.id)).toHaveLength(0);
  });

  it("a partial payment applies what it paid", async () => {
    const inv = await h.freshInvoice(1_000_000);
    const { payment, checkout } = await h.startPrompt(inv, 250_000);
    await settle(checkout);
    expect(await h.payment(payment.id)).toMatchObject({ applied_minor: 250_000, unapplied_minor: 0 });
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 250_000, balance_minor: 750_000, status: "part_paid" });
  });

  it("an overpayment applies only the outstanding balance and keeps the excess as an unapplied amount (KES 5,000 owed, 6,000 confirmed)", async () => {
    const inv = await h.freshInvoice(600_000); // KES 6,000 owed
    const { payment, checkout } = await h.startPrompt(inv, 600_000); // a 6,000 prompt is pending
    expect((await h.post("/payments", { invoice_id: inv, amount_minor: 100_000, method: "cash" })).statusCode).toBe(201); // 1,000 paid meanwhile: 5,000 owed
    await settle(checkout, receipt(), 6000);
    // the provider-confirmed KES 6,000 is untouched; KES 5,000 reached the invoice; KES 1,000 is held unapplied
    expect(await h.payment(payment.id)).toMatchObject({ status: "success", amount_minor: 600_000, applied_minor: 500_000, unapplied_minor: 100_000 });
    expect(await h.invoice(inv)).toMatchObject({ total_minor: 600_000, paid_minor: 600_000, balance_minor: 0, overpaid_minor: 0, status: "paid" });
    const ev = (await h.auditOf("finance.payment.unapplied")).find((e) => e.detail.paymentId === payment.id)!;
    expect(ev.actor_user_id).toBeNull();
    expect(ev.detail).toMatchObject({ amountMinor: 600_000, appliedMinor: 500_000, unappliedMinor: 100_000, actingVia: "callback" });
    // reconciliation identifies the unapplied amount, and the tamper alarms stay quiet
    const run = await h.post("/reconciliation-runs", { stale_after_minutes: 30 });
    const mine = (run.json().findings as Json[]).filter((f) => f.subject_id === payment.id || f.detail.invoice_id === inv);
    expect(mine.map((f) => f.kind).sort()).toEqual(["unapplied_payment"]);
    expect(mine[0]!.detail).toMatchObject({ amount_minor: 600_000, applied_minor: 500_000, unapplied_minor: 100_000 });
  });

  it("a total lowered while a prompt is pending: the prompt applies only what is now owed (adjustment while pending)", async () => {
    const inv = await h.freshInvoice(1_000_000);
    const { payment, checkout } = await h.startPrompt(inv, 1_000_000);
    const adjust = await h.post(`/invoices/${inv}/adjustments`, { expected_total_minor: 1_000_000, new_total_minor: 400_000, reason: "Bursary awarded" });
    expect(adjust.statusCode, adjust.body).toBe(200);
    await settle(checkout, receipt(), 10_000);
    expect(await h.payment(payment.id)).toMatchObject({ amount_minor: 1_000_000, applied_minor: 400_000, unapplied_minor: 600_000 });
    expect(await h.invoice(inv)).toMatchObject({ total_minor: 400_000, paid_minor: 400_000, balance_minor: 0, overpaid_minor: 0 });
  });

  it("an invoice fully paid by the office before the prompt settles applies nothing and keeps the whole payment unapplied", async () => {
    const inv = await h.freshInvoice(300_000);
    const { payment, checkout } = await h.startPrompt(inv, 300_000);
    expect((await h.post("/payments", { invoice_id: inv, amount_minor: 300_000, method: "cash" })).statusCode).toBe(201);
    await settle(checkout);
    expect(await h.payment(payment.id)).toMatchObject({ status: "success", applied_minor: 0, unapplied_minor: 300_000 });
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 300_000, balance_minor: 0, overpaid_minor: 0 });
  });

  it("concurrent settlement and office payment never over-credit the invoice, whichever wins", async () => {
    for (let i = 0; i < 6; i++) {
      const inv = await h.freshInvoice(300_000);
      const { payment, checkout } = await h.startPrompt(inv, 300_000);
      h.fake.queries.set(checkout, { done: true, resultCode: 0 });
      const [cb, office] = await Promise.all([
        h.sendCallback(h.callbackBody(checkout, 0, { receipt: receipt() })),
        h.post("/payments", { invoice_id: inv, amount_minor: 300_000, method: "cash" }),
      ]);
      expect(cb.statusCode, cb.body).toBe(200);
      expect([201, 400]).toContain(office.statusCode); // the office payment either lands first or is refused as over the balance
      const inv2 = await h.invoice(inv);
      expect(inv2).toMatchObject({ total_minor: 300_000, paid_minor: 300_000, balance_minor: 0, overpaid_minor: 0 });
      const rows = await h.owner<{ amount_minor: string; applied_minor: string; unapplied_minor: string }>(
        "SELECT amount_minor, applied_minor, unapplied_minor FROM finance_payments WHERE invoice_id = $1 AND status = 'success'",
        [inv],
      );
      expect(rows.reduce((n, r) => n + Number(r.applied_minor), 0)).toBe(300_000); // applied sums to the total exactly
      for (const r of rows) expect(Number(r.applied_minor) + Number(r.unapplied_minor)).toBe(Number(r.amount_minor));
      expect((await rowOf(payment.id)).status).toBe("success"); // the confirmed payment is never dropped
    }
  });

  it("a replayed callback or repeated settlement does not allocate twice", async () => {
    const inv = await h.freshInvoice(1_000_000);
    const { payment, checkout } = await h.startPrompt(inv, 400_000);
    const rcpt = await settle(checkout);
    const first = await rowOf(payment.id);
    for (let i = 0; i < 3; i++) await settle(checkout, rcpt); // the provider redelivers
    expect(await rowOf(payment.id)).toEqual(first);
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 400_000 });
    // the worker's late settle job is also a no-op
    await h.owner("UPDATE jobs SET run_after = now() + interval '1 day' WHERE status = 'queued'");
    await h.makeDue(payment.id);
    expect(await h.cycle()).toEqual(["succeeded"]);
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 400_000 });
  });

  it("a duplicate receipt is never allocated: the second prompt stays pending, the invoice is untouched", async () => {
    const a = await h.freshInvoice(1_000_000);
    const first = await h.startPrompt(a, 200_000);
    const rcpt = await settle(first.checkout);
    const b = await h.freshInvoice(1_000_000);
    const second = await h.startPrompt(b, 200_000);
    h.fake.queries.set(second.checkout, { done: true, resultCode: 0 });
    expect((await h.sendCallback(h.callbackBody(second.checkout, 0, { receipt: rcpt }))).statusCode).toBe(503);
    expect(await h.payment(second.payment.id)).toMatchObject({ status: "pending", applied_minor: null, unapplied_minor: null });
    expect(await h.invoice(b)).toMatchObject({ paid_minor: 0 });
    expect(await h.invoice(a)).toMatchObject({ paid_minor: 200_000 });
  });

  it("only a success has applied/unapplied amounts; failed and pending payments have none", async () => {
    const inv = await h.freshInvoice(500_000);
    const pending = await h.startPrompt(inv, 100_000);
    expect(await h.payment(pending.payment.id)).toMatchObject({ status: "pending", applied_minor: null, unapplied_minor: null });
    h.fake.queries.set(pending.checkout, { done: true, resultCode: 1032 });
    expect((await h.sendCallback(h.callbackBody(pending.checkout, 1032))).statusCode).toBe(200);
    expect(await h.payment(pending.payment.id)).toMatchObject({ status: "cancelled", applied_minor: null, unapplied_minor: null });
  });

  it("the database refuses to forge an allocation: no role may write applied/unapplied, and history is immutable", async () => {
    const inv = await h.freshInvoice(600_000);
    const { payment, checkout } = await h.startPrompt(inv, 600_000);
    expect(await h.asApp(h.A(), (c) => h.sqlState(c.query("UPDATE finance_payments SET applied_minor = 600000 WHERE id = $1", [payment.id])))).toBe("42501");
    expect(await h.asApp(h.A(), (c) => h.sqlState(c.query("UPDATE finance_payments SET applied_minor = 600000 WHERE id = $1", [payment.id])), h.workerPool)).toBe("42501");
    await settle(checkout);
    // final: even the owner cannot rewrite the allocation or the confirmed amount afterwards
    expect(await h.sqlState(h.ctx.pool.query("UPDATE finance_payments SET applied_minor = 0 WHERE id = $1", [payment.id]))).toBe("23514");
    expect(await h.sqlState(h.ctx.pool.query("UPDATE finance_payments SET amount_minor = 1 WHERE id = $1", [payment.id]))).toBe("23514");
    // a crafted INSERT cannot choose its allocation either: the trigger decides it from the invoice balance
    const inv2 = await h.freshInvoice(100_000);
    const ins = await h.asApp(h.A(), async (c) => {
      const r = await c.query(
        "INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status, applied_minor) VALUES ($1, $2, 100000, 'cash', 'success', 1) RETURNING applied_minor, unapplied_minor",
        [h.A(), inv2],
      );
      return r.rows[0];
    });
    expect(ins).toEqual({ applied_minor: "100000", unapplied_minor: "0" });
    // the CHECK ties applied to the success state and to the amount (the guard is disabled only to reach the CHECK)
    await h.ctx.pool.query("ALTER TABLE finance_payments DISABLE TRIGGER finance_payments_guard");
    try {
      expect(await h.sqlState(h.ctx.pool.query("UPDATE finance_payments SET applied_minor = amount_minor + 1 WHERE id = $1", [payment.id]))).toBe("23514");
    } finally {
      await h.ctx.pool.query("ALTER TABLE finance_payments ENABLE TRIGGER finance_payments_guard");
    }
  });

  it("an office payment above the balance is still refused; no invoice can be credited beyond its total", async () => {
    const inv = await h.freshInvoice(300_000);
    expect((await h.post("/payments", { invoice_id: inv, amount_minor: 400_000, method: "cash" })).statusCode).toBe(400);
    expect((await h.post("/payments", { invoice_id: inv, amount_minor: 300_000, method: "cash" })).statusCode).toBe(201);
    expect((await h.post("/payments", { invoice_id: inv, amount_minor: 100, method: "cash" })).statusCode).toBe(400);
    const any = await h.owner("SELECT 1 FROM finance_invoices WHERE paid_minor > total_minor");
    expect(any).toHaveLength(0);
  });

  it("every successful payment in the database satisfies amount = applied + unapplied, and no invoice is over-credited or negative", async () => {
    expect(await h.owner("SELECT 1 FROM finance_payments WHERE status = 'success' AND amount_minor <> applied_minor + unapplied_minor")).toHaveLength(0);
    expect(await h.owner("SELECT 1 FROM finance_payments WHERE status <> 'success' AND (applied_minor IS NOT NULL OR unapplied_minor IS NOT NULL)")).toHaveLength(0);
    expect(await h.owner("SELECT 1 FROM finance_invoices WHERE paid_minor > total_minor OR paid_minor < 0")).toHaveLength(0);
    expect(await h.owner(`SELECT i.id FROM finance_invoices i WHERE i.paid_minor <> COALESCE((SELECT sum(applied_minor) FROM finance_payments p WHERE p.invoice_id = i.id AND p.status = 'success'), 0)`)).toHaveLength(0);
  });

  it("reconciliation computes an invoice's paid total from applied amounts (no false total mismatch after an unapplied settlement)", async () => {
    const inv = await h.freshInvoice(200_000);
    const { checkout } = await h.startPrompt(inv, 200_000);
    expect((await h.post("/payments", { invoice_id: inv, amount_minor: 100_000, method: "cash" })).statusCode).toBe(201);
    await settle(checkout);
    const run = await h.post("/reconciliation-runs", { stale_after_minutes: 30 });
    const kinds = (run.json().findings as Json[]).filter((f) => f.subject_id === inv).map((f) => f.kind);
    expect(kinds).not.toContain("invoice_total_mismatch");
    expect(kinds).not.toContain("overpaid_invoice");
  });

  // ---- review follow-up: forced interleavings, lock order, visibility ----

  /** An open runtime-role transaction with the school's context, for forcing an interleaving. */
  async function openTx() {
    const c = await h.ctx.runtimePool.connect();
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [h.A(), h.ids.adminA]);
    return c;
  }
  /** Wait until some other backend is blocked on a lock (so the interleaving is real, not timing-dependent). */
  async function waitForLockWait(): Promise<void> {
    for (let i = 0; i < 60; i++) {
      const r = await h.owner<{ n: string }>(
        "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()",
      );
      if (Number(r[0]!.n) > 0) return;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error("no backend ever waited on a lock: the interleaving was not forced");
  }

  it("forced interleaving: an office payment that commits while the settlement waits on the invoice lock wins; the prompt applies nothing", async () => {
    const inv = await h.freshInvoice(300_000);
    const { payment, checkout } = await h.startPrompt(inv, 300_000);
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    const a = await openTx();
    try {
      await a.query("SELECT 1 FROM finance_invoices WHERE id = $1 FOR UPDATE", [inv]);
      await a.query("INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status) VALUES ($1, $2, 300000, 'cash', 'success')", [h.A(), inv]);
      const settling = h.sendCallback(h.callbackBody(checkout, 0, { receipt: receipt(), amount: 3000 })); // blocks on the invoice lock
      await waitForLockWait();
      await a.query("COMMIT");
      expect((await settling).statusCode).toBe(200);
    } finally {
      await a.query("ROLLBACK").catch(() => undefined);
      a.release();
    }
    expect(await rowOf(payment.id)).toMatchObject({ status: "success", applied_minor: "0", unapplied_minor: "300000" });
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 300_000, balance_minor: 0, overpaid_minor: 0, unapplied_minor: 300_000 });
  });

  it("lock order is invoice first: creating a prompt's locks while a settlement is queued behind the invoice cannot deadlock (review F1)", async () => {
    const inv = await h.freshInvoice(300_000);
    const { payment, checkout } = await h.startPrompt(inv, 300_000);
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    const a = await openTx(); // plays createPrompt: invoice lock first, then the invoice's pending payments
    let settling: ReturnType<typeof h.sendCallback> | undefined;
    try {
      await a.query("SELECT 1 FROM finance_invoices WHERE id = $1 FOR UPDATE", [inv]);
      settling = h.sendCallback(h.callbackBody(checkout, 0, { receipt: receipt(), amount: 3000 }));
      await waitForLockWait(); // the settlement is now waiting; with the old order it would already hold the payment row
      const pending = await a.query("SELECT id FROM finance_payments WHERE invoice_id = $1 AND status = 'pending' FOR UPDATE", [inv]);
      expect(pending.rows.map((r) => r.id)).toEqual([payment.id]); // no deadlock: this lock is granted at once
      await a.query("COMMIT");
    } finally {
      await a.query("ROLLBACK").catch(() => undefined);
      a.release();
    }
    expect((await settling!).statusCode).toBe(200);
    expect(await h.payment(payment.id)).toMatchObject({ status: "success", applied_minor: 300_000, unapplied_minor: 0 });
  });

  it("lock order is invoice first for the push-outcome write too (recordPushOutcome), not only for settlement", async () => {
    const inv = await h.freshInvoice(300_000);
    const prompt = await withSystemTenantTransaction(h.ctx.runtimePool, { tenantId: h.A(), userId: h.ids.adminA }, async (tx) =>
      (await createPrompt(tx, { tenantId: h.A(), actorUserId: h.ids.adminA, invoice_id: inv, amount_minor: 300_000, msisdn: "254733333333", settleDelaySeconds: 120 })).payment,
    );
    const a = await openTx();
    let recording: Promise<unknown> | undefined;
    try {
      await a.query("SELECT 1 FROM finance_invoices WHERE id = $1 FOR UPDATE", [inv]);
      recording = withSystemTenantTransaction(h.ctx.runtimePool, { tenantId: h.A(), userId: h.ids.adminA }, (tx) =>
        recordPushOutcome(tx, { tenantId: h.A(), paymentId: prompt.id, result: { accepted: true, checkoutRequestId: "ws_CO_PUSHORDER", merchantRequestId: "MR_PO" }, actorUserId: h.ids.adminA }),
      );
      await waitForLockWait();
      const locked = await a.query("SELECT id FROM finance_payments WHERE invoice_id = $1 AND status = 'pending' FOR UPDATE", [inv]);
      expect(locked.rows.map((r) => r.id)).toEqual([prompt.id]); // granted at once: recordPushOutcome holds no payment lock yet
      await a.query("COMMIT");
    } finally {
      await a.query("ROLLBACK").catch(() => undefined);
      a.release();
    }
    await recording;
    expect((await h.owner<{ checkout_request_id: string }>("SELECT checkout_request_id FROM finance_payments WHERE id = $1", [prompt.id]))[0]!.checkout_request_id).toBe("ws_CO_PUSHORDER");
  });

  it("a balance with cents cleared by the rounded-up prompt applies the cents and holds the rounding as an unapplied amount", async () => {
    const inv = await h.freshInvoice(150_050); // KES 1,500.50 owed
    const { payment, checkout } = await h.startPrompt(inv, 150_100); // the prompt rounds UP to a whole shilling
    await settle(checkout, receipt(), 1501);
    expect(await h.payment(payment.id)).toMatchObject({ amount_minor: 150_100, applied_minor: 150_050, unapplied_minor: 50 });
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 150_050, balance_minor: 0, overpaid_minor: 0, unapplied_minor: 50 });
  });

  it("after an unapplied settlement the total cannot be adjusted below what was applied", async () => {
    const inv = await h.freshInvoice(600_000);
    const { checkout } = await h.startPrompt(inv, 600_000);
    expect((await h.post("/payments", { invoice_id: inv, amount_minor: 100_000, method: "cash" })).statusCode).toBe(201);
    await settle(checkout, receipt(), 6000);
    const adjust = await h.post(`/invoices/${inv}/adjustments`, { expected_total_minor: 600_000, new_total_minor: 500_000, reason: "Trying to cut below what was paid" });
    expect(adjust.statusCode).toBe(400);
    expect(await h.invoice(inv)).toMatchObject({ total_minor: 600_000, paid_minor: 600_000 });
  });

  it("unapplied money stays visible after its finding is resolved: invoice sum and the payments filter", async () => {
    const inv = await h.freshInvoice(600_000);
    const { payment, checkout } = await h.startPrompt(inv, 600_000);
    expect((await h.post("/payments", { invoice_id: inv, amount_minor: 100_000, method: "cash" })).statusCode).toBe(201);
    await settle(checkout, receipt(), 6000);
    const run = await h.post("/reconciliation-runs", { stale_after_minutes: 30 });
    const finding = (run.json().findings as Json[]).find((f) => f.kind === "unapplied_payment" && f.subject_id === payment.id)!;
    expect(finding).toBeDefined();
    expect((await h.post(`/reconciliation-findings/${finding.id}/resolve`, { note: "Parent will be refunded by the bursar" })).statusCode).toBe(200);
    const again = await h.post("/reconciliation-runs", { stale_after_minutes: 30 });
    expect((again.json().findings as Json[]).some((f) => f.kind === "unapplied_payment" && f.subject_id === payment.id)).toBe(false); // resolved: not raised again
    // ...but the money is still visible to the office, with no finding needed
    expect((await h.invoice(inv)).unapplied_minor).toBe(100_000);
    const listed = (await h.get(`/payments?unapplied=true&invoiceId=${inv}`)).json().payments as Json[];
    expect(listed.map((p) => p.id)).toEqual([payment.id]);
    expect(listed[0]).toMatchObject({ unapplied_minor: 100_000, applied_minor: 500_000, amount_minor: 600_000 });
    const none = (await h.get(`/payments?unapplied=true&invoiceId=${await h.freshInvoice(100_000)}`)).json().payments as Json[];
    expect(none).toEqual([]);
  });

  it("the worker role cannot directly forge unapplied-amount or overpaid audit events (F8-B: emitted inside finance_worker_settle_payment only)", async () => {
    const insert = (type: string) =>
      h.asApp(
        h.A(),
        (c) => h.sqlState(c.query("INSERT INTO security_audit_events (event_type, tenant_id, detail) VALUES ($1, $2, '{\"actingVia\":\"worker\"}'::jsonb)", [type, h.A()])),
        h.workerPool,
      );
    expect(await insert("finance.payment.unapplied")).toBe("42501");
    expect(await insert("finance.payment.overpaid")).toBe("42501");
  });
});
