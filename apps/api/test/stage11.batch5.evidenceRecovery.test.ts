import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { financeHarness, type Json } from "./support/financeHarness.js";

/**
 * Remediation batch 5: a provider-confirmed STK payment is never stranded for want of a receipt that the system
 * already holds, and a receipt is NEVER fabricated. Evidence (an authenticated callback) is persisted before the
 * provider is queried, so a failed query / 503 / late settle job can still complete the payment from what arrived.
 */
describe("Stage 11 remediation batch 5: settlement evidence recovery", () => {
  const h = financeHarness();
  const receipt = () => "R" + randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase();

  async function pendingWithJob(amount = 100_000, lineMinor = 1_000_000) {
    const inv = await h.freshInvoice(lineMinor);
    const p = await h.startPrompt(inv, amount);
    await h.owner("UPDATE jobs SET run_after = now() + interval '1 day' WHERE status = 'queued'");
    await h.makeDue(p.payment.id);
    return { inv, ...p };
  }
  /** An authenticated callback whose provider query fails: 503, evidence stored, prompt untouched. */
  async function callbackStoredOnly(checkout: string, rcpt: string) {
    h.fake.queries.set(checkout, "throw");
    expect((await h.sendCallback(h.callbackBody(checkout, 0, { receipt: rcpt, amount: 1000 }))).statusCode).toBe(503);
  }
  const outcomes = async (paymentId: string) => (await h.owner<{ outcome: string }>("SELECT outcome FROM finance_mpesa_events WHERE payment_id = $1 ORDER BY received_at, id", [paymentId])).map((e) => e.outcome);

  it("a receipt delivered in a callback whose provider query failed is recovered by the settle job once the provider confirms success", async () => {
    const { inv, payment, checkout } = await pendingWithJob(250_000);
    const rcpt = receipt();
    await callbackStoredOnly(checkout, rcpt);
    expect((await h.payment(payment.id)).status).toBe("pending");
    h.fake.queries.set(checkout, { done: true, resultCode: 0 }); // the provider is back
    expect(await h.cycle()).toEqual(["succeeded"]);
    expect(await h.payment(payment.id)).toMatchObject({ status: "success", mpesa_receipt: rcpt, applied_minor: 250_000, unapplied_minor: 0 });
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 250_000 });
    expect(await outcomes(payment.id)).toEqual(["callback_received", "evidence_recovered", "settled_success"]);
    const settled = (await h.auditOf("finance.mpesa.settled")).find((e) => e.detail.paymentId === payment.id)!;
    expect(settled.actor_user_id).toBeNull();
    expect(settled.detail).toMatchObject({ actingVia: "worker", source: "status_query", receiptBasis: "stored_callback", jobType: "mpesa.stk_settle", attempt: 1 });
  });

  it("the job path also records an unapplied amount (the worker may emit it) when the balance was cleared meanwhile", async () => {
    const { inv, payment, checkout } = await pendingWithJob(300_000, 300_000);
    const rcpt = receipt();
    await callbackStoredOnly(checkout, rcpt);
    expect((await h.post("/payments", { invoice_id: inv, amount_minor: 300_000, method: "cash" })).statusCode).toBe(201);
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    expect(await h.cycle()).toEqual(["succeeded"]);
    expect(await h.payment(payment.id)).toMatchObject({ status: "success", applied_minor: 0, unapplied_minor: 300_000 });
    const ev = (await h.auditOf("finance.payment.unapplied")).find((e) => e.detail.paymentId === payment.id)!;
    expect(ev.detail).toMatchObject({ actingVia: "worker", unappliedMinor: 300_000, jobType: "mpesa.stk_settle" });
    expect(ev.actor_user_id).toBeNull();
  });

  it("callback BEFORE the settle job: the callback credits, the late job is a no-op", async () => {
    const { inv, payment, checkout } = await pendingWithJob();
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    expect((await h.sendCallback(h.callbackBody(checkout, 0, { receipt: receipt(), amount: 1000 }))).statusCode).toBe(200);
    expect(await h.cycle()).toEqual(["succeeded"]);
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 100_000 });
    expect((await h.owner("SELECT 1 FROM finance_payments WHERE invoice_id = $1 AND status = 'success'", [inv]))).toHaveLength(1);
    void payment;
  });

  it("callback AFTER the settle job: the job waits (no receipt exists), then the callback completes the payment", async () => {
    const { inv, payment, checkout } = await pendingWithJob();
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    expect(await h.cycle()).toEqual(["retry"]);
    expect((await h.payment(payment.id)).mpesa_receipt).toBeNull(); // a receipt is never made up
    expect((await h.jobOf(payment.id))!.last_error_code).toBe("provider_pending");
    const rcpt = receipt();
    expect((await h.sendCallback(h.callbackBody(checkout, 0, { receipt: rcpt, amount: 1000 }))).statusCode).toBe(200);
    expect(await h.payment(payment.id)).toMatchObject({ status: "success", mpesa_receipt: rcpt });
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 100_000 });
  });

  it("provider success WITHOUT any receipt evidence never credits and never invents a receipt (and the database would refuse it)", async () => {
    const { inv, payment, checkout } = await pendingWithJob();
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    expect(await h.cycle()).toEqual(["retry"]);
    expect(await h.payment(payment.id)).toMatchObject({ status: "pending", mpesa_receipt: null, applied_minor: null });
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 0 });
    expect(await outcomes(payment.id)).toEqual(["provider_pending"]);
    // even a direct attempt cannot credit a prompt without a receipt
    expect(await h.asApp(h.A(), (c) => h.sqlState(c.query("UPDATE finance_payments SET status = 'success' WHERE id = $1", [payment.id])))).toBe("23514");
  });

  it("provider still pending or failed: the job waits or settles the failure; evidence is not misused", async () => {
    const a = await pendingWithJob();
    await callbackStoredOnly(a.checkout, receipt());
    h.fake.queries.set(a.checkout, { done: false });
    expect(await h.cycle()).toEqual(["retry"]);
    expect((await h.payment(a.payment.id)).status).toBe("pending");
    const b = await pendingWithJob();
    await callbackStoredOnly(b.checkout, receipt()); // the callback CLAIMED success...
    h.fake.queries.set(b.checkout, { done: true, resultCode: 1032 }); // ...but the provider says the customer cancelled
    // N-1: a callback that CLAIMED success plus a worker-observed provider failure is contradictory and has no stored
    // failure evidence: the lease cannot decide it. It stays pending, the observation is recorded, a person reconciles.
    expect(await h.cycle()).toEqual(["retry"]);
    expect(await h.payment(b.payment.id)).toMatchObject({ status: "pending", mpesa_receipt: null, applied_minor: null });
    expect((await h.owner<{ outcome: string }>("SELECT outcome FROM finance_mpesa_events WHERE payment_id = $1", [b.payment.id])).map((e) => e.outcome)).toContain("failure_unconfirmed");
    expect((await h.invoice(b.inv)).paid_minor).toBe(0);
  });

  it("a duplicated callback stores the same receipt twice and the payment is still credited exactly once", async () => {
    const { inv, payment, checkout } = await pendingWithJob(100_000);
    const rcpt = receipt();
    await callbackStoredOnly(checkout, rcpt);
    await callbackStoredOnly(checkout, rcpt);
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    expect(await h.cycle()).toEqual(["succeeded"]);
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 100_000 });
    expect((await h.payment(payment.id)).mpesa_receipt).toBe(rcpt);
    expect(await h.cycle()).toEqual([]);
  });

  it("two DIFFERENT receipts for one prompt are a conflict: nothing is credited until a person decides", async () => {
    const { inv, payment, checkout } = await pendingWithJob();
    await callbackStoredOnly(checkout, receipt());
    await callbackStoredOnly(checkout, receipt());
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    expect(await h.cycle()).toEqual(["retry"]);
    expect(await h.payment(payment.id)).toMatchObject({ status: "pending", mpesa_receipt: null });
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 0 });
    expect(await outcomes(payment.id)).toContain("evidence_conflict");
  });

  it("a receipt already belonging to another payment is never credited again: the prompt stays pending", async () => {
    const first = await pendingWithJob(100_000);
    const rcpt = receipt();
    h.fake.queries.set(first.checkout, { done: true, resultCode: 0 });
    expect((await h.sendCallback(h.callbackBody(first.checkout, 0, { receipt: rcpt, amount: 1000 }))).statusCode).toBe(200);
    const second = await pendingWithJob(100_000);
    await callbackStoredOnly(second.checkout, rcpt); // the SAME receipt, claimed for another prompt
    h.fake.queries.set(second.checkout, { done: true, resultCode: 0 });
    expect(await h.cycle()).toEqual(["retry"]);
    expect(await h.payment(second.payment.id)).toMatchObject({ status: "pending", mpesa_receipt: null });
    expect(await h.invoice(second.inv)).toMatchObject({ paid_minor: 0 });
    expect(await outcomes(second.payment.id)).toContain("duplicate_receipt");
    expect((await h.invoice(first.inv)).paid_minor).toBe(100_000);
  });

  it("a callback and the settle job racing credit exactly once", async () => {
    for (let i = 0; i < 4; i++) {
      const { inv, payment, checkout } = await pendingWithJob(100_000);
      const rcpt = receipt();
      await callbackStoredOnly(checkout, rcpt); // evidence exists, so the job could credit on its own too
      h.fake.queries.set(checkout, { done: true, resultCode: 0 });
      const [cb, cycle] = await Promise.all([h.sendCallback(h.callbackBody(checkout, 0, { receipt: rcpt, amount: 1000 })), h.cycle()]);
      // Under contention PostgreSQL may abort one side with a transient 503; evidence is already stored and
      // the other side still credits. The invariant is exactly-once money, not which HTTP winner reports 200.
      expect([200, 503], cb.body).toContain(cb.statusCode);
      expect(cycle.every((o) => o === "succeeded" || o === "retry" || o === "lease_lost")).toBe(true);
      expect(await h.invoice(inv)).toMatchObject({ paid_minor: 100_000 });
      expect((await h.owner("SELECT 1 FROM finance_payments WHERE invoice_id = $1 AND status = 'success'", [inv]))).toHaveLength(1);
      expect((await h.payment(payment.id)).mpesa_receipt).toBe(rcpt);
    }
  });

  it("evidence is persisted before the provider is asked: a throwing provider loses nothing, and a redelivery adds no second credit", async () => {
    const { inv, payment, checkout } = await pendingWithJob();
    const rcpt = receipt();
    await callbackStoredOnly(checkout, rcpt);
    expect(await outcomes(payment.id)).toEqual(["callback_received"]);
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    expect((await h.sendCallback(h.callbackBody(checkout, 0, { receipt: rcpt, amount: 1000 }))).statusCode).toBe(200); // the provider redelivers
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 100_000 });
    expect((await h.sendCallback(h.callbackBody(checkout, 0, { receipt: rcpt, amount: 1000 }))).statusCode).toBe(200);
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 100_000 });
  });

  // ---- independent-review follow-ups (N1, N2, N3) ----

  it("only a callback that itself CLAIMS success supplies a receipt: a failure callback carrying a receipt is not evidence", async () => {
    const { inv, payment, checkout } = await pendingWithJob();
    const body = h.callbackBody(checkout, 1032) as Json;
    body.Body.stkCallback.CallbackMetadata = { Item: [{ Name: "MpesaReceiptNumber", Value: receipt() }, { Name: "Amount", Value: 1000 }] };
    h.fake.queries.set(checkout, "throw");
    expect((await h.sendCallback(body)).statusCode).toBe(503); // stored: claims failure (1032) yet carries a receipt
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    expect(await h.cycle()).toEqual(["retry"]); // no usable receipt: it waits, it does not credit
    expect(await h.payment(payment.id)).toMatchObject({ status: "pending", mpesa_receipt: null });
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 0 });
  });

  it("a credit made on a receipt recovered from a stored callback is raised by reconciliation until a person checks it", async () => {
    const { payment, checkout } = await pendingWithJob(100_000);
    const rcpt = receipt();
    await callbackStoredOnly(checkout, rcpt);
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    expect(await h.cycle()).toEqual(["succeeded"]);
    const run = await h.post("/reconciliation-runs", { stale_after_minutes: 30 });
    const f = (run.json().findings as Json[]).find((x) => x.kind === "recovered_receipt_credit" && x.subject_id === payment.id)!;
    expect(f).toBeDefined();
    expect(f.detail).toMatchObject({ receipt: rcpt, acting_source: "status_query", confirmed_minor: 100_000, callback_amount_minor: 100_000 });
    // a credit that arrived with the live callback (not recovered) raises nothing
    const live = await pendingWithJob(100_000);
    h.fake.queries.set(live.checkout, { done: true, resultCode: 0 });
    expect((await h.sendCallback(h.callbackBody(live.checkout, 0, { receipt: receipt(), amount: 1000 }))).statusCode).toBe(200);
    const run2 = await h.post("/reconciliation-runs", { stale_after_minutes: 30 });
    expect((run2.json().findings as Json[]).some((x) => x.kind === "recovered_receipt_credit" && x.subject_id === live.payment.id)).toBe(false);
  });

  it("a flood of redeliveries cannot hide the newest ledger rows: the operator sees the newest 200 and the total", async () => {
    const { payment, checkout } = await pendingWithJob();
    await h.owner(
      "INSERT INTO finance_mpesa_events (tenant_id, payment_id, checkout_request_id, source, result_code, outcome, received_at) SELECT $1, $2, $3, 'callback', 1032, 'callback_received', now() - interval '1 day' + (n || ' seconds')::interval FROM generate_series(1, 250) n",
      [h.A(), payment.id, checkout],
    );
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    const res = await h.post(`/payments/${payment.id}/mpesa-reconciliation`, { action: "refresh", note: "Reading the ledger after a redelivery flood" });
    expect(res.statusCode, res.body).toBe(200);
    const view = (await h.get(`/payments/${payment.id}/mpesa-events`)).json();
    expect(view.events).toHaveLength(200);
    expect(view.event_count).toBeGreaterThanOrEqual(251);
    expect(view.events.some((e: Json) => e.source === "operator" || e.outcome === "provider_pending")).toBe(true); // the newest acts are in view
    const times = view.events.map((e: Json) => e.received_at as string);
    expect([...times].sort()).toEqual(times); // oldest first within the page
  });

  it("a LIVE callback that reports failure but carries a receipt cannot credit, even when the provider says success", async () => {
    const { inv, payment, checkout } = await pendingWithJob();
    const body = h.callbackBody(checkout, 1032) as Json;
    body.Body.stkCallback.CallbackMetadata = { Item: [{ Name: "MpesaReceiptNumber", Value: receipt() }, { Name: "Amount", Value: 1000 }] };
    h.fake.queries.set(checkout, { done: true, resultCode: 0 }); // contradictory evidence: the callback says failed, the provider says paid
    expect((await h.sendCallback(body)).statusCode).toBe(503); // not usable: the provider may redeliver, a person may reconcile
    expect(await h.payment(payment.id)).toMatchObject({ status: "pending", mpesa_receipt: null });
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 0 });
  });

  // ---- final consolidated review follow-ups (N-1, N-2) ----

  it("a success callback contradicted by the provider's failure leaves the payment failed AND raises a reconciliation finding", async () => {
    const { payment, checkout } = await pendingWithJob();
    h.fake.queries.set(checkout, { done: true, resultCode: 1032 });
    await h.sendCallback(h.callbackBody(checkout, 0, { receipt: receipt(), amount: 1000 }));
    expect((await h.payment(payment.id)).status).not.toBe("success");
    const run = await h.post("/reconciliation-runs", { stale_after_minutes: 30 });
    expect((run.json().findings as Json[]).some((x) => x.kind === "contradicted_success_callback" && x.subject_id === payment.id)).toBe(true);
  });

  it("a credited payment that also has a stored success callback with a DIFFERENT receipt raises callback_receipt_mismatch", async () => {
    const { payment, checkout } = await pendingWithJob();
    const real = receipt();
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    expect((await h.sendCallback(h.callbackBody(checkout, 0, { receipt: real, amount: 1000 }))).statusCode).toBe(200);
    await h.owner(
      "INSERT INTO finance_mpesa_events (tenant_id, payment_id, checkout_request_id, source, result_code, receipt, outcome) VALUES ($1, $2, $3, 'callback', 0, $4, 'callback_received')",
      [h.A(), payment.id, checkout, receipt()],
    );
    const run = await h.post("/reconciliation-runs", { stale_after_minutes: 30 });
    const f = (run.json().findings as Json[]).find((x) => x.kind === "callback_receipt_mismatch" && x.subject_id === payment.id)!;
    expect(f).toBeDefined();
    expect(f.detail).toMatchObject({ credited_receipt: real });
  });
});
