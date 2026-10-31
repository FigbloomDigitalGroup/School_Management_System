import { useEffect, useRef, useState } from "react";
import { formatMoney, PAYMENT_FAILURES, normaliseMsisdn, parseShillings, payableSuggestions, payWithMpesa, wholeShillings, type PaymentFailure } from "@figbloom/shared";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { Mono } from "./ui/DataTable";
import { useTenantSession } from "../lib/sessionContext";

type Phase = "form" | "sending" | "prompting" | "success" | "failed" | "unconfirmed" | "unavailable";

interface Props {
  /** Who the fee is for: "Faith Achieng". */
  payeeName: string;
  /** Their first name, for "Faith's balance is now …". */
  payeeFirst: string;
  /** Shown under the title: "Form 2 West". */
  context: string;
  balanceCents: number;
  /** This term's invoice; null until the school has billed. */
  invoiceId: string | null;
  country: string;
  /** Prefilled M-Pesa number, or "" — never a stand-in: a prefilled demo number would send a real prompt to a stranger's phone. */
  initialPhone: string;
  onClose: () => void;
  /** The payment was confirmed, or might still arrive: the caller should reload the balance and receipts. */
  onSettled: () => void;
}

/**
 * Pay a fee by M-Pesa. Nothing here decides a payment worked: payWithMpesa
 * asks the server for the prompt, then reads the payment row until Safaricom's
 * confirmed answer is on it, so "received" always means the database says so.
 * When online M-Pesa isn't available for the school, the dialog shows the
 * school's own paybill/till/bank details instead of pretending.
 */
export function PayWithMpesaModal({ payeeName, payeeFirst, context, balanceCents, invoiceId, country, initialPhone, onClose, onSettled }: Props) {
  const { tenant } = useTenantSession();
  const [phase, setPhase] = useState<Phase>("form");
  // what was typed, kept as typed: a decimal point is refused with a reason, never dropped (FIG-1334)
  const [amountText, setAmountText] = useState(balanceCents > 0 ? String(wholeShillings(balanceCents) / 100) : "");
  const parsed = parseShillings(amountText);
  const amount = parsed.ok ? parsed.cents : 0;
  const [phone, setPhone] = useState(initialPhone);
  const [error, setError] = useState("");
  const [failure, setFailure] = useState<PaymentFailure>("timeout");
  const [receipt, setReceipt] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  // Closing the dialog stops us watching; the payment itself carries on and is credited by Safaricom's callback.
  useEffect(() => () => abort.current?.abort(), []);

  async function send() {
    const p = normaliseMsisdn(phone);
    if (!p.ok) { setError(p.message); return; }
    if (!parsed.ok) { setError(parsed.message); return; }
    if (amount <= 0) { setError("Enter how much you are paying."); return; }
    if (amount > wholeShillings(balanceCents)) { setError(`That is more than the ${formatMoney(balanceCents, country)} still owed.`); return; }
    if (!invoiceId) { setError("The school hasn't billed this term yet, so there is nothing to pay online."); return; }

    setError("");
    setPhase("sending");
    const controller = new AbortController();
    abort.current = controller;
    try {
      const result = await payWithMpesa(
        { invoiceId, amountCents: amount, msisdn: p.msisdn },
        { signal: controller.signal, onPrompted: () => setPhase("prompting") },
      );
      switch (result.kind) {
        case "success": setReceipt(result.receipt); setPhase("success"); onSettled(); break;
        case "failed": setFailure(result.reason); setPhase("failed"); break;
        case "unconfirmed": setPhase("unconfirmed"); onSettled(); break;
        case "unavailable": setPhase("unavailable"); break;
        case "rejected": setError(result.message); setPhase("form"); break;
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError("Something went wrong. Nothing was charged. Try again.");
      setPhase("form");
    }
  }

  const hasMethods = Boolean(tenant.payment_paybill || tenant.payment_till || tenant.payment_bank_details);

  const title =
    phase === "success" ? `${formatMoney(amount, country)} received`
      : phase === "failed" ? "The payment did not go through"
      : phase === "unconfirmed" ? "We haven't heard back from M-Pesa yet"
      : phase === "unavailable" ? "Pay using the school's details"
      : phase === "sending" ? "Contacting M-Pesa…"
      : phase === "prompting" ? "Check your phone"
      : `Pay for ${payeeName}`;

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="M-PESA"
      title={title}
      blurb={phase === "form" ? `${context} · balance ${formatMoney(balanceCents, country)}` : undefined}
      footNote={phase === "form" ? `A prompt will be sent to ${phone || "that number"}. Nothing leaves the account until the PIN is entered.` : undefined}
      actions={
        phase === "form" ? (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="accent" onClick={() => void send()}>Send M-Pesa prompt</Button>
          </>
        ) : phase === "failed" ? (
          <>
            <Button onClick={onClose}>Pay at the school office instead</Button>
            <Button variant="accent" onClick={() => setPhase("form")}>Try again</Button>
          </>
        ) : phase === "success" ? (
          <Button variant="accent" onClick={onClose}>Done</Button>
        ) : phase === "unconfirmed" || phase === "unavailable" ? (
          <Button variant="accent" onClick={onClose}>Back to fees</Button>
        ) : undefined
      }
    >
      {phase === "form" && (
        <div className="grid gap-4">
          <div>
            <h3 className="mb-2 text-[12.5px] font-semibold">How much?</h3>
            <div className="grid gap-2">
              {payableSuggestions(balanceCents).map((s) => {
                const on = s.cents > 0 && amount === s.cents;
                return (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => setAmountText(s.cents > 0 ? String(s.cents / 100) : "")}
                    className="flex items-center justify-between rounded-lg border-[1.5px] bg-white px-3.5 py-2.5 text-left"
                    style={{ borderColor: on ? "var(--accent)" : "#EAE6E5" }}
                  >
                    <span className="text-[13px] font-medium">{s.label}</span>
                    {s.cents > 0 && <span className="font-mono text-[12.5px]">{formatMoney(s.cents, country)}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Amount</span>
            <input
              value={amountText}
              inputMode="numeric"
              onChange={(e) => setAmountText(e.target.value)}
              className="w-full rounded-md border px-3 py-2 font-mono text-[14px] outline-none"
              style={{ borderColor: parsed.ok ? "#D3DAD5" : "#B8460A" }}
            />
            {!parsed.ok && <span className="mt-1.5 block text-[11.5px] text-warn-ink">{parsed.message}</span>}
          </label>

          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">M-Pesa number</span>
            <input
              value={phone}
              inputMode="tel"
              placeholder="e.g. 0712 345 678"
              onChange={(e) => setPhone(e.target.value)}
              className="w-full rounded-md border px-3 py-2 font-mono text-[14px] outline-none"
              style={{ borderColor: error ? "#B8460A" : "#D3DAD5" }}
            />
            {error && <span className="mt-1.5 block text-[11.5px] text-warn-ink">{error}</span>}
          </label>
        </div>
      )}

      {(phase === "sending" || phase === "prompting") && (
        <div className="py-6 text-center">
          <div className="mx-auto mb-5 h-10 w-10 animate-spin rounded-full border-[3px] border-line" style={{ borderTopColor: "var(--accent)" }} />
          <p className="mx-auto max-w-[340px] text-[13px] leading-relaxed text-ink-muted">
            {phase === "sending"
              ? "Sending the request. This takes a few seconds."
              : `An M-Pesa prompt has been sent to ${phone}. Enter the PIN when it appears. This updates when M-Pesa confirms; if you close it, the balance still updates once the payment arrives.`}
          </p>
        </div>
      )}

      {phase === "success" && (
        <div>
          <p className="text-[13px] leading-relaxed text-ink-muted">
            M-Pesa confirmed it. {payeeFirst}'s balance is now {formatMoney(Math.max(balanceCents - amount, 0), country)}.
          </p>
          <div className="mt-4 rounded-lg border border-line bg-page p-3.5">
            {[["Paid", formatMoney(amount, country)], ["For", payeeName], ["Method", `M-Pesa ${phone}`], ...(receipt ? [["Receipt", receipt]] : [])].map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-line-soft py-2 text-[12.5px] last:border-0">
                <span className="text-ink-muted">{k}</span><span className="font-medium">{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {phase === "failed" && <p className="text-[13px] leading-relaxed text-ink-muted">{PAYMENT_FAILURES[failure]}</p>}

      {phase === "unconfirmed" && (
        <p className="text-[13px] leading-relaxed text-ink-muted">
          If you entered your PIN, the payment may still come through, and the balance will update when it does. Check Receipts in a few
          minutes before paying again, so you don't pay twice.
        </p>
      )}

      {phase === "unavailable" && (
        <div className="grid gap-3.5">
          <p className="text-[13px] leading-relaxed text-ink-muted">
            Online M-Pesa isn't available for your school right now. Nothing was sent to your phone and nothing was charged.
          </p>
          {hasMethods ? (
            <div className="grid gap-2 rounded-lg border border-line bg-page p-3.5">
              {tenant.payment_paybill && <div className="flex justify-between text-[12.5px]"><span className="text-ink-muted">Paybill</span><Mono>{tenant.payment_paybill}</Mono></div>}
              {tenant.payment_till && <div className="flex justify-between text-[12.5px]"><span className="text-ink-muted">Till number</span><Mono>{tenant.payment_till}</Mono></div>}
              {tenant.payment_bank_details && <div className="flex justify-between gap-4 text-[12.5px]"><span className="text-ink-muted">Bank</span><span className="text-right">{tenant.payment_bank_details}</span></div>}
              {tenant.payment_notes && <p className="border-t border-line-soft pt-2 text-[12px] leading-relaxed text-ink-muted">{tenant.payment_notes}</p>}
            </div>
          ) : (
            <p className="text-[13px] text-ink-muted">Ask the school office how to pay.</p>
          )}
          <p className="text-[12px] leading-relaxed text-ink-faint">
            After you pay, upload your proof on the Fees page or show it at the office. The school records the payment and {payeeFirst}'s balance updates.
          </p>
        </div>
      )}
    </Modal>
  );
}
