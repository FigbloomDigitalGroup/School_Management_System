import type { PayInput, PayOptions, PayResult } from "../mpesaPay";
import { outcomeOf } from "../mpesaPay";
import { apiClient } from "./client";
import { isApiError, userMessage } from "./errors";
import { apiFetchChildFees, apiFetchChildren, familyTenantId } from "./parentApi";

/**
 * Paying a fee by M-Pesa from a parent's account on apps/api (the API side of `payWithMpesa`).
 *
 * `POST .../finance/mpesa/prompts` asks the server for the prompt; it is allowed for a parent whose live account link reaches the
 * invoice's child (any other caller is a 403). Nothing here decides that a payment worked: only the provider's confirmation makes
 * the payment `success`, and this reads the payment back until it says so. A parent may not read `GET /finance/payments/{id}` (that is
 * the office's), so the payment is read from the child's own fees (`/me/children/{learnerId}/fees`), which lists it with its status.
 */

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

/** The child the invoice belongs to, when the caller did not say: found among the parent's own children. */
async function learnerOfInvoice(invoiceId: string): Promise<string | null> {
  for (const child of await apiFetchChildren()) {
    if ((await apiFetchChildFees(child.learner_id)).some((i) => i.id === invoiceId)) return child.learner_id;
  }
  return null;
}

export async function apiPayWithMpesa(input: PayInput, options: PayOptions = {}): Promise<PayResult> {
  const { onPrompted, signal, intervalMs = 3000, timeoutMs = 90_000 } = options;
  const tenantId = familyTenantId();

  let paymentId: string;
  try {
    const started = await apiClient().post("/v1/tenants/{tenantId}/finance/mpesa/prompts", {
      path: { tenantId }, body: { invoice_id: input.invoiceId, amount_minor: input.amountCents, msisdn: input.msisdn }, tenantId, timeoutMs: START_TIMEOUT_MS,
    });
    paymentId = started.payment.id;
  } catch (err) {
    // 503: M-Pesa is not set up for the school, or is down: pay by the school's own details instead.
    if (isApiError(err) && err.status === 503) return { kind: "unavailable" };
    // 502: the provider refused the prompt and the payment is recorded as failed. No money moved.
    if (isApiError(err) && err.status === 502) return { kind: "failed", reason: "unreachable" };
    return { kind: "rejected", message: userMessage(err) || "The payment could not be started. Try again." };
  }

  onPrompted?.();

  const learnerId = input.learnerId ?? (await learnerOfInvoice(input.invoiceId).catch(() => null));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await sleep(intervalMs, signal);
    // A lookup that fails (no signal for a moment) is not an answer: keep waiting.
    const invoices = learnerId ? await apiFetchChildFees(learnerId).catch(() => null) : null;
    const payment = invoices?.flatMap((i) => i.payments).find((p) => p.id === paymentId);
    const outcome = payment ? outcomeOf({ status: payment.status, failure_reason: payment.failure_reason, mpesa_receipt: payment.mpesa_receipt }) : null;
    if (outcome) return outcome;
    if (Date.now() >= deadline) return { kind: "unconfirmed" };
  }
}
