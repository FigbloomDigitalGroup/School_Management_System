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
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { queryStk, secretsMatch, type StkOutcome, unpaidOutcome } from "../_shared/daraja.ts";

export interface Deps {
  // deno-lint-ignore no-explicit-any
  admin: any;
  /** DARAJA_CALLBACK_SECRET. */
  callbackSecret: string | undefined;
  queryStk: (checkoutRequestId: string) => Promise<StkOutcome>;
}

export async function handle(req: Request, { admin, callbackSecret, queryStk }: Deps): Promise<Response> {
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
    .from("payments").select("id, status, amount_cents").eq("checkout_request_id", checkoutId).maybeSingle();
  if (readErr) return retry("read the payment", readErr);
  if (!payment) return ok();                       // unknown prompt, nothing to do
  if (payment.status !== "pending") return ok();   // already settled — retry, ignore

  let outcome: StkOutcome;
  try {
    outcome = await queryStk(checkoutId);
  } catch (err) {
    return retry("confirm the result with Daraja", err);
  }
  if (!outcome.done) return retry("confirm the result with Daraja", "still processing");
  const resultCode = outcome.resultCode;

  if (resultCode === 0) {
    const items: { Name: string; Value?: string | number }[] =
      stk.CallbackMetadata?.Item ?? [];
    const receipt = String(items.find((i) => i.Name === "MpesaReceiptNumber")?.Value ?? "");
    const claimedShillings = Number(items.find((i) => i.Name === "Amount")?.Value ?? 0);
    if (claimedShillings && Math.round(claimedShillings * 100) !== payment.amount_cents) {
      console.warn(`mpesa-callback: ${checkoutId} claims KSh ${claimedShillings}, the prompt was for ${payment.amount_cents} cents; keeping the prompt's amount`);
    }

    // the apply_payment trigger moves the invoice
    const { error } = await admin.from("payments").update({
      status: "success",
      mpesa_receipt: receipt || null,
      completed_at: new Date().toISOString(),
    }).eq("id", payment.id).eq("status", "pending");
    if (error) return retry("mark the payment successful", error);

    const { data: p } = await admin.from("payments")
      .select("tenant_id, invoice_id, amount_cents, mpesa_receipt").eq("id", payment.id).single();
    if (p) {
      await admin.from("audit_events").insert({
        tenant_id: p.tenant_id, actor_label: "M-Pesa",
        event: `Fee payment received, receipt ${p.mpesa_receipt}`,
        category: "financial",
        metadata: { invoice_id: p.invoice_id, amount_cents: p.amount_cents },
      });
    }
    return ok();
  }

  const { error } = await admin.from("payments").update({
    ...unpaidOutcome(resultCode),
    completed_at: new Date().toISOString(),
  }).eq("id", payment.id).eq("status", "pending");
  if (error) return retry("mark the payment failed", error);

  return ok();
}

if (import.meta.main) {
  Deno.serve((req) => {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    return handle(req, { admin, callbackSecret: Deno.env.get("DARAJA_CALLBACK_SECRET"), queryStk });
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
