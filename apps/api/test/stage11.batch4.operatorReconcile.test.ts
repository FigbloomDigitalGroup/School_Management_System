import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withSystemTenantTransaction } from "../src/db/systemTenantTransaction.js";
import { createPrompt } from "../src/modules/finance/mpesa.js";
import { financeHarness, type Json } from "./support/financeHarness.js";

/**
 * Remediation batch 4: audited operator reconciliation of stuck M-Pesa prompts. The operator asks, the SYSTEM decides
 * from evidence (provider answer + authenticated callback evidence); nothing here lets an operator bypass the provider.
 */
describe("Stage 11 remediation batch 4: operator reconciliation", () => {
  const h = financeHarness();
  const receipt = () => "R" + randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase();
  const NOTE = "Checked with the parent and the bank statement";

  const reconcile = (paymentId: string, body: Json, token = h.admin) => h.post(`/payments/${paymentId}/mpesa-reconciliation`, body, token);
  const events = async (paymentId: string) => (await h.get(`/payments/${paymentId}/mpesa-events`)).json();
  const stuck = async (amount = 100_000, lineMinor = 1_000_000) => {
    const inv = await h.freshInvoice(lineMinor);
    const p = await h.startPrompt(inv, amount);
    return { inv, ...p };
  };
  /** A callback that carried a receipt but whose provider query failed: evidence stored, prompt still pending (503). */
  async function callbackWith503(checkout: string, rcpt: string) {
    h.fake.queries.set(checkout, "throw");
    expect((await h.sendCallback(h.callbackBody(checkout, 0, { receipt: rcpt, amount: 1000 }))).statusCode).toBe(503);
  }

  it("an operator can inspect the checkout id and the provider evidence ledger, oldest first", async () => {
    const { payment, checkout } = await stuck();
    const rcpt = receipt();
    await callbackWith503(checkout, rcpt);
    const view = await events(payment.id);
    expect(view).toMatchObject({ payment_id: payment.id, status: "pending", checkout_request_id: checkout });
    expect(view.events.map((e: Json) => e.outcome)).toEqual(["callback_received"]); // the provider query failed before any settlement: only the evidence exists
    expect(view.events[0]).toMatchObject({ source: "callback", result_code: 0, receipt: rcpt, actor_user_id: null, operator_note: null });
  });

  it("refresh settles from provider success plus the receipt an authenticated callback already delivered (provider was down at callback time)", async () => {
    const { inv, payment, checkout } = await stuck(250_000);
    const rcpt = receipt();
    await callbackWith503(checkout, rcpt);
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    const res = await reconcile(payment.id, { action: "refresh", note: NOTE });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json(), res.body).toMatchObject({ outcome: "settled_success", reason: null, payment: { status: "success", mpesa_receipt: rcpt, applied_minor: 250_000, unapplied_minor: 0 } });
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 250_000 });
    const led = (await events(payment.id)).events as Json[];
    expect(led.filter((e) => e.source === "operator").map((e) => e.outcome)).toEqual(["evidence_recovered", "settled_success"]); // deterministic order within one transaction
    const op = led.find((e) => e.source === "operator" && e.outcome === "settled_success")!;
    expect(op).toMatchObject({ outcome: "settled_success", actor_user_id: h.ids.adminA, operator_note: NOTE, evidence_basis: "stored_callback", receipt: rcpt });
    const audit = (await h.auditOf("finance.mpesa.settled")).find((e) => e.detail.paymentId === payment.id)!;
    expect(audit.actor_user_id).toBe(h.ids.adminA);
    expect(audit.detail).toMatchObject({ actingVia: "operator", outcome: "success", receiptBasis: "stored_callback" });
  });

  it("settle_success credits with an operator-typed receipt ONLY when the provider confirms success", async () => {
    const { inv, payment, checkout } = await stuck(100_000);
    const rcpt = receipt();
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    const res = await reconcile(payment.id, { action: "settle_success", receipt: rcpt.toLowerCase(), note: NOTE });
    expect(res.json()).toMatchObject({ outcome: "settled_success", payment: { status: "success", mpesa_receipt: rcpt } });
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 100_000 });
    expect(((await events(payment.id)).events as Json[]).find((e) => e.source === "operator")).toMatchObject({ evidence_basis: "operator_receipt" });
  });

  it("an operator cannot credit against the provider: provider says failed, unreachable, or unfinished -> inconclusive, nothing changes", async () => {
    const { inv, payment, checkout } = await stuck();
    const attempt = async (q: Json | "throw") => {
      h.fake.queries.set(checkout, q as never);
      const r = await reconcile(payment.id, { action: "settle_success", receipt: receipt(), note: NOTE });
      expect(r.statusCode, r.body).toBe(200);
      return r.json();
    };
    expect(await attempt({ done: true, resultCode: 1032 })).toMatchObject({ outcome: "inconclusive", reason: "provider_says_not_paid", payment: { status: "pending" } });
    expect(await attempt({ done: false })).toMatchObject({ outcome: "inconclusive", reason: "provider_not_finished" });
    expect(await attempt("throw")).toMatchObject({ outcome: "inconclusive", reason: "provider_unavailable" }); // an unreachable provider is never confirmation
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 0 });
    const led = ((await events(payment.id)).events as Json[]).filter((e) => e.source === "operator");
    expect(led.map((e) => e.outcome)).toEqual(["operator_inconclusive", "operator_inconclusive", "operator_inconclusive"]);
    expect((await h.auditOf("finance.mpesa.operator_inconclusive")).filter((e) => e.detail.paymentId === payment.id)).toHaveLength(3);
  });

  it("with the provider unreachable NOTHING is credited or failed, not even with an authenticated callback's claim and a matching receipt", async () => {
    const { inv, payment, checkout } = await stuck(100_000);
    const rcpt = receipt();
    await callbackWith503(checkout, rcpt); // provider still unreachable: the callback's claim is not provider confirmation
    for (const body of [{ action: "settle_success", receipt: rcpt, note: NOTE }, { action: "refresh", note: NOTE }, { action: "mark_failed", note: NOTE }]) {
      const r = await reconcile(payment.id, body);
      expect(r.json(), JSON.stringify(body)).toMatchObject({ outcome: "inconclusive", reason: "provider_unavailable", payment: { status: "pending" } });
    }
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 0 });
  });

  it("a planted success callback with no receipt, plus a typed receipt and an unreachable provider, cannot credit (review F1)", async () => {
    const { inv, payment, checkout } = await stuck(100_000);
    const bare = h.callbackBody(checkout, 0);
    delete (bare as Json).Body.stkCallback.CallbackMetadata; // code 0, no receipt: plantable by anyone holding the URL secret
    h.fake.queries.set(checkout, "throw");
    expect((await h.sendCallback(bare)).statusCode).toBe(503);
    const r = await reconcile(payment.id, { action: "settle_success", receipt: receipt(), note: NOTE });
    expect(r.json()).toMatchObject({ outcome: "inconclusive", reason: "provider_unavailable", payment: { status: "pending" } });
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 0 });
  });

  it("contradictory callbacks (success then failure) never let an unreachable provider decide", async () => {
    const { payment, checkout } = await stuck(100_000);
    await callbackWith503(checkout, receipt());
    h.fake.queries.set(checkout, "throw");
    expect((await h.sendCallback(h.callbackBody(checkout, 1032))).statusCode).toBe(503);
    for (const action of ["mark_failed", "refresh"]) expect((await reconcile(payment.id, { action, note: NOTE })).json()).toMatchObject({ outcome: "inconclusive", reason: "provider_unavailable" });
    expect((await h.payment(payment.id)).status).toBe("pending");
  });

  it("an operator CHOOSES between two receipts the provider's callbacks delivered; every typed-receipt credit is raised by reconciliation", async () => {
    const { inv, payment, checkout } = await stuck(100_000);
    const r1 = receipt();
    const r2 = receipt();
    await callbackWith503(checkout, r1);
    await callbackWith503(checkout, r2);
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    expect((await reconcile(payment.id, { action: "refresh", note: NOTE })).json()).toMatchObject({ outcome: "inconclusive", reason: "evidence_not_usable" }); // two receipts: a conflict
    expect((await reconcile(payment.id, { action: "settle_success", receipt: receipt(), note: NOTE })).json()).toMatchObject({ outcome: "inconclusive" }); // not one of them
    const pick = await reconcile(payment.id, { action: "settle_success", receipt: r2, note: NOTE });
    expect(pick.json()).toMatchObject({ outcome: "settled_success", payment: { mpesa_receipt: r2 } });
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 100_000 });
    const run = await h.post("/reconciliation-runs", { stale_after_minutes: 30 });
    const f = (run.json().findings as Json[]).find((x) => x.kind === "operator_receipt_credit" && x.subject_id === payment.id)!;
    expect(f).toBeDefined();
    expect(f.detail).toMatchObject({ receipt: r2, operator_user_id: h.ids.adminA, provider_view: "query:0" });
  });

  it("a typed receipt that the unmatched-callback quarantine holds for ANOTHER checkout is refused", async () => {
    const { inv, payment, checkout } = await stuck(100_000);
    const q = receipt();
    expect((await h.sendCallback(h.callbackBody("ws_CO_NOBODYS_" + q, 0, { receipt: q, amount: 1000 }))).statusCode).toBe(200); // quarantined
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    const r = await reconcile(payment.id, { action: "settle_success", receipt: q, note: NOTE });
    expect(r.json()).toMatchObject({ outcome: "inconclusive", reason: "receipt_in_quarantine", payment: { status: "pending" } });
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 0 });
  });

  it("operator rows record what the provider said, the action and the caller's IP; notes are hidden from read-only users", async () => {
    const { payment, checkout } = await stuck(100_000);
    h.fake.queries.set(checkout, { done: true, resultCode: 9999 });
    await reconcile(payment.id, { action: "refresh", note: NOTE });
    h.fake.queries.set(checkout, "throw");
    await reconcile(payment.id, { action: "mark_failed", note: NOTE });
    const led = ((await events(payment.id)).events as Json[]).filter((e) => e.source === "operator");
    expect(led.map((e) => e.outcome)).toEqual(["provider_pending", "operator_inconclusive"]); // an unknown code is logged by the settlement itself; an unreachable provider by the operator act
    const views = await h.owner<{ provider_view: string }>("SELECT provider_view FROM finance_mpesa_events WHERE payment_id = $1 AND source = 'operator' ORDER BY received_at, id", [payment.id]);
    expect(views.map((v) => v.provider_view)).toEqual(["query:9999", "unavailable"]);
    const audits = (await h.auditOf("finance.mpesa.operator_inconclusive")).filter((e) => e.detail.paymentId === payment.id);
    expect(audits).toHaveLength(2);
    expect(audits[0]!.ip).not.toBeNull();
    expect(audits[0]!.detail).toMatchObject({ action: "refresh", reason: "evidence_not_usable", providerView: "query:9999", actingVia: "operator" });
    expect(JSON.stringify(audits.map((a) => a.detail))).not.toContain("Checked with the parent"); // the free-text note lives in the ledger only
    // notes: an administrator sees them, a Fees-area writer (read access) does not
    await h.owner("INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'fees') ON CONFLICT DO NOTHING", [h.A(), h.ids.teacherA]);
    try {
      const asTeacher = (await h.get(`/payments/${payment.id}/mpesa-events`, h.teacher)).json().events as Json[];
      expect(asTeacher.filter((e) => e.source === "operator").every((e) => e.operator_note === null)).toBe(true);
      expect(led.every((e) => e.operator_note === NOTE)).toBe(true);
    } finally {
      await h.owner("DELETE FROM staff_area_grants WHERE user_id = $1 AND area = 'fees'", [h.ids.teacherA]);
    }
  });


  it("an operator receipt that contradicts the authenticated callback's is a conflict: nothing is credited", async () => {
    const { inv, payment, checkout } = await stuck();
    await callbackWith503(checkout, receipt());
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    const r = await reconcile(payment.id, { action: "settle_success", receipt: receipt(), note: NOTE });
    expect(r.json()).toMatchObject({ outcome: "inconclusive", reason: "evidence_not_usable", payment: { status: "pending" } });
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 0 });
    expect(((await events(payment.id)).events as Json[]).map((e) => e.outcome)).toContain("evidence_conflict");
  });

  it("a duplicate receipt (already another payment's) is never credited, and stays escalated", async () => {
    const other = await stuck(100_000);
    const rcpt = receipt();
    h.fake.queries.set(other.checkout, { done: true, resultCode: 0 });
    expect((await h.sendCallback(h.callbackBody(other.checkout, 0, { receipt: rcpt, amount: 1000 }))).statusCode).toBe(200);
    const { inv, payment, checkout } = await stuck(100_000);
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    const r = await reconcile(payment.id, { action: "settle_success", receipt: rcpt, note: NOTE });
    expect(r.json()).toMatchObject({ outcome: "inconclusive", reason: "evidence_not_usable", payment: { status: "pending" } });
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 0 });
    expect(((await events(payment.id)).events as Json[]).map((e) => e.outcome)).toContain("duplicate_receipt");
  });

  it("mark_failed with a provider-confirmed final failure releases the pending slot: a new prompt can then be created", async () => {
    const { inv, payment, checkout } = await stuck(100_000);
    const createAgain = () =>
      withSystemTenantTransaction(h.ctx.runtimePool, { tenantId: h.A(), userId: h.ids.adminA }, (tx) =>
        createPrompt(tx, { tenantId: h.A(), actorUserId: h.ids.adminA, invoice_id: inv, amount_minor: 100_000, msisdn: "254722222222", settleDelaySeconds: 120 }),
      );
    await expect(createAgain()).rejects.toThrow(/still in progress|conflict/i); // the stuck prompt blocks the invoice
    h.fake.queries.set(checkout, { done: true, resultCode: 1032 });
    const r = await reconcile(payment.id, { action: "mark_failed", note: NOTE });
    expect(r.json()).toMatchObject({ outcome: "settled_failure", payment: { status: "cancelled", failure_reason: "cancelled" } });
    expect((await createAgain()).reused).toBe(false); // released
  });

  it("mark_failed never fails a paid or still-processing prompt; an UNKNOWN code needs this explicit act; no confirmation -> pending", async () => {
    const a = await stuck();
    h.fake.queries.set(a.checkout, { done: true, resultCode: 0 });
    expect((await reconcile(a.payment.id, { action: "mark_failed", note: NOTE })).json()).toMatchObject({ outcome: "inconclusive", reason: "provider_says_paid" });
    const b = await stuck();
    h.fake.queries.set(b.checkout, { done: true, resultCode: 4999 });
    expect((await reconcile(b.payment.id, { action: "mark_failed", note: NOTE })).json()).toMatchObject({ outcome: "inconclusive", reason: "provider_processing" });
    const c = await stuck();
    h.fake.queries.set(c.checkout, "throw");
    expect((await reconcile(c.payment.id, { action: "mark_failed", note: NOTE })).json()).toMatchObject({ outcome: "inconclusive", reason: "provider_unavailable" });
    const d = await stuck();
    h.fake.queries.set(d.checkout, { done: true, resultCode: 9999 });
    expect((await reconcile(d.payment.id, { action: "refresh", note: NOTE })).json()).toMatchObject({ outcome: "inconclusive" }); // refresh never accepts an unknown code
    expect((await reconcile(d.payment.id, { action: "mark_failed", note: NOTE })).json()).toMatchObject({ outcome: "settled_failure", payment: { status: "failed", failure_reason: "unreachable" } });
    for (const x of [a, b, c]) expect((await h.payment(x.payment.id)).status).toBe("pending");
  });

  it("a prompt that never got a checkout id cannot be confirmed against anything: it stays pending and is escalated with the reason on record", async () => {
    const inv = await h.freshInvoice(300_000);
    const p = await withSystemTenantTransaction(h.ctx.runtimePool, { tenantId: h.A(), userId: h.ids.adminA }, async (tx) =>
      (await createPrompt(tx, { tenantId: h.A(), actorUserId: h.ids.adminA, invoice_id: inv, amount_minor: 100_000, msisdn: "254733333333", settleDelaySeconds: 120 })).payment,
    );
    const r = await reconcile(p.id, { action: "mark_failed", note: NOTE });
    expect(r.json()).toMatchObject({ outcome: "inconclusive", reason: "no_checkout_id", payment: { status: "pending" } });
    const ev = (await h.auditOf("finance.mpesa.operator_inconclusive")).find((e) => e.detail.paymentId === p.id)!;
    expect(ev.actor_user_id).toBe(h.ids.adminA);
    expect(ev.detail).toMatchObject({ reason: "no_checkout_id", note: NOTE, actingVia: "operator" });
  });

  it("is idempotent: repeating a settlement changes nothing and allocates nothing twice", async () => {
    const { inv, payment, checkout } = await stuck(200_000);
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    const rcpt = receipt();
    for (let i = 0; i < 3; i++) {
      const r = await reconcile(payment.id, { action: "settle_success", receipt: rcpt, note: NOTE });
      expect(r.json().outcome).toBe(i === 0 ? "settled_success" : "already_settled");
    }
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 200_000 });
    expect(await h.owner("SELECT 1 FROM finance_payments WHERE invoice_id = $1 AND status = 'success'", [inv])).toHaveLength(1);
    expect((await h.auditOf("finance.mpesa.settled")).filter((e) => e.detail.paymentId === payment.id)).toHaveLength(1);
  });

  it("a callback and an operator racing credit exactly once", async () => {
    for (let i = 0; i < 4; i++) {
      const { inv, payment, checkout } = await stuck(100_000);
      h.fake.queries.set(checkout, { done: true, resultCode: 0 });
      const rcpt = receipt();
      const [cb, op] = await Promise.all([
        h.sendCallback(h.callbackBody(checkout, 0, { receipt: rcpt, amount: 1000 })),
        reconcile(payment.id, { action: "settle_success", receipt: rcpt, note: NOTE }),
      ]);
      expect(cb.statusCode, cb.body).toBe(200);
      expect(op.statusCode, op.body).toBe(200);
      expect(["settled_success", "already_settled"]).toContain(op.json().outcome);
      expect(await h.invoice(inv)).toMatchObject({ paid_minor: 100_000 });
      expect((await h.payment(payment.id)).mpesa_receipt).toBe(rcpt);
    }
  });

  it("is restricted to finance administrators, validated, and tenant-scoped", async () => {
    const { payment, checkout } = await stuck();
    h.fake.queries.set(checkout, { done: true, resultCode: 1032 });
    await h.owner("INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'fees') ON CONFLICT DO NOTHING", [h.A(), h.ids.teacherA]);
    try {
      expect((await reconcile(payment.id, { action: "mark_failed", note: NOTE }, h.teacher)).statusCode).toBe(403); // Fees-area write is not administer
      expect((await h.get(`/payments/${payment.id}/mpesa-events`, h.teacher)).statusCode).toBe(200); // reading the ledger is
    } finally {
      await h.owner("DELETE FROM staff_area_grants WHERE user_id = $1 AND area = 'fees'", [h.ids.teacherA]);
    }
    expect((await reconcile(payment.id, { action: "mark_failed", note: NOTE }, h.parent)).statusCode).toBe(403);
    expect((await h.get(`/payments/${payment.id}/mpesa-events`, h.parent)).statusCode).toBe(403);
    expect((await reconcile(payment.id, { action: "mark_failed", note: "short" })).statusCode).toBe(400);
    expect((await reconcile(payment.id, { action: "settle_success", note: NOTE })).statusCode).toBe(400); // receipt required
    expect((await reconcile(payment.id, { action: "settle_success", receipt: "bad!", note: NOTE })).statusCode).toBe(400);
    expect((await reconcile(payment.id, { action: "refresh", receipt: receipt(), note: NOTE })).statusCode).toBe(400); // receipt only with settle_success
    expect((await reconcile(payment.id, { action: "nonsense", note: NOTE })).statusCode).toBe(400);
    expect((await reconcile(randomUUID(), { action: "refresh", note: NOTE })).statusCode).toBe(404); // another school's payment looks the same
    const other = await h.login({ tenantId: h.ids.tenantB, loginId: "TC-0001", password: "correct-horse-battery" });
    expect([403, 404]).toContain((await reconcile(payment.id, { action: "mark_failed", note: NOTE }, other)).statusCode);
    expect((await h.payment(payment.id)).status).toBe("pending"); // none of the refused attempts changed anything
  });

  it("the evidence ledger is append-only and the worker cannot plant callback or operator evidence", async () => {
    const { payment, checkout } = await stuck();
    await callbackWith503(checkout, receipt());
    const evId = ((await events(payment.id)).events as Json[])[0]!.id as string;
    expect(await h.asApp(h.A(), (c) => h.sqlState(c.query("UPDATE finance_mpesa_events SET receipt = NULL WHERE id = $1", [evId])))).toBe("42501");
    expect(await h.asApp(h.A(), (c) => h.sqlState(c.query("DELETE FROM finance_mpesa_events WHERE id = $1", [evId])))).toBe("42501");
    const plant = (source: string, extra = "") =>
      h.asApp(
        h.A(),
        (c) =>
          h.sqlState(
            c.query(
              `INSERT INTO finance_mpesa_events (tenant_id, payment_id, checkout_request_id, source, result_code, receipt, outcome${extra ? ", actor_user_id, operator_note" : ""})
               VALUES ($1, $2, $3, $4, 0, 'PLANTED0001', $5${extra ? ", $6, 'a long enough planted note'" : ""})`,
              extra ? [h.A(), payment.id, checkout, source, "callback_received", h.ids.adminA] : [h.A(), payment.id, checkout, source, "callback_received"],
            ),
          ),
        h.workerPool,
      );
    expect(await plant("callback")).toBe("42501");
    expect(await plant("operator", "x")).toBe("42501");
    expect(await plant("status_query", "x")).toBe("42501"); // not even its own source may carry an acting user
    expect(await plant("status_query")).toBeNull(); // its own provider queries are fine
  });

  it("the ledger shows what the provider said for each operator act (provider_view)", async () => {
    const { payment, checkout } = await stuck();
    h.fake.queries.set(checkout, { done: true, resultCode: 9999 });
    await reconcile(payment.id, { action: "mark_failed", note: NOTE });
    const view = await events(payment.id);
    expect((view.events as Json[]).find((e) => e.source === "operator")).toMatchObject({ provider_view: "query:9999" });
    expect(typeof view.event_count).toBe("number");
  });

  it("an administer permission lost WHILE the provider is being asked is honoured: nothing is settled", async () => {
    const { inv, payment, checkout } = await stuck(100_000);
    const rcpt = receipt();
    await callbackWith503(checkout, rcpt);
    const original = h.fake.stkQuery.bind(h.fake);
    h.fake.stkQuery = async () => {
      await h.owner("UPDATE users SET status = 'disabled' WHERE id = $1", [h.ids.adminA]); // the operator is disabled mid-request
      return { done: true, resultCode: 0 };
    };
    try {
      const res = await reconcile(payment.id, { action: "refresh", note: NOTE });
      expect([401, 403]).toContain(res.statusCode);
    } finally {
      h.fake.stkQuery = original;
      await h.owner("UPDATE users SET status = 'active' WHERE id = $1", [h.ids.adminA]);
    }
    expect((await h.payment(payment.id)).status).toBe("pending");
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 0 });
  });

  it("mark_failed on an UNKNOWN provider code is refused while a stored callback claims the money arrived", async () => {
    const { payment, checkout } = await stuck();
    await callbackWith503(checkout, receipt());
    h.fake.queries.set(checkout, { done: true, resultCode: 9999 });
    const r = await reconcile(payment.id, { action: "mark_failed", note: NOTE });
    expect(r.json()).toMatchObject({ outcome: "inconclusive", reason: "callback_claims_paid" });
    expect((await h.payment(payment.id)).status).toBe("pending");
  });
});
