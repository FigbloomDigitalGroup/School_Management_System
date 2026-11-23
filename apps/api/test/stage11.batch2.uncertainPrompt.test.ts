import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystemTenantTransaction } from "../src/db/systemTenantTransaction.js";
import { createPrompt, recordPushOutcome } from "../src/modules/finance/mpesa.js";
import { financeHarness, type Json } from "./support/financeHarness.js";

/**
 * Remediation batch 2 (review R2): an uncertain STK request is never recorded as a provider failure.
 * A missing checkout id is not proof that nothing was sent: the prompt stays pending, the settle job retries,
 * reconciliation shows it, and only the provider's own answer ever fails it.
 */
describe("Stage 11 remediation batch 2: uncertain prompts", () => {
  const h = financeHarness();

  /** A prompt whose provider outcome is unknown: created, but no push result was ever recorded. */
  async function unknownPrompt() {
    const inv = await h.freshInvoice(1_000_000);
    const payment = await withSystemTenantTransaction(h.ctx.runtimePool, { tenantId: h.A(), userId: h.ids.adminA }, async (tx) =>
      (await createPrompt(tx, { tenantId: h.A(), actorUserId: h.ids.adminA, invoice_id: inv, amount_minor: 100_000, msisdn: "254733333333", settleDelaySeconds: 120 })).payment,
    );
    await h.owner("UPDATE jobs SET run_after = now() + interval '1 day' WHERE status = 'queued'");
    await h.makeDue(payment.id);
    return { inv, payment: payment as Json };
  }
  const push = (paymentId: string, result: Parameters<typeof recordPushOutcome>[1]["result"]) =>
    withSystemTenantTransaction(h.ctx.runtimePool, { tenantId: h.A(), userId: h.ids.adminA }, (tx) =>
      recordPushOutcome(tx, { tenantId: h.A(), paymentId, result, actorUserId: h.ids.adminA }),
    );

  it("a push whose outcome is unknown leaves the prompt pending with no failure recorded", async () => {
    const { payment } = await unknownPrompt();
    const after = await push(payment.id, { error: true }); // the provider call threw: nothing is known
    expect(after).toMatchObject({ status: "pending", failure_reason: null });
    const row = (await h.owner("SELECT checkout_request_id, merchant_request_id, failure_reason FROM finance_payments WHERE id = $1", [payment.id]))[0]!;
    expect(row).toEqual({ checkout_request_id: null, merchant_request_id: null, failure_reason: null });
  });

  it("the settle job retries an unacknowledged prompt instead of failing it; nothing is audited as settled", async () => {
    const { payment, ...rest } = await unknownPrompt();
    void rest;
    expect(await h.cycle()).toEqual(["retry"]);
    const job = (await h.jobOf(payment.id))!;
    expect(job).toMatchObject({ status: "queued", last_error_code: "awaiting_checkout_id" });
    expect((await h.payment(payment.id)).status).toBe("pending");
    expect((await h.auditOf("finance.mpesa.settled")).filter((e) => e.detail.paymentId === payment.id)).toHaveLength(0);
    expect(await h.owner("SELECT 1 FROM finance_mpesa_events WHERE payment_id = $1", [payment.id])).toHaveLength(0);
  });

  it("a checkout id stored late is honoured: the next attempt asks the provider and records ITS answer", async () => {
    const { payment } = await unknownPrompt();
    expect(await h.cycle()).toEqual(["retry"]);
    await push(payment.id, { accepted: true, checkoutRequestId: "ws_CO_LATE_ID", merchantRequestId: "MR_LATE" });
    await h.plantFailureCallback(payment.id, "ws_CO_LATE_ID", 1032);
    h.fake.queries.set("ws_CO_LATE_ID", { done: true, resultCode: 1032 }); // the provider says the customer cancelled
    await h.owner("UPDATE jobs SET run_after = now() - interval '1 second' WHERE idempotency_key = $1", [`settle:${payment.id}`]);
    expect(await h.cycle()).toEqual(["succeeded"]);
    expect(await h.payment(payment.id)).toMatchObject({ status: "cancelled", failure_reason: "cancelled" });
    const events = await h.owner<{ outcome: string }>("SELECT outcome FROM finance_mpesa_events WHERE payment_id = $1", [payment.id]);
    expect(events.map((e) => e.outcome).sort()).toEqual(["callback_received", "settled_failure"]);
  });

  it("while the provider cannot say, the prompt stays pending and the job retries (no premature failure)", async () => {
    const { payment } = await unknownPrompt();
    await push(payment.id, { accepted: true, checkoutRequestId: "ws_CO_UNSURE", merchantRequestId: "MR_UNSURE" });
    h.fake.queries.set("ws_CO_UNSURE", { done: false });
    expect(await h.cycle()).toEqual(["retry"]);
    expect((await h.payment(payment.id)).status).toBe("pending");
    expect((await h.jobOf(payment.id))!.last_error_code).toBe("provider_pending");
    h.fake.queries.set("ws_CO_UNSURE", "throw"); // provider unreachable
    await h.owner("UPDATE jobs SET run_after = now() - interval '1 second' WHERE idempotency_key = $1", [`settle:${payment.id}`]);
    expect(await h.cycle()).toEqual(["retry"]);
    expect((await h.payment(payment.id)).status).toBe("pending");
    expect((await h.jobOf(payment.id))!.last_error_code).toBe("provider_error");
  });

  it("retry exhaustion leaves the prompt pending for a person, and reconciliation shows it", async () => {
    const { payment } = await unknownPrompt();
    await h.owner("UPDATE jobs SET max_attempts = 1 WHERE idempotency_key = $1", [`settle:${payment.id}`]);
    expect(await h.cycle()).toEqual(["dead"]);
    expect((await h.jobOf(payment.id))).toMatchObject({ status: "dead", last_error_code: "awaiting_checkout_id" });
    expect((await h.payment(payment.id)).status).toBe("pending"); // never auto-failed
    await h.owner("ALTER TABLE finance_payments DISABLE TRIGGER finance_payments_guard");
    try {
      await h.owner("UPDATE finance_payments SET created_at = now() - interval '3 hours' WHERE id = $1", [payment.id]);
    } finally {
      await h.owner("ALTER TABLE finance_payments ENABLE TRIGGER finance_payments_guard");
    }
    const run = await h.post("/reconciliation-runs", { stale_after_minutes: 30 });
    expect((run.json().findings as Json[]).some((f) => f.kind === "prompt_never_sent" && f.subject_id === payment.id)).toBe(true);
    expect((await h.payment(payment.id)).status).toBe("pending");
  });

  it("the database refuses to record 'not_sent' as a failure for any role, but still records a CONFIRMED provider refusal", async () => {
    const { payment } = await unknownPrompt();
    const direct = "UPDATE finance_payments SET status = 'failed', failure_reason = 'not_sent' WHERE id = $1";
    expect(await h.sqlState(h.ctx.pool.query(direct, [payment.id]))).toBe("23514"); // owner
    expect(await h.asApp(h.A(), (c) => h.sqlState(c.query(direct, [payment.id])))).toBe("23514"); // API role
    // F-8: worker has no direct UPDATE on finance_payments (privilege error before the trigger runs).
    expect(await h.asApp(h.A(), (c) => h.sqlState(c.query(direct, [payment.id])), h.workerPool)).toBe("42501");
    expect(
      await h.asApp(h.A(), (c) => h.sqlState(c.query("UPDATE finance_payments SET status = 'failed', failure_reason = 'cancelled' WHERE id = $1", [payment.id])), h.workerPool),
    ).toBe("42501");
    expect((await h.payment(payment.id)).status).toBe("pending");
    // the provider's explicit refusal (a response, not silence) is still a recorded failure
    const refused = await push(payment.id, { accepted: false, responseCode: "1" });
    expect(refused).toMatchObject({ status: "failed", failure_reason: "unreachable" });
  });

  it("the trigger exists and is enabled; no code path can request a not-sent failure (lint-style guard)", async () => {
    const t = await h.owner<{ tgenabled: string }>(
      "SELECT tgenabled FROM pg_trigger WHERE tgname = 'finance_payments_no_not_sent' AND tgrelid = 'finance_payments'::regclass",
    );
    expect(t).toEqual([{ tgenabled: "O" }]);
    const src = readFileSync(new URL("../src/modules/finance/mpesa.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/notSent/);
    expect(src).not.toMatch(/'not_sent'|"not_sent"/);
  });

  it("an unknown or still-processing provider result code never fails the prompt (job and callback)", async () => {
    for (const code of [9999, 4999]) {
      const { payment } = await unknownPrompt();
      const checkout = `ws_CO_CODE${code}`;
      await push(payment.id, { accepted: true, checkoutRequestId: checkout, merchantRequestId: "MR_" + code });
      h.fake.queries.set(checkout, { done: true, resultCode: code });
      expect(await h.cycle(), String(code)).toEqual(["retry"]);
      expect(await h.payment(payment.id), String(code)).toMatchObject({ status: "pending", failure_reason: null });
      expect((await h.jobOf(payment.id))!.last_error_code).toBe("provider_pending");
      // the callback path answers 503 (the provider may redeliver) and records nothing as failed
      expect((await h.sendCallback(h.callbackBody(checkout, code))).statusCode).toBe(503);
      expect((await h.payment(payment.id)).status).toBe("pending");
      const outcomes = (await h.owner<{ outcome: string }>("SELECT outcome FROM finance_mpesa_events WHERE payment_id = $1", [payment.id])).map((e) => e.outcome);
      expect(outcomes.every((o) => o === "provider_pending" || o === "callback_received")).toBe(true);
    }
    // a documented FINAL failure code still settles it
    const { payment } = await unknownPrompt();
    await push(payment.id, { accepted: true, checkoutRequestId: "ws_CO_FINAL2001", merchantRequestId: "MR_F" });
    await h.plantFailureCallback(payment.id, "ws_CO_FINAL2001", 2001);
    h.fake.queries.set("ws_CO_FINAL2001", { done: true, resultCode: 2001 });
    expect(await h.cycle()).toEqual(["succeeded"]);
    expect(await h.payment(payment.id)).toMatchObject({ status: "failed", failure_reason: "wrong_pin" });
  });

  it("crash window: the provider accepted but nothing was stored; the callback is quarantined and reconciliation flags the prompt", async () => {
    const { payment } = await unknownPrompt();
    const before = Number((await h.owner<{ n: string }>("SELECT count(*) AS n FROM finance_mpesa_unmatched_callbacks"))[0]!.n);
    expect((await h.sendCallback(h.callbackBody("ws_CO_CRASHED", 0, { receipt: "CRASHRCPT1" }))).statusCode).toBe(200); // quarantined, provider stops retrying
    expect(Number((await h.owner<{ n: string }>("SELECT count(*) AS n FROM finance_mpesa_unmatched_callbacks"))[0]!.n)).toBe(before + 1);
    expect((await h.payment(payment.id)).status).toBe("pending"); // the evidence is held for an operator, the payment is untouched
    await h.owner("ALTER TABLE finance_payments DISABLE TRIGGER finance_payments_guard");
    try {
      await h.owner("UPDATE finance_payments SET created_at = now() - interval '3 hours' WHERE id = $1", [payment.id]);
    } finally {
      await h.owner("ALTER TABLE finance_payments ENABLE TRIGGER finance_payments_guard");
    }
    const run = await h.post("/reconciliation-runs", { stale_after_minutes: 30 });
    expect((run.json().findings as Json[]).some((f) => f.kind === "prompt_never_sent" && f.subject_id === payment.id)).toBe(true);
  });

  it("reconciliation does not flag a young unacknowledged prompt (no false positive)", async () => {
    const { payment } = await unknownPrompt();
    const run = await h.post("/reconciliation-runs", { stale_after_minutes: 30 });
    expect((run.json().findings as Json[]).some((f) => f.kind === "prompt_never_sent" && f.subject_id === payment.id)).toBe(false);
  });
});
