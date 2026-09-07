import type { FeeInvoice, FeeItem, InvoiceStatus, Student } from "./types";

/** Money is cents everywhere. Never a float. */
export const KES = (cents: number): string =>
  "KSh " + (cents / 100).toLocaleString("en-KE", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

export const balanceCents = (i: FeeInvoice): number => Math.max(i.total_cents - i.paid_cents, 0);

export function invoiceStatus(i: Pick<FeeInvoice, "total_cents" | "paid_cents" | "due_on">, today = new Date()): InvoiceStatus {
  const bal = Math.max(i.total_cents - i.paid_cents, 0);
  if (bal === 0) return "paid";
  if (new Date(i.due_on) < today) return "overdue";
  return i.paid_cents > 0 ? "part_paid" : "unpaid";
}

export function itemsForStudent(items: FeeItem[], student: Pick<Student, "boarding">, formLevel: number): FeeItem[] {
  return items.filter((it) => {
    switch (it.applies_to) {
      case "all": return true;
      case "boarders": return student.boarding;
      case "day": return !student.boarding;
      case "form_level": return it.form_level === formLevel;
    }
  });
}

export const totalCents = (items: FeeItem[]): number => items.reduce((a, i) => a + i.amount_cents, 0);

/**
 * Parents commonly pay in instalments as harvests or salaries come in, so
 * part payment is normal, not an error state.
 */
export function payableSuggestions(balance: number): { label: string; cents: number }[] {
  if (balance <= 0) return [];
  const half = Math.round(balance / 2 / 10000) * 10000;
  const out = [{ label: "Pay in full", cents: balance }];
  if (half > 0 && half < balance) out.push({ label: "Pay half", cents: half });
  out.push({ label: "Another amount", cents: 0 });
  return out;
}

/** Daraja rejects anything that is not a plain 2547XXXXXXXX. */
export function normaliseMsisdn(raw: string): { ok: true; msisdn: string } | { ok: false; message: string } {
  const d = raw.replace(/[^0-9]/g, "");
  if (/^2547\d{8}$/.test(d)) return { ok: true, msisdn: d };
  if (/^07\d{8}$/.test(d)) return { ok: true, msisdn: "254" + d.slice(1) };
  if (/^7\d{8}$/.test(d)) return { ok: true, msisdn: "254" + d };
  if (/^2541\d{8}$/.test(d)) return { ok: true, msisdn: d };
  if (/^01\d{8}$/.test(d)) return { ok: true, msisdn: "254" + d.slice(1) };
  return { ok: false, message: "Enter the M-Pesa number as 07xx xxx xxx." };
}

/** Plain-language failures. A parent must know whether money left their account. */
export const PAYMENT_FAILURES: Record<string, string> = {
  timeout: "The M-Pesa prompt expired before it was entered. No money left your account. Try again and enter your PIN when the prompt appears.",
  cancelled: "The prompt was cancelled on the phone. No money left your account.",
  insufficient: "There was not enough in the M-Pesa balance for this amount. You can pay part of the fee instead.",
  wrong_pin: "The PIN was entered incorrectly too many times. No money left your account.",
  unreachable: "We could not reach the phone. Check it is on and has network, then try again.",
  duplicate: "This looks like a payment you already made. Check the receipts below before trying again.",
};
