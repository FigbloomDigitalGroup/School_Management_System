import { afterEach, describe, expect, it, vi } from "vitest";
import { mpesaProviderFromConfig, callbackUrlWithToken, type MpesaSettings } from "../src/modules/finance/mpesaProvider.js";
import { PayHeroProvider, parsePayHeroCallback, payheroAuthHeader, payheroConfigured, type PayHeroSettings } from "../src/modules/finance/payheroProvider.js";

function baseSettings(overrides: Partial<MpesaSettings & PayHeroSettings> = {}): MpesaSettings & PayHeroSettings {
  return {
    paymentProvider: "payhero",
    mpesaEnv: "sandbox",
    mpesaConsumerKey: undefined,
    mpesaConsumerSecret: undefined,
    mpesaShortcode: undefined,
    mpesaPasskey: undefined,
    mpesaCallbackUrl: undefined,
    mpesaCallbackSecret: undefined,
    mpesaHttpTimeoutMs: 10_000,
    payheroBaseUrl: "https://backend.payhero.co.ke/api/v2",
    payheroBasicAuthToken: "dXNlcjpwYXNz",
    payheroApiUsername: undefined,
    payheroApiPassword: undefined,
    payheroChannelId: 133,
    payheroCallbackUrl: "https://api.example.com/v1/payhero/callback",
    payheroCallbackSecret: "a".repeat(32),
    payheroHttpTimeoutMs: 5_000,
    ...overrides,
  };
}

describe("PayHeroProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("derives Basic auth header from token or username/password", () => {
    expect(payheroAuthHeader(baseSettings())).toBe("Basic dXNlcjpwYXNz");
    expect(payheroAuthHeader(baseSettings({ payheroBasicAuthToken: "Basic already" }))).toBe("Basic already");
    expect(
      payheroAuthHeader(
        baseSettings({
          payheroBasicAuthToken: undefined,
          payheroApiUsername: "school_api",
          payheroApiPassword: "secret",
        }),
      ),
    ).toBe(`Basic ${Buffer.from("school_api:secret").toString("base64")}`);
  });

  it("selects PayHeroProvider when paymentProvider=payhero and configured", () => {
    const provider = mpesaProviderFromConfig(baseSettings());
    expect(provider.configured).toBe(true);
    expect(provider).toBeInstanceOf(PayHeroProvider);
    expect(callbackUrlWithToken(baseSettings())).toContain("/v1/payhero/callback?token=");

    const unconfigured = mpesaProviderFromConfig(baseSettings({ payheroChannelId: undefined }));
    expect(unconfigured.configured).toBe(false);
    expect(payheroConfigured(baseSettings({ payheroChannelId: undefined }))).toBe(false);
  });

  it("sends STK push to /payments and parses accepted reference", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          status: "QUEUED",
          reference: "PH-99887766",
          CheckoutRequestID: "ws_CO_123456",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    const provider = new PayHeroProvider(baseSettings());
    const result = await provider.stkPush({
      amountMinor: 250_000,
      msisdn: "254712345678",
      accountReference: "FIG-12345678",
      description: "School fees",
      callbackUrl: "https://api.example.com/v1/payhero/callback?token=abc",
    });

    expect(result).toEqual({
      accepted: true,
      checkoutRequestId: "PH-99887766",
      merchantRequestId: "ws_CO_123456",
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://backend.payhero.co.ke/api/v2/payments",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Basic dXNlcjpwYXNz" }),
      }),
    );
    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body));
    expect(body).toMatchObject({
      amount: 2500,
      phone_number: "254712345678",
      channel_id: 133,
      provider: "m-pesa",
      external_reference: "FIG-12345678",
    });
  });

  it("returns explicit refusal on 4xx and throws uncertain on 5xx", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error_code: "INVALID_PHONE" }), { status: 400 }))
      .mockResolvedValueOnce(new Response("upstream error", { status: 502 }));
    const provider = new PayHeroProvider(baseSettings());

    const refused = await provider.stkPush({
      amountMinor: 10_000,
      msisdn: "254712345678",
      accountReference: "FIG-1",
      description: "Fees",
      callbackUrl: "https://api.example.com/v1/payhero/callback?token=abc",
    });
    expect(refused).toEqual({ accepted: false, responseCode: "INVALID_PHONE" });

    await expect(
      provider.stkPush({
        amountMinor: 10_000,
        msisdn: "254712345678",
        accountReference: "FIG-1",
        description: "Fees",
        callbackUrl: "https://api.example.com/v1/payhero/callback?token=abc",
      }),
    ).rejects.toThrow("PayHero push outcome unknown");
  });

  it("queries transaction status and maps SUCCESS, QUEUED, CANCELLED, and FAILED", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "SUCCESS", provider_reference: "QWE123RTY4" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "QUEUED" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "CANCELLED" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "FAILED", result_desc: "Insufficient funds" }), { status: 200 }));
    const provider = new PayHeroProvider(baseSettings());

    expect(await provider.stkQuery("PH-1")).toEqual({ done: true, resultCode: 0 });
    expect(await provider.stkQuery("PH-2")).toEqual({ done: false });
    expect(await provider.stkQuery("PH-3")).toEqual({ done: true, resultCode: 1032 });
    expect(await provider.stkQuery("PH-4")).toEqual({ done: true, resultCode: 1 });
  });

  it("parses PayHero nested and flat webhook callbacks", () => {
    const nested = parsePayHeroCallback({
      success: true,
      response: {
        reference: "PH-123456789",
        external_reference: "FIG-INV009",
        amount: 1500,
        phone_number: "0712345678",
        provider: "m-pesa",
        provider_reference: "qwe123rty4",
        status: "Success",
        result_desc: "The service request is processed successfully.",
      },
    });
    expect(nested).toEqual({
      checkoutRequestId: "PH-123456789",
      merchantRequestId: "FIG-INV009",
      evidence: {
        resultCode: 0,
        resultDesc: "The service request is processed successfully.",
        amountMinor: 150_000,
        receipt: "QWE123RTY4",
        msisdn: "254712345678",
      },
    });

    const cancelled = parsePayHeroCallback({
      reference: "PH-CANCEL",
      status: "Cancelled",
      result_desc: "Request cancelled by user",
      phone_number: "+254700111222",
      amount: "500.00",
    });
    expect(cancelled).toEqual({
      checkoutRequestId: "PH-CANCEL",
      merchantRequestId: null,
      evidence: {
        resultCode: 1032,
        resultDesc: "Request cancelled by user",
        amountMinor: 50_000,
        receipt: null,
        msisdn: "254700111222",
      },
    });

    expect(parsePayHeroCallback({ invalid: true })).toBeNull();
  });
});
