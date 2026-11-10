import type { BillableStudent } from "./fees";
import { yearGroupsOf, type YearGroup } from "./levels";
import { fetchAllPages } from "./paging";
import { supabase } from "./supabase";
import type { ClassLevel, FeeItem } from "./types";

/**
 * A term's fee structure and billing run: the fee items, the year groups they can be aimed at, billing the term, and
 * finding a learner's invoice for it. These reads and writes were inline in the web's Fees, FeeItemsEditor,
 * FeeCollection and parent Fees screens; they live here so screens ask for fee data by name and never query the tables
 * themselves (one place to change when the backend behind them does).
 *
 * Every function throws on a failed query: a read that failed must not look like an empty fee structure.
 */

/** The distinct year groups the school has classes in, youngest first (Grade 1 and Form 1 are both form_level 1). */
export async function fetchSchoolYearGroups(tenantId: string): Promise<YearGroup[]> {
  const { data, error } = await supabase().from("classes").select("level, form_level").eq("tenant_id", tenantId)
    .returns<{ level: ClassLevel; form_level: number }[]>();
  if (error) throw new Error(error.message);
  return yearGroupsOf(data ?? []);
}

/** The term's fee items, by name. */
export async function fetchTermFeeItems(termId: string): Promise<FeeItem[]> {
  const { data, error } = await supabase().from("fee_items").select("*").eq("term_id", termId).order("name").returns<FeeItem[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

export interface NewFeeItem {
  tenantId: string;
  termId: string;
  name: string;
  amountCents: number;
  /** Who pays it; a year group's item names the year group. */
  appliesTo: FeeItem["applies_to"];
  yearGroup?: Pick<YearGroup, "level" | "year"> | null;
}

export async function createFeeItem(input: NewFeeItem): Promise<void> {
  const forYear = input.appliesTo === "form_level" ? input.yearGroup ?? null : null;
  const { error } = await supabase().from("fee_items").insert({
    tenant_id: input.tenantId,
    term_id: input.termId,
    name: input.name,
    amount_cents: input.amountCents,
    applies_to: input.appliesTo,
    form_level: forYear?.year ?? null,
    level: forYear?.level ?? null,
  });
  if (error) throw new Error(error.message);
}

export async function updateFeeItem(id: string, change: { name: string; amountCents: number }): Promise<void> {
  const { error } = await supabase().from("fee_items").update({ name: change.name, amount_cents: change.amountCents }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteFeeItem(id: string): Promise<void> {
  const { error } = await supabase().from("fee_items").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

interface BillingStudentRow { id: string; boarding: boolean; classes: { form_level: number; level: ClassLevel } | null }

/**
 * What a billing run plans from: every active learner (read in pages, not the first 1,000) and who already has an
 * invoice for the term.
 */
export async function fetchBillingInputs(tenantId: string, termId: string): Promise<{ students: BillableStudent[]; invoiced: Set<string> }> {
  const sb = supabase();
  const [students, invoiced] = await Promise.all([
    fetchAllPages<BillingStudentRow>((from, to) =>
      sb.from("students").select("id, boarding, classes(form_level, level)")
        .eq("tenant_id", tenantId).eq("active", true).order("id").range(from, to).returns<BillingStudentRow[]>()),
    fetchAllPages<{ student_id: string }>((from, to) =>
      sb.from("fee_invoices").select("student_id").eq("term_id", termId).order("id").range(from, to)),
  ]);
  return {
    students: students.map((s) => ({ id: s.id, boarding: s.boarding, formLevel: s.classes?.form_level ?? null, classLevel: s.classes?.level ?? null })),
    invoiced: new Set(invoiced.map((i) => i.student_id)),
  };
}

export interface BillTermResult {
  created: number;
  totalCents: number;
  /** Billed by someone else between planning and saving; left as they were. */
  alreadyBilled: number;
}

/**
 * Create the planned invoices. One call, one transaction: the invoices and their audit event are what the database
 * saved, not what the caller planned (FIG-1331, bill_term). On failure nothing was saved, so it can be tried again.
 */
export async function billTerm(input: { termId: string; dueOn: string; invoices: { student_id: string; total_cents: number }[] }): Promise<BillTermResult> {
  const { data, error } = await supabase().rpc("bill_term", {
    p_term_id: input.termId,
    p_due_on: input.dueOn,
    p_invoices: input.invoices,
  });
  if (error) throw new Error(error.message);
  const r = data as { created: number; total_cents: number; already_billed: number };
  return { created: r.created, totalCents: r.total_cents, alreadyBilled: r.already_billed };
}

/** A learner's invoice for their school's current term, if they have one. (Row security limits terms to the caller's school.) */
export async function fetchCurrentInvoiceId(studentId: string): Promise<string | null> {
  const sb = supabase();
  const { data: term, error: termError } = await sb.from("terms").select("id").eq("is_current", true).maybeSingle<{ id: string }>();
  if (termError) throw new Error(termError.message);
  if (!term) return null;
  const { data: invoice, error } = await sb.from("fee_invoices").select("id")
    .eq("student_id", studentId).eq("term_id", term.id).maybeSingle<{ id: string }>();
  if (error) throw new Error(error.message);
  return invoice?.id ?? null;
}
