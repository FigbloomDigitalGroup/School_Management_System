import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { withSystemTenantTransaction } from "../src/db/systemTenantTransaction.js";
import { assertRuntimeRole } from "../src/db/roleAssert.js";
import { createPrompt, recordPushOutcome } from "../src/modules/finance/mpesa.js";
import { invoiceStatus } from "../src/modules/finance/money.js";
import type { MpesaProvider, StkPushRequest, StkPushResult, StkQueryResult } from "../src/modules/finance/mpesaProvider.js";
import { workerHandlers } from "../src/worker/handlers.js";
import { runCycle } from "../src/worker/runtime.js";
import { createTestApp, type FixtureIds } from "./support.js";
import { enableWorkerLogin, resetWorkerLogin } from "./support/financeHarness.js";

/**
 * Stage 11 finance: invariants, security and settlement, through the real HTTP app, the real runtime
 * logins (figbloom_app, figbloom_worker) and a deterministic fake M-Pesa provider (no network, no
 * credentials). Amounts are minor units (100 = KES 1).
 */

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
type Json = Record<string, any>;

class FakeProvider implements MpesaProvider {
  readonly configured = true;
  pushes: StkPushRequest[] = [];
  pushResult: StkPushResult | "throw" = { accepted: true, checkoutRequestId: "ws_CO_FAKE", merchantRequestId: "MR_FAKE" };
  queries = new Map<string, StkQueryResult | "throw">();
  async stkPush(req: StkPushRequest): Promise<StkPushResult> {
    this.pushes.push(req);
    if (this.pushResult === "throw") throw new Error("network");
    return this.pushResult;
  }
  async stkQuery(checkoutRequestId: string): Promise<StkQueryResult> {
    const r = this.queries.get(checkoutRequestId);
    if (r === "throw" || r === undefined) throw new Error("provider unavailable");
    return r;
  }
}

/** The tables the worker role may read (it has no grant on the others at all; fee items were removed by migration 046). */
const WORKER_TABLES = ["finance_invoices", "finance_invoice_lines", "finance_charges", "finance_invoice_adjustments", "finance_payments", "finance_mpesa_events", "finance_payment_proofs", "jobs"];
const CALLBACK_SECRET = "callback-secret-for-tests-0123456789abcdef";
const PASSWORD = "correct-horse-battery";

describe("Stage 11 finance", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let app: Ctx["app"];
  let fake: FakeProvider;
  let workerPool: pg.Pool;
  let admin: string;
  let teacher: string;
  let parent: string;
  let year: string;
  let term: string;
  let f1: string;
  let f2: string;
  let boarder: string;
  let dayF1: string;
  let dayF2: string;
  let invBoarder: string;
  let invDayF2: string;
  let seq = 0;

  const A = () => ids.tenantA;
  const hdr = (token: string, tenant = A()) => ({ authorization: `Bearer ${token}`, "x-tenant-id": tenant });
  const fin = (path = "") => `/v1/tenants/${A()}/finance${path}`;

  async function call(method: "GET" | "POST" | "PUT" | "PATCH", url: string, token: string, payload?: unknown, headers: Json = {}) {
    return app.inject({
      method,
      url,
      headers: { ...hdr(token), ...headers },
      ...(payload === undefined ? {} : { payload: payload as Json }),
    });
  }
  const post = (path: string, payload: unknown, token = admin, headers: Json = {}) => call("POST", fin(path), token, payload, headers);
  const get = (path: string, token = admin) => call("GET", fin(path), token);

  async function created(url: string, payload: unknown, key: string): Promise<string> {
    const res = await call("POST", `/v1/tenants/${A()}${url}`, admin, payload);
    expect(res.statusCode, `${url} ${res.body}`).toBe(201);
    return res.json()[key].id as string;
  }

  async function login(body: Json): Promise<string> {
    const res = await ctx.app.inject({ method: "POST", url: body.email ? "/v1/auth/login/email" : "/v1/auth/login/login-id", payload: body });
    expect(res.statusCode).toBe(200);
    return res.json().token as string;
  }

  async function asApp<T>(tenant: string | null, fn: (c: pg.PoolClient) => Promise<T>, pool: pg.Pool = ctx.runtimePool): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      if (tenant) await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant]);
      return await fn(c);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  }
  async function sqlState(p: Promise<unknown>): Promise<string | null> {
    try {
      await p;
      return null;
    } catch (err) {
      return (err as { code?: string }).code ?? "unknown";
    }
  }
  const owner = async <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await ctx.pool.query<T>(sql, params)).rows;

  async function invoice(id: string): Promise<Json> {
    return (await get(`/invoices/${id}`)).json().invoice;
  }

  /**
   * A new fully-isolated invoice (own learner, own academic year and term) seeded by the owner, so each test
   * controls its balance without depending on the billing workflow. `lineMinor` may include cents: the fee item
   * is whole shillings (rounded up) and the invoice line snapshots the exact amount.
   */
  async function freshInvoice(lineMinor = 1_000_000): Promise<string> {
    seq++;
    const tag = `${seq}${randomUUID().slice(0, 5)}`;
    const learner = await created("/learners", { admission_no: `FN${tag}`, full_name: `Fin ${tag}`, gender: "female" }, "learner");
    const y = (await owner<{ id: string }>(`INSERT INTO academic_years (tenant_id, label, starts_on, ends_on) VALUES ($1, $2, '2020-01-01', '2035-12-31') RETURNING id`, [A(), `Y${tag}`.slice(0, 32)]))[0]!.id;
    const t = (await owner<{ id: string }>(`INSERT INTO academic_terms (tenant_id, academic_year_id, index, label, starts_on, ends_on) VALUES ($1, $2, 1, $3, '2020-01-01', '2035-12-31') RETURNING id`, [A(), y, `T${tag}`.slice(0, 60)]))[0]!.id;
    const item = (await owner<{ id: string }>(`INSERT INTO finance_fee_items (tenant_id, term_id, name, amount_minor) VALUES ($1, $2, 'Seed', $3) RETURNING id`, [A(), t, Math.ceil(lineMinor / 100) * 100]))[0]!.id;
    const inv = (await owner<{ id: string }>(`INSERT INTO finance_invoices (tenant_id, learner_id, term_id, due_on) VALUES ($1, $2, $3, '2035-12-31') RETURNING id`, [A(), learner, t]))[0]!.id;
    await owner(`INSERT INTO finance_invoice_lines (tenant_id, invoice_id, fee_item_id, name, amount_minor) VALUES ($1, $2, $3, 'Seed', $4)`, [A(), inv, item, lineMinor]);
    return inv;
  }

  /** An M-Pesa prompt created through the module (the family route is fail-closed), with a provider checkout id. */
  async function startPrompt(invoiceId: string, amount: number, checkout = `ws_CO_${randomUUID().slice(0, 12)}`, msisdn = "254712345678") {
    const payment = await withSystemTenantTransaction(ctx.runtimePool, { tenantId: A(), userId: ids.adminA }, async (tx) => {
      const { payment: p } = await createPrompt(tx, { tenantId: A(), actorUserId: ids.adminA, invoice_id: invoiceId, amount_minor: amount, msisdn, settleDelaySeconds: 120 });
      return recordPushOutcome(tx, {
        tenantId: A(),
        paymentId: p.id,
        result: { accepted: true, checkoutRequestId: checkout, merchantRequestId: "MR_" + checkout },
        actorUserId: ids.adminA,
      });
    });
    return { payment, checkout };
  }

  const callbackBody = (checkout: string, code: number, extra: { amount?: number; receipt?: string } = {}) => ({
    Body: {
      stkCallback: {
        MerchantRequestID: "MR_" + checkout,
        CheckoutRequestID: checkout,
        ResultCode: code,
        ResultDesc: code === 0 ? "The service request is processed successfully." : "Request cancelled",
        ...(code === 0
          ? {
              CallbackMetadata: {
                Item: [
                  { Name: "Amount", Value: extra.amount ?? 1 },
                  { Name: "MpesaReceiptNumber", Value: extra.receipt ?? `RC${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}` },
                  { Name: "PhoneNumber", Value: 254712345678 },
                ],
              },
            }
          : {}),
      },
    },
  });
  /** `null` sends no token at all (a default parameter would silently substitute the real secret). */
  const sendCallback = (body: unknown, token: string | null = CALLBACK_SECRET) =>
    app.inject({ method: "POST", url: `/v1/mpesa/callback${token === null ? "" : `?token=${encodeURIComponent(token)}`}`, payload: body as Json });

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    fake = new FakeProvider();
    app = await buildApp(
      { ...ctx.config, mpesaCallbackSecret: CALLBACK_SECRET, mpesaCallbackUrl: "http://localhost/v1/mpesa/callback", mpesaSettleDelaySeconds: 120 },
      ctx.runtimePool,
      { mpesaProvider: fake },
    );
    await app.ready();
    admin = await login({ email: "admin-a@example.com", password: PASSWORD });
    teacher = await login({ tenantId: A(), loginId: "TC-0001", password: PASSWORD });
    parent = await login({ tenantId: A(), loginId: "PT-0001", password: PASSWORD });

    // the worker role is NOLOGIN until an operator enables it; the test enables it for this run only
    // (random password, short VALID UNTIL, reset before and after: see test/support/financeHarness.ts, F-14)
    workerPool = await enableWorkerLogin(ctx.pool, ctx.runtimeUrl);

    year = (await call("POST", `/v1/tenants/${A()}/academic-years`, admin, { label: "Fin 2026", starts_on: "2020-01-01", ends_on: "2035-12-31" })).json().academic_year.id;
    term = await created("/academic-terms", { academic_year_id: year, index: 1, label: "Fin T1", starts_on: "2020-01-01", ends_on: "2035-12-31" }, "term");
    expect((await call("POST", `/v1/tenants/${A()}/academic-terms/${term}/set-current`, admin, {})).statusCode).toBe(200);
    f1 = await created("/classes", { academic_year_id: year, name: "Fin F1", form_level: 1 }, "school_class");
    f2 = await created("/classes", { academic_year_id: year, name: "Fin F2", form_level: 2 }, "school_class");
    const learner = async (no: string, classId: string, boarding: boolean) => {
      const id = await created("/learners", { admission_no: no, full_name: `Fin ${no}`, gender: "male", boarding }, "learner");
      expect((await call("POST", `/v1/tenants/${A()}/class-memberships`, admin, { learner_id: id, class_id: classId })).statusCode).toBe(201);
      return id;
    };
    boarder = await learner("F9001", f1, true);
    dayF1 = await learner("F9002", f1, false);
    dayF2 = await learner("F9003", f2, false);
  }, 180_000);

  afterAll(async () => {
    await workerPool?.end().catch(() => undefined);
    await resetWorkerLogin(ctx.pool).catch(() => undefined);
    await app.close();
    await ctx.app.close();
    await ctx.pool.end();
  });

  // ============================================================ fee items and billing
  describe("fee items and term billing", () => {
    it("validates fee items: whole shillings, scope rules, no client totals", async () => {
      const base = { term_id: term, name: "Tuition", applies_to: "all" };
      expect((await post("/fee-items", { ...base, amount_minor: 5_000_050 })).statusCode).toBe(400);
      expect((await post("/fee-items", { ...base, amount_minor: 0 })).statusCode).toBe(400);
      expect((await post("/fee-items", { ...base, amount_minor: 5_000_000, form_level: 1 })).statusCode).toBe(400);
      expect((await post("/fee-items", { ...base, applies_to: "form_level", amount_minor: 100_000 })).statusCode).toBe(400);
      expect((await post("/fee-items", { ...base, amount_minor: 5_000_000, total_minor: 1 })).statusCode).toBe(400);
      expect((await post("/fee-items", { ...base, amount_minor: 5_000_000, currency: "USD" })).statusCode).toBe(400);
    });

    it("creates items, bills the term on the server, and bills each learner once", async () => {
      expect((await post("/billing-runs", { term_id: term, due_on: "2035-12-31" })).statusCode).toBe(400); // no items yet
      for (const body of [
        { term_id: term, name: "Tuition", amount_minor: 5_000_000, applies_to: "all" },
        { term_id: term, name: "Boarding", amount_minor: 2_000_000, applies_to: "boarders" },
        { term_id: term, name: "Form 1 levy", amount_minor: 300_000, applies_to: "form_level", form_level: 1 },
      ]) expect((await post("/fee-items", body)).statusCode).toBe(201);

      const run = await post("/billing-runs", { term_id: term, due_on: "2035-12-31" });
      expect(run.statusCode).toBe(201);
      expect(run.json().billing_run).toMatchObject({ created: 3, already_billed: 0, total_minor: 7_300_000 + 5_300_000 + 5_000_000 });

      const list = (await get(`/invoices?termId=${term}&limit=200`)).json().invoices as Json[];
      const byLearner = new Map(list.map((i) => [i.learner_id, i]));
      expect(byLearner.get(boarder)).toMatchObject({ total_minor: 7_300_000, paid_minor: 0, balance_minor: 7_300_000, status: "unpaid", currency: "KES" });
      expect(byLearner.get(dayF1)).toMatchObject({ total_minor: 5_300_000 });
      expect(byLearner.get(dayF2)).toMatchObject({ total_minor: 5_000_000 });
      invBoarder = byLearner.get(boarder)!.id;
      invDayF2 = byLearner.get(dayF2)!.id;

      const again = await post("/billing-runs", { term_id: term, due_on: "2035-12-31" });
      expect(again.json().billing_run).toMatchObject({ created: 0, already_billed: 3, total_minor: 0 });
      const detail = (await get(`/invoices/${invBoarder}`)).json();
      expect(detail.lines.map((l: Json) => [l.name, l.amount_minor]).sort()).toEqual([["Boarding", 2_000_000], ["Form 1 levy", 300_000], ["Tuition", 5_000_000]]);
    });

    it("a fee item change does not alter invoices already billed; archive is final", async () => {
      const items = (await get(`/fee-items?termId=${term}`)).json().fee_items as Json[];
      const tuition = items.find((i) => i.name === "Tuition")!;
      const patched = await call("PATCH", fin(`/fee-items/${tuition.id}`), admin, { amount_minor: 6_000_000 });
      expect(patched.statusCode).toBe(200);
      expect((await invoice(invDayF2)).total_minor).toBe(5_000_000);
      await post("/fee-items", { term_id: term, name: "Temp", amount_minor: 100_000, applies_to: "all" });
      const temp = ((await get(`/fee-items?termId=${term}`)).json().fee_items as Json[]).find((i) => i.name === "Temp")!;
      expect((await post(`/fee-items/${temp.id}/archive`, {})).json().fee_item.active).toBe(false);
      expect((await call("PATCH", fin(`/fee-items/${temp.id}`), admin, { name: "again" })).statusCode).toBe(400);
      await call("PATCH", fin(`/fee-items/${tuition.id}`), admin, { amount_minor: 5_000_000 });
    });

    it("concurrent billing runs never double-bill a learner", async () => {
      const t = await created("/academic-terms", { academic_year_id: year, index: 2, label: "Fin T2", starts_on: "2020-01-01", ends_on: "2035-12-31" }, "term");
      expect((await post("/fee-items", { term_id: t, name: "Tuition", amount_minor: 1_000_000, applies_to: "all" })).statusCode).toBe(201);
      const results = await Promise.all([1, 2, 3].map(() => post("/billing-runs", { term_id: t, due_on: "2035-12-31" })));
      for (const r of results) expect(r.statusCode).toBe(201);
      const total = results.reduce((n, r) => n + (r.json().billing_run.created as number), 0);
      const live = await owner<{ n: number }>(`SELECT count(*)::int AS n FROM finance_invoices WHERE tenant_id = $1 AND term_id = $2`, [A(), t]);
      expect(live[0]!.n).toBe(total);
      const dup = await owner(`SELECT learner_id FROM finance_invoices WHERE tenant_id = $1 AND term_id = $2 GROUP BY learner_id HAVING count(*) > 1`, [A(), t]);
      expect(dup).toHaveLength(0);
    });
  });

  // ============================================================ payments
  describe("payments and invoice balances", () => {
    it("derives status from payments: part paid, then paid; overpayment and fractions are refused", async () => {
      const inv = await freshInvoice(1_000_000);
      expect((await post("/payments", { invoice_id: inv, amount_minor: 400_000, method: "cash" })).statusCode).toBe(201);
      expect(await invoice(inv)).toMatchObject({ paid_minor: 400_000, balance_minor: 600_000, status: "part_paid", overpaid_minor: 0 });
      expect((await post("/payments", { invoice_id: inv, amount_minor: 600_100, method: "cash" })).statusCode).toBe(400); // more than balance
      expect((await post("/payments", { invoice_id: inv, amount_minor: 150_050, method: "cash" })).statusCode).toBe(400); // fraction
      expect((await post("/payments", { invoice_id: inv, amount_minor: 100_000, method: "bank" })).statusCode).toBe(400); // reference needed
      expect((await post("/payments", { invoice_id: inv, amount_minor: 600_000, method: "bank", reference: "BANK1" })).statusCode).toBe(201);
      expect(await invoice(inv)).toMatchObject({ paid_minor: 1_000_000, balance_minor: 0, status: "paid" });
      expect((await post("/payments", { invoice_id: inv, amount_minor: 100, method: "cash" })).statusCode).toBe(400); // nothing owed
    });

    it("accepts a fractional amount only when it is exactly the remaining balance", async () => {
      const inv = await freshInvoice(1_000_050); // a legacy invoice whose total has cents
      expect((await post("/payments", { invoice_id: inv, amount_minor: 1_000_000, method: "cash" })).statusCode).toBe(201);
      expect((await invoice(inv)).balance_minor).toBe(50);
      expect((await post("/payments", { invoice_id: inv, amount_minor: 25, method: "cash" })).statusCode).toBe(400);
      expect((await post("/payments", { invoice_id: inv, amount_minor: 50, method: "cash" })).statusCode).toBe(201);
      expect((await invoice(inv)).status).toBe("paid");
    });

    it("rejects repeated references: an M-Pesa receipt once system-wide, a bank reference once per invoice", async () => {
      const a = await freshInvoice();
      const b = await freshInvoice();
      expect((await post("/payments", { invoice_id: a, amount_minor: 100_000, method: "mpesa", reference: "qa12 bc34de" })).statusCode).toBe(201);
      expect((await get(`/payments?invoiceId=${a}`)).json().payments[0].mpesa_receipt).toBe("QA12BC34DE");
      expect((await post("/payments", { invoice_id: b, amount_minor: 100_000, method: "mpesa", reference: "QA12BC34DE" })).statusCode).toBe(409);
      expect((await post("/payments", { invoice_id: a, amount_minor: 100_000, method: "bank", reference: "Dep 77" })).statusCode).toBe(201);
      expect((await post("/payments", { invoice_id: a, amount_minor: 100_000, method: "bank", reference: "dep77" })).statusCode).toBe(409);
      expect((await post("/payments", { invoice_id: b, amount_minor: 100_000, method: "bank", reference: "DEP77" })).statusCode).toBe(201); // one deposit may split
    });

    it("concurrent payments of the full balance: exactly one succeeds; paid never exceeds the total", async () => {
      const inv = await freshInvoice(1_000_000);
      const rs = await Promise.all([1, 2, 3, 4].map((n) => post("/payments", { invoice_id: inv, amount_minor: 1_000_000, method: "bank", reference: `RACE${n}` })));
      expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 400, 400, 400]);
      const after = await invoice(inv);
      expect(after.paid_minor).toBe(1_000_000);
      expect(after.paid_minor).toBeLessThanOrEqual(after.total_minor);
    });

    it("idempotency: same key and body replays the original; same key with another body is refused", async () => {
      const inv = await freshInvoice();
      const key = { "idempotency-key": "pay-idem-0001" };
      const body = { invoice_id: inv, amount_minor: 200_000, method: "cash" };
      const first = await post("/payments", body, admin, key);
      expect(first.statusCode).toBe(201);
      const again = await post("/payments", body, admin, key);
      expect(again.statusCode).toBe(201);
      expect(again.headers["idempotent-replayed"]).toBe("true");
      expect(again.json().payment.id).toBe(first.json().payment.id);
      expect((await post("/payments", { ...body, amount_minor: 300_000 }, admin, key)).statusCode).toBe(422);
      expect((await invoice(inv)).paid_minor).toBe(200_000);
    });

    it("the database refuses direct tampering with money (figbloom_app)", async () => {
      const inv = await freshInvoice();
      await post("/payments", { invoice_id: inv, amount_minor: 100_000, method: "cash" });
      const pay = (await owner<{ id: string }>(`SELECT id FROM finance_payments WHERE invoice_id = $1`, [inv]))[0]!.id;
      await asApp(A(), async (c) => expect(await sqlState(c.query(`UPDATE finance_invoices SET paid_minor = 1000000 WHERE id = $1`, [inv]))).toBe("42501"));
      await asApp(A(), async (c) => expect(await sqlState(c.query(`UPDATE finance_invoices SET total_minor = 1 WHERE id = $1`, [inv]))).toBe("42501"));
      await asApp(A(), async (c) => expect(await sqlState(c.query(`UPDATE finance_payments SET amount_minor = 1 WHERE id = $1`, [pay]))).toBe("42501"));
      await asApp(A(), async (c) => expect(await sqlState(c.query(`DELETE FROM finance_payments WHERE id = $1`, [pay]))).toBe("42501"));
      await asApp(A(), async (c) => expect(await sqlState(c.query(`UPDATE finance_payments SET status = 'failed', failure_reason = 'cancelled' WHERE id = $1`, [pay]))).toBe("23514"));
      await asApp(A(), async (c) =>
        expect(await sqlState(c.query(`INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status, reference) VALUES ($1, $2, 99999900, 'bank', 'success', 'X1')`, [A(), inv]))).toBe("23514"),
      );
      expect(await owner(`SELECT 1 FROM finance_invoice_lines WHERE invoice_id = $1`, [inv])).toHaveLength(1);
      await asApp(A(), async (c) => expect(await sqlState(c.query(`INSERT INTO finance_invoice_lines (tenant_id, invoice_id, fee_item_id, name, amount_minor) SELECT $1, $2, fee_item_id, 'x', 100 FROM finance_invoice_lines WHERE invoice_id = $2`, [A(), inv]))).not.toBeNull());
    });

    it("an invoice's money columns are always recomputed from the source rows", async () => {
      const inv = await freshInvoice(1_000_000);
      const rows = await owner<{ total_minor: string; paid_minor: string }>(
        `UPDATE finance_invoices SET total_minor = 5, paid_minor = 5, lines_minor = 5 WHERE id = $1 RETURNING total_minor, paid_minor`,
        [inv],
      );
      expect(Number(rows[0]!.total_minor)).toBe(1_000_000);
      expect(Number(rows[0]!.paid_minor)).toBe(0);
    });

    it("TS and SQL invoice status agree on a grid of cases", async () => {
      const dues = ["2020-01-01", "2026-06-15", "2099-01-01"];
      for (const total of [0, 100, 1000]) for (const paid of [0, 50, 100, 1000, 2000]) for (const due of dues) {
        const sql = (await owner<{ s: string }>(`SELECT finance_invoice_status($1::bigint, $2::bigint, $3::date, DATE '2026-06-15') AS s`, [total, paid, due]))[0]!.s;
        expect(sql, `${total}/${paid}/${due}`).toBe(invoiceStatus(total, paid, due, "2026-06-15"));
      }
    });
  });

  // ============================================================ charges, adjustments, void and permissions
  describe("charges, adjustments, voids and the permission boundary", () => {
    let inv: string;
    beforeAll(async () => {
      inv = await freshInvoice(1_000_000);
      await owner(`UPDATE academic_terms SET is_current = false WHERE tenant_id = $1`, [A()]);
      await owner(`UPDATE academic_terms SET is_current = true WHERE id = (SELECT term_id FROM finance_invoices WHERE id = $1)`, [inv]);
    });

    it("a fees-area holder reads and writes but cannot administer; a teacher has no finance access", async () => {
      await owner(`INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'fees') ON CONFLICT DO NOTHING`, [A(), ids.teacherA]);
      const paid = await freshInvoice();
      expect((await get("/invoices?limit=5", teacher)).statusCode).toBe(200);
      expect((await post("/payments", { invoice_id: paid, amount_minor: 100_000, method: "cash" }, teacher)).statusCode).toBe(201);
      expect((await post(`/invoices/${inv}/charges`, { amount_minor: 100_000, reason: "Lost book" }, teacher)).statusCode).toBe(403);
      expect((await post(`/invoices/${inv}/adjustments`, { expected_total_minor: 1_000_000, new_total_minor: 900_000, reason: "Waiver" }, teacher)).statusCode).toBe(403);
      expect((await post(`/invoices/${inv}/void`, { reason: "mistake" }, teacher)).statusCode).toBe(403);
      expect((await call("PUT", fin("/ai-helper/settings"), teacher, { access_mode: "all", price_minor: 0, cancel_days: 7 })).statusCode).toBe(403);
      await owner(`DELETE FROM staff_area_grants WHERE user_id = $1 AND area = 'fees'`, [ids.teacherA]);
      expect((await get("/invoices", teacher)).statusCode).toBe(403);
      expect((await post("/payments", { invoice_id: paid, amount_minor: 100, method: "cash" }, teacher)).statusCode).toBe(403);
      expect((await get("/invoices", parent)).statusCode).toBe(403);
    });

    it("adds and voids a charge on the current-term invoice; the total follows", async () => {
      const add = await post(`/invoices/${inv}/charges`, { amount_minor: 200_000, reason: "Lost book" });
      expect(add.statusCode).toBe(200);
      expect(add.json().invoice).toMatchObject({ charges_minor: 200_000, total_minor: 1_200_000 });
      expect((await post(`/invoices/${inv}/charges`, { amount_minor: 150, reason: "x" })).statusCode).toBe(400);
      const detail = (await get(`/invoices/${inv}`)).json();
      const chargeId = detail.charges[0].id as string;
      const voided = await post(`/invoices/${inv}/charges/${chargeId}/void`, { reason: "Book found" });
      expect(voided.json().invoice).toMatchObject({ charges_minor: 0, total_minor: 1_000_000 });
      expect((await post(`/invoices/${inv}/charges/${chargeId}/void`, { reason: "again" })).statusCode).toBe(409);
      expect(((await get(`/invoices/${inv}`)).json().charges as Json[])).toHaveLength(1); // kept, not deleted
    });

    it("a charge on a past-term invoice is refused; a paid charge cannot be voided", async () => {
      const other = await freshInvoice(500_000);
      expect((await post(`/invoices/${other}/charges`, { amount_minor: 100_000, reason: "Late" })).statusCode).toBe(409);
      const add = await post(`/invoices/${inv}/charges`, { amount_minor: 300_000, reason: "Damaged desk" });
      expect(add.statusCode).toBe(200);
      const chargeId = ((await get(`/invoices/${inv}`)).json().charges as Json[]).find((c) => !c.voided_at)!.id;
      expect((await post("/payments", { invoice_id: inv, amount_minor: 1_300_000, method: "bank", reference: "CHG-PAID" })).statusCode).toBe(201);
      expect((await post(`/invoices/${inv}/charges/${chargeId}/void`, { reason: "refund?" })).statusCode).toBe(409);
    });

    it("adjusts a total with an audited, append-only record; guards stale, low and no-op totals", async () => {
      const a = await freshInvoice(1_000_000);
      expect((await post(`/invoices/${a}/adjustments`, { expected_total_minor: 999, new_total_minor: 900_000, reason: "Bursary" })).statusCode).toBe(409);
      expect((await post(`/invoices/${a}/adjustments`, { expected_total_minor: 1_000_000, new_total_minor: 1_000_000, reason: "same" })).statusCode).toBe(400);
      expect((await post(`/invoices/${a}/adjustments`, { expected_total_minor: 1_000_000, new_total_minor: 900_050, reason: "cents" })).statusCode).toBe(400);
      expect((await post("/payments", { invoice_id: a, amount_minor: 400_000, method: "cash" })).statusCode).toBe(201);
      expect((await post(`/invoices/${a}/adjustments`, { expected_total_minor: 1_000_000, new_total_minor: 300_000, reason: "below paid" })).statusCode).toBe(400);
      const ok = await post(`/invoices/${a}/adjustments`, { expected_total_minor: 1_000_000, new_total_minor: 800_000, reason: "Bursary" });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().invoice).toMatchObject({ adjustments_minor: -200_000, total_minor: 800_000, balance_minor: 400_000 });
      const adj = (await get(`/invoices/${a}`)).json().adjustments as Json[];
      expect(adj).toEqual([expect.objectContaining({ from_total_minor: 1_000_000, to_total_minor: 800_000, delta_minor: -200_000, reason: "Bursary" })]);
      await asApp(A(), async (c) => expect(await sqlState(c.query(`UPDATE finance_invoice_adjustments SET reason = 'edited'`))).toBe("42501"));
      // two adjustments racing from the same total: one wins
      const b = await freshInvoice(1_000_000);
      const rs = await Promise.all([900_000, 800_000].map((n) => post(`/invoices/${b}/adjustments`, { expected_total_minor: 1_000_000, new_total_minor: n, reason: "race" })));
      expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    });

    it("voids an unused invoice (kept, final) but not one with payments", async () => {
      const unused = await freshInvoice();
      const v = await post(`/invoices/${unused}/void`, { reason: "Billed in error" });
      expect(v.statusCode).toBe(200);
      expect(v.json().invoice.status).toBe("voided");
      expect((await post(`/invoices/${unused}/void`, { reason: "twice" })).statusCode).toBe(409);
      expect((await post("/payments", { invoice_id: unused, amount_minor: 100_000, method: "cash" })).statusCode).toBe(409);
      expect((await post(`/invoices/${unused}/charges`, { amount_minor: 100_000, reason: "x" })).statusCode).toBe(409);
      const used = await freshInvoice();
      await post("/payments", { invoice_id: used, amount_minor: 100_000, method: "cash" });
      expect((await post(`/invoices/${used}/void`, { reason: "nope" })).statusCode).toBe(409);
    });

    it("idempotent mutation replays the original response", async () => {
      const a = await freshInvoice();
      await owner(`UPDATE academic_terms SET is_current = false WHERE tenant_id = $1`, [A()]);
      await owner(`UPDATE academic_terms SET is_current = true WHERE id = (SELECT term_id FROM finance_invoices WHERE id = $1)`, [a]);
      const key = { "idempotency-key": "charge-idem-0001" };
      const first = await post(`/invoices/${a}/charges`, { amount_minor: 100_000, reason: "Idem" }, admin, key);
      const second = await post(`/invoices/${a}/charges`, { amount_minor: 100_000, reason: "Idem" }, admin, key);
      expect(second.headers["idempotent-replayed"]).toBe("true");
      expect(second.json().invoice.id).toBe(first.json().invoice.id);
      expect((await invoice(a)).charges_minor).toBe(100_000);
    });
  });

  // ============================================================ tenant isolation
  describe("tenant isolation", () => {
    it("another school's finance rows are invisible to the runtime roles and unreachable through the API", async () => {
      const tables = ["finance_fee_items", "finance_invoices", "finance_invoice_lines", "finance_charges", "finance_invoice_adjustments",
        "finance_payments", "finance_mpesa_events", "finance_payment_proofs", "finance_reconciliation_runs", "finance_reconciliation_findings",
        "finance_ai_helper_settings", "jobs"];
      for (const t of tables) {
        await asApp(ids.tenantB, async (c) => expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0));
        await asApp(null, async (c) => expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, `${t} (no context)`).toBe(0));
        if (WORKER_TABLES.includes(t)) {
          await asApp(ids.tenantB, async (c) => expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, `${t} (worker)`).toBe(0), workerPool);
        }
      }
      const cross = await app.inject({ method: "GET", url: `/v1/tenants/${ids.tenantB}/finance/invoices`, headers: hdr(admin) });
      expect(cross.statusCode).toBe(403);
      const forged = await app.inject({ method: "GET", url: fin("/invoices"), headers: { authorization: `Bearer ${admin}`, "x-tenant-id": ids.tenantB } });
      expect(forged.statusCode).toBe(403);
    });

    it("a payment cannot be written against another school's invoice, even with a forged tenant_id", async () => {
      const inv = await freshInvoice();
      // refused (the guard cannot see the invoice under school B's context, or RLS WITH CHECK refuses the row)
      await asApp(ids.tenantB, async (c) =>
        expect(await sqlState(c.query(`INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status) VALUES ($1, $2, 100, 'cash', 'success')`, [A(), inv]))).not.toBeNull(),
      );
      expect(await owner(`SELECT 1 FROM finance_payments WHERE invoice_id = $1`, [inv])).toHaveLength(0);
      await asApp(ids.tenantB, async (c) =>
        expect(await sqlState(c.query(`INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status) VALUES ($1, $2, 100, 'cash', 'success')`, [ids.tenantB, inv]))).not.toBeNull(),
      );
      expect((await post("/payments", { invoice_id: randomUUID(), amount_minor: 100_000, method: "cash" })).statusCode).toBe(404);
    });
  });

  // ============================================================ M-Pesa
  describe("M-Pesa prompt, callback and settlement", () => {
    it("the family prompt route is fail-closed: no account-to-guardian link exists yet", async () => {
      const inv = await freshInvoice();
      const real = await post("/mpesa/prompts", { invoice_id: inv, amount_minor: 100_000, msisdn: "254712345678" }, parent);
      const fakeId = await post("/mpesa/prompts", { invoice_id: randomUUID(), amount_minor: 100_000, msisdn: "254712345678" }, parent);
      const asAdmin = await post("/mpesa/prompts", { invoice_id: inv, amount_minor: 100_000, msisdn: "254712345678" }, admin);
      expect([real.statusCode, fakeId.statusCode, asAdmin.statusCode]).toEqual([403, 403, 403]);
      expect(real.json().error.message).toBe(fakeId.json().error.message); // invoice existence is not revealed
      expect(fake.pushes).toHaveLength(0);
      expect((await call("PUT", fin("/ai-helper/optins"), parent, { learner_id: boarder, term_id: term, opted_in: true })).statusCode).toBe(403);
    });

    it("prompt rules: whole shillings, balance ceiling, one pending prompt, reuse within the window", async () => {
      const inv = await freshInvoice(1_000_000);
      const mk = (amount: number, msisdn = "254712345678") =>
        withSystemTenantTransaction(ctx.runtimePool, { tenantId: A() }, (tx) => createPrompt(tx, { tenantId: A(), actorUserId: ids.adminA, invoice_id: inv, amount_minor: amount, msisdn, settleDelaySeconds: 120 }));
      await expect(mk(50)).rejects.toMatchObject({ statusCode: 400 });
      await expect(mk(1_000_100)).rejects.toMatchObject({ statusCode: 400 });
      await expect(mk(100_000, "0712345678")).rejects.toMatchObject({ statusCode: 400 });
      const first = await mk(500_000);
      expect(first.reused).toBe(false);
      const same = await mk(500_000);
      expect(same).toMatchObject({ reused: true });
      expect(same.payment.id).toBe(first.payment.id);
      await expect(mk(500_000, "254722222222")).rejects.toMatchObject({ statusCode: 409 });
      const jobs = await owner(`SELECT idempotency_key, status, run_after > now() AS later FROM jobs WHERE tenant_id = $1 AND idempotency_key = $2`, [A(), `settle:${first.payment.id}`]);
      expect(jobs).toEqual([{ idempotency_key: `settle:${first.payment.id}`, status: "queued", later: true }]);
    });

    it("callback authentication: missing or wrong token is refused before anything is read", async () => {
      const body = callbackBody("ws_CO_ANY", 0);
      expect((await sendCallback(body, null)).statusCode).toBe(403);
      expect((await sendCallback(body, "")).statusCode).toBe(403);
      expect((await sendCallback(body, "wrong-token")).statusCode).toBe(403);
      expect((await sendCallback(body, CALLBACK_SECRET + "x")).statusCode).toBe(403);
      expect((await sendCallback({ Body: {} })).statusCode).toBe(400);
    });

    it("an unknown CheckoutRequestID is quarantined, answered 200, and moves no money", async () => {
      const before = await owner<{ n: number }>(`SELECT count(*)::int AS n FROM finance_payments WHERE status = 'success'`);
      const res = await sendCallback(callbackBody("ws_CO_UNKNOWN_" + randomUUID().slice(0, 6), 0, { receipt: "UNKNOWN123" }));
      expect(res.statusCode).toBe(200);
      const q = await owner<{ receipt: string; msisdn_masked: string }>(`SELECT receipt, msisdn_masked FROM finance_mpesa_unmatched_callbacks`);
      expect(q.some((r) => r.receipt === "UNKNOWN123" && r.msisdn_masked === "254*****5678")).toBe(true);
      expect((await owner<{ n: number }>(`SELECT count(*)::int AS n FROM finance_payments WHERE status = 'success'`))[0]!.n).toBe(before[0]!.n);
    });

    it("settles from the provider's confirmed answer, credits the PROMPT amount, and replays are no-ops", async () => {
      const inv = await freshInvoice(1_000_000);
      const { payment, checkout } = await startPrompt(inv, 400_000);
      fake.queries.set(checkout, { done: true, resultCode: 0 });
      const body = callbackBody(checkout, 0, { amount: 1, receipt: "SETTLE0001" }); // callback claims KES 1
      const res = await sendCallback(body);
      expect(res.statusCode).toBe(200);
      const pay = (await get(`/payments/${payment.id}`)).json().payment;
      expect(pay).toMatchObject({ status: "success", amount_minor: 400_000, mpesa_receipt: "SETTLE0001" });
      expect(await invoice(inv)).toMatchObject({ paid_minor: 400_000, balance_minor: 600_000, status: "part_paid" });
      const ev = await owner<{ outcome: string; callback_amount_minor: string; msisdn_masked: string }>(`SELECT outcome, callback_amount_minor, msisdn_masked FROM finance_mpesa_events WHERE payment_id = $1 ORDER BY received_at, id`, [payment.id]);
      // the authenticated callback is persisted BEFORE the provider is queried (batch 5), then the settlement is recorded
      expect(ev).toEqual([
        { outcome: "callback_received", callback_amount_minor: "100", msisdn_masked: "254*****5678" },
        { outcome: "settled_success", callback_amount_minor: "100", msisdn_masked: "254*****5678" },
      ]);

      for (let i = 0; i < 3; i++) expect((await sendCallback(body)).statusCode).toBe(200);
      expect((await invoice(inv)).paid_minor).toBe(400_000);
      const events = await owner<{ outcome: string }>(`SELECT outcome FROM finance_mpesa_events WHERE payment_id = $1 ORDER BY received_at`, [payment.id]);
      expect(events.map((e) => e.outcome)).toEqual(["callback_received", "settled_success", "already_settled", "already_settled", "already_settled"]);
    });

    it("simultaneous duplicate callbacks credit once", async () => {
      const inv = await freshInvoice(1_000_000);
      const { checkout } = await startPrompt(inv, 300_000);
      fake.queries.set(checkout, { done: true, resultCode: 0 });
      const body = callbackBody(checkout, 0, { receipt: "RACECB0001" });
      const rs = await Promise.all([1, 2, 3, 4, 5].map(() => sendCallback(body)));
      expect(rs.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
      expect((await invoice(inv)).paid_minor).toBe(300_000);
      expect(await owner(`SELECT 1 FROM finance_payments WHERE mpesa_receipt = 'RACECB0001'`)).toHaveLength(1);
    });

    it("a callback that claims success is not believed when the provider says otherwise", async () => {
      const inv = await freshInvoice(1_000_000);
      const { payment, checkout } = await startPrompt(inv, 200_000);
      fake.queries.set(checkout, { done: true, resultCode: 1032 });
      expect((await sendCallback(callbackBody(checkout, 0, { receipt: "LIAR000001" }))).statusCode).toBe(200);
      const pay = (await get(`/payments/${payment.id}`)).json().payment;
      expect(pay).toMatchObject({ status: "cancelled", failure_reason: "cancelled", mpesa_receipt: null });
      expect((await invoice(inv)).paid_minor).toBe(0);
    });

    it("maps failure result codes and keeps the prompt pending when the provider is unavailable", async () => {
      const cases: Array<[number, string, string]> = [[1, "failed", "insufficient"], [1037, "timeout", "timeout"], [2001, "failed", "wrong_pin"], [1001, "failed", "duplicate"], [1032, "cancelled", "cancelled"]];
      // an UNKNOWN code (e.g. 9999) no longer fails the prompt (remediation batch 2): see stage11.batch2.uncertainPrompt.test.ts
      for (const [code, status, reason] of cases) {
        const inv = await freshInvoice();
        const { payment, checkout } = await startPrompt(inv, 100_000);
        fake.queries.set(checkout, { done: true, resultCode: code });
        expect((await sendCallback(callbackBody(checkout, code))).statusCode).toBe(200);
        expect((await get(`/payments/${payment.id}`)).json().payment).toMatchObject({ status, failure_reason: reason });
      }
      const inv = await freshInvoice();
      const { payment, checkout } = await startPrompt(inv, 100_000);
      fake.queries.set(checkout, "throw");
      expect((await sendCallback(callbackBody(checkout, 0))).statusCode).toBe(503);
      fake.queries.set(checkout, { done: false });
      expect((await sendCallback(callbackBody(checkout, 0))).statusCode).toBe(503);
      expect((await get(`/payments/${payment.id}`)).json().payment.status).toBe("pending");
    });

    it("a receipt already recorded is never credited twice; the provider-confirmed prompt stays pending", async () => {
      const a = await freshInvoice();
      expect((await post("/payments", { invoice_id: a, amount_minor: 100_000, method: "mpesa", reference: "DUPRECEIPT" })).statusCode).toBe(201);
      const b = await freshInvoice();
      const { payment, checkout } = await startPrompt(b, 100_000);
      fake.queries.set(checkout, { done: true, resultCode: 0 });
      // Keep pending (503) so Daraja may redeliver with a different receipt; never fail a confirmed payment.
      expect((await sendCallback(callbackBody(checkout, 0, { receipt: "DUPRECEIPT" }))).statusCode).toBe(503);
      expect((await get(`/payments/${payment.id}`)).json().payment).toMatchObject({ status: "pending", mpesa_receipt: null });
      expect((await invoice(b)).paid_minor).toBe(0);
    });

    it("an STK settlement without a receipt cannot credit; the same receipt cannot double-pay later", async () => {
      const inv = await freshInvoice(1_000_000);
      const { payment, checkout } = await startPrompt(inv, 250_000);
      fake.queries.set(checkout, { done: true, resultCode: 0 });
      // Callback body claims success but omits receipt: provider query alone must not credit.
      const bare = callbackBody(checkout, 0);
      delete (bare as { Body: { stkCallback: { CallbackMetadata?: unknown } } }).Body.stkCallback.CallbackMetadata;
      expect((await sendCallback(bare)).statusCode).toBe(503);
      expect((await get(`/payments/${payment.id}`)).json().payment.status).toBe("pending");
      expect((await invoice(inv)).paid_minor).toBe(0);
      expect((await sendCallback(callbackBody(checkout, 0, { receipt: "NEEDRCPT01" }))).statusCode).toBe(200);
      expect((await get(`/payments/${payment.id}`)).json().payment).toMatchObject({ status: "success", mpesa_receipt: "NEEDRCPT01" });
      expect((await invoice(inv)).paid_minor).toBe(250_000);
      // Direct SQL: STK success with null receipt is refused by the database guard.
      await asApp(A(), async (c) => {
        expect(
          await sqlState(
            c.query(
              `INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status, msisdn, checkout_request_id)
               VALUES ($1, $2, 100000, 'mpesa', 'pending', '254700000001', 'ws_CO_NULLRCPT')`,
              [A(), inv],
            ),
          ),
        ).toBeNull();
        expect(
          await sqlState(
            c.query(`UPDATE finance_payments SET status = 'success', mpesa_receipt = NULL WHERE checkout_request_id = 'ws_CO_NULLRCPT'`),
          ),
        ).toBe("23514");
      });
    });

    it("a callback cannot move money across invoices or schools: the prompt alone decides", async () => {
      const a = await freshInvoice(1_000_000);
      const b = await freshInvoice(1_000_000);
      const { checkout } = await startPrompt(a, 100_000);
      fake.queries.set(checkout, { done: true, resultCode: 0 });
      const body = callbackBody(checkout, 0, { receipt: "ONLYA00001" }) as Json;
      body.Body.stkCallback.AccountReference = `FIG-${b.slice(0, 8)}`;
      body.Body.stkCallback.InvoiceId = b;
      expect((await sendCallback(body)).statusCode).toBe(200);
      expect((await invoice(a)).paid_minor).toBe(100_000);
      expect((await invoice(b)).paid_minor).toBe(0);
    });

    it("the provider push outcome is recorded outside the prompt transaction; a refused push fails the prompt", async () => {
      const inv = await freshInvoice();
      const failed = await withSystemTenantTransaction(ctx.runtimePool, { tenantId: A() }, async (tx) => {
        const { payment } = await createPrompt(tx, { tenantId: A(), actorUserId: ids.adminA, invoice_id: inv, amount_minor: 100_000, msisdn: "254712345678", settleDelaySeconds: 120 });
        return recordPushOutcome(tx, { tenantId: A(), paymentId: payment.id, result: { accepted: false, responseCode: "1" }, actorUserId: ids.adminA });
      });
      expect(failed).toMatchObject({ status: "failed", failure_reason: "unreachable" });
      const retry = await withSystemTenantTransaction(ctx.runtimePool, { tenantId: A() }, (tx) =>
        createPrompt(tx, { tenantId: A(), actorUserId: ids.adminA, invoice_id: inv, amount_minor: 100_000, msisdn: "254712345678", settleDelaySeconds: 120 }),
      );
      expect(retry.reused).toBe(false);
    });

    it("overpayment from a prompt that settles after a manual payment is recorded, not rejected, and reconciled", async () => {
      const inv = await freshInvoice(1_000_000);
      const { checkout } = await startPrompt(inv, 1_000_000);
      expect((await post("/payments", { invoice_id: inv, amount_minor: 1_000_000, method: "cash" })).statusCode).toBe(201);
      fake.queries.set(checkout, { done: true, resultCode: 0 });
      expect((await sendCallback(callbackBody(checkout, 0, { amount: 3, receipt: "OVERPAY001" }))).statusCode).toBe(200);
      // overpayment policy (remediation batch 3): the invoice is credited only up to its total; the confirmed excess is
      // held unapplied on the prompt's payment, raised by reconciliation and audited
      expect(await invoice(inv)).toMatchObject({ paid_minor: 1_000_000, balance_minor: 0, overpaid_minor: 0, status: "paid" });
      const run = await post("/reconciliation-runs", { stale_after_minutes: 30 });
      expect(run.statusCode).toBe(201);
      const kinds = (run.json().findings as Json[]).filter((f) => f.detail.invoice_id === inv).map((f) => f.kind);
      expect(kinds).toContain("unapplied_payment");
      expect(kinds).not.toContain("overpaid_invoice");
      expect((await owner(`SELECT 1 FROM security_audit_events WHERE event_type = 'finance.payment.unapplied' AND detail->>'invoiceId' = $1`, [inv])).length).toBe(1);
    });
  });

  // ============================================================ worker, jobs, outbox
  describe("worker and outbox", () => {
    const handlers = () => workerHandlers(fake);
    const cycle = async () => {
      const out: string[] = [];
      for (let i = 0; i < 10; i++) {
        const r = await runCycle(workerPool, { workerName: "test-worker", leaseSeconds: 30, handlers: handlers() });
        if (r === "idle") break;
        out.push(r);
      }
      return out;
    };
    const makeDue = (paymentId: string) => owner(`UPDATE jobs SET run_after = now() - interval '1 second' WHERE idempotency_key = $1`, [`settle:${paymentId}`]);

    beforeAll(async () => {
      // drain jobs left by earlier tests so each case below sees only its own
      await owner(`UPDATE jobs SET run_after = now() + interval '1 day' WHERE status = 'queued'`);
    });

    it("the worker role is least-privilege and passes the same startup assertion as the API", async () => {
      const c = await workerPool.connect();
      try {
        await assertRuntimeRole(c, { expectedRole: "figbloom_worker" });
      } finally {
        c.release();
      }
      const flags = await owner<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(`SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'figbloom_worker'`);
      expect(flags[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
      expect((await owner(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = 'figbloom_worker'`))).toHaveLength(0);
      for (const sql of [`SELECT 1 FROM users LIMIT 1`, `SELECT 1 FROM sessions LIMIT 1`, `INSERT INTO jobs (tenant_id, job_type, idempotency_key) VALUES ('${A()}', 'mpesa.stk_settle', 'x')`, `DELETE FROM jobs`, `SET ROLE figbloom_app`]) {
        await asApp(A(), async (c2) => expect(await sqlState(c2.query(sql)), sql).not.toBeNull(), workerPool);
      }
    });

    it("tenant context never survives commit, rollback or error on a reused connection (pool of one)", async () => {
      for (const mode of ["commit", "rollback", "error"] as const) {
        const c = await workerPool.connect();
        try {
          await c.query("BEGIN");
          await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [A()]);
          expect(Number((await c.query(`SELECT count(*)::int AS n FROM finance_invoices`)).rows[0].n)).toBeGreaterThan(0);
          if (mode === "commit") await c.query("COMMIT");
          else if (mode === "rollback") await c.query("ROLLBACK");
          else {
            await c.query("SELECT 1/0").catch(() => undefined);
            await c.query("ROLLBACK");
          }
        } finally {
          c.release();
        }
        const c2 = await workerPool.connect();
        try {
          expect((await c2.query(`SELECT count(*)::int AS n FROM finance_invoices`)).rows[0].n, mode).toBe(0);
          expect((await c2.query(`SELECT current_setting('app.tenant_id', true) AS t`)).rows[0].t === null || (await c2.query(`SELECT current_setting('app.tenant_id', true) AS t`)).rows[0].t === "").toBe(true);
        } finally {
          c2.release();
        }
      }
    });

    it("a job payload may not name a tenant; identity columns are immutable", async () => {
      expect(await sqlState(ctx.pool.query(`INSERT INTO jobs (tenant_id, job_type, payload, idempotency_key) VALUES ($1, 'mpesa.stk_settle', '{"tenant_id":"x"}', 'k1')`, [A()]))).toBe("23514");
      expect(await sqlState(ctx.pool.query(`INSERT INTO jobs (tenant_id, job_type, payload, idempotency_key) VALUES ($1, 'mpesa.stk_settle', '{"tenantId":"x"}', 'k2')`, [A()]))).toBe("23514");
      expect(await sqlState(ctx.pool.query(`INSERT INTO jobs (tenant_id, job_type, idempotency_key) VALUES ($1, 'unknown.type', 'k3')`, [A()]))).toBe("23514");
      const ins = await ctx.pool.query(`INSERT INTO jobs (tenant_id, job_type, idempotency_key, run_after) VALUES ($1, 'mpesa.stk_settle', 'immut', now() + interval '1 day') RETURNING id`, [A()]);
      expect(await sqlState(ctx.pool.query(`UPDATE jobs SET tenant_id = $1 WHERE id = $2`, [ids.tenantB, ins.rows[0].id]))).toBe("23514");
      expect(await sqlState(ctx.pool.query(`INSERT INTO jobs (tenant_id, job_type, idempotency_key) VALUES ($1, 'mpesa.stk_settle', 'immut')`, [A()]))).toBe("23505");
    });

    it("the settle job alone cannot credit without a receipt; a later callback with a receipt settles exactly once", async () => {
      const inv = await freshInvoice(1_000_000);
      const { payment, checkout } = await startPrompt(inv, 250_000);
      fake.queries.set(checkout, { done: true, resultCode: 0 });
      expect(await cycle()).toEqual([]); // not due yet: the delay is a real delay
      await makeDue(payment.id);
      // STK query confirms success but supplies no receipt → retry, leave pending (no double-credit window).
      expect(await cycle()).toEqual(["retry"]);
      expect((await get(`/payments/${payment.id}`)).json().payment.status).toBe("pending");
      expect((await invoice(inv)).paid_minor).toBe(0);
      expect((await sendCallback(callbackBody(checkout, 0, { receipt: "JOBRCPT001" }))).statusCode).toBe(200);
      expect(await invoice(inv)).toMatchObject({ paid_minor: 250_000, status: "part_paid" });
      expect((await get(`/payments/${payment.id}`)).json().payment).toMatchObject({ status: "success", mpesa_receipt: "JOBRCPT001" });
      await owner(`UPDATE jobs SET status = 'queued', finished_at = NULL, run_after = now() - interval '1 second', last_error_code = NULL WHERE idempotency_key = $1`, [`settle:${payment.id}`]);
      expect(await cycle()).toEqual(["succeeded"]); // already settled: handler no-op
      expect((await invoice(inv)).paid_minor).toBe(250_000);
    });

    it("a late job after a callback is a no-op; callback settles with the receipt", async () => {
      const inv = await freshInvoice(1_000_000);
      const { payment, checkout } = await startPrompt(inv, 100_000);
      fake.queries.set(checkout, { done: true, resultCode: 0 });
      expect((await sendCallback(callbackBody(checkout, 0, { receipt: "JOBAFTER01" }))).statusCode).toBe(200);
      await makeDue(payment.id);
      expect(await cycle()).toEqual(["succeeded"]);
      expect((await invoice(inv)).paid_minor).toBe(100_000);
      expect((await get(`/payments/${payment.id}`)).json().payment.mpesa_receipt).toBe("JOBAFTER01");
    });

    it("provider failure retries with backoff, is audited, and goes dead after max attempts; failures are observable", async () => {
      const inv = await freshInvoice();
      const { payment, checkout } = await startPrompt(inv, 100_000);
      fake.queries.set(checkout, "throw");
      await makeDue(payment.id);
      expect(await cycle()).toEqual(["retry"]);
      const j = (await owner<{ status: string; attempts: number; last_error_code: string; later: boolean }>(
        `SELECT status, attempts, last_error_code, run_after > now() AS later FROM jobs WHERE idempotency_key = $1`, [`settle:${payment.id}`]))[0]!;
      expect(j).toEqual({ status: "queued", attempts: 1, last_error_code: "provider_error", later: true });
      expect(await cycle()).toEqual([]); // backoff: not claimable yet
      expect((await owner(`SELECT 1 FROM security_audit_events WHERE event_type = 'job.retry_scheduled' AND detail->>'actingVia' = 'worker' AND tenant_id = $1`, [A()])).length).toBeGreaterThan(0);

      // exhaustion: a job with max_attempts 1 goes dead on its first failure, still bound to its tenant
      const inv2 = await freshInvoice();
      const second = await startPrompt(inv2, 100_000);
      fake.queries.set(second.checkout, "throw");
      await owner(`UPDATE jobs SET max_attempts = 1, run_after = now() - interval '1 second' WHERE idempotency_key = $1`, [`settle:${second.payment.id}`]);
      expect(await cycle()).toEqual(["dead"]);
      expect((await owner<{ status: string; tenant_id: string }>(`SELECT status, tenant_id FROM jobs WHERE idempotency_key = $1`, [`settle:${second.payment.id}`]))[0]).toEqual({ status: "dead", tenant_id: A() });
      expect((await owner(`SELECT 1 FROM security_audit_events WHERE event_type = 'job.dead' AND tenant_id = $1`, [A()])).length).toBe(1);
      expect((await get(`/payments/${second.payment.id}`)).json().payment.status).toBe("pending"); // nothing was credited
    });

    it("a prompt the provider never acknowledged stays pending, the settle job retries then dies, and recon flags it", async () => {
      const inv = await freshInvoice();
      const p = await withSystemTenantTransaction(ctx.runtimePool, { tenantId: A() }, (tx) =>
        createPrompt(tx, { tenantId: A(), actorUserId: ids.adminA, invoice_id: inv, amount_minor: 100_000, msisdn: "254733333333", settleDelaySeconds: 120 }),
      );
      await owner(`UPDATE jobs SET max_attempts = 1, run_after = now() - interval '1 second' WHERE idempotency_key = $1`, [`settle:${p.payment.id}`]);
      expect(await cycle()).toEqual(["dead"]); // awaiting_checkout_id → exhausted
      expect((await get(`/payments/${p.payment.id}`)).json().payment.status).toBe("pending");
      expect((await owner<{ checkout_request_id: string | null }>(`SELECT checkout_request_id FROM finance_payments WHERE id = $1`, [p.payment.id]))[0]!.checkout_request_id).toBeNull();
      expect((await owner<{ status: string; last_error_code: string }>(`SELECT status, last_error_code FROM jobs WHERE idempotency_key = $1`, [`settle:${p.payment.id}`]))[0]).toEqual({
        status: "dead",
        last_error_code: "awaiting_checkout_id",
      });
      await owner(`ALTER TABLE finance_payments DISABLE TRIGGER finance_payments_guard`);
      try {
        await owner(`UPDATE finance_payments SET created_at = now() - interval '3 hours' WHERE id = $1`, [p.payment.id]);
      } finally {
        await owner(`ALTER TABLE finance_payments ENABLE TRIGGER finance_payments_guard`);
      }
      const run = await post("/reconciliation-runs", { stale_after_minutes: 30 });
      expect((run.json().findings as Json[]).some((f) => f.kind === "prompt_never_sent" && f.subject_id === p.payment.id)).toBe(true);
    });

    it("an expired lease at max_attempts is marked dead and does not stay leased forever", async () => {
      const inv = await freshInvoice();
      const { payment } = await startPrompt(inv, 100_000);
      await owner(
        `UPDATE jobs SET status = 'leased', attempts = max_attempts, leased_by = 'dead-worker', lease_token = 'dead-worker', lease_started_at = now(),
                lease_expires_at = now() - interval '1 minute', run_after = now() - interval '1 hour', last_error_code = 'provider_error'
          WHERE idempotency_key = $1`,
        [`settle:${payment.id}`],
      );
      expect(await cycle()).toEqual([]); // claim marks it dead; nothing to run
      expect((await owner<{ status: string; last_error_code: string }>(`SELECT status, last_error_code FROM jobs WHERE idempotency_key = $1`, [`settle:${payment.id}`]))[0]).toEqual({
        status: "dead",
        last_error_code: "provider_error",
      });
      expect((await get(`/payments/${payment.id}`)).json().payment.status).toBe("pending");
    });

    it("a crashed attempt's expired lease is reclaimed; credit still needs a receipt from the callback", async () => {
      const inv = await freshInvoice(1_000_000);
      const { payment, checkout } = await startPrompt(inv, 100_000);
      fake.queries.set(checkout, { done: true, resultCode: 0 });
      await owner(`UPDATE jobs SET status = 'leased', attempts = 1, leased_by = 'dead-worker', lease_token = 'dead-worker', lease_started_at = now(), lease_expires_at = now() - interval '1 minute', run_after = now() - interval '1 hour' WHERE idempotency_key = $1`, [`settle:${payment.id}`]);
      expect(await cycle()).toEqual(["retry"]); // query success without receipt
      expect((await owner<{ attempts: number }>(`SELECT attempts FROM jobs WHERE idempotency_key = $1`, [`settle:${payment.id}`]))[0]!.attempts).toBe(2);
      expect((await invoice(inv)).paid_minor).toBe(0);
      expect((await sendCallback(callbackBody(checkout, 0, { receipt: "LEASE00001" }))).statusCode).toBe(200);
      expect((await invoice(inv)).paid_minor).toBe(100_000);
    });

    it("a live lease is not stolen; a suspended school's jobs are not claimed and resume on restoration", async () => {
      const inv = await freshInvoice(1_000_000);
      const { payment, checkout } = await startPrompt(inv, 100_000);
      fake.queries.set(checkout, { done: true, resultCode: 0 });
      await owner(`UPDATE jobs SET status = 'leased', attempts = 1, leased_by = 'busy', lease_token = 'busy', lease_started_at = now(), lease_expires_at = now() + interval '5 minutes', run_after = now() - interval '1 hour' WHERE idempotency_key = $1`, [`settle:${payment.id}`]);
      expect(await cycle()).toEqual([]);
      await owner(`UPDATE jobs SET status = 'queued', lease_expires_at = NULL, leased_by = NULL, attempts = 0 WHERE idempotency_key = $1`, [`settle:${payment.id}`]);
      await owner(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [A()]);
      try {
        expect(await cycle()).toEqual([]);
      } finally {
        await owner(`UPDATE tenants SET status = 'active' WHERE id = $1`, [A()]);
      }
      expect((await sendCallback(callbackBody(checkout, 0, { receipt: "SUSPEND001" }))).statusCode).toBe(200);
      expect(await cycle()).toEqual(["succeeded"]); // already settled by callback; job no-op
      expect((await invoice(inv)).paid_minor).toBe(100_000);
    });

    it("a payload naming a payment the school does not own fails permanently; it cannot reach another school's payment", async () => {
      // a real payment of ANOTHER school, seeded by the owner
      const y = (await owner<{ id: string }>(`INSERT INTO academic_years (tenant_id, label, starts_on, ends_on) VALUES ($1, 'B', '2020-01-01', '2030-12-31') RETURNING id`, [ids.tenantB]))[0]!.id;
      const t = (await owner<{ id: string }>(`INSERT INTO academic_terms (tenant_id, academic_year_id, index, label, starts_on, ends_on) VALUES ($1, $2, 1, 'B1', '2020-01-01', '2030-12-31') RETURNING id`, [ids.tenantB, y]))[0]!.id;
      const l = (await owner<{ id: string }>(`INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, 'B1', 'B Learner', 'male') RETURNING id`, [ids.tenantB]))[0]!.id;
      const fi = (await owner<{ id: string }>(`INSERT INTO finance_fee_items (tenant_id, term_id, name, amount_minor) VALUES ($1, $2, 'B', 1000000) RETURNING id`, [ids.tenantB, t]))[0]!.id;
      const bi = (await owner<{ id: string }>(`INSERT INTO finance_invoices (tenant_id, learner_id, term_id, due_on) VALUES ($1, $2, $3, '2030-12-31') RETURNING id`, [ids.tenantB, l, t]))[0]!.id;
      await owner(`INSERT INTO finance_invoice_lines (tenant_id, invoice_id, fee_item_id, name, amount_minor) VALUES ($1, $2, $3, 'B', 1000000)`, [ids.tenantB, bi, fi]);
      const bp = (await owner<{ id: string }>(`INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status, msisdn, checkout_request_id) VALUES ($1, $2, 100000, 'mpesa', 'pending', '254700000000', 'ws_CO_TENANTB') RETURNING id`, [ids.tenantB, bi]))[0]!.id;
      fake.queries.set("ws_CO_TENANTB", { done: true, resultCode: 0 });
      // a job of tenant A whose payload names tenant B's payment
      await owner(`INSERT INTO jobs (tenant_id, job_type, payload, idempotency_key, run_after) VALUES ($1, 'mpesa.stk_settle', $2::jsonb, 'cross-tenant', now() - interval '1 second')`, [A(), JSON.stringify({ paymentId: bp })]);
      expect(await cycle()).toEqual(["dead"]);
      expect((await owner<{ status: string }>(`SELECT status FROM finance_payments WHERE id = $1`, [bp]))[0]!.status).toBe("pending");
      expect((await owner<{ last_error_code: string }>(`SELECT last_error_code FROM jobs WHERE idempotency_key = 'cross-tenant'`))[0]!.last_error_code).toBe("payment_not_visible");
      // and a callback for B's checkout id settles B only, through B's own context
      expect((await sendCallback(callbackBody("ws_CO_TENANTB", 0, { receipt: "TENANTB001" }))).statusCode).toBe(200);
      expect((await owner<{ status: string; tenant_id: string }>(`SELECT status, tenant_id FROM finance_payments WHERE id = $1`, [bp]))[0]).toEqual({ status: "success", tenant_id: ids.tenantB });
    });
  });

  // ============================================================ proofs
  describe("payment proofs", () => {
    const sms = (code: string) => `${code} Confirmed. Ksh1,000.00 paid to FIGBLOOM SCHOOL on 1/1/26.`;

    it("the office records a proof; a family member needs the (not yet provisioned) payer link", async () => {
      const inv = await freshInvoice();
      const body = { invoice_id: inv, sms_text: sms("QWE1234567"), txn_code: "QWE1234567", txn_source: "mpesa", txn_amount_minor: 100_000 };
      expect((await post("/proofs", body, parent)).statusCode).toBe(403);
      const ok = await post("/proofs", body);
      expect(ok.statusCode).toBe(201);
      expect(ok.json().proof).toMatchObject({ status: "pending", submitted_via: "office", txn_code: "QWE1234567", currency: "KES", file: null });
      expect((await post("/proofs", { ...body, sms_text: sms("QWE1234567") }, admin)).statusCode).toBe(409); // code already waiting
    });

    it("validates the proof: code must appear in the message; files are metadata only; strict types", async () => {
      const inv = await freshInvoice();
      expect((await post("/proofs", { invoice_id: inv, sms_text: sms("AAA1111111"), txn_code: "BBB2222222" })).statusCode).toBe(400);
      expect((await post("/proofs", { invoice_id: inv })).statusCode).toBe(400);
      expect((await post("/proofs", { invoice_id: inv, sms_text: "short" })).statusCode).toBe(400);
      expect((await post("/proofs", { invoice_id: inv, file: { file_name: "a.exe", content_type: "application/x-msdownload", byte_size: 10 } })).statusCode).toBe(400);
      expect((await post("/proofs", { invoice_id: inv, file: { file_name: "../etc/passwd", content_type: "image/png", byte_size: 10 } })).statusCode).toBe(400);
      expect((await post("/proofs", { invoice_id: inv, file: { file_name: "big.png", content_type: "image/png", byte_size: 20_000_000 } })).statusCode).toBe(400);
      expect((await post("/proofs", { invoice_id: inv, file: { file_name: "x.png", content_type: "image/png", byte_size: 10 }, storage_key: "obj/x" })).statusCode).toBe(400);
      const file = await post("/proofs", { invoice_id: inv, file: { file_name: "receipt.pdf", content_type: "application/pdf", byte_size: 52_000 } });
      expect(file.statusCode).toBe(201);
      expect(file.json().proof.file).toEqual({ file_name: "receipt.pdf", content_type: "application/pdf", byte_size: 52_000, storage_status: "metadata_only", object_available: false });
      expect(JSON.stringify(file.json())).not.toMatch(/storage_key|obj\//);
    });

    it("confirmation happens only with the payment it produced; the proof cannot be reused or edited", async () => {
      const inv = await freshInvoice();
      const proof = (await post("/proofs", { invoice_id: inv, sms_text: sms("CNF1234567"), txn_code: "CNF1234567", txn_amount_minor: 100_000 })).json().proof;
      const other = await freshInvoice();
      expect((await post("/payments", { invoice_id: other, amount_minor: 100_000, method: "mpesa", reference: "CNF1234567", proof_id: proof.id })).statusCode).toBe(409); // wrong invoice
      expect((await post("/payments", { invoice_id: inv, amount_minor: 200_000, method: "mpesa", reference: "CNF1234567", proof_id: proof.id })).statusCode).toBe(400); // amount mismatch
      expect((await post("/payments", { invoice_id: inv, amount_minor: 100_000, method: "mpesa", reference: "OTHERCODE1", proof_id: proof.id })).statusCode).toBe(400); // code mismatch
      const paid = await post("/payments", { invoice_id: inv, amount_minor: 100_000, method: "mpesa", reference: "CNF1234567", proof_id: proof.id });
      expect(paid.statusCode).toBe(201);
      const after = (await get(`/proofs/${proof.id}`)).json().proof;
      expect(after).toMatchObject({ status: "confirmed", payment_id: paid.json().payment.id, reviewed_by: ids.adminA });
      expect((await post("/payments", { invoice_id: inv, amount_minor: 100_000, method: "cash", proof_id: proof.id })).statusCode).toBe(409);
      expect((await post(`/proofs/${proof.id}/reject`, { reason: "too late" })).statusCode).toBe(409);
      await asApp(A(), async (c) => expect(await sqlState(c.query(`UPDATE finance_payment_proofs SET status = 'pending', payment_id = NULL WHERE id = $1`, [proof.id]))).not.toBeNull());
      await asApp(A(), async (c) => expect(await sqlState(c.query(`DELETE FROM finance_payment_proofs WHERE id = $1`, [proof.id]))).toBe("42501"));
    });

    it("rejection needs a reason and the administer permission, and frees the code", async () => {
      const inv = await freshInvoice();
      const proof = (await post("/proofs", { invoice_id: inv, sms_text: sms("REJ1234567"), txn_code: "REJ1234567" })).json().proof;
      await owner(`INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'fees') ON CONFLICT DO NOTHING`, [A(), ids.teacherA]);
      expect((await post(`/proofs/${proof.id}/reject`, { reason: "not ours" }, teacher)).statusCode).toBe(403);
      await owner(`DELETE FROM staff_area_grants WHERE user_id = $1 AND area = 'fees'`, [ids.teacherA]);
      expect((await post(`/proofs/${proof.id}/reject`, { reason: "no" })).statusCode).toBe(400);
      const rej = await post(`/proofs/${proof.id}/reject`, { reason: "Not our paybill" });
      expect(rej.json().proof).toMatchObject({ status: "rejected", rejection_reason: "Not our paybill", payment_id: null });
      expect((await post("/proofs", { invoice_id: inv, sms_text: sms("REJ1234567"), txn_code: "REJ1234567" })).statusCode).toBe(201);
    });

    it("a proof whose transaction is already recorded as a payment is refused and an invoice with proofs cannot be voided", async () => {
      const inv = await freshInvoice();
      await post("/payments", { invoice_id: inv, amount_minor: 100_000, method: "mpesa", reference: "PAID123456" });
      expect((await post("/proofs", { invoice_id: inv, sms_text: sms("PAID123456"), txn_code: "PAID123456" })).statusCode).toBe(409);
      const inv2 = await freshInvoice();
      await post("/proofs", { invoice_id: inv2, file: { file_name: "p.png", content_type: "image/png", byte_size: 99 } });
      expect((await post(`/invoices/${inv2}/void`, { reason: "billed wrongly" })).statusCode).toBe(409);
    });
  });

  // ============================================================ reconciliation
  describe("reconciliation", () => {
    it("finds stale prompts and callback-amount mismatches, never changes money, and resolutions are final and attributed", async () => {
      const inv = await freshInvoice(1_000_000);
      const { payment, checkout } = await startPrompt(inv, 100_000);
      await owner(`ALTER TABLE finance_payments DISABLE TRIGGER finance_payments_guard`);
      try {
        await owner(`UPDATE finance_payments SET created_at = now() - interval '3 hours' WHERE id = $1`, [payment.id]);
      } finally {
        await owner(`ALTER TABLE finance_payments ENABLE TRIGGER finance_payments_guard`);
      }
      const before = await invoice(inv);
      const run = await post("/reconciliation-runs", { stale_after_minutes: 30 });
      expect(run.statusCode).toBe(201);
      const stale = (run.json().findings as Json[]).find((f) => f.kind === "stale_pending_prompt" && f.subject_id === payment.id);
      expect(stale).toMatchObject({ status: "open", subject_type: "payment" });
      if (!stale) throw new Error("stale finding missing");
      expect(await invoice(inv)).toEqual(before); // reconciliation changes no money

      // resolve while the prompt is STILL stale and pending: a resolved (kind, subject) must not be raised again
      const res = await post(`/reconciliation-findings/${stale.id}/resolve`, { note: "Parent confirmed payment", evidence: "Parent supplied M-Pesa SMS; provider portal checked" });
      expect(res.statusCode).toBe(200);
      expect(res.json().finding).toMatchObject({ status: "resolved", resolved_by: ids.adminA, resolution_note: "Parent confirmed payment" });
      expect((await post(`/reconciliation-findings/${stale.id}/resolve`, { note: "again" })).statusCode).toBe(409);
      await asApp(A(), async (c) => expect(await sqlState(c.query(`UPDATE finance_reconciliation_findings SET status = 'open' WHERE id = $1`, [stale.id]))).not.toBeNull());
      expect((await get(`/payments/${payment.id}`)).json().payment.status).toBe("pending");
      const rerun = await post("/reconciliation-runs", { stale_after_minutes: 30 });
      expect((rerun.json().findings as Json[]).some((f) => f.kind === "stale_pending_prompt" && f.subject_id === payment.id)).toBe(false);

      // the provider evidence then arrives with a different amount: flagged, never credited
      fake.queries.set(checkout, { done: true, resultCode: 0 });
      await sendCallback(callbackBody(checkout, 0, { amount: 9, receipt: "RECON00001" }));
      const run2 = await post("/reconciliation-runs", { stale_after_minutes: 30 });
      expect((run2.json().findings as Json[]).some((f) => f.kind === "callback_amount_mismatch" && f.subject_id === payment.id && f.detail.callback_amount_minor === 900 && f.detail.confirmed_minor === 100_000 && f.detail.applied_minor === 100_000)).toBe(true);
      expect((await invoice(inv)).paid_minor).toBe(100_000);
      expect(((await get("/reconciliation-findings?status=resolved")).json().findings as Json[]).some((f) => f.id === stale.id)).toBe(true);
      expect(((await get("/reconciliation-runs")).json().runs as Json[]).length).toBeGreaterThanOrEqual(3);
    });

    it("requires finance permissions; a validation error never leaks SQL", async () => {
      expect((await post("/reconciliation-runs", {}, teacher)).statusCode).toBe(403);
      expect((await get("/reconciliation-findings", teacher)).statusCode).toBe(403);
      const bad = await post("/reconciliation-runs", { stale_after_minutes: 1 });
      expect(bad.statusCode).toBe(400);
      expect(bad.body).not.toMatch(/violates|constraint|relation|SQL/i);
    });
  });

  // ============================================================ AI helper billing
  describe("AI helper billing foundations", () => {
    it("has defaults, is changeable only by administer, and billing stays off in the database", async () => {
      const s = (await get("/ai-helper/settings")).json().settings;
      expect(s).toMatchObject({ access_mode: "all", price_minor: 0, cancel_days: 7, currency: "KES", billing_available: false, billing_enabled: false });
      expect((await call("PUT", fin("/ai-helper/settings"), admin, { access_mode: "opt_in", price_minor: 150_000, cancel_days: 14 })).json().settings).toMatchObject({ access_mode: "opt_in", price_minor: 150_000, cancel_days: 14, billing_enabled: false });
      expect((await call("PUT", fin("/ai-helper/settings"), admin, { access_mode: "opt_in", price_minor: 150_050, cancel_days: 14 })).statusCode).toBe(400);
      expect((await call("PUT", fin("/ai-helper/settings"), admin, { access_mode: "opt_in", price_minor: 150_000, cancel_days: 14, billing_enabled: true })).statusCode).toBe(400);
      await asApp(A(), async (c) => expect(await sqlState(c.query(`UPDATE finance_ai_helper_settings SET billing_enabled = true`))).toBe("42501"));
      expect(await sqlState(ctx.pool.query(`UPDATE finance_ai_helper_settings SET billing_enabled = true WHERE tenant_id = $1`, [A()]))).toBe("23514");
      expect((await owner(`SELECT 1 FROM security_audit_events WHERE event_type = 'finance.ai_helper.settings_updated' AND tenant_id = $1`, [A()])).length).toBeGreaterThan(0);
    });

    it("never creates a charge; the opt-in roster is read-only for the office and family opt-in is payer-gated", async () => {
      const before = await owner<{ n: number }>(`SELECT count(*)::int AS n FROM finance_charges`);
      expect((await get(`/ai-helper/optins?termId=${term}`)).json().optins).toEqual([]);
      expect((await get("/ai-helper/optins")).statusCode).toBe(400);
      expect((await call("PUT", fin("/ai-helper/optins"), admin, { learner_id: boarder, term_id: term, opted_in: true })).statusCode).toBe(403);
      expect((await owner<{ n: number }>(`SELECT count(*)::int AS n FROM finance_charges`))[0]!.n).toBe(before[0]!.n);
    });
  });

  // ============================================================ audit
  describe("audit trail", () => {
    it("records financially significant operations with ids and amounts, never a phone number or free text", async () => {
      const types = ["finance.fee_item.created", "finance.term.billed", "finance.payment.recorded", "finance.invoice.adjusted", "finance.charge.added",
        "finance.mpesa.prompt_started", "finance.mpesa.settled", "finance.proof.submitted", "finance.proof.confirmed", "finance.proof.rejected",
        "finance.reconciliation.run", "finance.reconciliation.resolved", "finance.invoice.voided"];
      for (const t of types) {
        expect((await owner(`SELECT 1 FROM security_audit_events WHERE event_type = $1 AND tenant_id = $2`, [t, A()])).length, t).toBeGreaterThan(0);
      }
      const all = JSON.stringify(await owner(`SELECT detail FROM security_audit_events WHERE event_type LIKE 'finance.%' AND tenant_id = $1`, [A()]));
      expect(all).not.toMatch(/254712345678|254733333333/);
      expect(all).not.toMatch(/Bursary|Lost book|Parent confirmed payment|Not our paybill/); // reasons live in their own tables
      const events = JSON.stringify(await owner(`SELECT * FROM finance_mpesa_events`));
      expect(events).not.toMatch(/254712345678/);
    });
  });
});
