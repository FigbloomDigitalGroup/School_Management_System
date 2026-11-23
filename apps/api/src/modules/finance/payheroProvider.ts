import type { AppConfig } from "../../config.js";
import { callbackAmountToMinor, type CallbackEvidence } from "./mpesa.js";
import type { MpesaProvider, StkPushRequest, StkPushResult, StkQueryResult } from "./mpesaProvider.js";

/**
 * PayHero Kenya API v2 payment provider (M-Pesa STK Push, status query, and webhook callback parser).
 *
 * Implements the same `MpesaProvider` contract as `DarajaProvider` so existing prompt creation,
 * transactional outbox settlement (`mpesa.stk_settle`), operator reconciliation, and callback
 * quarantine work identically regardless of whether a deployment uses Daraja or PayHero.
 *
 * API v2 endpoints:
 *   - STK Push:     POST {baseUrl}/payments
 *   - Status Query: GET  {baseUrl}/transaction-status?reference=<ref>
 *   - Auth:         Authorization: Basic <token> (direct token or base64(username:password))
 */
export type PayHeroSettings = Pick<
  AppConfig,
  | "payheroBaseUrl"
  | "payheroBasicAuthToken"
  | "payheroApiUsername"
  | "payheroApiPassword"
  | "payheroChannelId"
  | "payheroCallbackUrl"
  | "payheroCallbackSecret"
  | "payheroHttpTimeoutMs"
>;

export function payheroAuthHeader(config: PayHeroSettings): string | null {
  if (config.payheroBasicAuthToken) {
    const raw = config.payheroBasicAuthToken.trim();
    return raw.startsWith("Basic ") ? raw : `Basic ${raw}`;
  }
  if (config.payheroApiUsername && config.payheroApiPassword) {
    const encoded = Buffer.from(`${config.payheroApiUsername}:${config.payheroApiPassword}`).toString("base64");
    return `Basic ${encoded}`;
  }
  return null;
}

export function payheroConfigured(config: PayHeroSettings): boolean {
  return Boolean(
    payheroAuthHeader(config) &&
      config.payheroChannelId &&
      config.payheroCallbackUrl &&
      config.payheroCallbackSecret,
  );
}

export function payheroCallbackUrlWithToken(config: PayHeroSettings): string {
  const url = new URL(config.payheroCallbackUrl!);
  url.searchParams.set("token", config.payheroCallbackSecret!);
  return url.toString();
}

const REFERENCE_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

function mapPayHeroStatusToResultCode(statusRaw: unknown, resultDescRaw?: unknown): { done: false } | { done: true; resultCode: number } {
  const status = typeof statusRaw === "string" ? statusRaw.trim().toUpperCase() : "";
  const desc = typeof resultDescRaw === "string" ? resultDescRaw.toLowerCase() : "";
  if (status === "SUCCESS" || status === "SUCCESSFUL" || status === "COMPLETED" || status === "PAID") {
    return { done: true, resultCode: 0 };
  }
  if (status === "QUEUED" || status === "PENDING" || status === "PROCESSING" || status === "INITIATED") {
    return { done: false };
  }
  if (status === "CANCELLED" || status === "CANCELED" || desc.includes("cancel")) {
    return { done: true, resultCode: 1032 };
  }
  if (status === "TIMEOUT" || status === "EXPIRED" || desc.includes("timeout") || desc.includes("timed out")) {
    return { done: true, resultCode: 1037 };
  }
  if (status === "FAILED" || status === "REJECTED" || status === "DECLINED") {
    if (desc.includes("insufficient")) return { done: true, resultCode: 1 };
    if (desc.includes("pin") || desc.includes("initiator")) return { done: true, resultCode: 2001 };
    return { done: true, resultCode: 1 };
  }
  // Unknown status: never fabricate a final failure; stay pending for retry/operator review.
  return { done: false };
}

export class PayHeroProvider implements MpesaProvider {
  readonly configured = true;
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(private readonly config: PayHeroSettings) {
    this.baseUrl = config.payheroBaseUrl.replace(/\/+$/, "");
    const header = payheroAuthHeader(config);
    if (!header) throw new Error("PayHero credentials are not configured");
    this.authHeader = header;
  }

  private async fetchJson(path: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(this.config.payheroHttpTimeoutMs),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  }

  async stkPush(req: StkPushRequest): Promise<StkPushResult> {
    const { status, body } = await this.fetchJson("/payments", {
      method: "POST",
      body: JSON.stringify({
        amount: req.amountMinor / 100,
        phone_number: req.msisdn,
        channel_id: this.config.payheroChannelId,
        provider: "m-pesa",
        external_reference: req.accountReference,
        customer_name: req.description,
        callback_url: req.callbackUrl,
      }),
    });

    const ok = status >= 200 && status < 300;
    const reference =
      typeof body.reference === "string" && REFERENCE_PATTERN.test(body.reference)
        ? body.reference
        : typeof body.CheckoutRequestID === "string" && REFERENCE_PATTERN.test(body.CheckoutRequestID)
          ? body.CheckoutRequestID
          : null;

    if (ok && body.success === true && reference) {
      const merchantRef =
        typeof body.CheckoutRequestID === "string" && body.CheckoutRequestID !== reference
          ? body.CheckoutRequestID.slice(0, 80)
          : typeof body.MerchantRequestID === "string"
            ? body.MerchantRequestID.slice(0, 80)
            : null;
      return {
        accepted: true,
        checkoutRequestId: reference,
        merchantRequestId: merchantRef,
      };
    }

    // Explicit readable refusal (2xx with success: false or 4xx with an error code/message).
    if ((ok && body.success === false) || (status >= 400 && status < 500)) {
      const rawCode =
        typeof body.error_code === "string"
          ? body.error_code
          : typeof body.code === "string"
            ? body.code
            : typeof body.status === "string"
              ? body.status
              : `HTTP_${status}`;
      return { accepted: false, responseCode: rawCode.slice(0, 40) };
    }

    // 5xx or unreadable response: outcome is UNCERTAIN — never auto-fail the prompt.
    throw new Error(`PayHero push outcome unknown (HTTP ${status})`);
  }

  async stkQuery(checkoutRequestId: string): Promise<StkQueryResult> {
    const { status, body } = await this.fetchJson(`/transaction-status?reference=${encodeURIComponent(checkoutRequestId)}`, {
      method: "GET",
    });
    if (status < 200 || status >= 300) {
      throw new Error(`PayHero status query failed (HTTP ${status})`);
    }
    const payload = (typeof body.response === "object" && body.response !== null ? body.response : body) as Record<string, unknown>;
    const txStatus = payload.status ?? body.status;
    const desc = payload.result_desc ?? body.result_desc ?? payload.message ?? body.message;
    if (typeof txStatus !== "string" && typeof payload.success !== "boolean") {
      throw new Error("PayHero status query returned an unreadable result");
    }
    if (typeof txStatus === "string") {
      return mapPayHeroStatusToResultCode(txStatus, desc);
    }
    return payload.success ? { done: true, resultCode: 0 } : { done: false };
  }
}

/**
 * Parse a PayHero v2 webhook callback payload into the same `CallbackEvidence` shape used by Daraja.
 * Supports both nested `{ success, response: { ... } }` and flat `{ reference, status, ... }` payloads.
 */
export function parsePayHeroCallback(
  body: unknown,
): { checkoutRequestId: string; merchantRequestId: string | null; evidence: CallbackEvidence } | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const nested = typeof root.response === "object" && root.response !== null ? (root.response as Record<string, unknown>) : root;

  const checkout =
    typeof nested.reference === "string" && REFERENCE_PATTERN.test(nested.reference)
      ? nested.reference
      : typeof nested.CheckoutRequestID === "string" && REFERENCE_PATTERN.test(nested.CheckoutRequestID)
        ? nested.CheckoutRequestID
        : null;
  if (!checkout) return null;

  const merchant =
    typeof nested.external_reference === "string" && nested.external_reference.length <= 80
      ? nested.external_reference
      : typeof nested.CheckoutRequestID === "string" && nested.CheckoutRequestID !== checkout && nested.CheckoutRequestID.length <= 80
        ? nested.CheckoutRequestID
        : null;

  const statusVal = nested.status ?? root.status;
  const descVal = nested.result_desc ?? nested.ResultDesc ?? root.result_desc ?? root.message;
  let resultCode: number | null = null;
  if (typeof nested.ResultCode === "number" && Number.isInteger(nested.ResultCode)) {
    resultCode = nested.ResultCode;
  } else if (typeof statusVal === "string") {
    const mapped = mapPayHeroStatusToResultCode(statusVal, descVal);
    resultCode = mapped.done ? mapped.resultCode : null;
  } else if (typeof root.success === "boolean") {
    resultCode = root.success ? 0 : 1;
  }

  const amountMinor = callbackAmountToMinor(nested.amount ?? nested.Amount);
  const rawReceipt = nested.provider_reference ?? nested.MpesaReceiptNumber ?? nested.mpesa_receipt;
  const receipt = typeof rawReceipt === "string" ? rawReceipt.trim().toUpperCase() : null;
  const rawPhone = nested.phone_number ?? nested.Phone ?? nested.PhoneNumber;
  let msisdn: string | null = null;
  if (typeof rawPhone === "string" || typeof rawPhone === "number") {
    const digits = String(rawPhone).replace(/^\+/, "").replace(/\s+/g, "");
    if (/^0[17]\d{8}$/.test(digits)) msisdn = `254${digits.slice(1)}`;
    else if (/^254\d{9}$/.test(digits)) msisdn = digits;
  }

  return {
    checkoutRequestId: checkout,
    merchantRequestId: merchant,
    evidence: {
      resultCode,
      resultDesc: typeof descVal === "string" ? descVal : null,
      amountMinor,
      receipt: receipt && receipt.length > 0 ? receipt : null,
      msisdn,
    },
  };
}
