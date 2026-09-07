/**
 * Safaricom's result callback. This is the ONLY thing that marks a payment
 * successful — the client is never trusted for that.
 *
 * Deploy with JWT verification off, since Safaricom cannot send one:
 *   supabase functions deploy mpesa-callback --no-verify-jwt
 *
 * Safaricom retries, so this must be idempotent: the mpesa_receipt column is
 * unique and a second delivery of the same receipt is a no-op.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/** Daraja result codes, mapped to the copy a parent actually reads. */
const REASON: Record<number, string> = {
  1: "insufficient",
  1032: "cancelled",
  1037: "timeout",
  2001: "wrong_pin",
  1001: "duplicate",
};

Deno.serve(async (req) => {
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: any;
  try { body = await req.json(); } catch { return ok(); }

  const stk = body?.Body?.stkCallback;
  if (!stk) return ok();

  const checkoutId: string | undefined = stk.CheckoutRequestID;
  const resultCode: number = Number(stk.ResultCode);
  if (!checkoutId) return ok();

  const { data: payment } = await admin
    .from("payments").select("id, status").eq("checkout_request_id", checkoutId).maybeSingle();
  if (!payment) return ok();                       // unknown prompt, nothing to do
  if (payment.status !== "pending") return ok();   // already settled — retry, ignore

  if (resultCode === 0) {
    const items: { Name: string; Value?: string | number }[] =
      stk.CallbackMetadata?.Item ?? [];
    const receipt = String(items.find((i) => i.Name === "MpesaReceiptNumber")?.Value ?? "");
    const paidShillings = Number(items.find((i) => i.Name === "Amount")?.Value ?? 0);

    // the apply_payment trigger moves the invoice
    const { error } = await admin.from("payments").update({
      status: "success",
      mpesa_receipt: receipt || null,
      amount_cents: paidShillings > 0 ? Math.round(paidShillings * 100) : undefined,
      completed_at: new Date().toISOString(),
    }).eq("id", payment.id).eq("status", "pending");

    if (!error) {
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
    }
    return ok();
  }

  await admin.from("payments").update({
    status: resultCode === 1032 ? "cancelled" : resultCode === 1037 ? "timeout" : "failed",
    failure_reason: REASON[resultCode] ?? "unreachable",
    completed_at: new Date().toISOString(),
  }).eq("id", payment.id).eq("status", "pending");

  return ok();
});

/** Safaricom expects a 200 whatever happens, or it retries forever. */
const ok = () =>
  new Response(JSON.stringify({ ResultCode: 0, ResultDesc: "Accepted" }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
