/**
 * The Daraja (Safaricom M-Pesa) calls both M-Pesa functions make: an OAuth
 * token, the STK password, and the STK status query mpesa-callback uses to
 * confirm a result instead of taking the callback's word for it.
 */

const DARAJA_BASE = Deno.env.get("DARAJA_ENV") === "production"
  ? "https://api.safaricom.co.ke"
  : "https://sandbox.safaricom.co.ke";

export function darajaUrl(path: string): string {
  return `${DARAJA_BASE}${path}`;
}

export async function darajaToken(): Promise<string> {
  const key = Deno.env.get("DARAJA_CONSUMER_KEY")!;
  const secret = Deno.env.get("DARAJA_CONSUMER_SECRET")!;
  const res = await fetch(darajaUrl("/oauth/v1/generate?grant_type=client_credentials"), {
    headers: { Authorization: "Basic " + btoa(`${key}:${secret}`) },
  });
  if (!res.ok) throw new Error("Could not authenticate with Safaricom");
  return (await res.json()).access_token as string;
}

/** Daraja wants YYYYMMDDHHmmss in Nairobi time. */
export function timestamp(): string {
  const nairobi = new Date(Date.now() + 3 * 3600 * 1000);
  return nairobi.toISOString().replace(/[-:T.]/g, "").slice(0, 14);
}

export function stkPassword(shortcode: string, passkey: string, ts: string): string {
  return btoa(shortcode + passkey + ts);
}

/** Daraja result codes, mapped to the copy a parent actually reads. */
const REASON: Record<number, string> = {
  1: "insufficient",
  1032: "cancelled",
  1037: "timeout",
  2001: "wrong_pin",
  1001: "duplicate",
};

/** What a prompt Daraja says wasn't paid becomes: its status, and the reason the parent reads. */
export function unpaidOutcome(resultCode: number): { status: "cancelled" | "timeout" | "failed"; failure_reason: string } {
  return {
    status: resultCode === 1032 ? "cancelled" : resultCode === 1037 ? "timeout" : "failed",
    failure_reason: REASON[resultCode] ?? "unreachable",
  };
}

/** done: false while the customer is still on the PIN screen. */
export type StkOutcome = { done: true; resultCode: number } | { done: false };

/**
 * Daraja turned the query away for now, not for good: throttled (HTTP 429,
 * which the sandbox answers a lot), a 5xx that isn't "still processing", a
 * reply that took too long, or no reply at all. Worth asking again shortly.
 */
export class DarajaBusy extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "DarajaBusy";
  }
}

export interface QueryRetry {
  /** The wait before each further attempt; [] asks once. */
  delaysMs?: number[];
  /** Also ask again while Daraja says the prompt is still being processed (default true). */
  retryWhileProcessing?: boolean;
  /** Never start an attempt that could end later than this after the first one began. */
  budgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Time budget. A query is retried after 1.5 s, 3 s and 5 s (longer if Daraja
 * sends a Retry-After), each attempt cut off at 4 s, and no attempt is started
 * that could end more than 16 s after the first began: about 11 s when Daraja
 * answers 429 at once, never more than 16 s plus the OAuth call. That stays
 * well inside the tightest limit the functions run under (29 s behind API
 * Gateway; the self-hosted edge runtime allows 400 s, Envoy 410 s).
 */
export const QUERY_RETRY_DELAYS_MS = [1500, 3000, 5000];
export const QUERY_BUDGET_MS = 16_000;
export const QUERY_ATTEMPT_TIMEOUT_MS = 4_000;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retry-After in ms (seconds, or an HTTP date), or undefined when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * Ask Daraja what became of an STK prompt, asking again (see the budget
 * above) while it is throttled, briefly unavailable or, unless told not to,
 * still processing. While a prompt is in progress Daraja answers HTTP 500
 * with errorCode 500.001.1001 ("The transaction is being processed") —
 * that's an answer, not an error, and is returned as { done: false } once
 * retries run out. Throws DarajaBusy when every attempt was turned away, and
 * a plain Error for anything that isn't a result (a refused token, a 4xx, a
 * ResultCode that isn't a whole number: Number("") and Number(null) are 0,
 * which would read as paid, FIG-1322).
 */
export async function queryStk(checkoutRequestId: string, retry: QueryRetry = {}): Promise<StkOutcome> {
  const {
    delaysMs = QUERY_RETRY_DELAYS_MS, retryWhileProcessing = true, budgetMs = QUERY_BUDGET_MS, sleep = realSleep, now = Date.now,
  } = retry;
  const token = await darajaToken();
  const start = now();
  for (let attempt = 0; ; attempt++) {
    let outcome: StkOutcome | undefined;
    let busy: DarajaBusy | undefined;
    try {
      outcome = await queryStkOnce(checkoutRequestId, token);
    } catch (err) {
      if (!(err instanceof DarajaBusy)) throw err;
      busy = err;
    }
    if (outcome && (outcome.done || !retryWhileProcessing)) return outcome;

    const scheduled = delaysMs[attempt];
    const wait = scheduled === undefined ? undefined : Math.max(scheduled, busy?.retryAfterMs ?? 0);
    if (wait === undefined || now() - start + wait + QUERY_ATTEMPT_TIMEOUT_MS > budgetMs) {
      if (busy) throw busy;
      return outcome!;
    }
    console.warn(`daraja: STK query attempt ${attempt + 1}: ${busy ? busy.message : "still processing"}; asking again in ${wait} ms`);
    await sleep(wait);
  }
}

/** One STK query. */
async function queryStkOnce(checkoutRequestId: string, token: string): Promise<StkOutcome> {
  const shortcode = Deno.env.get("DARAJA_SHORTCODE")!;
  const passkey = Deno.env.get("DARAJA_PASSKEY")!;
  const ts = timestamp();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUERY_ATTEMPT_TIMEOUT_MS);
  let res: Response;
  // deno-lint-ignore no-explicit-any
  let out: any;
  try {
    res = await fetch(darajaUrl("/mpesa/stkpushquery/v1/query"), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: stkPassword(shortcode, passkey, ts),
        Timestamp: ts,
        CheckoutRequestID: checkoutRequestId,
      }),
      signal: controller.signal,
    });
    out = await res.json().catch(() => ({}));
  } catch (err) {
    throw new DarajaBusy(`STK query got no answer: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
  if (out.errorCode === "500.001.1001") return { done: false };
  if (!res.ok || out.ResponseCode !== "0" || out.ResultCode === undefined) {
    const message = `STK query failed (HTTP ${res.status}): ${out.errorMessage ?? out.ResponseDescription ?? "no result"}`;
    if (res.status === 429 || res.status >= 500) throw new DarajaBusy(message, retryAfterMs(res.headers.get("Retry-After")));
    throw new Error(message);
  }
  const raw = out.ResultCode;
  const code = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(code)) {
    throw new Error(`STK query returned an unreadable result: ${JSON.stringify(raw)}`);
  }
  return { done: true, resultCode: code };
}

/**
 * DARAJA_TENANTS: the schools (tenant ids, comma-separated) that may use
 * M-Pesa on this project, or null when it isn't set, meaning every school
 * may, as before the setting existed. Set but empty means none may: a
 * mistyped list fails closed. Lets one demo school use Daraja (e.g. sandbox
 * credentials) while every other school is answered as if M-Pesa weren't set up.
 */
export function darajaTenants(raw: string | undefined = Deno.env.get("DARAJA_TENANTS")): Set<string> | null {
  if (raw === undefined) return null;
  return new Set(raw.split(",").map((t) => t.trim()).filter(Boolean));
}

/** Whether this school may use M-Pesa under DARAJA_TENANTS (null: every school may). */
export function tenantMayUseDaraja(tenantId: string | null | undefined, allowed: Set<string> | null): boolean {
  if (allowed === null) return true;
  return typeof tenantId === "string" && allowed.has(tenantId);
}

/** Compare a secret without the time taken revealing how much of it matched. */
export function secretsMatch(given: string | null, expected: string): boolean {
  const a = new TextEncoder().encode(given ?? "");
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}
