import { supabase } from "./supabase";
import { EdgeError, invokeEdge } from "./edge";
import { PAYMENT_FAILURES } from "./fees";
import type { Payment } from "./types";

/**
 * Paying a fee by M-Pesa, from a parent's or learner's phone or browser.
 *
 * The one rule: this code never decides that a payment worked. The
 * mpesa-stk-push function creates a *pending* payment and asks Safaricom to
 * raise the PIN prompt; only Safaricom's callback, confirmed by mpesa-callback
 * against Daraja, can set it to success. Here we ask for the prompt, then read
 * the payment row until it settles. So "received" on screen always means the
 * database says it was.
 */

export type PaymentFailure = keyof typeof PAYMENT_FAILURES;

export type PayResult =
  /** Safaricom confirmed it. The invoice has already moved. */
  | { kind: "success"; receipt: string | null }
  /** It did not go through, and no money left the account (the reason's copy in PAYMENT_FAILURES says so). */
  | { kind: "failed"; reason: PaymentFailure }
  /** We stopped waiting without an answer. The payment may still arrive; do not tell the payer it failed, or to pay again. */
  | { kind: "unconfirmed" }
  /** Online M-Pesa isn't available for this school (or right now). Nothing was sent; pay by the school's own details instead. */
  | { kind: "unavailable" }
  /** The request was refused before any prompt was sent (wrong amount, not this person's invoice, ...). Nothing was sent. */
  | { kind: "rejected"; message: string };

export interface PayInput {
  invoiceId: string;
  amountCents: number;
  /** 2547XXXXXXXX / 2541XXXXXXXX, from normaliseMsisdn(). */
  msisdn: string;
}

export interface PayOptions {
  /** Called once the prompt has been sent: the payer should now look at their phone. */
  onPrompted?: () => void;
  /** Stops waiting (the screen was closed). payWithMpesa then rejects with an AbortError; the payment itself carries on. */
  signal?: AbortSignal;
  /** How often to look at the payment, and how long to keep looking. Safaricom's prompt itself lasts about a minute. */
  intervalMs?: number;
  timeoutMs?: number;
}

const START_TIMEOUT_MS = 30_000;

function aborted(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(aborted()); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); reject(aborted()); }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

type PaymentRow = Pick<Payment, "status" | "failure_reason" | "mpesa_receipt">;

/** null while the payment is still pending. */
export function outcomeOf(row: PaymentRow): Exclude<PayResult, { kind: "unavailable" | "rejected" }> | null {
  switch (row.status) {
    case "success":
      return { kind: "success", receipt: row.mpesa_receipt };
    case "failed":
    case "cancelled":
    case "timeout": {
      const fallback: PaymentFailure = row.status === "failed" ? "unreachable" : row.status;
      const reason = row.failure_reason && row.failure_reason in PAYMENT_FAILURES ? (row.failure_reason as PaymentFailure) : fallback;
      return { kind: "failed", reason };
    }
    default:
      return null;
  }
}

/** Asks for the prompt, then waits for Safaricom's answer to appear on the payment row. */
export async function payWithMpesa(input: PayInput, options: PayOptions = {}): Promise<PayResult> {
  const { onPrompted, signal, intervalMs = 3000, timeoutMs = 90_000 } = options;

  let paymentId: string;
  try {
    const started = await invokeEdge<{ payment_id?: string }>(
      "mpesa-stk-push",
      { invoice_id: input.invoiceId, amount_cents: input.amountCents, msisdn: input.msisdn },
      { timeoutMs: START_TIMEOUT_MS },
    );
    if (!started?.payment_id) return { kind: "rejected", message: "The payment could not be started. Try again." };
    paymentId = started.payment_id;
  } catch (err) {
    // 503: the function says M-Pesa isn't set up for this school, or the gateway has nothing behind it.
    if (err instanceof EdgeError && err.status === 503) return { kind: "unavailable" };
    return { kind: "rejected", message: err instanceof Error ? err.message : "The payment could not be started. Try again." };
  }

  onPrompted?.();

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await sleep(intervalMs, signal);
    // A lookup that fails (no signal for a moment) is not an answer: keep waiting.
    const { data } = await supabase()
      .from("payments")
      .select("status, failure_reason, mpesa_receipt")
      .eq("id", paymentId)
      .maybeSingle<PaymentRow>();
    const outcome = data ? outcomeOf(data) : null;
    if (outcome) return outcome;
    if (Date.now() >= deadline) return { kind: "unconfirmed" };
  }
}

export interface PaymentMethods {
  paybill: string | null;
  till: string | null;
  bank: string | null;
  notes: string | null;
}

/** The school's own ways to pay (paybill, till, bank, a note), as set in admin Settings. null when none are set. */
export async function fetchPaymentMethods(tenantId: string): Promise<PaymentMethods | null> {
  const { data } = await supabase()
    .from("tenants")
    .select("payment_paybill, payment_till, payment_bank_details, payment_notes")
    .eq("id", tenantId)
    .maybeSingle<{ payment_paybill: string | null; payment_till: string | null; payment_bank_details: string | null; payment_notes: string | null }>();
  if (!data) return null;
  const methods = { paybill: data.payment_paybill, till: data.payment_till, bank: data.payment_bank_details, notes: data.payment_notes };
  return methods.paybill || methods.till || methods.bank ? methods : null;
}
