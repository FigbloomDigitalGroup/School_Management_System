/**
 * Safaricom's result callback. This is the ONLY thing that marks a payment
 * successful — the client is never trusted for that, and neither is the
 * callback body on its own:
 *
 * - Anyone can POST to this URL (Safaricom can't send a JWT), so the URL
 *   mpesa-stk-push gives Safaricom carries a secret (?token=, from
 *   DARAJA_CALLBACK_SECRET). Anything without it is refused, and with the
 *   secret unset every callback is.
 * - The result itself comes from asking Daraja (STK query for this
 *   CheckoutRequestID), and the amount is the one the prompt asked for when
 *   mpesa-stk-push raised it — never the callback's "Amount".
 *
 * Deploy with JWT verification off, since Safaricom cannot send one:
 *   supabase functions deploy mpesa-callback --no-verify-jwt
 *
 * Safaricom redelivers anything but a 200, so this must be idempotent: only a
 * still-pending payment is ever settled, and mpesa_receipt is unique. A
 * database error or a result Daraja can't confirm yet answers 500, so the
 * delivery is retried rather than the payment silently staying pending.
 * Daraja's sandbox throttles the query (HTTP 429) and may not redeliver, so the
 * query itself is asked again for a few seconds first, and a payment still
 * left pending is settled later by mpesa-stk-push's "check" action (the
 * paying app calls it while it waits), through the same settleFromDaraja.
 */

import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { darajaTenants, queryStk, secretsMatch, type StkOutcome, tenantMayUseDaraja } from "../_shared/daraja.ts";
import { settleFromDaraja } from "../_shared/mpesaSettle.ts";

export interface Deps {
  // deno-lint-ignore no-explicit-any
  admin: any;
  /** DARAJA_CALLBACK_SECRET. */
  callbackSecret: string | undefined;
  queryStk: (checkoutRequestId: string) => Promise<StkOutcome>;
  /** DARAJA_TENANTS (darajaTenants()): the schools that may use M-Pesa; null or left out, every school may. */
  allowedTenants?: Set<string> | null;
}

export async function handle(req: Request, { admin, callbackSecret, queryStk, allowedTenants = null }: Deps): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token");
  if (!callbackSecret || !secretsMatch(token, callbackSecret)) {
    return new Response("Forbidden", { status: 403 });
  }

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return ok(); }

  const stk = body?.Body?.stkCallback;
  if (!stk) return ok();

  const checkoutId: string | undefined = stk.CheckoutRequestID;
  if (!checkoutId) return ok();

  const { data: payment, error: readErr } = await admin
    .from("payments").select("id, tenant_id, status, amount_cents").eq("checkout_request_id", checkoutId).maybeSingle();
  if (readErr) return retry("read the payment", readErr);
  if (!payment) return ok();                       // unknown prompt, nothing to do
  if (payment.status !== "pending") return ok();   // already settled — retry, ignore
  // DARAJA_TENANTS: a school not on the list never has a payment settled from here, nor Daraja asked about it.
  // mpesa-stk-push won't raise a prompt for one, so this is a prompt from before the list or a forged callback.
  if (!tenantMayUseDaraja(payment.tenant_id, allowedTenants)) {
    console.error(`mpesa-callback: payment ${payment.id} is for a school not in DARAJA_TENANTS; left pending, not credited`);
    return ok();
  }

  // what Safaricom said happened, so a failure (a wrong PIN, a phone's "MMI code" error) can be read in the logs;
  // only the payment id identifies it, never the phone number or the amount
  console.log(`mpesa-callback: payment ${payment.id}: Safaricom reported ResultCode ${loggable(stk.ResultCode)} (${loggable(stk.ResultDesc)})`);

  const items: { Name: string; Value?: string | number }[] = stk.CallbackMetadata?.Item ?? [];
  const receipt = String(items.find((i) => i.Name === "MpesaReceiptNumber")?.Value ?? "") || null;

  let outcome: StkOutcome;
  try {
    outcome = await queryStk(checkoutId);   // asks again on a 429 or a busy Daraja (_shared/daraja.ts)
  } catch (err) {
    await keepClaimedReceipt(admin, payment.id, stk.ResultCode, receipt);
    return retry("confirm the result with Daraja", err);
  }
  if (!outcome.done) {
    await keepClaimedReceipt(admin, payment.id, stk.ResultCode, receipt);
    return retry("confirm the result with Daraja", "still processing");
  }

  if (outcome.resultCode === 0) {
    const claimedShillings = Number(items.find((i) => i.Name === "Amount")?.Value ?? 0);
    if (claimedShillings && Math.round(claimedShillings * 100) !== payment.amount_cents) {
      console.warn(`mpesa-callback: payment ${payment.id} callback claims a different amount from the prompt's; keeping the prompt's amount`);
    }
  }

  const settled = await settleFromDaraja(admin, payment.id, outcome.resultCode, receipt, "mpesa-callback");
  if (!settled.ok) return retry(settled.step, settled.error);
  return ok();
}

/**
 * Daraja couldn't confirm a callback that says "paid", and Safaricom may never
 * deliver it again (the sandbox often doesn't). Keep the receipt it reported on
 * the still-pending row, so whatever confirms the payment later (mpesa-stk-push's
 * "check") credits it with its receipt. The payment stays pending: nothing is
 * credited without Daraja, and settling it unpaid clears the receipt.
 */
// deno-lint-ignore no-explicit-any
async function keepClaimedReceipt(admin: any, paymentId: string, claimedCode: unknown, receipt: string | null) {
  if (!receipt || (claimedCode !== 0 && claimedCode !== "0")) return;
  const { error } = await admin.from("payments").update({ mpesa_receipt: receipt })
    .eq("id", paymentId).eq("status", "pending").is("mpesa_receipt", null);
  if (error) console.error(`mpesa-callback: could not keep the reported receipt on payment ${paymentId}:`, error.message);
}

/** A callback field for the logs: short, on one line. */
function loggable(value: unknown): string {
  return String(value ?? "none").replace(/\s+/g, " ").slice(0, 200);
}

if (import.meta.main) {
  Deno.serve((req) => {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    return handle(req, { admin, callbackSecret: Deno.env.get("DARAJA_CALLBACK_SECRET"), queryStk, allowedTenants: darajaTenants() });
  });
}

/** What Safaricom expects once a callback is handled (or safely ignored). */
const ok = () =>
  new Response(JSON.stringify({ ResultCode: 0, ResultDesc: "Accepted" }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });

/** Anything but a 200 makes Safaricom deliver the callback again. */
function retry(step: string, err: unknown): Response {
  console.error(`mpesa-callback: could not ${step}:`, err instanceof Error ? err.message : err);
  return new Response(JSON.stringify({ ResultCode: 1, ResultDesc: "Try again" }), {
    status: 500, headers: { "Content-Type": "application/json" },
  });
}
