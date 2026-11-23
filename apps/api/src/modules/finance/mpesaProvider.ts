import { timingSafeEqual, createHash } from "node:crypto";
import type { AppConfig } from "../../config.js";
import { PayHeroProvider, payheroCallbackUrlWithToken, payheroConfigured } from "./payheroProvider.js";

/**
 * M-Pesa (Safaricom Daraja) provider boundary. Semantics follow the legacy client
 * (supabase/functions/_shared/daraja.ts):
 *   * STK push: POST /mpesa/stkpush/v1/processrequest; Password = base64(shortcode + passkey + timestamp),
 *     timestamp YYYYMMDDHHmmss in Nairobi time; Amount in whole shillings.
 *   * STK query: errorCode 500.001.1001 = still on the PIN screen (not done); otherwise ResultCode.
 *   * Result code mapping: 1032 cancelled, 1037 timeout, anything else failed; reasons 1 insufficient,
 *     1032 cancelled, 1037 timeout, 2001 wrong_pin, 1001 duplicate, otherwise unreachable.
 * Remediation batch 2 (review R2), these supersede the two result-code lines above where they differ:
 *   * Result codes: only codes the legacy client documented as FINAL failures are final (1 insufficient,
 *     1001 duplicate, 1032 cancelled, 1037 timeout, 2001 wrong_pin); 4999 is the provider's "still under
 *     processing" ([A] from the Daraja documentation, unverified here); any other non-zero code is UNKNOWN.
 *     Neither processing nor unknown ever fails a payment: the prompt stays pending, the settle job retries,
 *     reconciliation shows it, and an administrator resolves it with evidence.
 *   * A push is "refused" only when the provider gave a readable refusal (HTTP 2xx or 4xx with a non-zero
 *     ResponseCode or an errorCode). A 5xx, an unreadable or empty body, or a transport error is UNCERTAIN: the
 *     push may have reached the phone, so nothing is recorded as failed.
 * Credentials come only from typed configuration and are never logged or returned. Tests use a fake.
 */
export interface StkPushRequest {
  amountMinor: number;
  msisdn: string;
  accountReference: string;
  description: string;
  callbackUrl: string;
}

export type StkPushResult =
  | { accepted: true; checkoutRequestId: string; merchantRequestId: string | null }
  | { accepted: false; responseCode: string };

export type StkQueryResult = { done: true; resultCode: number } | { done: false };

export interface MpesaProvider {
  readonly configured: boolean;
  stkPush(req: StkPushRequest): Promise<StkPushResult>;
  stkQuery(checkoutRequestId: string): Promise<StkQueryResult>;
}

export type UnpaidOutcome = { status: "cancelled" | "timeout" | "failed"; failure_reason: string };

const REASON: Record<number, string> = { 1: "insufficient", 1032: "cancelled", 1037: "timeout", 2001: "wrong_pin", 1001: "duplicate" };
const PROCESSING_CODES = new Set([4999]);

/**
 * How a non-zero STK ResultCode is treated. Only a code known to be a final failure may fail a payment.
 * 'processing' (the provider is still working) and 'unknown' (a code this system has no documented meaning
 * for) leave the prompt pending: an uncertain provider outcome is never represented as a confirmed failure.
 */
export type ResultClass = "final_failure" | "processing" | "unknown";
export function classifyResultCode(resultCode: number): ResultClass {
  if (PROCESSING_CODES.has(resultCode)) return "processing";
  return resultCode in REASON ? "final_failure" : "unknown";
}

/** Only meaningful for a 'final_failure' code (callers check classifyResultCode first). */
export function unpaidOutcome(resultCode: number): UnpaidOutcome {
  return {
    status: resultCode === 1032 ? "cancelled" : resultCode === 1037 ? "timeout" : "failed",
    failure_reason: REASON[resultCode] ?? "unreachable",
  };
}

/** Constant-time secret comparison (hashing first removes the length side channel). */
export function secretsMatch(given: string | null | undefined, expected: string): boolean {
  const a = createHash("sha256").update(given ?? "").digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) && (given ?? "").length === expected.length;
}

export function nairobiTimestamp(now = Date.now()): string {
  return new Date(now + 3 * 3600 * 1000).toISOString().replace(/[-:T.]/g, "").slice(0, 14);
}

/** The configuration the provider needs: a subset of AppConfig, so the worker can supply it too. */
export type MpesaSettings = Pick<
  AppConfig,
  | "mpesaEnv"
  | "mpesaConsumerKey"
  | "mpesaConsumerSecret"
  | "mpesaShortcode"
  | "mpesaPasskey"
  | "mpesaCallbackUrl"
  | "mpesaCallbackSecret"
  | "mpesaHttpTimeoutMs"
> &
  Partial<
    Pick<
      AppConfig,
      | "paymentProvider"
      | "payheroBaseUrl"
      | "payheroBasicAuthToken"
      | "payheroApiUsername"
      | "payheroApiPassword"
      | "payheroChannelId"
      | "payheroCallbackUrl"
      | "payheroCallbackSecret"
      | "payheroHttpTimeoutMs"
    >
  >;

function toPayHeroSettings(config: MpesaSettings) {
  return {
    payheroBaseUrl: config.payheroBaseUrl ?? "https://backend.payhero.co.ke/api/v2",
    payheroBasicAuthToken: config.payheroBasicAuthToken,
    payheroApiUsername: config.payheroApiUsername,
    payheroApiPassword: config.payheroApiPassword,
    payheroChannelId: config.payheroChannelId,
    payheroCallbackUrl: config.payheroCallbackUrl,
    payheroCallbackSecret: config.payheroCallbackSecret,
    payheroHttpTimeoutMs: config.payheroHttpTimeoutMs ?? 10_000,
  };
}

export function callbackUrlWithToken(config: MpesaSettings): string {
  if (config.paymentProvider === "payhero") {
    return payheroCallbackUrlWithToken(toPayHeroSettings(config));
  }
  const url = new URL(config.mpesaCallbackUrl!);
  url.searchParams.set("token", config.mpesaCallbackSecret!);
  return url.toString();
}

export function mpesaConfigured(config: MpesaSettings): boolean {
  if (config.paymentProvider === "payhero") {
    return payheroConfigured(toPayHeroSettings(config));
  }
  return Boolean(
    config.mpesaConsumerKey &&
      config.mpesaConsumerSecret &&
      config.mpesaShortcode &&
      config.mpesaPasskey &&
      config.mpesaCallbackUrl &&
      config.mpesaCallbackSecret,
  );
}

class UnconfiguredProvider implements MpesaProvider {
  readonly configured = false;
  async stkPush(): Promise<StkPushResult> {
    throw new Error("M-Pesa is not configured");
  }
  async stkQuery(): Promise<StkQueryResult> {
    throw new Error("M-Pesa is not configured");
  }
}

export class DarajaProvider implements MpesaProvider {
  readonly configured = true;
  private token: { value: string; expiresAt: number } | null = null;
  private readonly base: string;

  constructor(private readonly config: MpesaSettings) {
    this.base = config.mpesaEnv === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";
  }

  private async fetchJson(path: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${this.base}${path}`, { ...init, signal: AbortSignal.timeout(this.config.mpesaHttpTimeoutMs) });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.config.mpesaConsumerKey}:${this.config.mpesaConsumerSecret}`).toString("base64");
    const { status, body } = await this.fetchJson("/oauth/v1/generate?grant_type=client_credentials", {
      headers: { Authorization: `Basic ${basic}` },
    });
    if (status !== 200 || typeof body.access_token !== "string") throw new Error("M-Pesa authentication failed");
    const seconds = Number(body.expires_in ?? 3599);
    this.token = { value: body.access_token, expiresAt: Date.now() + (Number.isFinite(seconds) ? seconds : 3599) * 1000 };
    return this.token.value;
  }

  private password(ts: string): string {
    return Buffer.from(`${this.config.mpesaShortcode}${this.config.mpesaPasskey}${ts}`).toString("base64");
  }

  async stkPush(req: StkPushRequest): Promise<StkPushResult> {
    const ts = nairobiTimestamp();
    const token = await this.accessToken();
    const { status, body } = await this.fetchJson("/mpesa/stkpush/v1/processrequest", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: this.config.mpesaShortcode,
        Password: this.password(ts),
        Timestamp: ts,
        TransactionType: "CustomerPayBillOnline",
        Amount: req.amountMinor / 100,
        PartyA: req.msisdn,
        PartyB: this.config.mpesaShortcode,
        PhoneNumber: req.msisdn,
        CallBackURL: req.callbackUrl,
        AccountReference: req.accountReference,
        TransactionDesc: req.description,
      }),
    });
    // a rejected access token (401 or a 404.001.* errorCode) is certain not to have reached the phone; drop the cached
    // token so the next push authenticates again instead of being refused until the cache would have expired
    if (status === 401 || (typeof body.errorCode === "string" && body.errorCode.startsWith("404.001."))) this.token = null;
    const ok = status >= 200 && status < 300;
    if (ok && body.ResponseCode === "0" && typeof body.CheckoutRequestID === "string") {
      // the provider accepted the prompt: a missing MerchantRequestID must not turn that into a failure
      return {
        accepted: true,
        checkoutRequestId: body.CheckoutRequestID,
        merchantRequestId: typeof body.MerchantRequestID === "string" ? body.MerchantRequestID : null,
      };
    }
    // an explicit, readable refusal (2xx or 4xx with a non-zero ResponseCode or an errorCode) is a confirmed refusal
    const code =
      typeof body.ResponseCode === "string" && body.ResponseCode !== "0" ? body.ResponseCode : typeof body.errorCode === "string" ? body.errorCode : null;
    if (code && (ok || (status >= 400 && status < 500))) return { accepted: false, responseCode: code.slice(0, 40) };
    // anything else (5xx, empty or unreadable body, an accepted-looking body without a checkout id) is UNCERTAIN:
    // the push may have reached the phone, so it is never recorded as failed (the caller treats a throw as unknown)
    throw new Error(`M-Pesa push outcome unknown (HTTP ${status})`);
  }

  async stkQuery(checkoutRequestId: string): Promise<StkQueryResult> {
    const ts = nairobiTimestamp();
    const token = await this.accessToken();
    const { status, body } = await this.fetchJson("/mpesa/stkpushquery/v1/query", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: this.config.mpesaShortcode,
        Password: this.password(ts),
        Timestamp: ts,
        CheckoutRequestID: checkoutRequestId,
      }),
    });
    if (body.errorCode === "500.001.1001") return { done: false };
    if (status !== 200 || body.ResponseCode !== "0" || body.ResultCode === undefined) {
      throw new Error(`M-Pesa status query failed (HTTP ${status})`);
    }
    const raw = body.ResultCode;
    const code = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(code)) throw new Error("M-Pesa status query returned an unreadable result");
    return { done: true, resultCode: code };
  }
}

export function mpesaProviderFromConfig(config: MpesaSettings): MpesaProvider {
  if (config.paymentProvider === "payhero") {
    const ph = toPayHeroSettings(config);
    return payheroConfigured(ph) ? new PayHeroProvider(ph) : new UnconfiguredProvider();
  }
  return mpesaConfigured(config) ? new DarajaProvider(config) : new UnconfiguredProvider();
}
