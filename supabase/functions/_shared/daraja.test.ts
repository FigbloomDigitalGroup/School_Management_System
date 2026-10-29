import { afterEach, beforeEach, describe, it } from "jsr:@std/testing/bdd";
import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert";
import { darajaToken, queryStk, secretsMatch, stkPassword, timestamp } from "./daraja.ts";
import { itFails } from "./knownDefect.ts";

const realFetch = globalThis.fetch;
const realNow = Date.now;

// The process environment is shared by every test file (check-services asserts that no Daraja secret is set), so put
// back whatever was there.
const ENV = {
  DARAJA_SHORTCODE: "174379",
  DARAJA_PASSKEY: "the-passkey",
  DARAJA_CONSUMER_KEY: "the-key",
  DARAJA_CONSUMER_SECRET: "the-secret",
};
let envBefore: Record<string, string | undefined> = {};

beforeEach(() => {
  envBefore = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  for (const [k, v] of Object.entries(envBefore)) {
    if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v);
  }
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Routes fetch: the OAuth call answers `oauth`, everything else answers `answer`. Returns what was sent. */
function stubDaraja(answer: () => Response, oauth: () => Response = () => json({ access_token: "test-token" })) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    const href = url.toString();
    calls.push({ url: href, init });
    return Promise.resolve(href.includes("/oauth/v1/generate") ? oauth() : answer());
  }) as typeof fetch;
  return calls;
}

describe("queryStk (how mpesa-callback confirms a result with Daraja)", () => {
  it("asks about this checkout id, with a bearer token and the STK password, on the sandbox by default", async () => {
    const calls = stubDaraja(() => json({ ResponseCode: "0", ResultCode: "0" }));
    await queryStk("ws_CO_1234");

    const query = calls[1];
    assertEquals(query.url, "https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query");
    assertEquals((query.init?.headers as Record<string, string>).Authorization, "Bearer test-token");
    const body = JSON.parse(String(query.init?.body));
    assertEquals(body.CheckoutRequestID, "ws_CO_1234");
    assertEquals(body.BusinessShortCode, "174379");
    assertEquals(body.Password, stkPassword("174379", "the-passkey", body.Timestamp));
  });

  it("reads a string result code: '0' is success, '1032' is the customer cancelling", async () => {
    stubDaraja(() => json({ ResponseCode: "0", ResultCode: "0" }));
    assertEquals(await queryStk("a"), { done: true, resultCode: 0 });
    stubDaraja(() => json({ ResponseCode: "0", ResultCode: "1032" }));
    assertEquals(await queryStk("a"), { done: true, resultCode: 1032 });
  });

  it("says 'not done yet' while the customer is on the PIN screen (HTTP 500, errorCode 500.001.1001)", async () => {
    stubDaraja(() => json({ errorCode: "500.001.1001", errorMessage: "The transaction is being processed" }, 500));
    assertEquals(await queryStk("a"), { done: false });
  });

  it("throws, so the callback answers 500 and Safaricom retries, on any other HTTP error", async () => {
    stubDaraja(() => json({ errorCode: "404.001.03", errorMessage: "Invalid Access Token" }, 404));
    const err = await assertRejects(() => queryStk("a"));
    assertStringIncludes(String(err), "404");
  });

  it("throws when Daraja answers 200 but not with ResponseCode 0", async () => {
    stubDaraja(() => json({ ResponseCode: "1", ResponseDescription: "Bad request" }));
    await assertRejects(() => queryStk("a"));
  });

  it("throws when the answer carries no result code at all", async () => {
    stubDaraja(() => json({ ResponseCode: "0", ResponseDescription: "ok" }));
    await assertRejects(() => queryStk("a"));
  });

  it("throws on a reply that isn't JSON (a gateway error page)", async () => {
    stubDaraja(() => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    await assertRejects(() => queryStk("a"));
  });

  it("throws when Safaricom's OAuth refuses us, without asking the status", async () => {
    const calls = stubDaraja(() => json({ ResponseCode: "0", ResultCode: "0" }), () => json({}, 400));
    await assertRejects(() => queryStk("a"), Error, "Could not authenticate with Safaricom");
    assertEquals(calls.length, 1);
  });

  // An empty or non-numeric ResultCode is read by Number(): "" and null become 0, which mpesa-callback takes for "paid",
  // and "abc" becomes NaN, which it takes for a permanent failure. The right answer to a result we can't read is to throw,
  // so the callback answers 500 and Safaricom asks again.
  for (const [label, resultCode] of [["an empty string", ""], ["null", null], ["a non-number", "abc"]] as const) {
    itFails(`FIG-1322 (open): ResultCode ${label} is refused, not read as a result`, async () => {
      stubDaraja(() => json({ ResponseCode: "0", ResultCode: resultCode }));
      await assertRejects(() => queryStk("a"));
    });
  }
});

describe("darajaToken", () => {
  it("sends the consumer key and secret as Basic auth and returns the access token", async () => {
    const calls = stubDaraja(() => json({}));
    assertEquals(await darajaToken(), "test-token");
    assertEquals((calls[0].init?.headers as Record<string, string>).Authorization, "Basic " + btoa("the-key:the-secret"));
  });
});

describe("timestamp and stkPassword", () => {
  it("writes Nairobi time (UTC+3) as YYYYMMDDHHmmss, across midnight UTC", () => {
    Date.now = () => Date.UTC(2026, 9, 29, 22, 30, 5);
    assertEquals(timestamp(), "20261030013005");
  });

  it("is base64 of shortcode + passkey + timestamp", () => {
    assertEquals(stkPassword("174379", "pk", "20261030013005"), btoa("174379pk20261030013005"));
  });
});

describe("which Daraja the functions talk to", () => {
  it("is the sandbox unless DARAJA_ENV is exactly 'production'", async () => {
    const was = Deno.env.get("DARAJA_ENV");
    try {
      Deno.env.delete("DARAJA_ENV");
      const unset = await import("./daraja.ts?env=unset");
      assertEquals(unset.darajaUrl("/x"), "https://sandbox.safaricom.co.ke/x");
      Deno.env.set("DARAJA_ENV", "Production");
      const wrongCase = await import("./daraja.ts?env=wrong-case");
      assertEquals(wrongCase.darajaUrl("/x"), "https://sandbox.safaricom.co.ke/x");
      Deno.env.set("DARAJA_ENV", "production");
      const live = await import("./daraja.ts?env=production");
      assertEquals(live.darajaUrl("/x"), "https://api.safaricom.co.ke/x");
    } finally {
      if (was === undefined) Deno.env.delete("DARAJA_ENV"); else Deno.env.set("DARAJA_ENV", was);
    }
  });
});

describe("secretsMatch (the callback's secret path)", () => {
  const SECRET = "s3cret-Value_123";

  it("accepts the exact secret", () => {
    assertEquals(secretsMatch(SECRET, SECRET), true);
  });

  for (const [label, given] of [
    ["nothing", null],
    ["an empty string", ""],
    ["a different secret of the same length", "S3cret-Value_123"],
    ["a prefix of the secret", SECRET.slice(0, -1)],
    ["the secret with something added", SECRET + "x"],
    ["the secret in another case", SECRET.toUpperCase()],
    ["the secret with surrounding spaces", ` ${SECRET} `],
  ] as const) {
    it(`refuses ${label}`, () => {
      assertEquals(secretsMatch(given, SECRET), false);
    });
  }

  it("compares bytes, so a multi-byte secret works and a look-alike doesn't", () => {
    assertEquals(secretsMatch("clé-secrète", "clé-secrète"), true);
    assertEquals(secretsMatch("cle-secrete", "clé-secrète"), false);
  });
});
