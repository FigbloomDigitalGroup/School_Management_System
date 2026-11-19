import { validationError } from "../../http/errors.js";

/**
 * Stage 11 money rules (legacy evidence: packages/shared/src/fees.ts, supabase/migrations FIG-1334).
 * Amounts are integer minor units (cents). JavaScript numbers are exact for integers up to 2^53, far
 * above the 1e11 cap the database enforces; values travel as integers in JSON and as bigint in SQL.
 * Never use floating-point arithmetic on money.
 */
export const CURRENCY = "KES" as const;
export const MAX_AMOUNT_MINOR = 100_000_000_000;

export type InvoiceStatus = "paid" | "overdue" | "part_paid" | "unpaid";

/** Twin of SQL finance_invoice_status (migration 037). `today` is the school's local date (YYYY-MM-DD). */
export function invoiceStatus(totalMinor: number, paidMinor: number, dueOn: string, today: string): InvoiceStatus {
  if (paidMinor >= totalMinor) return "paid";
  if (dueOn < today) return "overdue";
  if (paidMinor > 0) return "part_paid";
  return "unpaid";
}

export function balanceMinor(totalMinor: number, paidMinor: number): number {
  return Math.max(totalMinor - paidMinor, 0);
}

export function assertMinorAmount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_AMOUNT_MINOR) {
    throw validationError(`${field} must be a positive whole number of cents`);
  }
}

/** Fee items, charges and M-Pesa prompts are whole shillings (legacy FIG-1334). */
export function assertWholeShillings(value: number, field: string): void {
  assertMinorAmount(value, field);
  if (value % 100 !== 0) throw validationError(`${field} must be whole shillings (a multiple of 100 cents)`);
}

/** Node-pg returns bigint/numeric as strings. Convert a database money value to a safe integer. */
export function toMinor(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new Error("money value out of range");
  return n;
}

/** Fee scope twin (legacy itemsForStudent): which fee items apply to a learner. */
export type FeeScope = "all" | "boarders" | "day" | "form_level";
export function feeApplies(
  item: { applies_to: FeeScope; form_level: number | null },
  learner: { boarding: boolean; form_level: number | null },
): boolean {
  switch (item.applies_to) {
    case "all":
      return true;
    case "boarders":
      return learner.boarding;
    case "day":
      return !learner.boarding;
    case "form_level":
      return learner.form_level !== null && learner.form_level === item.form_level;
  }
}

/** M-Pesa phone numbers (legacy rule): 2547XXXXXXXX or 2541XXXXXXXX. */
export const MSISDN_PATTERN = /^254[17]\d{8}$/;

export function maskMsisdn(msisdn: string): string {
  return `254*****${msisdn.slice(-4)}`;
}
