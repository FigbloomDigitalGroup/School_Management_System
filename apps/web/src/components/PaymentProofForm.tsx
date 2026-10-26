import { useMemo, useState, type FormEvent } from "react";
import {
  PAYMENT_SMS_MAX, PAYMENT_SMS_SOURCE_LABEL, formatMoney, parsePaymentSms, paymentSmsFlags,
  type PaymentSmsFlag,
} from "@figbloom/shared";
import { Button } from "./ui/Button";
import { useToast } from "./ui/Toast";
import { uploadPaymentProof, type PaymentProof } from "../lib/uploads";

// What a family is told about a flag: gentler than the office's label, and
// never a refusal -- a part payment is still a payment.
const FAMILY_FLAG: Partial<Record<PaymentSmsFlag, string>> = {
  amount_differs: "This is not the full balance. That's fine for a part payment.",
  wrong_payee_number: "This doesn't look like it went to the school's paybill or till. Check you pasted the right message.",
  future_date: "The date on this message is in the future. Check you pasted the right message.",
};

/**
 * "Payment proof" for a parent's or learner's fees screen: a photo or PDF of
 * the slip, the confirmation SMS pasted as text, or both. What we read from
 * a pasted message is shown before it is sent, so a family can see we got
 * the code and amount right; the bursar still checks it against the school's
 * statement.
 */
export function PaymentProofForm({ tenantId, invoiceId, uploadedBy, balanceCents, country, school, disabled, onSent }: {
  tenantId: string;
  invoiceId: string | null;
  uploadedBy: string;
  balanceCents: number | null;
  country: string;
  school: { paybill: string | null; till: string | null };
  disabled?: boolean;
  onSent: () => void;
}) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [note, setNote] = useState("");
  const [sms, setSms] = useState("");
  const [sending, setSending] = useState(false);

  const parsed = useMemo(() => (sms.trim() ? parsePaymentSms(sms) : null), [sms]);
  const flags = parsed ? paymentSmsFlags(parsed, { balanceCents, ...school }) : [];
  // A pasted message is only worth sending with its code: the code is what the bursar looks up.
  const smsUsable = !!parsed?.code;
  const ready = !!invoiceId && !disabled && !sending && (file !== null || smsUsable) && (!sms.trim() || smsUsable);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || !invoiceId) return;
    setSending(true);
    try {
      await uploadPaymentProof({
        tenantId, invoiceId, uploadedBy,
        note: note.trim() || undefined,
        file: file ?? undefined,
        sms: parsed && smsUsable ? { text: sms, parsed } : undefined,
      });
      toast("Payment proof sent. The bursar will review it.");
      setFile(null);
      setFileKey((k) => k + 1);
      setNote("");
      setSms("");
      onSent();
    } catch (err) {
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message;
      toast(message ? `Could not send proof: ${message}` : "Could not send proof.", "error");
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 border-b border-line-soft px-4 py-3.5">
      <label className="block">
        <span className="mb-1.5 block text-[12px] font-semibold">Paste the confirmation message</span>
        <textarea
          value={sms}
          onChange={(e) => setSms(e.target.value.slice(0, PAYMENT_SMS_MAX))}
          rows={3}
          placeholder="e.g. SJQ4ABC12D Confirmed. Ksh15,000.00 sent to … for account … on 26/10/26 at 10:15 AM …"
          className="w-full resize-y rounded-md border border-[#D3DAD5] px-3 py-2 font-mono text-[12px] outline-none"
        />
        <span className="mt-1 block text-[11.5px] text-ink-faint">The M-Pesa, Airtel Money or bank SMS, copied whole. No screenshot needed.</span>
      </label>

      {parsed && (
        <div className="rounded-lg border border-line bg-page px-3.5 py-3" aria-live="polite">
          {smsUsable ? (
            <>
              <div className="mb-2 text-[12px] font-semibold">What we read from it. Check before sending:</div>
              <dl className="grid gap-x-4 gap-y-1.5 text-[12.5px]" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
                <Field label={`${PAYMENT_SMS_SOURCE_LABEL[parsed.source]} code`} value={parsed.code} mono />
                <Field label="Amount" value={parsed.amountCents !== null ? formatMoney(parsed.amountCents, country) : null} mono />
                <Field label="Paid on" value={parsed.paidAt ? formatPaidAt(parsed.paidAt) : null} />
                <Field label="Paid to" value={[parsed.payee, parsed.payeeNumber].filter(Boolean).join(" · ") || null} />
                {parsed.account && <Field label="Account" value={parsed.account} mono />}
              </dl>
              {flags.map((f) => FAMILY_FLAG[f] && (
                <p key={f} className="mt-2 text-[12px] text-warn-ink">{FAMILY_FLAG[f]}</p>
              ))}
            </>
          ) : (
            <p className="text-[12px] text-warn-ink">
              We couldn't find a transaction code in that message. Paste the whole confirmation SMS, starting with the code (e.g. SJQ4ABC12D Confirmed…), or upload a photo instead.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-semibold">Or a file (optional)</span>
          <input
            key={fileKey}
            type="file"
            accept="image/*,.pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block text-[12.5px]"
          />
        </label>
        <label className="block min-w-[200px] flex-1">
          <span className="mb-1.5 block text-[12px] font-semibold">Note (optional)</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Paid at the school office"
            className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[12.5px] outline-none"
          />
        </label>
        <Button type="submit" variant="accent" disabled={!ready}>
          {sending ? "Sending…" : "Send proof"}
        </Button>
      </div>
    </form>
  );
}

function Field({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-ink-faint">{label}</dt>
      <dd className={`truncate ${mono ? "font-mono" : ""} ${value ? "" : "text-ink-faint"}`}>{value ?? "Not found"}</dd>
    </div>
  );
}

/** A proof in a family's list: the file (tap to open), or the pasted message's code and amount. */
export function ProofLabel({ proof, country, onOpen }: {
  proof: Pick<PaymentProof, "file_path" | "file_name" | "txn_code" | "txn_amount_cents">;
  country: string;
  onOpen: (path: string) => void;
}) {
  const path = proof.file_path;
  return (
    <span className="flex min-w-0 items-center gap-2">
      {proof.txn_code && (
        <span className="shrink-0 font-mono text-[12.5px]">
          {proof.txn_code}
          {proof.txn_amount_cents !== null && <span className="text-ink-faint"> · {formatMoney(proof.txn_amount_cents, country)}</span>}
        </span>
      )}
      {path && (
        <button
          type="button"
          onClick={() => onOpen(path)}
          className="min-w-0 truncate text-left text-[12.5px] font-medium text-forest hover:underline"
        >
          {proof.file_name}
        </button>
      )}
    </span>
  );
}

export function formatPaidAt(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Nairobi",
  });
}
