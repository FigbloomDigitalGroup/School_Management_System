import { afterEach, beforeEach, describe, it } from "jsr:@std/testing/bdd";
import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { queryStk } from "../_shared/daraja.ts";
import { handle as stkPush } from "../mpesa-stk-push/index.ts";
import { handle as callback } from "./index.ts";

/**
 * Daraja's sandbox throttles the STK query (HTTP 429), so a callback could not
 * confirm a paid prompt and left it pending for good. The real queryStk is used
 * here, with Daraja played by a stub and its waits skipped: the callback asks
 * again for a few seconds, and a payment still left pending is settled by
 * mpesa-stk-push's "check" action, through the same code, once.
 */

const SECRET = "callback-secret";
const CHECKOUT_ID = "ws_CO_1234";
const PAYMENT_ID = "payment-1";
const VARS = ["DARAJA_SHORTCODE", "DARAJA_PASSKEY", "DARAJA_CONSUMER_KEY", "DARAJA_CONSUMER_SECRET", "DARAJA_TENANTS"];
let envBefore: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
const quiet = { log: console.log, warn: console.warn, error: console.error };
let logged: string[] = [];

beforeEach(() => {
  envBefore = Object.fromEntries(VARS.map((k) => [k, Deno.env.get(k)]));
  Deno.env.set("DARAJA_SHORTCODE", "174379");
  Deno.env.set("DARAJA_PASSKEY", "passkey");
  Deno.env.set("DARAJA_CONSUMER_KEY", "key");
  Deno.env.set("DARAJA_CONSUMER_SECRET", "secret");
  Deno.env.delete("DARAJA_TENANTS");
  logged = [];
  const keep = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  console.log = keep; console.warn = keep; console.error = keep;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(console, quiet);
  for (const [k, v] of Object.entries(envBefore)) {
    if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v);
  }
});

const noWait = { sleep: () => Promise.resolve() };
/** The real query, its waits skipped; options as the caller passes them. */
const realQuery = (id: string, retry = {}) => queryStk(id, { ...retry, ...noWait });

/** Daraja: OAuth always works; each STK query gets the next answer (the last repeats). Counts the queries. */
function daraja(...answers: ("429" | "processing" | number)[]) {
  const state = { queries: 0 };
  globalThis.fetch = ((url: string | URL) => {
    if (url.toString().includes("/oauth/v1/generate")) return Promise.resolve(new Response(JSON.stringify({ access_token: "t" })));
    const a = answers[Math.min(state.queries++, answers.length - 1)];
    if (a === "429") return Promise.resolve(new Response(JSON.stringify({ errorMessage: "no result" }), { status: 429 }));
    if (a === "processing") return Promise.resolve(new Response(JSON.stringify({ errorCode: "500.001.1001" }), { status: 500 }));
    return Promise.resolve(new Response(JSON.stringify({ ResponseCode: "0", ResultCode: String(a), ResultDesc: "x" })));
  }) as typeof fetch;
  return state;
}

const secondsAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString();

/** A pending prompt raised `age` seconds ago; the parent can read it (RLS), the admin client holds it. */
function school(age = 30) {
  const admin = new FakeSupabaseClient();
  const asUser = new FakeSupabaseClient();
  asUser.authUser = { id: "parent-1" };
  const payment = {
    id: PAYMENT_ID, tenant_id: "tenant-1", invoice_id: "invoice-1", checkout_request_id: CHECKOUT_ID,
    status: "pending", amount_cents: 50000, msisdn: "254712345678", created_at: secondsAgo(age),
  };
  admin.seed("payments", [payment]);
  asUser.seed("payments", [{ id: PAYMENT_ID }]);
  return { admin, asUser };
}

function paidCallback(desc = "The service request is processed successfully.") {
  return new Request(`https://example.com/mpesa-callback?token=${SECRET}`, {
    method: "POST",
    body: JSON.stringify({
      Body: {
        stkCallback: {
          CheckoutRequestID: CHECKOUT_ID, ResultCode: 0, ResultDesc: desc,
          CallbackMetadata: { Item: [{ Name: "MpesaReceiptNumber", Value: "SFC1234ABC" }, { Name: "Amount", Value: 500 }, { Name: "PhoneNumber", Value: 254712345678 }] },
        },
      },
    }),
  });
}

const check = (paymentId: unknown = PAYMENT_ID) => new Request("https://example.com/mpesa-stk-push", {
  method: "POST", headers: { Authorization: "Bearer token" }, body: JSON.stringify({ action: "check", payment_id: paymentId }),
});

const row = (admin: FakeSupabaseClient) => admin.rowsIn("payments")[0];
const credits = (admin: FakeSupabaseClient) => admin.rowsIn("audit_events").length;

describe("mpesa-callback when Daraja throttles the confirming query", () => {
  it("429, then the result: credited once, in the same delivery", async () => {
    const { admin } = school();
    const d = daraja("429", 0);
    const res = await callback(paidCallback(), { admin, callbackSecret: SECRET, queryStk: realQuery });
    assertEquals(res.status, 200);
    assertEquals(d.queries, 2);
    assertEquals(row(admin).status, "success");
    assertEquals(row(admin).mpesa_receipt, "SFC1234ABC");
    assertEquals(credits(admin), 1);
  });

  it("429 every time: stays pending, answers 500 so Safaricom may redeliver, keeps the reported receipt", async () => {
    const { admin } = school();
    const d = daraja("429");
    const res = await callback(paidCallback(), { admin, callbackSecret: SECRET, queryStk: realQuery });
    assertEquals(res.status, 500);
    assertEquals((await res.json()).ResultDesc, "Try again");
    assertEquals(d.queries, 4);
    assertEquals(row(admin).status, "pending");
    assertEquals(row(admin).mpesa_receipt, "SFC1234ABC");
    assertEquals(credits(admin), 0);
  });

  it("logs what Safaricom reported, by payment id, without the phone number or amount", async () => {
    const { admin } = school();
    daraja(0);
    await callback(paidCallback("[MMI code]\nerror"), { admin, callbackSecret: SECRET, queryStk: realQuery });
    const line = logged.find((l) => l.includes("Safaricom reported"))!;
    assertStringIncludes(line, `payment ${PAYMENT_ID}: Safaricom reported ResultCode 0 ([MMI code] error)`);
    for (const l of logged) {
      assertEquals(l.includes("254712345678") || l.includes("712345678"), false, l);
      assertEquals(/\b500\b|50000/.test(l), false, l);
    }
  });
});

describe("mpesa-stk-push 'check': settling a payment the callback couldn't confirm", () => {
  it("settles it later, without a new prompt, with the callback's receipt; a late callback changes nothing", async () => {
    const { admin, asUser } = school();
    daraja("429");
    assertEquals((await callback(paidCallback(), { admin, callbackSecret: SECRET, queryStk: realQuery })).status, 500);

    const d = daraja(0);
    const res = await stkPush(check(), { admin, asUser, queryStk: realQuery });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { payment_id: PAYMENT_ID, status: "success" });
    assertEquals(d.queries, 1);
    assertEquals(row(admin).status, "success");
    assertEquals(row(admin).mpesa_receipt, "SFC1234ABC");
    assertEquals(admin.rowsIn("payments").length, 1);   // no new prompt
    assertEquals(credits(admin), 1);

    // Safaricom redelivers after all: already settled, Daraja isn't asked, nothing is credited twice
    const late = daraja(0);
    assertEquals((await callback(paidCallback(), { admin, callbackSecret: SECRET, queryStk: realQuery })).status, 200);
    assertEquals(late.queries, 0);
    assertEquals(credits(admin), 1);
    // and another check just reads it
    assertEquals(await (await stkPush(check(), { admin, asUser, queryStk: realQuery })).json(), { payment_id: PAYMENT_ID, status: "success" });
    assertEquals(late.queries, 0);
  });

  it("a check and a callback settling at once credit once", async () => {
    const { admin, asUser } = school();
    daraja(0);
    await Promise.all([
      stkPush(check(), { admin, asUser, queryStk: realQuery }),
      callback(paidCallback(), { admin, callbackSecret: SECRET, queryStk: realQuery }),
    ]);
    assertEquals(row(admin).status, "success");
    assertEquals(credits(admin), 1);
  });

  it("never credits without a result from Daraja: throttled or still processing stays pending", async () => {
    for (const answer of ["429", "processing"] as const) {
      const { admin, asUser } = school();
      const d = daraja(answer);
      const res = await stkPush(check(), { admin, asUser, queryStk: realQuery });
      assertEquals(await res.json(), { payment_id: PAYMENT_ID, status: "pending" });
      assertEquals(row(admin).status, "pending");
      assertEquals(credits(admin), 0);
      // throttled: asked again within the budget; processing: asked once, the app checks again later
      assertEquals(d.queries, answer === "429" ? 4 : 1);
    }
  });

  it("settles it unpaid when Daraja says so, and drops a receipt the callback claimed", async () => {
    const { admin, asUser } = school();
    daraja("429");
    await callback(paidCallback(), { admin, callbackSecret: SECRET, queryStk: realQuery });
    daraja(1032);
    assertEquals(await (await stkPush(check(), { admin, asUser, queryStk: realQuery })).json(), { payment_id: PAYMENT_ID, status: "cancelled" });
    assertEquals(row(admin).mpesa_receipt, null);
    assertEquals(credits(admin), 0);
  });

  it("refuses a caller who can't read the payment, without asking Daraja", async () => {
    const { admin } = school();
    const stranger = new FakeSupabaseClient();
    stranger.authUser = { id: "someone-else" };
    const d = daraja(0);
    const res = await stkPush(check(), { admin, asUser: stranger, queryStk: realQuery });
    assertEquals(res.status, 403);
    assertEquals(d.queries, 0);
    assertEquals(row(admin).status, "pending");
  });

  it("refuses a caller who isn't signed in, and a request with no payment id", async () => {
    const { admin, asUser } = school();
    const d = daraja(0);
    const anon = new FakeSupabaseClient();
    assertEquals((await stkPush(check(), { admin, asUser: anon, queryStk: realQuery })).status, 401);
    assertEquals((await stkPush(check(""), { admin, asUser, queryStk: realQuery })).status, 400);
    assertEquals(d.queries, 0);
  });

  it("doesn't ask Daraja about a prompt younger than 20 s: the callback is still the usual answer", async () => {
    const { admin, asUser } = school(5);
    const d = daraja(0);
    assertEquals(await (await stkPush(check(), { admin, asUser, queryStk: realQuery })).json(), { payment_id: PAYMENT_ID, status: "pending" });
    assertEquals(d.queries, 0);
  });

  it("doesn't ask Daraja past the per-payment limit", async () => {
    const { admin, asUser } = school();
    const d = daraja(0);
    const keys: string[] = [];
    const checkLimit = (key: string) => { keys.push(key); return Promise.resolve(false); };
    assertEquals(await (await stkPush(check(), { admin, asUser, queryStk: realQuery, checkLimit })).json(), { payment_id: PAYMENT_ID, status: "pending" });
    assertEquals(d.queries, 0);
    assertEquals(keys.length, 1);
  });

  it("doesn't ask Daraja about a school not in DARAJA_TENANTS", async () => {
    Deno.env.set("DARAJA_TENANTS", "tenant-demo");
    const { admin, asUser } = school();
    const d = daraja(0);
    assertEquals(await (await stkPush(check(), { admin, asUser, queryStk: realQuery })).json(), { payment_id: PAYMENT_ID, status: "pending" });
    assertEquals(d.queries, 0);
  });
});
