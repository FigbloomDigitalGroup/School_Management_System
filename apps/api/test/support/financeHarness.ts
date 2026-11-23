import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect } from "vitest";
import { buildApp } from "../../src/app.js";
import { withSystemTenantTransaction } from "../../src/db/systemTenantTransaction.js";
import { createPrompt, recordPushOutcome } from "../../src/modules/finance/mpesa.js";
import type { MpesaProvider, StkPushRequest, StkPushResult, StkQueryResult } from "../../src/modules/finance/mpesaProvider.js";
import { workerHandlers } from "../../src/worker/handlers.js";
import { runCycle, type CycleOutcome } from "../../src/worker/runtime.js";
import { createTestApp, type FixtureIds } from "../support.js";

/**
 * Shared Stage 11 test harness (finance, M-Pesa, worker). Call `financeHarness()` inside a `describe`.
 * Everything runs against the isolated local figbloom_api test database (see assertIsolatedTestDatabase),
 * through the real runtime logins (figbloom_app, figbloom_worker) and a deterministic fake provider.
 *
 * Worker login hygiene (review F-14): figbloom_worker is a cluster-wide role. Its LOGIN is enabled only for
 * the life of a test file, with a per-run random password, a short VALID UNTIL and a small connection limit;
 * it is reset to NOLOGIN with no password both BEFORE the run (so a crashed earlier run cannot leave it
 * usable) and AFTER it, in a finally block.
 */
export type Json = Record<string, any>;
type InjectResponse = Awaited<ReturnType<Awaited<ReturnType<typeof buildApp>>["inject"]>>;
export const PASSWORD = "correct-horse-battery";
export const CALLBACK_SECRET = "callback-secret-for-tests-0123456789abcdef";

export class FakeProvider implements MpesaProvider {
  readonly configured = true;
  pushes: StkPushRequest[] = [];
  pushResult: StkPushResult | "throw" = { accepted: true, checkoutRequestId: "ws_CO_FAKE", merchantRequestId: "MR_FAKE" };
  queries = new Map<string, StkQueryResult | "throw">();
  async stkPush(req: StkPushRequest): Promise<StkPushResult> {
    this.pushes.push(req);
    if (this.pushResult === "throw") throw new Error("network");
    return this.pushResult;
  }
  /** Test hook: runs while the provider is being asked (used to change authority between authorization and use). */
  onQuery?: (checkoutRequestId: string) => Promise<void>;
  async stkQuery(checkoutRequestId: string): Promise<StkQueryResult> {
    await this.onQuery?.(checkoutRequestId);
    const r = this.queries.get(checkoutRequestId);
    if (r === "throw" || r === undefined) throw new Error("provider unavailable");
    return r;
  }
}

export async function resetWorkerLogin(ownerPool: pg.Pool): Promise<void> {
  await ownerPool.query(`ALTER ROLE figbloom_worker WITH NOLOGIN PASSWORD NULL VALID UNTIL 'infinity'`);
}

/** Enable the worker login for this run and return a pool of one connection logged in as figbloom_worker. */
export async function enableWorkerLogin(ownerPool: pg.Pool, runtimeUrl: string): Promise<pg.Pool & { connectionString: string }> {
  await resetWorkerLogin(ownerPool);
  const password = "w-" + randomBytes(24).toString("base64url");
  const until = new Date(Date.now() + 30 * 60_000).toISOString();
  await ownerPool.query(`ALTER ROLE figbloom_worker WITH LOGIN PASSWORD '${password}' CONNECTION LIMIT 8 VALID UNTIL '${until}'`);
  const url = new URL(runtimeUrl);
  url.username = "figbloom_worker";
  url.password = password;
  const connectionString = url.toString();
  const pool = new pg.Pool({ connectionString, max: 1 }) as pg.Pool & { connectionString: string };
  pool.connectionString = connectionString;
  return pool;
}

export function financeHarness() {
  const h = {} as {
    ctx: Awaited<ReturnType<typeof createTestApp>>;
    ids: FixtureIds;
    app: Awaited<ReturnType<typeof buildApp>>;
    fake: FakeProvider;
    workerPool: pg.Pool;
    admin: string;
    teacher: string;
    parent: string;
    A: () => string;
    owner: <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]) => Promise<T[]>;
    sqlState: (p: Promise<unknown>) => Promise<string | null>;
    asApp: <T>(tenant: string | null, fn: (c: pg.PoolClient) => Promise<T>, pool?: pg.Pool) => Promise<T>;
    call: (method: "GET" | "POST" | "PUT" | "PATCH", url: string, token: string, payload?: unknown, headers?: Json) => Promise<InjectResponse>;
    post: (path: string, payload: unknown, token?: string, headers?: Json) => Promise<InjectResponse>;
    get: (path: string, token?: string) => Promise<InjectResponse>;
    fin: (path?: string) => string;
    created: (url: string, payload: unknown, key: string) => Promise<string>;
    freshInvoice: (lineMinor?: number) => Promise<string>;
    startPrompt: (invoiceId: string, amount: number, checkout?: string, msisdn?: string) => Promise<{ payment: Json; checkout: string }>;
    callbackBody: (checkout: string, code: number, extra?: { amount?: number | string; receipt?: string }) => Json;
    sendCallback: (body: unknown, token?: string | null) => Promise<InjectResponse>;
    invoice: (id: string) => Promise<Json>;
    payment: (id: string) => Promise<Json>;
    cycle: (opts?: { workerName?: string; leaseSeconds?: number }) => Promise<CycleOutcome[]>;
    makeDue: (paymentId: string) => Promise<unknown>;
    jobOf: (paymentId: string) => Promise<Json | undefined>;
    /** Persist authenticated-callback FAILURE evidence (what the callback route stores before it queries the provider). */
    plantFailureCallback: (paymentId: string, checkout: string, code: number, tenantId?: string) => Promise<void>;
    auditOf: (eventType: string, tenant?: string) => Promise<Json[]>;
    login: (body: Json) => Promise<string>;
  };
  let seq = 0;
  let year: string;
  let term: string;

  h.A = () => h.ids.tenantA;
  const hdr = (token: string, tenant = h.A()) => ({ authorization: `Bearer ${token}`, "x-tenant-id": tenant });
  h.fin = (path = "") => `/v1/tenants/${h.A()}/finance${path}`;
  h.call = (method, url, token, payload, headers = {}) =>
    h.app.inject({ method, url, headers: { ...hdr(token), ...headers }, ...(payload === undefined ? {} : { payload: payload as Json }) });
  h.post = (path, payload, token = h.admin, headers = {}) => h.call("POST", h.fin(path), token, payload, headers);
  h.get = (path, token = h.admin) => h.call("GET", h.fin(path), token);
  h.created = async (url, payload, key) => {
    const res = await h.call("POST", `/v1/tenants/${h.A()}${url}`, h.admin, payload);
    expect(res.statusCode, `${url} ${res.body}`).toBe(201);
    return res.json()[key].id as string;
  };
  h.login = async (body) => {
    const res = await h.ctx.app.inject({ method: "POST", url: body.email ? "/v1/auth/login/email" : "/v1/auth/login/login-id", payload: body });
    expect(res.statusCode).toBe(200);
    return res.json().token as string;
  };
  h.asApp = async (tenant, fn, pool = h.ctx.runtimePool) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      if (tenant) await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant]);
      return await fn(c);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  };
  h.sqlState = async (p) => {
    try {
      await p;
      return null;
    } catch (err) {
      return (err as { code?: string }).code ?? "unknown";
    }
  };
  h.owner = async (sql, params = []) => (await h.ctx.pool.query(sql, params)).rows as any[];
  h.invoice = async (id) => (await h.get(`/invoices/${id}`)).json().invoice;
  h.payment = async (id) => (await h.get(`/payments/${id}`)).json().payment;

  h.freshInvoice = async (lineMinor = 1_000_000) => {
    seq++;
    const tag = `${seq}${randomUUID().slice(0, 5)}`;
    const A = h.A();
    const learner = await h.created("/learners", { admission_no: `FN${tag}`, full_name: `Fin ${tag}`, gender: "female" }, "learner");
    const y = (await h.owner<{ id: string }>(`INSERT INTO academic_years (tenant_id, label, starts_on, ends_on) VALUES ($1, $2, '2020-01-01', '2035-12-31') RETURNING id`, [A, `Y${tag}`.slice(0, 32)]))[0]!.id;
    const t = (await h.owner<{ id: string }>(`INSERT INTO academic_terms (tenant_id, academic_year_id, index, label, starts_on, ends_on) VALUES ($1, $2, 1, $3, '2020-01-01', '2035-12-31') RETURNING id`, [A, y, `T${tag}`.slice(0, 60)]))[0]!.id;
    const item = (await h.owner<{ id: string }>(`INSERT INTO finance_fee_items (tenant_id, term_id, name, amount_minor) VALUES ($1, $2, 'Seed', $3) RETURNING id`, [A, t, Math.ceil(lineMinor / 100) * 100]))[0]!.id;
    const inv = (await h.owner<{ id: string }>(`INSERT INTO finance_invoices (tenant_id, learner_id, term_id, due_on) VALUES ($1, $2, $3, '2035-12-31') RETURNING id`, [A, learner, t]))[0]!.id;
    await h.owner(`INSERT INTO finance_invoice_lines (tenant_id, invoice_id, fee_item_id, name, amount_minor) VALUES ($1, $2, $3, 'Seed', $4)`, [A, inv, item, lineMinor]);
    return inv;
  };

  h.startPrompt = async (invoiceId, amount, checkout = `ws_CO_${randomUUID().slice(0, 12)}`, msisdn = "254712345678") => {
    const payment = await withSystemTenantTransaction(h.ctx.runtimePool, { tenantId: h.A(), userId: h.ids.adminA }, async (tx) => {
      const { payment: p } = await createPrompt(tx, { tenantId: h.A(), actorUserId: h.ids.adminA, invoice_id: invoiceId, amount_minor: amount, msisdn, settleDelaySeconds: 120 });
      return recordPushOutcome(tx, {
        tenantId: h.A(),
        paymentId: p.id,
        result: { accepted: true, checkoutRequestId: checkout, merchantRequestId: "MR_" + checkout },
        actorUserId: h.ids.adminA,
      });
    });
    return { payment: payment as Json, checkout };
  };

  h.callbackBody = (checkout, code, extra = {}) => ({
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
  h.sendCallback = (body, token = CALLBACK_SECRET) =>
    h.app.inject({ method: "POST", url: `/v1/mpesa/callback${token === null ? "" : `?token=${encodeURIComponent(token)}`}`, payload: body as Json });

  h.cycle = async (opts = {}) => {
    const out: CycleOutcome[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await runCycle(h.workerPool, { workerName: opts.workerName ?? "test-worker", leaseSeconds: opts.leaseSeconds ?? 30, handlers: workerHandlers(h.fake) });
      if (r === "idle") break;
      out.push(r);
    }
    return out;
  };
  h.makeDue = (paymentId) => h.owner(`UPDATE jobs SET run_after = now() - interval '1 second' WHERE idempotency_key = $1`, [`settle:${paymentId}`]);
  h.plantFailureCallback = async (paymentId, checkout, code, tenantId = h.A()) => {
    await h.owner(
      `INSERT INTO finance_mpesa_events (tenant_id, payment_id, checkout_request_id, source, result_code, outcome) VALUES ($1, $2, $3, 'callback', $4, 'callback_received')`,
      [tenantId, paymentId, checkout, code],
    );
  };
  h.jobOf = async (paymentId) => (await h.owner(`SELECT * FROM jobs WHERE idempotency_key = $1`, [`settle:${paymentId}`]))[0];
  h.auditOf = (eventType, tenant = h.A()) =>
    h.owner(`SELECT * FROM security_audit_events WHERE event_type = $1 AND tenant_id = $2 ORDER BY occurred_at, id`, [eventType, tenant]);

  beforeAll(async () => {
    h.ctx = await createTestApp();
    h.ids = h.ctx.ids;
    h.fake = new FakeProvider();
    h.app = await buildApp(
      { ...h.ctx.config, mpesaCallbackSecret: CALLBACK_SECRET, mpesaCallbackUrl: "http://localhost/v1/mpesa/callback", mpesaSettleDelaySeconds: 120 },
      h.ctx.runtimePool,
      { mpesaProvider: h.fake },
    );
    await h.app.ready();
    h.admin = await h.login({ email: "admin-a@example.com", password: PASSWORD });
    h.teacher = await h.login({ tenantId: h.A(), loginId: "TC-0001", password: PASSWORD });
    h.parent = await h.login({ tenantId: h.A(), loginId: "PT-0001", password: PASSWORD });
    h.workerPool = await enableWorkerLogin(h.ctx.pool, h.ctx.runtimeUrl);
    year = (await h.call("POST", `/v1/tenants/${h.A()}/academic-years`, h.admin, { label: "Fin 2026", starts_on: "2020-01-01", ends_on: "2035-12-31" })).json().academic_year.id;
    term = await h.created("/academic-terms", { academic_year_id: year, index: 1, label: "Fin T1", starts_on: "2020-01-01", ends_on: "2035-12-31" }, "term");
    expect((await h.call("POST", `/v1/tenants/${h.A()}/academic-terms/${term}/set-current`, h.admin, {})).statusCode).toBe(200);
    // drain jobs left by the fixtures so each case sees only its own
    await h.owner(`UPDATE jobs SET run_after = now() + interval '1 day' WHERE status = 'queued'`);
  }, 180_000);

  afterAll(async () => {
    try {
      await h.workerPool?.end().catch(() => undefined);
    } finally {
      try {
        await resetWorkerLogin(h.ctx.pool).catch(() => undefined);
      } finally {
        await h.app?.close();
        await h.ctx?.app.close();
        await h.ctx?.pool.end();
      }
    }
  });

  return h;
}
