import { describe, it, afterEach, beforeEach } from "jsr:@std/testing/bdd";
import { assertEquals } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle } from "./index.ts";

const INVOICE_ID = "invoice-1";
const PARENT_ID = "parent-1";
const STUDENT_ID = "student-1";

beforeEach(() => {
  Deno.env.set("DARAJA_CALLBACK_URL", "https://example.supabase.co/functions/v1/mpesa-callback");
  Deno.env.set("DARAJA_CALLBACK_SECRET", "callback-secret");
});

/** The caller is the learner's guardian, and payments has the one-pending-per-invoice index. */
function makeClients(invoiceOverrides: Record<string, unknown> = {}) {
  const admin = new FakeSupabaseClient();
  const asUser = new FakeSupabaseClient();
  asUser.authUser = { id: PARENT_ID };
  asUser.seed("fee_invoices", [{
    id: INVOICE_ID, tenant_id: "tenant-1", student_id: STUDENT_ID, total_cents: 100000, paid_cents: 0, ...invoiceOverrides,
  }]);
  admin.seed("guardians", [{ id: "g-1", profile_id: PARENT_ID, student_id: STUDENT_ID }]);
  admin.seed("students", [{ id: STUDENT_ID, profile_id: "learner-login-1" }]);
  admin.uniqueIndex("payments", ["invoice_id"], (r) => r.status === "pending");
  return { admin, asUser };
}

function request(body: unknown, opts: { method?: string; auth?: string | null } = {}) {
  const method = opts.method ?? "POST";
  const headers = new Headers();
  if (opts.auth !== null) headers.set("Authorization", opts.auth ?? "Bearer token");
  return new Request("https://example.com/mpesa-stk-push", {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
}

const validBody = { invoice_id: INVOICE_ID, amount_cents: 50000, msisdn: "254712345678" };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Routes fetch by URL: oauth token endpoint vs. the STK push endpoint. Returns the STK push bodies sent. */
function stubFetch(stkResponse: () => Response | Promise<Response>) {
  const sent: Record<string, unknown>[] = [];
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    const href = url.toString();
    if (href.includes("/oauth/v1/generate")) {
      return Promise.resolve(new Response(JSON.stringify({ access_token: "test-token" }), { status: 200 }));
    }
    if (href.includes("/stkpush/v1/processrequest")) {
      sent.push(JSON.parse(String(init?.body)));
      return Promise.resolve(stkResponse());
    }
    throw new Error(`Unexpected fetch to ${href}`);
  }) as typeof fetch;
  return sent;
}

describe("mpesa-stk-push handle", () => {
  it("answers a CORS preflight", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request(undefined, { method: "OPTIONS", auth: null }), { admin, asUser });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("rejects a body that isn't JSON", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(
      new Request("https://example.com/mpesa-stk-push", { method: "POST", headers: { Authorization: "Bearer token" }, body: "not json" }),
      { admin, asUser },
    );
    assertEquals(res.status, 400);
  });

  it("rejects an amount that isn't whole shillings", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ ...validBody, amount_cents: 50050 }), { admin, asUser });
    assertEquals(res.status, 400);
    assertEquals(admin.rowsIn("payments").length, 0);
  });

  it("refuses to raise a prompt when the callback secret isn't configured", async () => {
    Deno.env.delete("DARAJA_CALLBACK_SECRET");
    const { admin, asUser } = makeClients();
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 503);
    assertEquals(admin.rowsIn("payments").length, 0);
  });

  it("rejects non-POST requests", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request(validBody, { method: "GET" }), { admin, asUser });
    assertEquals(res.status, 405);
  });

  it("rejects a request with no Authorization header", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request(validBody, { auth: null }), { admin, asUser });
    assertEquals(res.status, 401);
  });

  it("rejects when the token does not resolve to a user", async () => {
    const { admin, asUser } = makeClients();
    asUser.authUser = null;
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 401);
  });

  it("rejects an malformed M-Pesa number", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ ...validBody, msisdn: "0712345678" }), { admin, asUser });
    assertEquals(res.status, 400);
  });

  it("rejects an amount below the minimum", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ ...validBody, amount_cents: 50 }), { admin, asUser });
    assertEquals(res.status, 400);
  });

  it("rejects an invoice the guardian cannot see", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ ...validBody, invoice_id: "not-mine" }), { admin, asUser });
    assertEquals(res.status, 403);
  });

  it("rejects an amount above the outstanding balance", async () => {
    const { admin, asUser } = makeClients({ total_cents: 100000, paid_cents: 90000 });
    const res = await handle(request({ ...validBody, amount_cents: 50000 }), { admin, asUser });
    assertEquals(res.status, 400);
  });

  it("reuses an in-flight payment instead of starting a second prompt", async () => {
    const { admin, asUser } = makeClients();
    admin.seed("payments", [{
      id: "existing-payment", invoice_id: INVOICE_ID, status: "pending", msisdn: validBody.msisdn,
      amount_cents: validBody.amount_cents, created_at: new Date().toISOString(),
    }]);
    const res = await handle(request(validBody), { admin, asUser });
    const out = await res.json();
    assertEquals(out.reused, true);
    assertEquals(out.payment_id, "existing-payment");
  });

  it("starts a payment and stores the checkout request id on success", async () => {
    const { admin, asUser } = makeClients();
    const sent = stubFetch(() => new Response(JSON.stringify({ ResponseCode: "0", CheckoutRequestID: "ws_CO_999" }), { status: 200 }));

    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 200);
    const out = await res.json();
    // the client polls by payment id; the checkout id stays server-side
    assertEquals(out.checkout_request_id, undefined);

    const payment = admin.rowsIn("payments").find((p) => p.id === out.payment_id);
    assertEquals(payment?.status, "pending");
    assertEquals(payment?.checkout_request_id, "ws_CO_999");
    assertEquals(payment?.amount_cents, 50000);

    assertEquals(sent[0].Amount, 500);
    assertEquals(sent[0].CallBackURL, "https://example.supabase.co/functions/v1/mpesa-callback?token=callback-secret");
  });

  it("marks the payment failed when Safaricom rejects the STK push", async () => {
    const { admin, asUser } = makeClients();
    stubFetch(() => new Response(JSON.stringify({ ResponseCode: "1", errorMessage: "busy" }), { status: 200 }));

    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 502);
    const payment = admin.rowsIn("payments")[0];
    assertEquals(payment.status, "failed");
    assertEquals(payment.failure_reason, "unreachable");
  });

  it("marks the payment failed when the network call throws", async () => {
    const { admin, asUser } = makeClients();
    globalThis.fetch = (() => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 502);
    assertEquals(admin.rowsIn("payments")[0].status, "failed");
  });
});

const stkOk = () => new Response(JSON.stringify({ ResponseCode: "0", CheckoutRequestID: "ws_CO_new" }), { status: 200 });
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe("who can be prompted (FIG-1320)", () => {
  it("refuses staff who can see the invoice but aren't the family", async () => {
    const { admin, asUser } = makeClients();
    asUser.authUser = { id: "teacher-1" };
    const sent = stubFetch(stkOk);
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 403);
    assertEquals(sent.length, 0);
    assertEquals(admin.rowsIn("payments").length, 0);
  });

  it("lets the learner pay their own invoice", async () => {
    const { admin, asUser } = makeClients();
    asUser.authUser = { id: "learner-login-1" };
    const sent = stubFetch(stkOk);
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 200);
    assertEquals(sent.length, 1);
  });

  it("limits prompts per caller and per number, noting both every time", async () => {
    const { admin, asUser } = makeClients();
    const sent = stubFetch(stkOk);
    const keys: string[] = [];
    const withinLimit = (key: string) => { keys.push(key); return Promise.resolve(keys.length !== 2); };
    const res = await handle(request(validBody), { admin, asUser, withinLimit });
    assertEquals(res.status, 429);
    assertEquals(keys.length, 2);
    assertEquals(new Set(keys).size, 2);
    assertEquals(sent.length, 0);
    assertEquals(admin.rowsIn("payments").length, 0);
  });
});

describe("one prompt at a time per invoice (FIG-1321)", () => {
  it("raises one prompt for two requests arriving together", async () => {
    const { admin, asUser } = makeClients();
    const sent = stubFetch(stkOk);
    const [a, b] = await Promise.all([
      handle(request(validBody), { admin, asUser }),
      handle(request(validBody), { admin, asUser }),
    ]);
    const outs = [await a.json(), await b.json()];
    assertEquals(sent.length, 1);
    assertEquals(admin.rowsIn("payments").length, 1);
    assertEquals(outs.filter((o) => o.reused).length, 1);
    assertEquals(outs[0].payment_id, outs[1].payment_id);
  });

  it("answers an error, not a new prompt, when the in-flight check can't tell", async () => {
    const { admin, asUser } = makeClients();
    // two pending prompts from before the index: maybeSingle() errors, as PostgREST does
    admin.seed("payments", [
      { id: "p1", invoice_id: INVOICE_ID, status: "pending", msisdn: validBody.msisdn, amount_cents: 50000, created_at: minutesAgo(0) },
      { id: "p2", invoice_id: INVOICE_ID, status: "pending", msisdn: validBody.msisdn, amount_cents: 50000, created_at: minutesAgo(0) },
    ]);
    const sent = stubFetch(stkOk);
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 500);
    assertEquals(sent.length, 0);
  });

  it("doesn't hand back another number's prompt, or one for another amount", async () => {
    const { admin, asUser } = makeClients();
    admin.seed("payments", [{
      id: "first", invoice_id: INVOICE_ID, status: "pending", msisdn: "254700000001", amount_cents: 10000, created_at: minutesAgo(0),
    }]);
    const sent = stubFetch(stkOk);
    const otherPhone = await handle(request({ ...validBody, msisdn: "254733999888" }), { admin, asUser });
    assertEquals(otherPhone.status, 409);
    assertEquals((await otherPhone.json()).payment_id, undefined);
    const otherAmount = await handle(request({ ...validBody, msisdn: "254700000001" }), { admin, asUser });
    assertEquals(otherAmount.status, 409);
    assertEquals(sent.length, 0);
  });

  it("settles a stale prompt Daraja says was cancelled, then raises a new one", async () => {
    const { admin, asUser } = makeClients();
    admin.seed("payments", [{
      id: "old", invoice_id: INVOICE_ID, status: "pending", msisdn: "254700000001", amount_cents: 10000,
      checkout_request_id: "ws_CO_old", created_at: minutesAgo(5),
    }]);
    const sent = stubFetch(stkOk);
    const queryStk = () => Promise.resolve({ done: true as const, resultCode: 1032 });
    const res = await handle(request(validBody), { admin, asUser, queryStk });
    assertEquals(res.status, 200);
    assertEquals(sent.length, 1);
    const old = admin.rowsIn("payments").find((p) => p.id === "old")!;
    assertEquals(old.status, "cancelled");
    assertEquals(old.failure_reason, "cancelled");
  });

  it("never prompts again over a stale prompt Daraja says was paid", async () => {
    const { admin, asUser } = makeClients();
    admin.seed("payments", [{
      id: "old", invoice_id: INVOICE_ID, status: "pending", msisdn: validBody.msisdn, amount_cents: 50000,
      checkout_request_id: "ws_CO_old", created_at: minutesAgo(5),
    }]);
    const sent = stubFetch(stkOk);
    const queryStk = () => Promise.resolve({ done: true as const, resultCode: 0 });
    const res = await handle(request(validBody), { admin, asUser, queryStk });
    assertEquals(res.status, 409);
    assertEquals(sent.length, 0);
    assertEquals(admin.rowsIn("payments")[0].status, "pending");
  });

  it("waits while Daraja is still processing a stale prompt, or can't be reached", async () => {
    const { admin, asUser } = makeClients();
    admin.seed("payments", [{
      id: "old", invoice_id: INVOICE_ID, status: "pending", msisdn: validBody.msisdn, amount_cents: 50000,
      checkout_request_id: "ws_CO_old", created_at: minutesAgo(5),
    }]);
    const sent = stubFetch(stkOk);
    const processing = await handle(request(validBody), { admin, asUser, queryStk: () => Promise.resolve({ done: false as const }) });
    assertEquals(processing.status, 409);
    const unreachable = await handle(request(validBody), { admin, asUser, queryStk: () => Promise.reject(new Error("down")) });
    assertEquals(unreachable.status, 502);
    assertEquals(sent.length, 0);
    assertEquals(admin.rowsIn("payments")[0].status, "pending");
  });

  it("fails a stale prompt that never reached Safaricom, then raises a new one", async () => {
    const { admin, asUser } = makeClients();
    admin.seed("payments", [{
      id: "old", invoice_id: INVOICE_ID, status: "pending", msisdn: validBody.msisdn, amount_cents: 50000, created_at: minutesAgo(5),
    }]);
    const sent = stubFetch(stkOk);
    const res = await handle(request(validBody), { admin, asUser, queryStk: () => Promise.reject(new Error("not called")) });
    assertEquals(res.status, 200);
    assertEquals(sent.length, 1);
    assertEquals(admin.rowsIn("payments").find((p) => p.id === "old")!.failure_reason, "unreachable");
  });
});
