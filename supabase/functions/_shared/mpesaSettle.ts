/**
 * Settling a pending M-Pesa payment once Daraja's STK query has answered with
 * a result. The one place a payment is marked paid or unpaid from Daraja, used
 * by mpesa-callback (Safaricom's callback) and mpesa-stk-push (its "check"
 * action, and an old prompt found when a new one is asked for), so every path
 * settles the same way:
 *
 * - The result is the one Daraja's query gave, never a callback's claim.
 * - Only a still-pending payment changes (.eq("status", "pending")), so two
 *   paths settling the same payment at once credit it once and log it once.
 * - The amount is the one on the payment, which is what the prompt asked for.
 * - The receipt is the one the callback reported (Daraja's query doesn't give
 *   one). A payment confirmed without a callback body in hand uses the receipt
 *   a callback left on the row when Daraja couldn't confirm it at the time.
 */

import { unpaidOutcome } from "./daraja.ts";

export type Settlement =
  /** This call settled it: "success", or the unpaid status. */
  | { ok: true; status: "success" | "cancelled" | "timeout" | "failed" }
  /** It was no longer pending: something else settled it a moment ago. */
  | { ok: true; status: "already" }
  /** A database write failed; the payment is still pending. */
  | { ok: false; step: string; error: unknown };

export async function settleFromDaraja(
  // deno-lint-ignore no-explicit-any
  admin: any,
  paymentId: string,
  resultCode: number,
  receipt: string | null,
  /** Who is settling, for the logs. */
  who: string,
): Promise<Settlement> {
  if (resultCode === 0) {
    // the apply_payment trigger moves the invoice
    const { data: settled, error } = await admin.from("payments").update({
      status: "success",
      mpesa_receipt: receipt || null,
      completed_at: new Date().toISOString(),
    }).eq("id", paymentId).eq("status", "pending").select("id");
    if (error) return { ok: false, step: "mark the payment successful", error };
    // another path settled it a moment ago, and logged it (FIG-1323)
    if (!settled?.length) return { ok: true, status: "already" };

    const { data: p } = await admin.from("payments")
      .select("tenant_id, invoice_id, amount_cents, mpesa_receipt").eq("id", paymentId).single();
    if (p) {
      const { error: auditErr } = await admin.from("audit_events").insert({
        tenant_id: p.tenant_id, actor_label: "M-Pesa",
        event: `Fee payment received, receipt ${p.mpesa_receipt}`,
        category: "financial",
        metadata: { invoice_id: p.invoice_id, amount_cents: p.amount_cents },
      });
      // the payment is settled either way; a lost audit line must at least show in the logs
      if (auditErr) console.error(`${who}: could not log payment ${paymentId}:`, auditErr.message);
    }
    console.log(`${who}: payment ${paymentId} confirmed by Daraja and credited`);
    return { ok: true, status: "success" };
  }

  const unpaid = unpaidOutcome(resultCode);
  const { data: settled, error } = await admin.from("payments").update({
    ...unpaid,
    // a receipt a callback claimed while Daraja couldn't confirm it is not one
    mpesa_receipt: null,
    completed_at: new Date().toISOString(),
  }).eq("id", paymentId).eq("status", "pending").select("id");
  if (error) return { ok: false, step: "mark the payment failed", error };
  if (!settled?.length) return { ok: true, status: "already" };
  console.log(`${who}: payment ${paymentId} settled as ${unpaid.status} (Daraja ResultCode ${resultCode})`);
  return { ok: true, status: unpaid.status };
}
