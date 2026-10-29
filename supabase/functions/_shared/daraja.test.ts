import { afterEach, beforeEach, describe, it } from "jsr:@std/testing/bdd";
import { assertEquals, assertRejects } from "jsr:@std/assert";
import { queryStk } from "./daraja.ts";

const originalFetch = globalThis.fetch;

/** Daraja stubbed: the OAuth call succeeds, the STK query answers `query` with `status`. */
function daraja(query: unknown, status = 200) {
  globalThis.fetch = ((url: string | URL) => {
    if (String(url).includes("/oauth/")) return Promise.resolve(Response.json({ access_token: "token" }));
    return Promise.resolve(new Response(JSON.stringify(query), { status, headers: { "Content-Type": "application/json" } }));
  }) as typeof fetch;
}

const ENV = { DARAJA_SHORTCODE: "174379", DARAJA_PASSKEY: "passkey", DARAJA_CONSUMER_KEY: "key", DARAJA_CONSUMER_SECRET: "secret" };

describe("queryStk", () => {
  // put back what was there: check-services reads these to say whether M-Pesa is set up
  const before: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) { before[k] = Deno.env.get(k); Deno.env.set(k, v); }
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const k of Object.keys(ENV)) {
      if (before[k] === undefined) Deno.env.delete(k); else Deno.env.set(k, before[k]!);
    }
  });

  it("reads a paid prompt", async () => {
    daraja({ ResponseCode: "0", ResultCode: "0" });
    assertEquals(await queryStk("ws_CO_1"), { done: true, resultCode: 0 });
  });

  it("reads a cancelled prompt, as a string or a number", async () => {
    daraja({ ResponseCode: "0", ResultCode: "1032" });
    assertEquals(await queryStk("ws_CO_1"), { done: true, resultCode: 1032 });
    daraja({ ResponseCode: "0", ResultCode: 1032 });
    assertEquals(await queryStk("ws_CO_1"), { done: true, resultCode: 1032 });
  });

  it("says the prompt is still open while Daraja is processing it", async () => {
    daraja({ errorCode: "500.001.1001", errorMessage: "The transaction is being processed" }, 500);
    assertEquals(await queryStk("ws_CO_1"), { done: false });
  });

  it("throws when there is no ResultCode, so the callback is retried", async () => {
    daraja({ ResponseCode: "0" });
    await assertRejects(() => queryStk("ws_CO_1"));
  });

  // FIG-1322: Number("") and Number(null) are 0, which read as paid; "abc" read as a permanent failure
  for (const unreadable of ["", null, "abc", " 0", "1.5", true, {}]) {
    it(`throws on ResultCode ${JSON.stringify(unreadable)} instead of reading it as a result`, async () => {
      daraja({ ResponseCode: "0", ResultCode: unreadable });
      await assertRejects(() => queryStk("ws_CO_1"), Error, "unreadable result");
    });
  }
});
