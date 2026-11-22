import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyResultCode, DarajaProvider, unpaidOutcome, type MpesaSettings } from "../src/modules/finance/mpesaProvider.js";

/**
 * Remediation batch 2 follow-up (independent review F1, F2, F3): how the Daraja boundary turns HTTP responses
 * into outcomes. Only a readable provider refusal or a known final result code may ever fail a payment;
 * anything uncertain throws (push) or stays pending (result code). No network: fetch is mocked.
 */
const settings: MpesaSettings = {
  mpesaEnv: "sandbox",
  mpesaConsumerKey: "key",
  mpesaConsumerSecret: "secret",
  mpesaShortcode: "174379",
  mpesaPasskey: "passkey",
  mpesaCallbackUrl: "https://example.test/v1/mpesa/callback",
  mpesaCallbackSecret: "s".repeat(32),
  mpesaHttpTimeoutMs: 1000,
};

const req = { amountMinor: 100_000, msisdn: "254712345678", accountReference: "FIG-1", description: "School fees", callbackUrl: "https://example.test/cb" };

/** Mock fetch: the first call is the OAuth token, the second is the push or query under test. */
function mockPushResponse(status: number, raw: string | null) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("/oauth/")) return new Response(JSON.stringify({ access_token: "tok", expires_in: "3599" }), { status: 200 });
      return new Response(raw, { status });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("DarajaProvider.stkPush: an uncertain response is never a failure", () => {
  const accepted = JSON.stringify({ ResponseCode: "0", CheckoutRequestID: "ws_CO_1", MerchantRequestID: "MR_1" });

  it("an HTTP 200 acceptance is accepted", async () => {
    mockPushResponse(200, accepted);
    expect(await new DarajaProvider(settings).stkPush(req)).toEqual({ accepted: true, checkoutRequestId: "ws_CO_1", merchantRequestId: "MR_1" });
  });

  it("an acceptance without a MerchantRequestID is still accepted (F2), with a null merchant id", async () => {
    mockPushResponse(200, JSON.stringify({ ResponseCode: "0", CheckoutRequestID: "ws_CO_2" }));
    expect(await new DarajaProvider(settings).stkPush(req)).toEqual({ accepted: true, checkoutRequestId: "ws_CO_2", merchantRequestId: null });
  });

  it.each([
    ["HTTP 500 with an empty body", 500, ""],
    ["HTTP 502 with an HTML error page", 502, "<html>Bad gateway</html>"],
    ["HTTP 503 with a JSON body that names no refusal", 503, "{}"],
    ["HTTP 504 even with an errorCode (the gateway may have forwarded it)", 504, JSON.stringify({ errorCode: "500.001.1001" })],
    ["HTTP 200 with a garbled body", 200, "not json at all"],
    ["HTTP 200 with an empty body", 200, ""],
    ["HTTP 200 'accepted' without a checkout id", 200, JSON.stringify({ ResponseCode: "0" })],
    ["HTTP 200 with no ResponseCode and no errorCode", 200, JSON.stringify({ requestId: "x" })],
    ["HTTP 500 with a refusal-looking ResponseCode", 500, JSON.stringify({ ResponseCode: "1" })],
  ])("%s throws (uncertain), it is not reported as a refusal", async (_name, status, body) => {
    mockPushResponse(status, body);
    await expect(new DarajaProvider(settings).stkPush(req)).rejects.toThrow(/outcome unknown/);
  });

  it.each([
    ["HTTP 200 with a non-zero ResponseCode", 200, JSON.stringify({ ResponseCode: "1", ResponseDescription: "refused" }), "1"],
    ["HTTP 400 with an errorCode", 400, JSON.stringify({ errorCode: "400.002.02", errorMessage: "Bad Request" }), "400.002.02"],
    ["HTTP 404 with an errorCode", 404, JSON.stringify({ errorCode: "404.001.03" }), "404.001.03"],
  ])("%s is a confirmed refusal", async (_name, status, body, code) => {
    mockPushResponse(status, body);
    expect(await new DarajaProvider(settings).stkPush(req)).toEqual({ accepted: false, responseCode: code });
  });

  it("a rejected access token is a confirmed refusal AND clears the cached token so the next push re-authenticates (N3)", async () => {
    let oauth = 0;
    let pushes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/oauth/")) {
          oauth++;
          return new Response(JSON.stringify({ access_token: "tok" + oauth, expires_in: "3599" }), { status: 200 });
        }
        pushes++;
        return pushes === 1
          ? new Response(JSON.stringify({ errorCode: "404.001.03", errorMessage: "Invalid Access Token" }), { status: 404 })
          : new Response(accepted, { status: 200 });
      }),
    );
    const provider = new DarajaProvider(settings);
    expect(await provider.stkPush(req)).toEqual({ accepted: false, responseCode: "404.001.03" });
    expect(await provider.stkPush(req)).toMatchObject({ accepted: true });
    expect(oauth).toBe(2); // a second token was fetched; the stale one was not reused
  });

  it("a transport failure (timeout/abort) throws, as before", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/oauth/")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
        throw new DOMException("The operation was aborted", "TimeoutError");
      }),
    );
    await expect(new DarajaProvider(settings).stkPush(req)).rejects.toThrow();
  });
});

describe("result codes: only a known final failure may fail a payment (F3)", () => {
  it("classifies known final failures, the processing code and everything else", () => {
    for (const code of [1, 1001, 1032, 1037, 2001]) expect(classifyResultCode(code), String(code)).toBe("final_failure");
    expect(classifyResultCode(4999)).toBe("processing");
    for (const code of [2, 17, 1019, 1025, 9999, -1]) expect(classifyResultCode(code), String(code)).toBe("unknown");
  });

  it("maps only the known final codes to a status and reason", () => {
    expect(unpaidOutcome(1032)).toEqual({ status: "cancelled", failure_reason: "cancelled" });
    expect(unpaidOutcome(1037)).toEqual({ status: "timeout", failure_reason: "timeout" });
    expect(unpaidOutcome(2001)).toEqual({ status: "failed", failure_reason: "wrong_pin" });
    expect(unpaidOutcome(1)).toEqual({ status: "failed", failure_reason: "insufficient" });
    expect(unpaidOutcome(1001)).toEqual({ status: "failed", failure_reason: "duplicate" });
  });
});
