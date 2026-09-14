import { describe, it, afterEach } from "jsr:@std/testing/bdd";
import { assertEquals } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle } from "./index.ts";

const INVOICE_ID = "invoice-1";
const PARENT_ID = "parent-1";

function makeClients(invoiceOverrides: Record<string, unknown> = {}) {
  const admin = new FakeSupabaseClient();
  const asUser = new FakeSupabaseClient();
  asUser.authUser = { id: PARENT_ID };
  asUser.seed("fee_invoices", [{
    id: INVOICE_ID, tenant_id: "tenant-1", total_cents: 100000, paid_cents: 0, ...invoiceOverrides,
  }]);
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

/** Routes fetch by URL: oauth token endpoint vs. the STK push endpoint. */
function stubFetch(stkResponse: () => Response | Promise<Response>) {
  globalThis.fetch = ((url: string | URL) => {
    const href = url.toString();
    if (href.includes("/oauth/v1/generate")) {
      return Promise.resolve(new Response(JSON.stringify({ access_token: "test-token" }), { status: 200 }));
    }
    if (href.includes("/stkpush/v1/processrequest")) return Promise.resolve(stkResponse());
    throw new Error(`Unexpected fetch to ${href}`);
  }) as typeof fetch;
}

describe("mpesa-stk-push handle", () => {
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
      id: "existing-payment", invoice_id: INVOICE_ID, status: "pending",
      created_at: new Date().toISOString(),
    }]);
    const res = await handle(request(validBody), { admin, asUser });
    const out = await res.json();
    assertEquals(out.reused, true);
    assertEquals(out.payment_id, "existing-payment");
  });

  it("starts a payment and stores the checkout request id on success", async () => {
    const { admin, asUser } = makeClients();
    stubFetch(() => new Response(JSON.stringify({ ResponseCode: "0", CheckoutRequestID: "ws_CO_999" }), { status: 200 }));

    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.checkout_request_id, "ws_CO_999");

    const payment = admin.rowsIn("payments").find((p) => p.id === out.payment_id);
    assertEquals(payment?.status, "pending");
    assertEquals(payment?.checkout_request_id, "ws_CO_999");
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
