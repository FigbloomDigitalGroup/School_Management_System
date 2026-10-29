import { afterEach, beforeEach, describe, it } from "jsr:@std/testing/bdd";
import { assertEquals } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle as raisePrompt } from "../mpesa-stk-push/index.ts";
import { handle as callback } from "./index.ts";

/**
 * QA 06 (FIG-1239): the two M-Pesa functions together, with Safaricom played by a stub. mpesa-stk-push builds the URL
 * Safaricom will post to (adding ?token=<secret>) and mpesa-callback checks it; each is tested alone elsewhere, so a
 * change to how one writes or reads the secret could break payments without either test noticing.
 */

const VARS = ["DARAJA_CALLBACK_URL", "DARAJA_CALLBACK_SECRET", "DARAJA_SHORTCODE", "DARAJA_PASSKEY", "DARAJA_CONSUMER_KEY", "DARAJA_CONSUMER_SECRET"];
let envBefore: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
const warn = console.warn;

beforeEach(() => {
  envBefore = Object.fromEntries(VARS.map((k) => [k, Deno.env.get(k)]));
  Deno.env.set("DARAJA_CALLBACK_URL", "https://example.supabase.co/functions/v1/mpesa-callback");
  Deno.env.set("DARAJA_SHORTCODE", "174379");
  Deno.env.set("DARAJA_PASSKEY", "passkey");
  Deno.env.set("DARAJA_CONSUMER_KEY", "key");
  Deno.env.set("DARAJA_CONSUMER_SECRET", "secret");
  console.warn = () => {};
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = warn;
  for (const [k, v] of Object.entries(envBefore)) {
    if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v);
  }
});

/** Safaricom: accepts the prompt, remembers the callback URL it was given. */
function safaricom() {
  const seen: { callbackUrl?: string; amount?: number } = {};
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    if (url.toString().includes("/oauth/v1/generate")) return Promise.resolve(new Response(JSON.stringify({ access_token: "t" })));
    const body = JSON.parse(String(init?.body));
    seen.callbackUrl = body.CallBackURL;
    seen.amount = body.Amount;
    return Promise.resolve(new Response(JSON.stringify({ ResponseCode: "0", CheckoutRequestID: "ws_CO_ROUND_TRIP" })));
  }) as typeof fetch;
  return seen;
}

function school() {
  const admin = new FakeSupabaseClient();
  const asUser = new FakeSupabaseClient();
  asUser.authUser = { id: "parent-1" };
  asUser.seed("fee_invoices", [{ id: "invoice-1", tenant_id: "tenant-1", total_cents: 100000, paid_cents: 0 }]);
  return { admin, asUser };
}

const promptRequest = new Request("https://example.com/mpesa-stk-push", {
  method: "POST",
  headers: { Authorization: "Bearer token" },
  body: JSON.stringify({ invoice_id: "invoice-1", amount_cents: 50000, msisdn: "254712345678" }),
});

const paid = (receipt: string) => JSON.stringify({
  Body: { stkCallback: { CheckoutRequestID: "ws_CO_ROUND_TRIP", ResultCode: 0, CallbackMetadata: { Item: [{ Name: "MpesaReceiptNumber", Value: receipt }, { Name: "Amount", Value: 500 }] } } },
});

describe("prompt, then Safaricom's callback", () => {
  for (const secret of ["plain-secret", "a+b&c=d%e f/é?#=", "0123456789abcdef".repeat(4)]) {
    it(`credits the payment the prompt created, for the secret ${JSON.stringify(secret.length > 20 ? secret.slice(0, 16) + "…" : secret)}`, async () => {
      Deno.env.set("DARAJA_CALLBACK_SECRET", secret);
      const { admin, asUser } = school();
      const seen = safaricom();

      const started = await raisePrompt(promptRequest.clone(), { admin, asUser });
      assertEquals(started.status, 200);
      assertEquals(seen.amount, 500);
      const pending = admin.rowsIn("payments")[0];
      assertEquals(pending.status, "pending");
      assertEquals(pending.checkout_request_id, "ws_CO_ROUND_TRIP");

      const queries: string[] = [];
      const deps = { admin, callbackSecret: secret, queryStk: (id: string) => { queries.push(id); return Promise.resolve({ done: true as const, resultCode: 0 }); } };

      // Safaricom posts to exactly the URL it was given
      const delivered = await callback(new Request(seen.callbackUrl!, { method: "POST", body: paid("SFC77AAA") }), deps);
      assertEquals(delivered.status, 200);
      const settled = admin.rowsIn("payments")[0];
      assertEquals(settled.status, "success");
      assertEquals(settled.amount_cents, 50000);
      assertEquals(settled.mpesa_receipt, "SFC77AAA");
      assertEquals(queries, ["ws_CO_ROUND_TRIP"]);

      // the same URL with the token taken off, or changed, is refused
      for (const forged of [(u: URL) => u.searchParams.delete("token"), (u: URL) => u.searchParams.set("token", secret + "x")]) {
        const url = new URL(seen.callbackUrl!);
        forged(url);
        assertEquals((await callback(new Request(url, { method: "POST", body: paid("FORGED1") }), deps)).status, 403);
      }
      assertEquals(admin.rowsIn("payments")[0].mpesa_receipt, "SFC77AAA");
    });
  }
});
