/**
 * M-Pesa Daraja STK Push.
 *
 * Deploy: supabase functions deploy mpesa-stk-push
 *
 * The parent taps Pay, we create a PENDING payment row and ask Safaricom to
 * raise the PIN prompt on their phone. We do NOT wait for the PIN here — the
 * prompt can sit unanswered for 60 seconds and a hanging request would time the
 * app out. The client polls the payment row; mpesa-callback completes it.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DARAJA_BASE = Deno.env.get("DARAJA_ENV") === "production"
  ? "https://api.safaricom.co.ke"
  : "https://sandbox.safaricom.co.ke";

interface Body { invoice_id: string; amount_cents: number; msisdn: string }

async function darajaToken(): Promise<string> {
  const key = Deno.env.get("DARAJA_CONSUMER_KEY")!;
  const secret = Deno.env.get("DARAJA_CONSUMER_SECRET")!;
  const res = await fetch(`${DARAJA_BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: "Basic " + btoa(`${key}:${secret}`) },
  });
  if (!res.ok) throw new Error("Could not authenticate with Safaricom");
  return (await res.json()).access_token as string;
}

/** Daraja wants YYYYMMDDHHmmss in Nairobi time. */
function timestamp(): string {
  const nairobi = new Date(Date.now() + 3 * 3600 * 1000);
  return nairobi.toISOString().replace(/[-:T.]/g, "").slice(0, 14);
}

// deno-lint-ignore no-explicit-any
export interface Deps { admin: any; asUser: any }

export async function handle(req: Request, { admin, asUser }: Deps): Promise<Response> {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const auth = req.headers.get("Authorization");
  if (!auth) return new Response("Unauthorized", { status: 401 });

  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { invoice_id, amount_cents, msisdn } = (await req.json()) as Body;

  if (!/^254[17]\d{8}$/.test(msisdn)) {
    return json({ error: "Enter the M-Pesa number as 07xx xxx xxx." }, 400);
  }
  if (!Number.isInteger(amount_cents) || amount_cents < 100) {
    return json({ error: "The smallest payment is KSh 1." }, 400);
  }

  // RLS on the user client proves this guardian may pay this invoice
  const { data: invoice, error: invErr } = await asUser
    .from("fee_invoices").select("id, tenant_id, total_cents, paid_cents").eq("id", invoice_id).single();
  if (invErr || !invoice) return json({ error: "That invoice is not yours to pay." }, 403);

  const outstanding = invoice.total_cents - invoice.paid_cents;
  if (amount_cents > outstanding) {
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
    const res = await fetch(`${DARAJA_BASE}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: btoa(shortcode + passkey + ts),
        Timestamp: ts,
        TransactionType: "CustomerPayBillOnline",
        Amount: Math.round(amount_cents / 100),      // Daraja takes whole shillings
        PartyA: msisdn,
        PartyB: shortcode,
        PhoneNumber: msisdn,
        CallBackURL: Deno.env.get("DARAJA_CALLBACK_URL")!,
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
    return json({ payment_id: payment.id, checkout_request_id: out.CheckoutRequestID });
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
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
