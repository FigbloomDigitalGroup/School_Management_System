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
 * Ask Daraja what became of an STK prompt. While it's still in progress
 * Daraja answers HTTP 500 with errorCode 500.001.1001 ("The transaction is
 * being processed") — that's an answer, not an error. Anything else that
 * isn't a result throws, including a ResultCode that isn't a whole number:
 * Number("") and Number(null) are 0, which would read as paid (FIG-1322).
 */
export async function queryStk(checkoutRequestId: string): Promise<StkOutcome> {
  const shortcode = Deno.env.get("DARAJA_SHORTCODE")!;
  const passkey = Deno.env.get("DARAJA_PASSKEY")!;
  const ts = timestamp();
  const token = await darajaToken();
  const res = await fetch(darajaUrl("/mpesa/stkpushquery/v1/query"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: stkPassword(shortcode, passkey, ts),
      Timestamp: ts,
      CheckoutRequestID: checkoutRequestId,
    }),
  });
  // deno-lint-ignore no-explicit-any
  const out: any = await res.json().catch(() => ({}));
  if (out.errorCode === "500.001.1001") return { done: false };
  if (!res.ok || out.ResponseCode !== "0" || out.ResultCode === undefined) {
    throw new Error(`STK query failed (HTTP ${res.status}): ${out.errorMessage ?? out.ResponseDescription ?? "no result"}`);
  }
  const raw = out.ResultCode;
  const code = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(code)) {
    throw new Error(`STK query returned an unreadable result: ${JSON.stringify(raw)}`);
  }
  return { done: true, resultCode: code };
}

/** Compare a secret without the time taken revealing how much of it matched. */
export function secretsMatch(given: string | null, expected: string): boolean {
  const a = new TextEncoder().encode(given ?? "");
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}
