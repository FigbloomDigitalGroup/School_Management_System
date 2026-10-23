/**
 * M-Pesa Daraja STK Push.
 *
 * Deploy: supabase functions deploy mpesa-stk-push
 *
 * The parent taps Pay, we create a PENDING payment row and ask Safaricom to
 * raise the PIN prompt on their phone. We do NOT wait for the PIN here — the
 * prompt can sit unanswered for 60 seconds and a hanging request would time the
 * app out. The client polls the payment row; mpesa-callback completes it.
 *
 * This is the only place a payments row is created (clients have no insert
 * policy), and the amount on it is exactly what Safaricom is asked to charge,
 * which is what mpesa-callback credits.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { darajaToken, darajaUrl, stkPassword, timestamp } from "../_shared/daraja.ts";

interface Body { invoice_id: string; amount_cents: number; msisdn: string }

// deno-lint-ignore no-explicit-any
export interface Deps { admin: any; asUser: any }

export async function handle(req: Request, { admin, asUser }: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = req.headers.get("Authorization");
  if (!auth) return json({ error: "Unauthorized" }, 401);

  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: Partial<Body>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }
  const { invoice_id, amount_cents, msisdn } = body;

  if (!invoice_id) return json({ error: "Which invoice is this for?" }, 400);
  if (typeof msisdn !== "string" || !/^254[17]\d{8}$/.test(msisdn)) {
    return json({ error: "Enter the M-Pesa number as 07xx xxx xxx." }, 400);
  }
  if (!Number.isInteger(amount_cents) || amount_cents! < 100) {
    return json({ error: "The smallest payment is KSh 1." }, 400);
  }
  // Daraja only charges whole shillings; anything else would be credited as
  // a different amount from the one actually paid.
  if (amount_cents! % 100 !== 0) {
    return json({ error: "M-Pesa payments are in whole shillings." }, 400);
  }

  // The callback refuses anything without this secret, so a prompt raised
  // without it could be paid but never credited.
  const callbackSecret = Deno.env.get("DARAJA_CALLBACK_SECRET");
  const callbackBase = Deno.env.get("DARAJA_CALLBACK_URL");
  if (!callbackSecret || !callbackBase) {
    console.error("mpesa-stk-push: DARAJA_CALLBACK_SECRET or DARAJA_CALLBACK_URL is not set");
    return json({ error: "M-Pesa payments aren't set up for this school yet." }, 503);
  }
  const callbackUrl = new URL(callbackBase);
  callbackUrl.searchParams.set("token", callbackSecret);

  // RLS on the user client proves this caller may see (and so pay) this invoice
  const { data: invoice, error: invErr } = await asUser
    .from("fee_invoices").select("id, tenant_id, total_cents, paid_cents").eq("id", invoice_id).single();
  if (invErr || !invoice) return json({ error: "That invoice is not yours to pay." }, 403);

  const outstanding = invoice.total_cents - invoice.paid_cents;
  if (amount_cents! > outstanding) {
    return json({ error: "That is more than the outstanding balance." }, 400);
  }

  // Guard against a double tap raising two prompts
  const { data: inflight } = await admin
    .from("payments").select("id").eq("invoice_id", invoice_id).eq("status", "pending")
    .gte("created_at", new Date(Date.now() - 90_000).toISOString()).maybeSingle();
  if (inflight) return json({ payment_id: inflight.id, reused: true });

  const { data: payment, error: payErr } = await admin.from("payments").insert({
    tenant_id: invoice.tenant_id, invoice_id, amount_cents,
    method: "mpesa", msisdn, status: "pending",
  }).select("id").single();
  if (payErr || !payment) return json({ error: "Could not start the payment." }, 500);

  const shortcode = Deno.env.get("DARAJA_SHORTCODE")!;
  const passkey = Deno.env.get("DARAJA_PASSKEY")!;
  const ts = timestamp();

  try {
    const token = await darajaToken();
    const res = await fetch(darajaUrl("/mpesa/stkpush/v1/processrequest"), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: stkPassword(shortcode, passkey, ts),
        Timestamp: ts,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount_cents! / 100,
        PartyA: msisdn,
        PartyB: shortcode,
        PhoneNumber: msisdn,
        CallBackURL: callbackUrl.toString(),
        AccountReference: `FIG-${invoice_id.slice(0, 8)}`,
        TransactionDesc: "School fees",
      }),
    });

    const out = await res.json();
    if (out.ResponseCode !== "0") {
      await admin.from("payments").update({
        status: "failed", failure_reason: "unreachable", completed_at: new Date().toISOString(),
      }).eq("id", payment.id);
      return json({ error: "We could not reach that phone. Check it is on and has network." }, 502);
    }

    await admin.from("payments")
      .update({ checkout_request_id: out.CheckoutRequestID }).eq("id", payment.id);

    // The client now polls payments.status until it leaves 'pending'
    return json({ payment_id: payment.id });
  } catch (err) {
    await admin.from("payments").update({
      status: "failed", failure_reason: "unreachable",
      completed_at: new Date().toISOString(),
    }).eq("id", payment.id);
    return json({ error: err instanceof Error ? err.message : "Payment could not start." }, 502);
  }
}

if (import.meta.main) {
  Deno.serve((req) => {
    const auth = req.headers.get("Authorization") ?? "";
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    return handle(req, { admin, asUser });
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
