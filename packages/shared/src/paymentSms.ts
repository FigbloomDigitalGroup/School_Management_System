/**
 * Payment proof pasted as text: the confirmation SMS a parent got from
 * M-Pesa, Airtel Money or their bank, instead of (or as well as) a photo of
 * it. The parser pulls out what the bursar checks against the school's
 * statement: the transaction code, the amount, when, and who it was paid to.
 *
 * It never decides that a payment happened. Anyone can type an SMS; the
 * bursar still matches the code against the school's own M-Pesa/bank
 * statement before recording it. What this buys is speed (no squinting at a
 * screenshot) and two cheap checks: a code that has been used before is
 * refused by the database (payment_proofs_check_sms), and an amount or
 * paybill that doesn't match is flagged here.
 *
 * Pure, so it runs the same in the parent's browser (to show what we read
 * before they submit) and in the office's queue.
 */

export type PaymentSmsSource = "mpesa" | "airtel" | "bank" | "unknown";

export interface ParsedPaymentSms {
  source: PaymentSmsSource;
  /** Upper-cased transaction code / reference, e.g. "SJQ4ABC12D". */
  code: string | null;
  amountCents: number | null;
  /** ISO 8601 with Nairobi's offset, e.g. "2026-10-26T10:15:00+03:00"; date-only messages get midnight. */
  paidAt: string | null;
  /** Who it was paid to, as the SMS names them: "ST MARYS SCHOOL". */
  payee: string | null;
  /** A paybill, till or phone number the SMS shows for the payee. M-Pesa's own paybill SMS usually doesn't. */
  payeeNumber: string | null;
  /** The account number entered on a paybill payment (often the admission number). */
  account: string | null;
}

/** Longest text kept: a confirmation SMS is a few hundred characters; anything longer isn't one. */
export const PAYMENT_SMS_MAX = 2000;

const CURRENCY = String.raw`(?:KES|KSH|Ksh|Kshs|KShs)\.?\s?`;
const AMOUNT = new RegExp(`${CURRENCY}([0-9][0-9,]*(?:\\.[0-9]{1,2})?)`, "gi");
// An amount right after one of these is the balance, a charge or a limit, not what was paid.
const NOT_THE_AMOUNT = /(balance|bal|cost|charge|charges|fee|fees|limit|transact)\W*(is|of|was)?\W*$/i;

function toCents(raw: string): number | null {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

function amountOf(text: string): number | null {
  for (const m of text.matchAll(AMOUNT)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 30), m.index);
    if (NOT_THE_AMOUNT.test(before)) continue;
    const cents = toCents(m[1]!);
    if (cents !== null) return cents;
  }
  return null;
}

// "QJK3ABC12D Confirmed." -- M-Pesa codes are ten capital letters/digits and lead the
// message, unless it was forwarded ("Fwd: ...") or copied with the sender's name.
const MPESA_CODE = /(?:^|[\s:])([A-Z0-9]{10})\s+(?:Confirmed|confirmed|CONFIRMED)\b/;
// Airtel: "TID:CI241026.1234.H56789", "Trans. ID: MP241026.1015.A12345", "Txn ID ..."
const AIRTEL_CODE = /\b(?:TID|Trans(?:action)?\.?\s*ID|Txn\.?\s*ID)\s*[:.]?\s*([A-Z0-9][A-Z0-9.]{5,30}[A-Z0-9])/i;
// Banks: "Ref: FT24300ABC12", "Ref No. S12345678", "Reference FT243..", "Transaction Ref ..."
const BANK_CODE = /\b(?:Ref(?:erence)?|Transaction\s+Ref(?:erence)?)\.?\s*(?:No\.?|Number)?\s*[:.]?\s*([A-Z0-9][A-Z0-9-]{5,24})/i;

function sourceOf(text: string): PaymentSmsSource {
  if (MPESA_CODE.test(text) || /\bM-?PESA\b/i.test(text)) return "mpesa";
  if (/\bairtel\b/i.test(text) || /\bTID\s*:/i.test(text)) return "airtel";
  if (/\b(bank|a\/c|acct|debited|credited|deposit(ed)?|EFT|RTGS|pesalink)\b/i.test(text)) return "bank";
  return "unknown";
}

function codeOf(text: string, source: PaymentSmsSource): string | null {
  const m =
    (source === "mpesa" ? text.match(MPESA_CODE) : null)
    ?? text.match(AIRTEL_CODE)
    ?? text.match(BANK_CODE);
  const code = m?.[1]?.toUpperCase().replace(/\.$/, "") ?? null;
  // A code has letters and digits; a bare number is an account or phone that a "Ref" pattern grabbed.
  return code && /[A-Z]/.test(code) && /[0-9]/.test(code) ? code : null;
}

const pad = (n: number) => String(n).padStart(2, "0");

function paidAtOf(text: string): string | null {
  // dd/mm/yy or dd-mm-yyyy, optionally "at 10:15 AM" / " 10:15" after it.
  const m = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})\b(?:\s*(?:at)?\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?)?/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let hour = m[4] ? Number(m[4]) : 0;
  const minute = m[5] ? Number(m[5]) : 0;
  const half = m[6]?.toUpperCase();
  if (half === "PM" && hour < 12) hour += 12;
  if (half === "AM" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  // Check the day exists in that month (31/02 isn't a date).
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1) return null;
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00+03:00`;
}

// Where the payee's name ends: "for account", " on 26/10", a phone/number, end of sentence.
const PAYEE_END = String.raw`(?=\s+for\s+account\b|\s+account\s+(?:no\.?|number)\b|\s+A\/C\b|\s+on\s+\d|\s+\d{9,}|\.\s|\.?\s*$|\s+Ref\b|\s+via\b)`;

function payeeOf(text: string): { payee: string | null; payeeNumber: string | null } {
  // "sent to 247247 - EQUITY PAYBILL" / "paid to 123456 ST MARYS SCHOOL"
  const numbered = text.match(new RegExp(String.raw`\b(?:sent|paid|transferred)\s+(?:${CURRENCY}[0-9][0-9,.]*\s+)?to\s+(\d{5,7})\s*-?\s*([A-Za-z][^\n]*?)${PAYEE_END}`, "i"));
  if (numbered) return { payeeNumber: numbered[1]!, payee: tidyName(numbered[2]!) };

  const named = text.match(new RegExp(String.raw`\b(?:sent|paid|transferred)\s+(?:${CURRENCY}[0-9][0-9,.]*\s+)?to\s+([A-Za-z][^\n]*?)${PAYEE_END}`, "i"));
  let payeeNumber: string | null = null;
  const explicit = text.match(/\b(?:Paybill|Pay\s*bill|Business\s*(?:No\.?|Number)|Till\s*(?:No\.?|Number)?|Buy\s*Goods)\s*[:.]?\s*(\d{5,7})\b/i);
  if (explicit) payeeNumber = explicit[1]!;
  if (named) {
    const after = text.slice((named.index ?? 0) + named[0].length).match(/^\s+((?:\+?254|0)[17]\d{8})\b/);
    if (!payeeNumber && after) payeeNumber = after[1]!;
    return { payee: tidyName(named[1]!), payeeNumber };
  }
  return { payee: null, payeeNumber };
}

function tidyName(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").replace(/[.,;:\s-]+$/, "").trim();
  return name.length >= 2 && name.length <= 80 ? name : null;
}

function accountOf(text: string): string | null {
  const m = text.match(/\b(?:for\s+account|account\s+(?:no\.?|number)|A\/C(?:\s+no\.?)?)\s*[:.]?\s*([A-Za-z0-9][A-Za-z0-9/_-]{0,30})/i);
  if (!m) return null;
  const acc = m[1]!;
  // "for account on 26/10" -- an empty account field leaves the next word behind
  return /^(on|at|is)$/i.test(acc) ? null : acc;
}

export function parsePaymentSms(raw: string): ParsedPaymentSms {
  const text = raw.slice(0, PAYMENT_SMS_MAX).replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
  const source = sourceOf(text);
  const { payee, payeeNumber } = payeeOf(text);
  return {
    source,
    code: codeOf(text, source),
    amountCents: amountOf(text),
    paidAt: paidAtOf(text),
    payee,
    payeeNumber,
    account: accountOf(text),
  };
}

export type PaymentSmsFlag = "no_code" | "no_amount" | "amount_differs" | "wrong_payee_number" | "future_date";

export const PAYMENT_SMS_FLAG_LABEL: Record<PaymentSmsFlag, string> = {
  no_code: "No transaction code found",
  no_amount: "No amount found",
  amount_differs: "Amount differs from balance",
  wrong_payee_number: "Not the school's paybill/till",
  future_date: "Dated in the future",
};

/**
 * What the bursar should look at twice. Flags, never refusals: a part
 * payment is a real payment, and a family may pay through a bank paybill
 * the school banks with rather than the school's own number.
 */
export function paymentSmsFlags(
  parsed: Pick<ParsedPaymentSms, "code" | "amountCents" | "payeeNumber" | "paidAt">,
  school: { balanceCents: number | null; paybill: string | null; till: string | null },
  now: Date = new Date(),
): PaymentSmsFlag[] {
  const flags: PaymentSmsFlag[] = [];
  if (!parsed.code) flags.push("no_code");
  if (parsed.amountCents === null) flags.push("no_amount");
  else if (school.balanceCents !== null && parsed.amountCents !== school.balanceCents) flags.push("amount_differs");
  const own = [school.paybill, school.till].map((n) => n?.replace(/\D/g, "")).filter((n): n is string => !!n);
  // Only a number the SMS actually shows can be wrong. A phone number is flagged too: that went to a person.
  if (parsed.payeeNumber && own.length > 0 && !own.includes(parsed.payeeNumber.replace(/\D/g, ""))) flags.push("wrong_payee_number");
  // A day's grace: a phone clock or timezone can be a little ahead.
  if (parsed.paidAt && Date.parse(parsed.paidAt) > now.getTime() + 86400_000) flags.push("future_date");
  return flags;
}

export const PAYMENT_SMS_SOURCE_LABEL: Record<PaymentSmsSource, string> = {
  mpesa: "M-Pesa",
  airtel: "Airtel Money",
  bank: "Bank",
  unknown: "Transaction",
};
