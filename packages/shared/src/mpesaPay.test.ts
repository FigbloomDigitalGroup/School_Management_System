import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const maybeSingle = vi.fn();
const eq = vi.fn(() => ({ maybeSingle }));
const select = vi.fn(() => ({ eq }));
const from = vi.fn(() => ({ select }));
vi.mock("./supabase", () => ({ supabase: () => ({ functions: { invoke }, from }) }));

import { fetchPaymentMethods, outcomeOf, payWithMpesa } from "./mpesaPay";

const httpError = (status: number, body: unknown) => ({
  data: null,
  error: { message: "Edge Function returned a non-2xx status code", context: new Response(JSON.stringify(body), { status }) },
});

const input = { invoiceId: "inv-1", amountCents: 500000, msisdn: "254712345678" };
const row = (status: string, extra: Record<string, unknown> = {}) => ({ data: { status, failure_reason: null, mpesa_receipt: null, ...extra }, error: null });

// braces matter: a function returned from beforeEach is run as cleanup, and mockReset() returns the mock
beforeEach(() => { vi.useFakeTimers(); invoke.mockReset(); maybeSingle.mockReset(); from.mockClear(); select.mockClear(); eq.mockClear(); });
afterEach(() => { vi.useRealTimers(); });

/** Runs payWithMpesa while the fake clock ticks, returning its result. */
async function run(options: Parameters<typeof payWithMpesa>[1] = {}, ticks = 40, step = 1000) {
  const result = payWithMpesa(input, options);
  const settled = result.then((r) => r, (e) => e);
  for (let i = 0; i < ticks; i++) await vi.advanceTimersByTimeAsync(step);
  return settled;
}

describe("outcomeOf", () => {
  it("is null while pending", () => {
    expect(outcomeOf({ status: "pending", failure_reason: null, mpesa_receipt: null })).toBeNull();
  });
  it("is success with the receipt code", () => {
    expect(outcomeOf({ status: "success", failure_reason: null, mpesa_receipt: "SFC1234ABC" })).toEqual({ kind: "success", receipt: "SFC1234ABC" });
  });
  it("uses the failure reason the callback recorded", () => {
    expect(outcomeOf({ status: "failed", failure_reason: "wrong_pin", mpesa_receipt: null })).toEqual({ kind: "failed", reason: "wrong_pin" });
    expect(outcomeOf({ status: "failed", failure_reason: "insufficient", mpesa_receipt: null })).toEqual({ kind: "failed", reason: "insufficient" });
  });
  it("falls back to the status when there is no usable reason", () => {
    expect(outcomeOf({ status: "cancelled", failure_reason: null, mpesa_receipt: null })).toEqual({ kind: "failed", reason: "cancelled" });
    expect(outcomeOf({ status: "timeout", failure_reason: null, mpesa_receipt: null })).toEqual({ kind: "failed", reason: "timeout" });
    expect(outcomeOf({ status: "failed", failure_reason: "something new", mpesa_receipt: null })).toEqual({ kind: "failed", reason: "unreachable" });
  });
});

describe("payWithMpesa", () => {
  it("asks the function for a prompt, then reports success only when the payment row says so", async () => {
    invoke.mockResolvedValue({ data: { payment_id: "pay-1" }, error: null });
    maybeSingle
      .mockResolvedValueOnce(row("pending"))
      .mockResolvedValueOnce(row("pending"))
      .mockResolvedValueOnce(row("success", { mpesa_receipt: "SFC1234ABC" }));
    const onPrompted = vi.fn();

    const result = await run({ onPrompted, intervalMs: 3000 });

    expect(result).toEqual({ kind: "success", receipt: "SFC1234ABC" });
    expect(invoke).toHaveBeenCalledWith("mpesa-stk-push", expect.objectContaining({ body: { invoice_id: "inv-1", amount_cents: 500000, msisdn: "254712345678" } }));
    expect(onPrompted).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("payments");
    expect(eq).toHaveBeenCalledWith("id", "pay-1");
  });

  it("never reports success from the function's answer alone", async () => {
    invoke.mockResolvedValue({ data: { payment_id: "pay-1" }, error: null });
    maybeSingle.mockResolvedValue(row("pending"));
    const result = await run({ timeoutMs: 20_000 });
    expect(result).toEqual({ kind: "unconfirmed" });
  });

  it("reports why it failed, in the callback's own terms", async () => {
    invoke.mockResolvedValue({ data: { payment_id: "pay-1" }, error: null });
    maybeSingle.mockResolvedValueOnce(row("failed", { failure_reason: "wrong_pin" }));
    expect(await run()).toEqual({ kind: "failed", reason: "wrong_pin" });
  });

  it("reports a cancelled prompt as cancelled", async () => {
    invoke.mockResolvedValue({ data: { payment_id: "pay-1" }, error: null });
    maybeSingle.mockResolvedValueOnce(row("cancelled"));
    expect(await run()).toEqual({ kind: "failed", reason: "cancelled" });
  });

  it("keeps waiting through a lookup that fails or returns nothing", async () => {
    invoke.mockResolvedValue({ data: { payment_id: "pay-1" }, error: null });
    maybeSingle
      .mockResolvedValueOnce({ data: null, error: { message: "network" } })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce(row("success", { mpesa_receipt: "SFC9" }));
    expect(await run({ intervalMs: 3000 })).toEqual({ kind: "success", receipt: "SFC9" });
  });

  it("says unconfirmed, not failed, when it stops waiting without an answer", async () => {
    invoke.mockResolvedValue({ data: { payment_id: "pay-1" }, error: null });
    maybeSingle.mockResolvedValue(row("pending"));
    expect(await run({ intervalMs: 3000, timeoutMs: 90_000 }, 120)).toEqual({ kind: "unconfirmed" });
  });

  it("is 'unavailable' when the function answers 503 (M-Pesa not set up, or nothing behind the gateway)", async () => {
    invoke.mockResolvedValue(httpError(503, { error: "M-Pesa payments aren't set up for this school yet." }));
    expect(await run()).toEqual({ kind: "unavailable" });
    invoke.mockResolvedValue(httpError(503, { message: "name resolution failed" }));
    expect(await run()).toEqual({ kind: "unavailable" });
    expect(maybeSingle).not.toHaveBeenCalled();
  });

  it("passes the function's refusal through as a sentence, and sends nothing", async () => {
    invoke.mockResolvedValue(httpError(400, { error: "That is more than the outstanding balance." }));
    const onPrompted = vi.fn();
    expect(await run({ onPrompted })).toEqual({ kind: "rejected", message: "That is more than the outstanding balance." });
    expect(onPrompted).not.toHaveBeenCalled();
  });

  it("is rejected, not unavailable, when the invoice isn't the payer's (403)", async () => {
    invoke.mockResolvedValue(httpError(403, { error: "That invoice is not yours to pay." }));
    expect(await run()).toEqual({ kind: "rejected", message: "That invoice is not yours to pay." });
  });

  it("is rejected when the function answers without a payment id", async () => {
    invoke.mockResolvedValue({ data: {}, error: null });
    expect((await run()).kind).toBe("rejected");
  });

  it("gives up starting after 30 seconds", async () => {
    invoke.mockImplementation((_fn: string, opts: { signal: AbortSignal }) =>
      new Promise((resolve) => opts.signal.addEventListener("abort", () => resolve({ data: null, error: { message: "aborted" } }))));
    const result = await run({}, 35);
    expect(result).toEqual({ kind: "rejected", message: "That took too long. Check your connection and try again." });
  });

  it("stops waiting when the screen is closed, without claiming any outcome", async () => {
    invoke.mockResolvedValue({ data: { payment_id: "pay-1" }, error: null });
    maybeSingle.mockResolvedValue(row("pending"));
    const controller = new AbortController();
    const result = payWithMpesa(input, { signal: controller.signal, intervalMs: 3000 });
    const settled = result.then(() => "resolved", (e: Error) => e.name);
    await vi.advanceTimersByTimeAsync(4000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(4000);
    expect(await settled).toBe("AbortError");
  });
});

describe("fetchPaymentMethods", () => {
  it("returns the school's details", async () => {
    maybeSingle.mockResolvedValue({
      data: { payment_paybill: "522522", payment_till: null, payment_bank_details: "Equity 0123", payment_notes: "Account = admission number" },
      error: null,
    });
    expect(await fetchPaymentMethods("t1")).toEqual({ paybill: "522522", till: null, bank: "Equity 0123", notes: "Account = admission number" });
    expect(from).toHaveBeenCalledWith("tenants");
  });

  it("is null when the school has set none, even if it has a note", async () => {
    maybeSingle.mockResolvedValue({ data: { payment_paybill: null, payment_till: null, payment_bank_details: null, payment_notes: "Pay at the office" }, error: null });
    expect(await fetchPaymentMethods("t1")).toBeNull();
  });

  it("is null when the school can't be read", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await fetchPaymentMethods("t1")).toBeNull();
  });
});
