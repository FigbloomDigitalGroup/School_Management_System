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
 *
 * Who may raise a prompt: the learner's guardians, or the learner for their
 * own invoice. Staff can read every invoice but record money they receive
 * with record_payment, and nobody may ring a phone over and over: prompts
 * are limited per caller and per number (FIG-1320).
 *
 * One prompt at a time per invoice, held by the database
 * (payments_one_pending_per_invoice, FIG-1321). A request matching the
 * prompt in flight (same number, same amount) gets that one back; anything
 * else waits for it. A prompt older than any prompt lives is settled by
 * asking Daraja, through the same settleFromDaraja as mpesa-callback.
 *
 * The "check" action ({ action: "check", payment_id }): the paying app calls
 * it while it waits. A payment still pending CHECK_AFTER_MS after the prompt
 * (the callback never came, or Daraja couldn't confirm it then: the sandbox
 * throttles its query) is settled by asking Daraja, through the same
 * settleFromDaraja the callback uses. Allowed to anyone who may read the
 * payment (RLS: the learner's guardians, the learner, the school's fees
 * staff), limited per payment, and never a new prompt.
 *
 * DARAJA_TENANTS, when set, lists the only schools that may use M-Pesa here
 * (e.g. a demo school on sandbox credentials); every other school gets the
 * same 503 as when M-Pesa isn't set up, with nothing sent to Daraja.
 */

import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { CORS_HEADERS } from "../_shared/cors.ts";
import {
  darajaTenants, darajaToken, darajaUrl, type QueryRetry, queryStk as darajaQueryStk, stkPassword, type StkOutcome, tenantMayUseDaraja, timestamp,
  unpaidOutcome,
} from "../_shared/daraja.ts";
import { settleFromDaraja } from "../_shared/mpesaSettle.ts";
import { dbLimiter, type Limiter, userKey } from "../_shared/rateLimit.ts";

interface Body { invoice_id: string; amount_cents: number; msisdn: string }

/** A PIN prompt times out on the phone after about a minute; past this, its result should be known. */
const PROMPT_LIFETIME_MS = 2 * 60_000;
/** Prompts per caller, and per phone number, in PROMPT_WINDOW. */
const PROMPT_LIMIT = 10;
const PROMPT_WINDOW = "1 hour";
/** The 503 the apps read as "online M-Pesa isn't available for this school" (mpesaPay.ts). */
const NOT_SET_UP = "M-Pesa payments aren't set up for this school yet.";
/** "check" asks Daraja only about a prompt at least this old: before then the callback is the usual answer. */
const CHECK_AFTER_MS = 20_000;
/** Daraja questions per payment from "check" in CHECK_WINDOW (the apps ask every 15 s or so). */
const CHECK_LIMIT = 6;
const CHECK_WINDOW = "1 minute";

type QueryStk = (checkoutRequestId: string, retry?: QueryRetry) => Promise<StkOutcome>;

export interface Deps {
  // deno-lint-ignore no-explicit-any
  admin: any;
  // deno-lint-ignore no-explicit-any
  asUser: any;
  queryStk?: QueryStk;
  withinLimit?: Limiter;
  /** The per-payment limit on "check". */
  checkLimit?: Limiter;
}

export async function handle(
  req: Request,
  { admin, asUser, queryStk = darajaQueryStk, withinLimit = () => Promise.resolve(true), checkLimit = () => Promise.resolve(true) }: Deps,
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = req.headers.get("Authorization");
  if (!auth) return json({ error: "Unauthorized" }, 401);

  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: Partial<Body>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }
  // JSON that isn't an object (null, a number, a list) can't be destructured below (FIG-1324)
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Invalid request body" }, 400);
  if ((body as { action?: unknown }).action === "check") {
    return checkPayment(admin, asUser, queryStk, checkLimit, (body as { payment_id?: unknown }).payment_id);
  }
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
    return json({ error: NOT_SET_UP }, 503);
  }
  const callbackUrl = new URL(callbackBase);
  callbackUrl.searchParams.set("token", callbackSecret);

  // RLS on the user client proves this caller may see this invoice
  const { data: invoice, error: invErr } = await asUser
    .from("fee_invoices").select("id, tenant_id, student_id, total_cents, paid_cents").eq("id", invoice_id).single();
  if (invErr || !invoice) return json({ error: "That invoice is not yours to pay." }, 403);
  // DARAJA_TENANTS: a school not on the list is answered exactly as when M-Pesa isn't set up,
  // before anything reaches Daraja (not even settling an old prompt) or payments
  if (!tenantMayUseDaraja(invoice.tenant_id, darajaTenants())) {
    return json({ error: NOT_SET_UP }, 503);
  }
  if (!(await paysFor(admin, user.id, invoice.student_id))) {
    return json({ error: "Only the learner's family can pay by M-Pesa here. The school office records payments it receives." }, 403);
  }

  const outstanding = invoice.total_cents - invoice.paid_cents;
  // M-Pesa charges whole shillings, so a balance left with cents is cleared by
  // rounding up to the next one (FIG-1334); the few cents over are logged as an overpayment
  if (amount_cents! > Math.ceil(outstanding / 100) * 100) {
    return json({ error: "That is more than the outstanding balance." }, 400);
  }

  const inFlight = await promptInFlight(admin, queryStk, invoice_id, msisdn, amount_cents!);
  if (inFlight) return inFlight;

  // both keys are noted every time, so neither allowance can be dodged by tripping the other first
  const [callerOk, numberOk] = await Promise.all([
    withinLimit(await userKey(user.id, "mpesa-stk-push")),
    withinLimit(await userKey(msisdn, "mpesa-stk-push:number")),
  ]);
  if (!callerOk || !numberOk) {
    return json({ error: "Too many payment prompts in the last hour. Try again later, or pay to the school's paybill." }, 429);
  }

  const { data: payment, error: payErr } = await admin.from("payments").insert({
    tenant_id: invoice.tenant_id, invoice_id, amount_cents,
    method: "mpesa", msisdn, status: "pending",
  }).select("id").single();
  if (payErr?.code === "23505") {
    // another request raised a prompt for this invoice a moment ago
    return (await promptInFlight(admin, queryStk, invoice_id, msisdn, amount_cents!))
      ?? json({ error: "A payment for this invoice is already starting. Try again in a moment." }, 409);
  }
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
    return handle(req, {
      admin, asUser,
      withinLimit: dbLimiter(admin, "mpesa-stk-push", PROMPT_LIMIT, PROMPT_WINDOW),
      checkLimit: dbLimiter(admin, "mpesa-stk-push:check", CHECK_LIMIT, CHECK_WINDOW),
    });
  });
}

/** Whether this person pays for this learner: one of their guardians, or the learner. */
// deno-lint-ignore no-explicit-any
async function paysFor(admin: any, profileId: string, studentId: string): Promise<boolean> {
  const [guardian, learner] = await Promise.all([
    admin.from("guardians").select("id").eq("profile_id", profileId).eq("student_id", studentId).limit(1),
    admin.from("students").select("id").eq("id", studentId).eq("profile_id", profileId).limit(1),
  ]);
  return (guardian.data ?? []).length > 0 || (learner.data ?? []).length > 0;
}

/**
 * The invoice's pending prompt, if there is one: the answer to send back
 * (reuse it, or wait for it), or null when a new prompt may go out. A
 * prompt past its lifetime is settled first by asking Daraja.
 */
async function promptInFlight(
  // deno-lint-ignore no-explicit-any
  admin: any,
  queryStk: QueryStk,
  invoiceId: string,
  msisdn: string,
  amountCents: number,
): Promise<Response | null> {
  const { data: pending, error } = await admin.from("payments")
    .select("id, msisdn, amount_cents, checkout_request_id, mpesa_receipt, created_at")
    .eq("invoice_id", invoiceId).eq("status", "pending").maybeSingle();
  // an error here is an error, never "nothing in flight"
  if (error) return json({ error: "Could not check for a payment already in progress. Try again." }, 500);
  if (!pending) return null;

  // an age that can't be read counts as fresh: settling a live prompt is the worse mistake
  if (!(Date.now() - Date.parse(pending.created_at) >= PROMPT_LIFETIME_MS)) {
    if (pending.msisdn === msisdn && pending.amount_cents === amountCents) {
      return json({ payment_id: pending.id, reused: true });
    }
    return json({
      error: pending.msisdn === msisdn
        ? "A prompt for a different amount is already on that phone. Answer or cancel it, then try again."
        : "A payment prompt for this invoice is already waiting on another phone. Try again in a couple of minutes.",
    }, 409);
  }

  // Older than any prompt lives. No checkout id: it never reached Safaricom.
  let unpaid = { status: "failed", failure_reason: "unreachable" };
  if (pending.checkout_request_id) {
    let outcome: StkOutcome;
    try {
      // fewer retries than the callback's: the parent is waiting on this answer
      outcome = await queryStk(pending.checkout_request_id, { delaysMs: [1500, 3000] });
    } catch {
      return json({ error: "We couldn't check the last M-Pesa payment for this invoice. Try again in a minute." }, 502);  // 503 reads as "M-Pesa isn't set up" in mpesaPay.ts
    }
    if (!outcome.done) {
      return json({ error: "The last M-Pesa payment for this invoice is still being processed. Try again in a minute." }, 409);
    }
    // paid: credited here exactly as the callback would (its result may never have been confirmed); never a second prompt on top
    if (outcome.resultCode === 0) {
      const settled = await settleFromDaraja(admin, pending.id, 0, pending.mpesa_receipt ?? null, "mpesa-stk-push");
      if (!settled.ok) return json({ error: "Could not check for a payment already in progress. Try again." }, 500);
      return json({ error: "The last M-Pesa payment for this invoice went through. Check the balance before paying again." }, 409);
    }
    unpaid = unpaidOutcome(outcome.resultCode);
  }
  const { error: settleErr } = await admin.from("payments")
    .update({ ...unpaid, completed_at: new Date().toISOString() })
    .eq("id", pending.id).eq("status", "pending");
  if (settleErr) return json({ error: "Could not check for a payment already in progress. Try again." }, 500);
  return null;
}

/**
 * The "check" action: settle a payment left pending by asking Daraja, as the
 * callback would. Answers { payment_id, status }: the payment's status after
 * the check, "pending" when Daraja has no result yet, was not asked, or
 * couldn't be reached. The app reads the row itself either way.
 */
async function checkPayment(
  // deno-lint-ignore no-explicit-any
  admin: any,
  // deno-lint-ignore no-explicit-any
  asUser: any,
  queryStk: QueryStk,
  checkLimit: Limiter,
  paymentId: unknown,
): Promise<Response> {
  if (typeof paymentId !== "string" || !paymentId) return json({ error: "Which payment is this?" }, 400);
  // RLS on the user client proves this caller may see this payment (the learner's guardians, the learner, the school's fees staff)
  const { data: seen, error: seenErr } = await asUser.from("payments").select("id").eq("id", paymentId).maybeSingle();
  if (seenErr || !seen) return json({ error: "That payment is not yours to check." }, 403);

  const { data: p, error } = await admin.from("payments")
    .select("id, tenant_id, status, checkout_request_id, mpesa_receipt, created_at").eq("id", paymentId).maybeSingle();
  if (error || !p) return json({ error: "Could not check the payment. Try again." }, 500);
  const pending = () => json({ payment_id: p.id, status: "pending" });
  if (p.status !== "pending") return json({ payment_id: p.id, status: p.status });
  // an unlisted school's payment is never settled from here, nor Daraja asked about it
  if (!tenantMayUseDaraja(p.tenant_id, darajaTenants())) return pending();
  // no checkout id: still being raised. Too young (or an age that can't be read): the callback is still the usual answer.
  if (!p.checkout_request_id || !(Date.now() - Date.parse(p.created_at) >= CHECK_AFTER_MS)) return pending();
  if (!(await checkLimit(await userKey(p.id, "mpesa-stk-push:check")))) return pending();

  let outcome: StkOutcome;
  try {
    // the customer may still be on the PIN screen: "still processing" is an answer here, and the app asks again later
    outcome = await queryStk(p.checkout_request_id, { retryWhileProcessing: false });
  } catch (err) {
    console.error(`mpesa-stk-push: check of payment ${p.id}: could not confirm the result with Daraja:`, err instanceof Error ? err.message : err);
    return pending();
  }
  if (!outcome.done) return pending();

  const settled = await settleFromDaraja(admin, p.id, outcome.resultCode, p.mpesa_receipt ?? null, "mpesa-stk-push");
  if (!settled.ok) {
    console.error(`mpesa-stk-push: check of payment ${p.id}: could not ${settled.step}:`, settled.error);
    return json({ error: "Could not check the payment. Try again." }, 500);
  }
  const { data: after } = await admin.from("payments").select("status").eq("id", p.id).maybeSingle();
  return json({ payment_id: p.id, status: after?.status ?? "pending" });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
