import { afterEach, beforeEach, describe, it } from "jsr:@std/testing/bdd";
import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert";
import {
  DarajaBusy, darajaTenants, darajaToken, queryStk, retryAfterMs, secretsMatch, stkPassword, tenantMayUseDaraja, timestamp,
} from "./daraja.ts";

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
    assertEquals(await queryStk("a", { delaysMs: [] }), { done: false });
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
    await assertRejects(() => queryStk("a", { delaysMs: [] }));
  });

  it("throws when Safaricom's OAuth refuses us, without asking the status", async () => {
    const calls = stubDaraja(() => json({ ResponseCode: "0", ResultCode: "0" }), () => json({}, 400));
    await assertRejects(() => queryStk("a"), Error, "Could not authenticate with Safaricom");
    assertEquals(calls.length, 1);
  });

  // FIG-1322 (fixed): an empty or non-numeric ResultCode used to be read by Number(): "" and null became 0, which mpesa-callback
  // took for "paid", and "abc" became NaN, which it took for a permanent failure. A result we cannot read now throws, so the
  // callback answers 500 and Safaricom asks again.
  for (const [label, resultCode] of [["an empty string", ""], ["null", null], ["a non-number", "abc"], ["a space and a zero", " 0"], ["a decimal", "1.5"], ["a boolean", true], ["an object", {}]] as const) {
    it(`FIG-1322: ResultCode ${label} is refused, not read as a result`, async () => {
      stubDaraja(() => json({ ResponseCode: "0", ResultCode: resultCode }));
      await assertRejects(() => queryStk("a"), Error, "unreadable result");
    });
  }
});

describe("queryStk asks again while Daraja is throttled or busy", () => {
  const warn = console.warn;
  beforeEach(() => { console.warn = () => {}; });
  afterEach(() => { console.warn = warn; });

  /** A clock the waits move forward, so the budget is tested without real waiting. */
  function clock(attemptMs = 0) {
    let t = 0;
    const waits: number[] = [];
    return {
      waits,
      now: () => t,
      sleep: (ms: number) => { waits.push(ms); t += ms; return Promise.resolve(); },
      attempt: () => { t += attemptMs; },
    };
  }

  /** Daraja answers each query with the next of `answers` (the last one repeats). */
  function answers(list: (() => Response)[], c?: ReturnType<typeof clock>) {
    let i = 0;
    return stubDaraja(() => { c?.attempt(); return list[Math.min(i++, list.length - 1)](); });
  }

  const throttled = (headers: Record<string, string> = {}) => () =>
    new Response(JSON.stringify({ errorCode: "429.000.01", errorMessage: "Too many requests" }), { status: 429, headers });
  const paid = () => json({ ResponseCode: "0", ResultCode: "0" });
  const processing = () => json({ errorCode: "500.001.1001", errorMessage: "The transaction is being processed" }, 500);
  const queries = (calls: { url: string }[]) => calls.filter((c) => c.url.includes("stkpushquery")).length;

  it("429, then a result: returns the result after one 1.5 s wait, with one OAuth token", async () => {
    const c = clock();
    const calls = answers([throttled(), paid], c);
    assertEquals(await queryStk("a", { sleep: c.sleep, now: c.now }), { done: true, resultCode: 0 });
    assertEquals(c.waits, [1500]);
    assertEquals(queries(calls), 2);
    assertEquals(calls.filter((x) => x.url.includes("/oauth/")).length, 1);
  });

  it("429 every time: asks four times (waits 1.5 s, 3 s, 5 s), then throws DarajaBusy", async () => {
    const c = clock();
    const calls = answers([throttled()], c);
    const err = await assertRejects(() => queryStk("a", { sleep: c.sleep, now: c.now }), DarajaBusy);
    assertStringIncludes(err.message, "HTTP 429");
    assertEquals(c.waits, [1500, 3000, 5000]);
    assertEquals(queries(calls), 4);
  });

  it("honours a Retry-After longer than its own wait", async () => {
    const c = clock();
    answers([throttled({ "Retry-After": "4" }), paid], c);
    await queryStk("a", { sleep: c.sleep, now: c.now });
    assertEquals(c.waits, [4000]);
  });

  it("gives up at once on a Retry-After that won't fit in the time budget", async () => {
    const c = clock();
    const calls = answers([throttled({ "Retry-After": "60" }), paid], c);
    await assertRejects(() => queryStk("a", { sleep: c.sleep, now: c.now }), DarajaBusy);
    assertEquals(c.waits, []);
    assertEquals(queries(calls), 1);
  });

  it("starts no attempt that could end past 16 s: slow answers get fewer retries", async () => {
    const c = clock(4000);
    const calls = answers([throttled()], c);
    await assertRejects(() => queryStk("a", { sleep: c.sleep, now: c.now }), DarajaBusy);
    assertEquals(c.waits, [1500]);
    assertEquals(queries(calls), 2);
  });

  it("asks again on a 503 and when the request itself fails", async () => {
    const c = clock();
    let i = 0;
    globalThis.fetch = ((url: string | URL) => {
      if (url.toString().includes("/oauth/")) return Promise.resolve(json({ access_token: "t" }));
      i++;
      if (i === 1) return Promise.resolve(new Response("busy", { status: 503 }));
      if (i === 2) return Promise.reject(new TypeError("connection reset"));
      return Promise.resolve(json({ ResponseCode: "0", ResultCode: "1032" }));
    }) as typeof fetch;
    assertEquals(await queryStk("a", { sleep: c.sleep, now: c.now }), { done: true, resultCode: 1032 });
    assertEquals(c.waits, [1500, 3000]);
  });

  it("asks again while still processing; with retryWhileProcessing false, answers 'not done' at once", async () => {
    const c = clock();
    answers([processing, paid], c);
    assertEquals(await queryStk("a", { sleep: c.sleep, now: c.now }), { done: true, resultCode: 0 });

    const c2 = clock();
    const calls = answers([processing, paid], c2);
    assertEquals(await queryStk("a", { sleep: c2.sleep, now: c2.now, retryWhileProcessing: false }), { done: false });
    assertEquals(queries(calls), 1);
  });

  it("still processing every time: answers 'not done', never a result", async () => {
    const c = clock();
    answers([processing], c);
    assertEquals(await queryStk("a", { sleep: c.sleep, now: c.now }), { done: false });
  });

  it("does not ask again on an answer that won't change (a 4xx, an unreadable result)", async () => {
    for (const answer of [() => json({ errorMessage: "Invalid Access Token" }, 404), () => json({ ResponseCode: "0", ResultCode: "" })]) {
      const c = clock();
      const calls = answers([answer, paid], c);
      const err = await assertRejects(() => queryStk("a", { sleep: c.sleep, now: c.now }));
      assertEquals(err instanceof DarajaBusy, false);
      assertEquals(queries(calls), 1);
    }
  });

  it("retryAfterMs reads seconds and HTTP dates", () => {
    assertEquals(retryAfterMs(null), undefined);
    assertEquals(retryAfterMs("3"), 3000);
    assertEquals(retryAfterMs("soon"), undefined);
    assertEquals(retryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000);
  });
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
      Deno.env.set("DARAJA_ENV", "sandbox");
      const sandbox = await import("./daraja.ts?env=sandbox");
      assertEquals(sandbox.darajaUrl("/oauth/v1/generate"), "https://sandbox.safaricom.co.ke/oauth/v1/generate");
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

describe("DARAJA_TENANTS", () => {
  it("darajaTenants: unset is null (every school), set is the trimmed list, empty is nobody", () => {
    assertEquals(darajaTenants(undefined), null);
    assertEquals([...darajaTenants(" t-1 ,t-2,, ")!], ["t-1", "t-2"]);
    assertEquals(darajaTenants("")!.size, 0);
  });

  it("tenantMayUseDaraja", () => {
    assertEquals(tenantMayUseDaraja("t-1", null), true);
    assertEquals(tenantMayUseDaraja("t-1", new Set(["t-1"])), true);
    assertEquals(tenantMayUseDaraja("t-2", new Set(["t-1"])), false);
    assertEquals(tenantMayUseDaraja(null, new Set(["t-1"])), false);
    assertEquals(tenantMayUseDaraja("t-1", new Set()), false);
  });
});
