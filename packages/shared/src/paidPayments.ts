import { supabase } from "./supabase";
import type { Payment } from "./types";

/**
 * The successful payments made for some learners, each with the learner it was paid for: what the parent's and the learner's own fee
 * screens list as receipts.
 *
 * The query starts from the learners' invoices and has the database fetch each invoice's payments. The obvious way round (payments
 * with the invoice embedded and filtered by learner) makes PostgREST start from EVERY payment and look each invoice up afterwards,
 * so the permission check ran on every payment of every school before the learner filter could drop them: 8 s, cut off with error
 * 57014, at a school of 1,512 learners (FIG-1497). From the invoices it reaches only these learners' payments, through the index on
 * payments (invoice_id): 61 ms.
 */

export interface PaidPaymentRow {
  id: string;
  amount_cents: number;
  method: Payment["method"];
  mpesa_receipt: string | null;
  reference: string | null;
  msisdn: string | null;
  completed_at: string | null;
  created_at: string;
  fee_invoices: { student_id: string };
}

type PaymentFields = Omit<PaidPaymentRow, "fee_invoices">;
interface InvoiceWithPayments {
  student_id: string;
  payments: PaymentFields[];
}

/** One row per payment, newest first by completion time. A payment with no completion time comes first, as a descending sort puts it. */
export function flattenInvoicePayments(invoices: InvoiceWithPayments[]): PaidPaymentRow[] {
  return invoices
    .flatMap((inv) => inv.payments.map((p) => ({ ...p, fee_invoices: { student_id: inv.student_id } })))
    .sort((a, b) => {
      if (a.completed_at === b.completed_at) return 0;
      if (a.completed_at === null) return -1;
      if (b.completed_at === null) return 1;
      return a.completed_at < b.completed_at ? 1 : -1;
    });
}

/** In the shape of one query's answer, so it sits among the other reads of a Promise.all. */
export async function fetchPaidPayments(studentIds: string[]): Promise<{ data: PaidPaymentRow[]; error: { message: string } | null }> {
  if (!studentIds.length) return { data: [], error: null };
  const { data, error } = await supabase()
    .from("fee_invoices")
    .select("student_id, payments!inner(id, amount_cents, method, mpesa_receipt, reference, msisdn, completed_at, created_at)")
    .in("student_id", studentIds)
    .eq("payments.status", "success")
    .returns<InvoiceWithPayments[]>();
  if (error) return { data: [], error };
  return { data: flattenInvoicePayments(data ?? []), error: null };
}
