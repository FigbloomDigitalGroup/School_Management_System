import { supabase } from "./supabase";
import { apiFetchFeesExtras, apiTermInvoiceRows } from "./api/feesApi";
import { onApi } from "./backend";
import { fetchAllPages } from "./paging";
import { targetYearLabel } from "./levels";
import type { FeeItem, InvoiceStatus } from "./types";
import { shapeFeesCollection, type FeesCollection, type OutstandingRow, type OverpaidRow, type RawProofRow } from "./adminFees";

/**
 * The Fees page at the size of a real school: the term's figures from two
 * amount columns (not every invoice with its learner and class), the
 * collection list one page at a time, and the term's fee items grouped by
 * band instead of 249 rows down the page.
 */

// ---------------------------------------------------------------- fee items by band

export interface FeeBand {
  key: string;
  label: string;
  items: FeeItem[];
  totalCents: number;
}

/** "Grade 1–3", "PP1", "Form 3": the band a year-group item is shown under. Grades go in threes; anything else is its own band. */
export function feeBandOf(item: Pick<FeeItem, "applies_to" | "level" | "form_level">): { key: string; label: string; order: number } {
  if (item.applies_to !== "form_level" || item.form_level == null) {
    return { key: "everyone", label: "Every learner, boarders and day scholars", order: -1 };
  }
  const label = targetYearLabel(item.level, item.form_level);
  const grade = /^Grade (\d+)$/.exec(label);
  if (grade) {
    const n = Number(grade[1]);
    const from = Math.floor((n - 1) / 3) * 3 + 1;
    return { key: `grade-${from}`, label: `Grade ${from}–${from + 2}`, order: 100 + from };
  }
  const pp = /^PP(\d+)$/.exec(label);
  if (pp) return { key: `pp-${pp[1]}`, label, order: Number(pp[1]) };
  return { key: `y-${item.level ?? "x"}-${item.form_level}`, label, order: 200 + item.form_level };
}

/** The term's items under their bands, youngest first, with each band's total. */
export function groupFeeItems(items: FeeItem[]): FeeBand[] {
  const by = new Map<string, FeeBand & { order: number }>();
  for (const it of items) {
    const b = feeBandOf(it);
    const g = by.get(b.key) ?? { key: b.key, label: b.label, order: b.order, items: [], totalCents: 0 };
    g.items.push(it);
    g.totalCents += it.amount_cents;
    by.set(b.key, g);
  }
  return [...by.values()].sort((a, b) => a.order - b.order).map(({ order: _o, ...g }) => g);
}

// ---------------------------------------------------------------- figures

export interface InvoiceAmounts {
  id: string;
  student_id: string;
  total_cents: number;
  paid_cents: number;
  status: InvoiceStatus;
  /**
   * Set on the API build only: the API read already holds the learner, so the largest balances need no second read
   * (Supabase reads the names for the top ten only, in fetchLargestBalances).
   */
  api?: { studentName: string; cls: string; chargesCents: number };
}

export interface TermFigures {
  invoices: number;
  billed: number;
  collected: number;
  outstanding: number;
  collectedPct: number;
  paid: number;
  partPaid: number;
  nothingPaid: number;
  owing: number;
  overdue: number;
}

export function termFigures(rows: Pick<InvoiceAmounts, "total_cents" | "paid_cents" | "status">[]): TermFigures {
  const billed = rows.reduce((a, r) => a + r.total_cents, 0);
  const collected = rows.reduce((a, r) => a + r.paid_cents, 0);
  const owingRows = rows.filter((r) => r.status !== "paid");
  return {
    invoices: rows.length,
    billed,
    collected,
    outstanding: rows.reduce((a, r) => a + Math.max(r.total_cents - r.paid_cents, 0), 0),
    collectedPct: billed > 0 ? Math.round((collected / billed) * 100) : 0,
    paid: rows.length - owingRows.length,
    partPaid: owingRows.filter((r) => r.paid_cents > 0).length,
    nothingPaid: owingRows.filter((r) => r.paid_cents === 0).length,
    owing: owingRows.length,
    overdue: rows.filter((r) => r.status === "overdue").length,
  };
}

/** Every invoice of the term, only its amounts and status: one light read for the figures and the largest balances. */
export async function fetchTermAmounts(tenantId: string, termId: string): Promise<InvoiceAmounts[]> {
  if (onApi()) {
    return (await apiTermInvoiceRows(tenantId, termId)).map((r) => ({
      id: r.id, student_id: r.learnerId, total_cents: r.total, paid_cents: r.paid, status: r.status,
      api: { studentName: r.studentName, cls: r.cls, chargesCents: r.charges },
    }));
  }
  return fetchAllPages<InvoiceAmounts>((from, to) =>
    supabase().from("fee_invoices").select("id, student_id, total_cents, paid_cents, status").eq("tenant_id", tenantId).eq("term_id", termId)
      .order("id").range(from, to).returns<InvoiceAmounts[]>());
}

/** The n largest balances, with names read for those n learners only. */
export async function fetchLargestBalances(amounts: InvoiceAmounts[], n = 10): Promise<OutstandingRow[]> {
  const top = amounts.filter((r) => r.paid_cents < r.total_cents)
    .sort((a, b) => (b.total_cents - b.paid_cents) - (a.total_cents - a.paid_cents)).slice(0, n);
  if (top.length === 0) return [];
  if (onApi()) {
    return top.map((t) => ({
      id: t.id, name: t.api?.studentName ?? "Unknown learner", cls: t.api?.cls ?? "—", billed: t.total_cents, charges: t.api?.chargesCents ?? 0, paid: t.paid_cents,
    }));
  }
  const { data, error } = await supabase().from("fee_invoices").select("id, charges_cents, students(full_name, classes(name))")
    .in("id", top.map((t) => t.id))
    .returns<{ id: string; charges_cents: number; students: { full_name: string; classes: { name: string } | null } | null }[]>();
  if (error) throw new Error(error.message);
  const by = new Map((data ?? []).map((r) => [r.id, r]));
  return top.map((t) => {
    const r = by.get(t.id);
    return { id: t.id, name: r?.students?.full_name ?? "Unknown learner", cls: r?.students?.classes?.name ?? "—", billed: t.total_cents, charges: r?.charges_cents ?? 0, paid: t.paid_cents };
  });
}

// ---------------------------------------------------------------- the collection list, a page at a time

export type CollectionFilter = "all" | "paid" | "part_paid" | "nothing_paid" | "owing" | "overdue";

export const COLLECTION_FILTERS: { key: CollectionFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "owing", label: "Owing" },
  { key: "overdue", label: "Overdue" },
  { key: "part_paid", label: "Part paid" },
  { key: "nothing_paid", label: "Nothing paid" },
  { key: "paid", label: "Paid" },
];

export interface CollectionRow {
  id: string;
  studentName: string;
  admissionNo: string | null;
  cls: string;
  total: number;
  charges: number;
  paid: number;
  dueOn: string | null;
  status: InvoiceStatus;
}

type CollectionJoin = {
  id: string; total_cents: number; charges_cents: number; paid_cents: number; due_on: string | null; status: InvoiceStatus;
  students: { full_name: string; admission_no: string | null; class_id: string | null; classes: { name: string } | null } | null;
};

/** A search typed by a person, safe inside a PostgREST or=() filter. */
const clean = (q: string) => q.trim().replace(/[,()"*\\%:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);

/**
 * One page of the term's invoices, by learner name, with the total that
 * matches. Search covers the learner's name, admission number and class.
 */
export async function fetchCollectionPage(tenantId: string, termId: string, opts: { filter: CollectionFilter; query?: string; offset: number; limit: number }): Promise<{ rows: CollectionRow[]; total: number }> {
  if (onApi()) {
    // The API lists a term's invoices, not one page matched on the server: filter, search and page them here.
    const needle = (opts.query ?? "").trim().toLowerCase();
    const matches = (await apiTermInvoiceRows(tenantId, termId))
      .filter((r) => {
        if (opts.filter === "paid") return r.status === "paid";
        if (opts.filter === "owing") return r.status !== "paid";
        if (opts.filter === "overdue") return r.status === "overdue";
        if (opts.filter === "part_paid") return r.status !== "paid" && r.paid > 0;
        if (opts.filter === "nothing_paid") return r.status !== "paid" && r.paid === 0;
        return true;
      })
      .filter((r) => !needle || [r.studentName, r.admissionNo, r.cls].some((s) => s?.toLowerCase().includes(needle)))
      .sort((a, b) => a.studentName.localeCompare(b.studentName) || a.id.localeCompare(b.id));
    return { rows: matches.slice(opts.offset, opts.offset + opts.limit).map(({ learnerId: _l, ...row }) => row), total: matches.length };
  }
  const sb = supabase();
  const term = clean(opts.query ?? "");
  let classIds: string[] = [];
  if (term) {
    const { data, error } = await sb.from("classes").select("id").eq("tenant_id", tenantId).ilike("name", `%${term}%`).limit(50);
    if (error) throw new Error(error.message);
    classIds = (data ?? []).map((c: { id: string }) => c.id);
  }
  let q = sb.from("fee_invoices")
    .select(`id, total_cents, charges_cents, paid_cents, due_on, status, students${term ? "!inner" : ""}(full_name, admission_no, class_id, classes(name))`, { count: "exact" })
    .eq("tenant_id", tenantId).eq("term_id", termId);
  if (opts.filter === "paid") q = q.eq("status", "paid");
  if (opts.filter === "owing") q = q.neq("status", "paid");
  if (opts.filter === "overdue") q = q.eq("status", "overdue");
  if (opts.filter === "part_paid") q = q.neq("status", "paid").gt("paid_cents", 0);
  if (opts.filter === "nothing_paid") q = q.neq("status", "paid").eq("paid_cents", 0);
  if (term) {
    const like = `"*${term}*"`;
    q = q.or([`full_name.ilike.${like}`, `admission_no.ilike.${like}`, ...(classIds.length ? [`class_id.in.(${classIds.join(",")})`] : [])].join(","), { referencedTable: "students" });
  }
  // by learner name: PostgREST orders a parent by a to-one embed's column
  const { data, error, count } = await q.order("students(full_name)").order("id").range(opts.offset, opts.offset + opts.limit - 1).returns<CollectionJoin[]>();
  if (error) throw new Error(error.message);
  const rows = (data ?? []).map((r) => ({
    id: r.id, studentName: r.students?.full_name ?? "Unknown learner", admissionNo: r.students?.admission_no ?? null,
    cls: r.students?.classes?.name ?? "—", total: r.total_cents, charges: r.charges_cents, paid: r.paid_cents, dueOn: r.due_on, status: r.status,
  }));
  return { rows, total: count ?? rows.length };
}

// ---------------------------------------------------------------- proofs, overpayments, payee

/** What fetchFeesCollection reads besides the invoices: proofs to review, overpayments and the school's payee numbers. */
export async function fetchFeesExtras(tenantId: string, termId: string | null): Promise<Pick<FeesCollection, "overpaid" | "pendingProofs" | "school">> {
  if (onApi()) return apiFetchFeesExtras(tenantId, termId);
  const sb = supabase();
  const [proofs, overpaid, tenant] = await Promise.all([
    termId
      ? sb.from("payment_proofs")
          .select("id,file_path,file_name,note,uploaded_at,sms_text,txn_source,txn_code,txn_amount_cents,txn_at,txn_payee,txn_payee_number,txn_account,fee_invoices!inner(id,total_cents,paid_cents,term_id,students(full_name,classes(name)))")
          .eq("tenant_id", tenantId).eq("status", "pending").eq("fee_invoices.term_id", termId)
          .order("uploaded_at", { ascending: true }).returns<RawProofRow[]>()
      : Promise.resolve({ data: [] as RawProofRow[], error: null }),
    sb.from("overpaid_invoices").select("id,total_cents,paid_cents,overpaid_cents,students(full_name,classes(name)),terms(name)")
      .eq("tenant_id", tenantId).order("overpaid_cents", { ascending: false }).returns<OverpaidRow[]>(),
    sb.from("tenants").select("payment_paybill,payment_till").eq("id", tenantId).maybeSingle<{ payment_paybill: string | null; payment_till: string | null }>(),
  ]);
  if (proofs.error) throw new Error(proofs.error.message);
  if (overpaid.error) throw new Error(overpaid.error.message);
  if (tenant.error) throw new Error(tenant.error.message);
  const shaped = shapeFeesCollection({ invoices: [], proofs: proofs.data ?? [], overpaid: overpaid.data ?? [] });
  return { overpaid: shaped.overpaid, pendingProofs: shaped.pendingProofs, school: { paybill: tenant.data?.payment_paybill ?? null, till: tenant.data?.payment_till ?? null } };
}
