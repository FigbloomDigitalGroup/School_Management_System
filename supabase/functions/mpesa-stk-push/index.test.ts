import { describe, it, afterEach, beforeEach } from "jsr:@std/testing/bdd";
import { assertEquals } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { itFails } from "../_shared/knownDefect.ts";
import { handle } from "./index.ts";

const INVOICE_ID = "invoice-1";
const PARENT_ID = "parent-1";

beforeEach(() => {
  Deno.env.set("DARAJA_CALLBACK_URL", "https://example.supabase.co/functions/v1/mpesa-callback");
  Deno.env.set("DARAJA_CALLBACK_SECRET", "callback-secret");
});

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

// QA 06 (FIG-1239) -------------------------------------------------------------------------------------------------

/** A Daraja that accepts every prompt, with a different CheckoutRequestID each time. Returns the STK bodies sent. */
function stubAccepting() {
  let n = 0;
  return stubFetch(() => new Response(JSON.stringify({ ResponseCode: "0", CheckoutRequestID: `ws_CO_${++n}` }), { status: 200 }));
}

/** A raw request body, for bodies JSON.stringify can't produce (the literal `null`). */
function rawRequest(body: string) {
  return new Request("https://example.com/mpesa-stk-push", { method: "POST", headers: { Authorization: "Bearer token" }, body });
}

describe("mpesa-stk-push: refused before any prompt is sent", () => {
  const badAmounts: [string, unknown][] = [
    ["zero", 0], ["a negative", -100], ["below KSh 1", 99], ["not whole shillings", 150], ["a fraction", 50050.5],
    ["a string", "50000"], ["a boolean", true], ["null", null], ["missing", undefined], ["an array", [50000]],
    ["an object", { cents: 50000 }], ["absurdly large", 1e21], ["the largest safe integer", Number.MAX_SAFE_INTEGER],
  ];
  for (const [label, amount_cents] of badAmounts) {
    it(`refuses an amount that is ${label}, creates no payment and contacts nobody`, async () => {
      const { admin, asUser } = makeClients();
      const sent = stubAccepting();
      const res = await handle(request({ ...validBody, amount_cents }), { admin, asUser });
      assertEquals(res.status, 400);
      assertEquals(admin.rowsIn("payments").length, 0);
      assertEquals(sent.length, 0);
    });
  }

  const badNumbers: [string, unknown][] = [
    ["with a leading zero", "0712345678"], ["with a plus sign", "+254712345678"], ["with spaces", "254 712 345 678"],
    ["without the country code", "712345678"], ["one digit too long", "2547123456789"], ["one digit too short", "25471234567"],
    ["a landline prefix", "254212345678"], ["a prefix Safaricom doesn't use", "254812345678"], ["empty", ""],
    ["a number, not a string", 254712345678], ["null", null], ["missing", undefined], ["followed by a newline", "254712345678\n"],
    ["in full-width digits", "２５４７１２３４５６７８"],
  ];
  for (const [label, msisdn] of badNumbers) {
    it(`refuses a phone number ${label}`, async () => {
      const { admin, asUser } = makeClients();
      const sent = stubAccepting();
      const res = await handle(request({ ...validBody, msisdn }), { admin, asUser });
      assertEquals(res.status, 400);
      assertEquals(admin.rowsIn("payments").length, 0);
      assertEquals(sent.length, 0);
    });
  }

  for (const msisdn of ["254712345678", "254112345678", "254700000000", "254799999999"]) {
    it(`accepts ${msisdn} and prompts exactly that number`, async () => {
      const { admin, asUser } = makeClients();
      const sent = stubAccepting();
      const res = await handle(request({ ...validBody, msisdn }), { admin, asUser });
      assertEquals(res.status, 200);
      assertEquals(sent.length, 1);
      assertEquals(sent[0].PhoneNumber, msisdn);
      assertEquals(sent[0].PartyA, msisdn);
    });
  }

  it("refuses more than the balance without creating a payment or contacting Safaricom", async () => {
    const { admin, asUser } = makeClients({ total_cents: 100000, paid_cents: 90000 });
    const sent = stubAccepting();
    const res = await handle(request({ ...validBody, amount_cents: 50000 }), { admin, asUser });
    assertEquals(res.status, 400);
    assertEquals(admin.rowsIn("payments").length, 0);
    assertEquals(sent.length, 0);
  });

  it("allows paying exactly the balance, and one shilling less", async () => {
    for (const amount_cents of [10000, 9900]) {
      const { admin, asUser } = makeClients({ total_cents: 100000, paid_cents: 90000 });
      const sent = stubAccepting();
      assertEquals((await handle(request({ ...validBody, amount_cents }), { admin, asUser })).status, 200);
      assertEquals(sent[0].Amount, amount_cents / 100);
    }
  });

  for (const [label, invoice] of [["fully paid", { total_cents: 100000, paid_cents: 100000 }], ["overpaid", { total_cents: 100000, paid_cents: 150000 }]] as const) {
    it(`refuses a prompt for an invoice that is ${label}`, async () => {
      const { admin, asUser } = makeClients(invoice);
      const sent = stubAccepting();
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 400);
      assertEquals(admin.rowsIn("payments").length, 0);
      assertEquals(sent.length, 0);
    });
  }

  for (const body of ["[]", '"text"', "5", "true"]) {
    it(`answers 400, not an error, to a JSON body of ${body}`, async () => {
      const { admin, asUser } = makeClients();
      const res = await handle(rawRequest(body), { admin, asUser });
      assertEquals(res.status, 400);
    });
  }

  // `const { invoice_id, ... } = body` throws on null, so the function answers with an unhandled error, not a 400.
  itFails("FIG-1324 (open): a JSON body of null is answered with a 400", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(rawRequest("null"), { admin, asUser });
    assertEquals(res.status, 400);
  });

  it("answers 500 and sends no prompt when the payment row can't be created", async () => {
    const { admin, asUser } = makeClients();
    const sent = stubAccepting();
    admin.failNextWrite("payments", "database unavailable");
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 500);
    assertEquals(sent.length, 0);
  });
});

describe("mpesa-stk-push: the double-tap guard", () => {
  const pendingRow = (over: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(), invoice_id: INVOICE_ID, status: "pending", amount_cents: 10000, msisdn: "254700000001",
    created_at: new Date().toISOString(), ...over,
  });

  it("raises one prompt for two taps that arrive one after the other", async () => {
    const { admin, asUser } = makeClients();
    const sent = stubAccepting();
    const first = await (await handle(request(validBody), { admin, asUser })).json();
    const second = await (await handle(request(validBody), { admin, asUser })).json();
    assertEquals(sent.length, 1);
    assertEquals(second.payment_id, first.payment_id);
    assertEquals(second.reused, true);
  });

  it("raises a new prompt when the pending one is older than 90 seconds", async () => {
    const { admin, asUser } = makeClients();
    admin.seed("payments", [pendingRow({ created_at: new Date(Date.now() - 91_000).toISOString() })]);
    const sent = stubAccepting();
    const out = await (await handle(request(validBody), { admin, asUser })).json();
    assertEquals(sent.length, 1);
    assertEquals(out.reused, undefined);
  });

  it("raises a new prompt when the earlier one has already settled", async () => {
    const { admin, asUser } = makeClients();
    admin.seed("payments", [pendingRow({ status: "cancelled" })]);
    const sent = stubAccepting();
    const out = await (await handle(request(validBody), { admin, asUser })).json();
    assertEquals(sent.length, 1);
    assertEquals(out.reused, undefined);
  });

  it("does not reuse another invoice's prompt", async () => {
    const { admin, asUser } = makeClients();
    admin.seed("payments", [pendingRow({ invoice_id: "someone-elses-invoice" })]);
    const sent = stubAccepting();
    assertEquals((await handle(request(validBody), { admin, asUser })).status, 200);
    assertEquals(sent.length, 1);
  });

  // The guard reads, then writes, with nothing between them to stop a second request reading before the first has
  // written, and the database has no unique index on (invoice_id) where status = 'pending' to catch it either.
  itFails("FIG-1321 (open): two taps that arrive together raise one prompt", async () => {
    const { admin, asUser } = makeClients();
    const sent = stubAccepting();
    await Promise.all([handle(request(validBody), { admin, asUser }), handle(request(validBody), { admin, asUser })]);
    assertEquals(sent.length, 1);
  });

  // The guard uses .maybeSingle(), which answers an ERROR (not "the first row") once two rows match; the code only
  // reads `data`, so the error looks like "nothing in flight" and a third prompt goes out. After the race above, every
  // tap for the rest of the 90 seconds raises another prompt.
  itFails("FIG-1321 (open): the guard still holds once two prompts are pending", async () => {
    const { admin, asUser } = makeClients();
    admin.seed("payments", [pendingRow(), pendingRow()]);
    const sent = stubAccepting();
    const out = await (await handle(request(validBody), { admin, asUser })).json();
    assertEquals(sent.length, 0);
    assertEquals(out.reused, true);
  });

  // The guard is keyed on the invoice alone. A second request with another phone number or amount, within 90 seconds,
  // is answered with the first request's payment id and no prompt: a corrected mistyped number is never prompted, and
  // a different payer (parent, then the learner) ends up watching somebody else's payment.
  itFails("FIG-1321 (open): a request for another number or amount is not answered with the earlier prompt", async () => {
    const { admin, asUser } = makeClients();
    const earlier = pendingRow();
    admin.seed("payments", [earlier]);
    stubAccepting();
    const res = await handle(request({ ...validBody, amount_cents: 50000, msisdn: "254733999888" }), { admin, asUser });
    const out = await res.json();
    assertEquals(out.payment_id === earlier.id, false);
  });
});

// "Any guardian or staff can prompt any phone number" (PRODUCTION_TODO, known): confirmed. Nothing compares the number
// with the caller, and the only limits are per invoice. These pass while that is true; when FIG-1320 is fixed they
// should be replaced by tests of the new rule.
describe("mpesa-stk-push: who can be prompted (FIG-1320)", () => {
  it("prompts a number that has nothing to do with the caller", async () => {
    const { admin, asUser } = makeClients();
    asUser.seed("profiles", [{ id: PARENT_ID, role: "parent", phone: "+254700111222" }]);
    const sent = stubAccepting();
    const res = await handle(request({ ...validBody, msisdn: "254733999888" }), { admin, asUser });
    assertEquals(res.status, 200);
    assertEquals(sent[0].PhoneNumber, "254733999888");
  });

  it("lets one caller prompt the same stranger for every invoice they can see, with no limit", async () => {
    const asUserInvoices = Array.from({ length: 25 }, (_, i) => ({ id: `invoice-${i}`, tenant_id: "tenant-1", total_cents: 100000, paid_cents: 0 }));
    const admin = new FakeSupabaseClient();
    const asUser = new FakeSupabaseClient();
    asUser.authUser = { id: "teacher-1" }; // school staff can read every learner's invoice (RLS), see QA 04
    asUser.seed("fee_invoices", asUserInvoices);
    const sent = stubAccepting();
    for (const inv of asUserInvoices) {
      const res = await handle(request({ ...validBody, invoice_id: inv.id, msisdn: "254733999888" }), { admin, asUser });
      assertEquals(res.status, 200);
    }
    assertEquals(sent.length, 25);
    assertEquals(new Set(sent.map((s) => s.PhoneNumber)).size, 1);
  });
});
