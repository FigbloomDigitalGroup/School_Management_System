import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { financeHarness } from "./support/financeHarness.js";

/**
 * Workstream 5C / 7: the worker cannot be pointed at another school through a manipulated job payload. A settle job that belongs to
 * school A but NAMES a payment of school B must find nothing (the handler scopes every read to the JOB's tenant), must not touch
 * school B's payment, must not write an event for it, and must end permanently rather than retry forever.
 */
describe("worker tenant boundary: manipulated job payload", () => {
  const h = financeHarness();

  it("a settle job of school A naming school B's pending payment changes nothing in school B", async () => {
    const B = h.ids.tenantB;
    const learner = (await h.owner(`INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, $2, 'WB Learner', 'male') RETURNING id`, [B, "WB" + randomUUID().slice(0, 6)]))[0]!.id;
    const year = (await h.owner(`INSERT INTO academic_years (tenant_id, label, starts_on, ends_on) VALUES ($1, $2, '2026-01-01', '2026-12-31') RETURNING id`, [B, "WB" + randomUUID().slice(0, 5)]))[0]!.id;
    const term = (await h.owner(`INSERT INTO academic_terms (tenant_id, academic_year_id, index, label, starts_on, ends_on) VALUES ($1, $2, 1, 'WB T1', '2026-01-01', '2026-12-31') RETURNING id`, [B, year]))[0]!.id;
    const fee = (await h.owner(`INSERT INTO finance_fee_items (tenant_id, term_id, name, amount_minor, applies_to) VALUES ($1, $2, 'WB', 1000000, 'all') RETURNING id`, [B, term]))[0]!.id;
    const inv = (await h.owner(`INSERT INTO finance_invoices (tenant_id, learner_id, term_id, due_on, lines_minor, total_minor) VALUES ($1, $2, $3, '2026-12-31', 1000000, 1000000) RETURNING id`, [B, learner, term]))[0]!.id;
    await h.owner(`INSERT INTO finance_invoice_lines (tenant_id, invoice_id, fee_item_id, name, amount_minor) VALUES ($1, $2, $3, 'WB', 1000000)`, [B, inv, fee]);
    const checkout = "ws_CO_WB_" + randomUUID().slice(0, 8);
    const victim = (await h.owner(
      `INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status, msisdn, checkout_request_id) VALUES ($1, $2, 100000, 'mpesa', 'pending', '254712345678', $3) RETURNING id`,
      [B, inv, checkout],
    ))[0]!.id as string;
    h.fake.queries.set(checkout, { resultCode: 0, resultDesc: "ok" } as never); // even a provider "success" must not be applied through the wrong tenant
    const key = "settle-forged:" + victim;
    await h.owner(`INSERT INTO jobs (tenant_id, job_type, payload, idempotency_key, run_after) VALUES ($1, 'mpesa.stk_settle', $2::jsonb, $3, now() - interval '1 second')`, [h.A(), JSON.stringify({ paymentId: victim }), key]);

    await h.cycle();

    const pay = (await h.owner(`SELECT status, mpesa_receipt FROM finance_payments WHERE id = $1`, [victim]))[0]!;
    expect(pay).toMatchObject({ status: "pending", mpesa_receipt: null });
    expect((await h.owner(`SELECT count(*)::int AS n FROM finance_mpesa_events WHERE payment_id = $1`, [victim]))[0]!.n).toBe(0);
    expect((await h.owner(`SELECT paid_minor FROM finance_invoices WHERE id = $1`, [inv]))[0]!.paid_minor).toBe("0");
    const job = (await h.owner(`SELECT status, attempts FROM jobs WHERE idempotency_key = $1`, [key]))[0]!;
    expect(["dead", "done", "failed"]).toContain(job.status); // permanently ended, not left leased or endlessly retried
  });
});
