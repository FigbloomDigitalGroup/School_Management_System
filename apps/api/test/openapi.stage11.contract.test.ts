import { isDeepStrictEqual } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../src/app.js";
import { withSystemTenantTransaction } from "../src/db/systemTenantTransaction.js";
import { FINANCE_REQUEST_SCHEMAS } from "../src/http/routes/finance.js";
import { createPrompt, recordPushOutcome } from "../src/modules/finance/mpesa.js";
import type { MpesaProvider } from "../src/modules/finance/mpesaProvider.js";
import { createTestApp, type FixtureIds } from "./support.js";
import { loadSpec, responseSchema, validate } from "./support/openapiConformance.js";

/**
 * Stage 11 OpenAPI drift guard (both directions), like openapi.stage910.contract.test.ts:
 *  1. every runtime request schema deep-equals the spec's request body (both generated from zod);
 *  2. every finance operation documents a 2xx response schema; request bodies are $refs and closed;
 *  3. route parity: every registered finance and M-Pesa route is documented, and every documented
 *     finance operation is a real route;
 *  4. a tour calls every operation and validates every success body against its documented schema
 *     (an undocumented property fails), then asserts that none was skipped.
 */
type Json = any;

const spec = loadSpec();
const BASE = "/v1/tenants/{tenantId}/finance";

function financeOps(): string[] {
  const out: string[] = [];
  for (const [p, item] of Object.entries<Json>(spec.paths)) {
    for (const [m, op] of Object.entries<Json>(item)) if (op?.tags?.includes("finance")) out.push(`${m.toUpperCase()} ${p}`);
  }
  return out.sort();
}

const fakeProvider: MpesaProvider = {
  configured: true,
  async stkPush() {
    return { accepted: true, checkoutRequestId: "ws_CO_CONTRACT", merchantRequestId: "MR_CONTRACT" };
  },
  async stkQuery() {
    return { done: true, resultCode: 0 };
  },
};

describe("Stage 11 OpenAPI static contract", () => {
  it("every runtime request schema equals its OpenAPI request body", () => {
    const drift: string[] = [];
    for (const [key, schema] of Object.entries<z.ZodType>(FINANCE_REQUEST_SCHEMAS)) {
      const [method, path] = key.split(" ") as [string, string];
      const body = spec.paths[path]?.[method.toLowerCase()]?.requestBody?.content?.["application/json"]?.schema;
      if (!body?.$ref) {
        drift.push(`${key}: no $ref request body`);
        continue;
      }
      const documented = String(body.$ref).slice(2).split("/").reduce((cur: Json, k: string) => cur?.[k], spec);
      const runtime = z.toJSONSchema(schema, { unrepresentable: "any" }) as Json;
      delete runtime.$schema;
      if (!isDeepStrictEqual(documented, runtime)) drift.push(`${key}: spec and runtime schemas differ`);
    }
    expect(drift).toEqual([]);
  });

  it("every finance operation has a 2xx schema and a $ref request body; only the provider callback is open", () => {
    const bad: string[] = [];
    for (const key of financeOps()) {
      const [method, path] = key.split(" ") as [string, string];
      const op = spec.paths[path][method.toLowerCase()];
      const ok = Object.entries<Json>(op.responses).filter(([c]) => c.startsWith("2"));
      if (ok.length === 0 || !ok.every(([, r]) => r.content?.["application/json"]?.schema)) bad.push(`${key}: 2xx schema missing`);
      const rb = op.requestBody?.content?.["application/json"]?.schema;
      if (rb && !rb.$ref) bad.push(`${key}: inline request body`);
      if (rb && !path.startsWith("/v1/mpesa/") && !FINANCE_REQUEST_SCHEMAS[key as keyof typeof FINANCE_REQUEST_SCHEMAS]) bad.push(`${key}: no runtime schema registered`);
      if (rb?.$ref && !path.startsWith("/v1/mpesa/")) {
        const target = String(rb.$ref).slice(2).split("/").reduce((cur: Json, k: string) => cur?.[k], spec);
        if (target.additionalProperties !== false) bad.push(`${key}: request body is not closed`);
      }
    }
    expect(bad).toEqual([]);
    expect(financeOps().length).toBe(43);
    expect(spec.paths["/v1/mpesa/callback"].post["x-figbloom-authz"]).toBe("public");
  });

  it("no finance schema or example carries a storage key, secret, or full phone number", () => {
    const text = JSON.stringify(Object.fromEntries(Object.entries<Json>(spec.paths).filter(([p]) => p.includes("/finance") || p.startsWith("/v1/mpesa"))));
    expect(text).not.toMatch(/storage_key|passkey|consumer_secret|callback_secret/i);
  });
});

describe("Stage 11 OpenAPI runtime conformance", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token: string;
  const covered = new Set<string>();
  const problems: string[] = [];
  const SECRET = "contract-callback-secret-0123456789abcdef";

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    app = await buildApp({ ...ctx.config, mpesaCallbackSecret: SECRET, mpesaCallbackUrl: "http://localhost/v1/mpesa/callback" }, ctx.runtimePool, { mpesaProvider: fakeProvider });
    await app.ready();
    const login = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "admin-a@example.com", password: "correct-horse-battery" } });
    token = login.json().token as string;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("route parity: every finance and M-Pesa route is documented and every documented finance operation is routed", () => {
    const routed = new Set<string>();
    for (const r of app.routeTable) {
      const method = r.method.toUpperCase();
      if (method === "HEAD" || method === "OPTIONS") continue;
      if (r.url.startsWith("/v1/tenants/:tenantId/finance") || r.url.startsWith("/v1/mpesa/")) routed.add(`${method} ${r.url.replace(/:([A-Za-z]+)/g, "{$1}")}`);
    }
    expect([...routed].sort()).toEqual(financeOps());
  });

  async function call(method: "GET" | "POST" | "PUT" | "PATCH", template: string, vars: Record<string, string>, payload?: unknown, query = "") {
    const url = template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `MISSING_${k}`) + query;
    const res = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, "x-tenant-id": ids.tenantA },
      ...(payload === undefined ? {} : { payload: payload as Json }),
    });
    const key = `${method} ${template}`;
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const schema = responseSchema(spec, method, template, res.statusCode);
      if (typeof schema === "string") problems.push(schema);
      else {
        const errs = validate(spec, schema, res.json());
        if (errs.length) problems.push(`${key} ${res.statusCode}: ${errs.slice(0, 5).join("; ")}`);
        else covered.add(key);
      }
    } else {
      problems.push(`${key}: unexpected ${res.statusCode} ${res.body.slice(0, 200)}`);
    }
    return res.json() as Json;
  }

  it("every finance operation answers with a body that matches its documented schema", async () => {
    const F = BASE;
    const v: Record<string, string> = { tenantId: ids.tenantA };
    const plain = async (url: string, payload: unknown) =>
      (await app.inject({ method: "POST", url: `/v1/tenants/${ids.tenantA}${url}`, headers: { authorization: `Bearer ${token}`, "x-tenant-id": ids.tenantA }, payload: payload as Json })).json();

    const year = (await plain("/academic-years", { label: "Contract", starts_on: "2020-01-01", ends_on: "2035-12-31" })).academic_year.id;
    v.termId = (await plain("/academic-terms", { academic_year_id: year, index: 1, label: "C T1", starts_on: "2020-01-01", ends_on: "2035-12-31" })).term.id;
    await plain(`/academic-terms/${v.termId}/set-current`, {});
    const cls = (await plain("/classes", { academic_year_id: year, name: "C F1", form_level: 1 })).school_class.id;
    const learner = (await plain("/learners", { admission_no: "CT1", full_name: "Contract Learner", gender: "female", boarding: true })).learner.id;
    await plain("/class-memberships", { learner_id: learner, class_id: cls });

    v.feeItemId = (await call("POST", `${F}/fee-items`, v, { term_id: v.termId, name: "Tuition", amount_minor: 5_000_000, applies_to: "all" })).fee_item.id;
    await call("GET", `${F}/fee-items`, v, undefined, `?termId=${v.termId}`);
    await call("GET", `${F}/fee-items/{feeItemId}`, v);
    await call("PATCH", `${F}/fee-items/{feeItemId}`, v, { name: "Tuition fee" });
    const extra = (await call("POST", `${F}/fee-items`, v, { term_id: v.termId, name: "Extra", amount_minor: 100_000, applies_to: "form_level", form_level: 3 })).fee_item.id;
    await call("POST", `${F}/fee-items/{feeItemId}/archive`, { ...v, feeItemId: extra }, {});
    await call("POST", `${F}/billing-runs`, v, { term_id: v.termId, due_on: "2035-12-31" });
    v.invoiceId = (await call("GET", `${F}/invoices`, v, undefined, `?termId=${v.termId}`)).invoices[0].id;
    await call("GET", `${F}/invoices`, v, undefined, `?status=unpaid&learnerId=${learner}`);
    await call("GET", `${F}/invoices/{invoiceId}`, v);
    await call("PUT", `${F}/invoices/{invoiceId}/due-date`, v, { due_on: "2035-11-30" });
    const withCharge = await call("POST", `${F}/invoices/{invoiceId}/charges`, v, { amount_minor: 200_000, reason: "Lost book" });
    expect(withCharge.invoice.charges_minor).toBe(200_000);
    const detail = await call("GET", `${F}/invoices/{invoiceId}`, v);
    v.chargeId = detail.charges[0].id;
    await call("POST", `${F}/invoices/{invoiceId}/charges/{chargeId}/void`, v, { reason: "Book found" });
    await call("POST", `${F}/invoices/{invoiceId}/adjustments`, v, { expected_total_minor: 5_000_000, new_total_minor: 4_900_000, reason: "Bursary" });

    const proof = await call("POST", `${F}/proofs`, v, { invoice_id: v.invoiceId, sms_text: "QCT1234567 Confirmed. Ksh1,000.00 paid to the school.", txn_code: "QCT1234567", txn_source: "mpesa", txn_amount_minor: 100_000 });
    v.proofId = proof.proof.id;
    await call("GET", `${F}/proofs`, v, undefined, "?status=pending");
    await call("GET", `${F}/proofs/{proofId}`, v);
    const paid = await call("POST", `${F}/payments`, v, { invoice_id: v.invoiceId, amount_minor: 100_000, method: "mpesa", reference: "QCT1234567", proof_id: v.proofId });
    v.paymentId = paid.payment.id;
    await call("GET", `${F}/payments`, v, undefined, `?invoiceId=${v.invoiceId}&status=success`);
    await call("GET", `${F}/payments/{paymentId}`, v);
    // a queued settlement job whose payment is final (the office payment above): the operator may cancel it
    await ctx.pool.query(
      `INSERT INTO jobs (tenant_id, job_type, payload, idempotency_key, run_after) VALUES ($1, 'mpesa.stk_settle', $2::jsonb, $3, now() + interval '1 day')`,
      [ids.tenantA, JSON.stringify({ paymentId: v.paymentId }), `settle:${v.paymentId}`],
    );
    await call("GET", `${F}/payments/{paymentId}/mpesa-events`, v);
    await call("POST", `${F}/payments/{paymentId}/mpesa-reconciliation`, v, { action: "refresh", note: "Contract tour: nothing to reconcile" });
    await call("POST", `${F}/payments/{paymentId}/settlement-job/cancel`, v, { reason: "Settled office payment; stop the redundant check" });
    const proof2 = await call("POST", `${F}/proofs`, v, { invoice_id: v.invoiceId, file: { file_name: "slip.png", content_type: "image/png", byte_size: 4096 } });
    await call("POST", `${F}/proofs/{proofId}/reject`, { ...v, proofId: proof2.proof.id }, { reason: "Unreadable" });

    const run = await call("POST", `${F}/reconciliation-runs`, v, { stale_after_minutes: 30 });
    await call("GET", `${F}/reconciliation-runs`, v);
    await call("GET", `${F}/reconciliation-findings`, v, undefined, `?runId=${run.run.id}`);
    // a finding to resolve: run again with a short stale window; seed one directly if the data raised none
    const findings = await call("POST", `${F}/reconciliation-runs`, v, { stale_after_minutes: 5 });
    if (findings.findings.length === 0) {
      // seed one open finding directly so the resolve operation can be exercised
      await ctx.pool.query(
        `INSERT INTO finance_reconciliation_findings (tenant_id, run_id, kind, subject_type, subject_id, detail) VALUES ($1, $2, 'overpaid_invoice', 'invoice', $3, '{}'::jsonb)`,
        [ids.tenantA, findings.run.id, v.invoiceId],
      );
    }
    const open = (await call("GET", `${F}/reconciliation-findings`, v, undefined, "?status=open")).findings[0];
    v.findingId = open.id;
    await call("POST", `${F}/reconciliation-findings/{findingId}/assign`, v, { owner_user_id: null });
    await call("POST", `${F}/reconciliation-findings/{findingId}/resolve`, v, { note: "Checked with the bursar" });
    // an unacknowledged prompt (no checkout id) to withdraw
    const unsent = (await ctx.pool.query<{ id: string }>(`INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status, msisdn) VALUES ($1, $2, 100000, 'mpesa', 'pending', '254712345678') RETURNING id`, [ids.tenantA, v.invoiceId])).rows[0]!.id;
    await call("POST", `${F}/payments/{paymentId}/withdraw-unacknowledged-prompt`, { ...v, paymentId: unsent }, { reason: "STK never sent", evidence: "Portal shows no STK request for this account" });

    // an unused invoice (second term, no payments) to void
    const term2 = (await plain("/academic-terms", { academic_year_id: year, index: 2, label: "C T2", starts_on: "2020-01-01", ends_on: "2035-12-31" })).term.id;
    await call("POST", `${F}/fee-items`, { ...v, termId: term2 }, { term_id: term2, name: "T2 fee", amount_minor: 100_000, applies_to: "all" });
    await call("POST", `${F}/billing-runs`, v, { term_id: term2, due_on: "2035-12-31" });
    const unused = (await call("GET", `${F}/invoices`, v, undefined, `?termId=${term2}`)).invoices[0].id;
    await call("POST", `${F}/invoices/{invoiceId}/void`, { ...v, invoiceId: unused }, { reason: "Billed in error" });

    await call("GET", `${F}/ai-helper/settings`, v);
    await call("PUT", `${F}/ai-helper/settings`, v, { access_mode: "opt_in", price_minor: 100_000, cancel_days: 7 });
    await call("GET", `${F}/ai-helper/optins`, v, undefined, `?termId=${v.termId}`);

    // Invoice PDF & delivery
    const pdfRes = await app.inject({
      method: "GET",
      url: `${F}/invoices/${v.invoiceId}/pdf`.replace("{tenantId}", ids.tenantA),
      headers: { authorization: `Bearer ${token}`, "x-tenant-id": ids.tenantA },
    });
    expect(pdfRes.statusCode).toBe(200);
    expect(pdfRes.headers["content-type"]).toContain("application/pdf");
    covered.add(`GET ${F}/invoices/{invoiceId}/pdf`);
    await call("POST", `${F}/invoices/{invoiceId}/send`, v, { channels: ["email"] });
    await call("POST", `${F}/terms/{termId}/invoices/send`, v, { channels: ["email"], status_filter: "all" });

    // Bank statement reconciliation
    const stmt = await call("POST", `${F}/bank-reconciliation/statements`, v, {
      bank_name: "Contract Bank",
      account_number: "100200300",
      csv_text: "Date,Reference,Narration,Debit,Credit\n2026-02-10,BANKREF1,Fee deposit,,500.00\n2026-02-11,CHG1,Ledger fee,50.00,",
    });
    const stmtId = stmt.statement.id as string;
    const creditLineId = stmt.lines[0].id as string;
    const debitLineId = stmt.lines[1].id as string;
    await call("GET", `${F}/bank-reconciliation/statements`, v);
    await call("GET", `${F}/bank-reconciliation/statements/{statementId}`, { ...v, statementId: stmtId });
    await call("POST", `${F}/bank-reconciliation/lines/{lineId}/match`, { ...v, lineId: creditLineId }, { payment_id: v.paymentId, note: "Contract match" });
    await call("POST", `${F}/bank-reconciliation/lines/{lineId}/ignore`, { ...v, lineId: debitLineId }, { note: "Monthly bank charge" });

    // family-only operations are fail-closed (no account-to-guardian link): validate the documented 403,
    // and the documented success shape against real module output
    for (const [method, template, payload] of [
      ["POST", `${F}/mpesa/prompts`, { invoice_id: v.invoiceId, amount_minor: 100_000, msisdn: "254712345678" }],
      ["PUT", `${F}/ai-helper/optins`, { learner_id: learner, term_id: v.termId, opted_in: true }],
    ] as const) {
      const res = await app.inject({ method, url: template.replace("{tenantId}", ids.tenantA), headers: { authorization: `Bearer ${token}`, "x-tenant-id": ids.tenantA }, payload });
      expect(res.statusCode).toBe(403);
      const doc = spec.paths[template][method.toLowerCase()].responses["403"];
      expect(doc.$ref ?? doc).toBeTruthy();
      expect(validate(spec, { $ref: "#/components/schemas/Error" }, res.json())).toEqual([]);
      covered.add(`${method} ${template}`);
    }
    const prompted = await withSystemTenantTransaction(ctx.runtimePool, { tenantId: ids.tenantA }, async (tx) => {
      const inv = (await tx.query<{ id: string }>(`SELECT id FROM finance_invoices WHERE tenant_id = $1 AND voided_at IS NULL ORDER BY created_at LIMIT 1`, [ids.tenantA])).rows[0]!.id;
      const { payment } = await createPrompt(tx, { tenantId: ids.tenantA, actorUserId: ids.adminA, invoice_id: inv, amount_minor: 100_000, msisdn: "254712345678", settleDelaySeconds: 120 });
      return recordPushOutcome(tx, { tenantId: ids.tenantA, paymentId: payment.id, result: { accepted: true, checkoutRequestId: "ws_CO_CONTRACT", merchantRequestId: "MR_CONTRACT" }, actorUserId: ids.adminA });
    });
    expect(validate(spec, { $ref: "#/components/schemas/FinanceMpesaPrompt" }, { payment: prompted, reused: false })).toEqual([]);
    expect(validate(spec, { $ref: "#/components/schemas/FinanceMpesaPrompt" }, { payment: prompted, reused: false, extra: 1 })).not.toEqual([]); // a leaked field would fail

    // the public callback
    const ok = await app.inject({
      method: "POST",
      url: `/v1/mpesa/callback?token=${SECRET}`,
      payload: { Body: { stkCallback: { MerchantRequestID: "MR_CONTRACT", CheckoutRequestID: "ws_CO_CONTRACT", ResultCode: 0, ResultDesc: "ok", CallbackMetadata: { Item: [{ Name: "Amount", Value: 1 }, { Name: "MpesaReceiptNumber", Value: "QCTCB12345" }] } } } },
    });
    expect(ok.statusCode).toBe(200);
    const ackSchema = responseSchema(spec, "POST", "/v1/mpesa/callback", 200);
    expect(typeof ackSchema).not.toBe("string");
    expect(validate(spec, ackSchema as Json, ok.json())).toEqual([]);
    covered.add("POST /v1/mpesa/callback");

    expect(problems).toEqual([]);
    const missing = financeOps().filter((k) => !covered.has(k));
    expect(missing).toEqual([]);
  });
});
