import type { FeesCollection, OverpaidRow, PayableInvoice, PaymentMethodValue, RawInvoiceRow, RawProofRow } from "../adminFees";
import { rejectionReason, shapeFeesCollection } from "../adminFees";
import type { BillTermResult, NewFeeItem } from "../feeStructure";
import type { BillableStudent } from "../fees";
import { yearGroupsOf, type YearGroup } from "../levels";
import type { ClassLevel, FeeItem, Term } from "../types";
import { apiClient } from "./client";
import { isApiError } from "./errors";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import type { components } from "./schema";
import { classGroupFromApi, currentAcademicYear, listAcademicTerms, listAcademicYears, termFromApi } from "./setupApi";

/**
 * The office side of fees on apps/api (FIG-1891): the API side of adminFees.ts and feeStructure.ts.
 *
 * Differences from Supabase, handled here rather than in the screens:
 *  - Money is in `*_minor` (cents); mapped to `*_cents` for the screens.
 *  - Fee items are archived via POST .../archive rather than hard-deleted, and have `form_level` without `level`.
 *  - Billing runs are computed server-side by POST /finance/billing-runs with `{ term_id, due_on }`; the modal's client-side
 *    preview still uses active learners + memberships + classes + existing invoices.
 *  - Invoices and proofs are joined client-side with learners, class memberships, and classes (all read with graceful 403
 *    fallbacks so a bursar holding only the Fees area still sees invoices and proofs even without People/Academics read).
 *  - Proof files on the API are metadata-only (no object storage yet), so `file_path` is null and `feesCapabilities().proofFiles`
 *    is false.
 */

type ApiFeeItem = components["schemas"]["FinanceFeeItem"];
type ApiInvoice = components["schemas"]["FinanceInvoice"];
type ApiProof = components["schemas"]["FinanceProof"];
type ApiLearner = components["schemas"]["Learner"];
type ApiMembership = components["schemas"]["ClassMembership"];
type ApiClass = components["schemas"]["SchoolClass"];

function tenantIdOrThrow(tenantId?: string): string {
  const id = tenantId ?? apiClient().activeTenant();
  if (!id) throw new Error("No active school selected.");
  return id;
}

export function feeItemFromApi(f: ApiFeeItem): FeeItem {
  return {
    id: f.id,
    tenant_id: f.tenantId,
    term_id: f.term_id,
    name: f.name,
    amount_cents: f.amount_minor,
    applies_to: f.applies_to,
    form_level: f.form_level,
    level: null,
  };
}

// ---------------------------------------------------------------- optional directory/academics lookups (graceful on 403)

async function listLearnersOrEmpty(tenantId: string): Promise<ApiLearner[]> {
  try {
    return await listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/learners", {
        path: { tenantId },
        query: { active: true, limit: API_PAGE_LIMIT, cursor },
        tenantId,
      });
      return { items: r.learners, page: r.page };
    });
  } catch (err) {
    if (isApiError(err) && err.code === "forbidden") return [];
    throw err;
  }
}

async function listClassesOrEmpty(tenantId: string): Promise<ApiClass[]> {
  try {
    const year = await currentAcademicYear(tenantId);
    return await listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/classes", {
        path: { tenantId },
        query: { academicYearId: year?.id, active: true, limit: API_PAGE_LIMIT, cursor },
        tenantId,
      });
      return { items: r.classes, page: r.page };
    });
  } catch (err) {
    if (isApiError(err) && err.code === "forbidden") return [];
    throw err;
  }
}

async function listMembershipsOrEmpty(tenantId: string): Promise<ApiMembership[]> {
  try {
    return await listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/class-memberships", {
        path: { tenantId },
        query: { active: true, limit: API_PAGE_LIMIT, cursor },
        tenantId,
      });
      return { items: r.memberships, page: r.page };
    });
  } catch (err) {
    if (isApiError(err) && err.code === "forbidden") return [];
    throw err;
  }
}

async function listInvoicesForTerm(tenantId: string, termId: string): Promise<ApiInvoice[]> {
  const all = await listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/finance/invoices", {
      path: { tenantId },
      query: { termId, limit: API_PAGE_LIMIT, cursor },
      tenantId,
    });
    return { items: r.invoices, page: r.page };
  });
  return all.filter((i) => i.status !== "voided");
}

async function listPendingProofs(tenantId: string): Promise<ApiProof[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/finance/proofs", {
      path: { tenantId },
      query: { status: "pending", limit: API_PAGE_LIMIT, cursor },
      tenantId,
    });
    return { items: r.proofs, page: r.page };
  });
}

function learnerLookups(
  tenantId: string,
  learners: ApiLearner[],
  memberships: ApiMembership[],
  classes: ApiClass[],
): {
  learnerById: Map<string, ApiLearner>;
  classByLearner: Map<string, { name: string; form_level: number; level: ClassLevel }>;
} {
  const classById = new Map(classes.map((c) => [c.id, classGroupFromApi(c, tenantId)]));
  const classByLearner = new Map<string, { name: string; form_level: number; level: ClassLevel }>();
  for (const m of memberships) {
    const cls = classById.get(m.class_id);
    if (cls) classByLearner.set(m.learner_id, { name: cls.name, form_level: cls.form_level, level: cls.level });
  }
  return { learnerById: new Map(learners.map((l) => [l.id, l])), classByLearner };
}

// ---------------------------------------------------------------- current term & year groups

export async function apiFetchTenantCurrentTerm(tenantId: string): Promise<Term | null> {
  const [years, terms] = await Promise.all([listAcademicYears(tenantId), listAcademicTerms(tenantId)]);
  const current = terms.find((t) => t.is_current);
  if (!current) return null;
  const yearById = new Map(years.map((y) => [y.id, y]));
  return termFromApi(current, yearById.get(current.academic_year_id), tenantId);
}

export async function apiFetchSchoolYearGroups(tenantId: string): Promise<YearGroup[]> {
  const classes = await listClassesOrEmpty(tenantId);
  return yearGroupsOf(classes.map((c) => classGroupFromApi(c, tenantId)));
}

// ---------------------------------------------------------------- fee items CRUD

export async function apiFetchTermFeeItems(termId: string, tenantId?: string): Promise<FeeItem[]> {
  const tid = tenantIdOrThrow(tenantId);
  const rows = await listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/finance/fee-items", {
      path: { tenantId: tid },
      query: { termId, active: true, limit: API_PAGE_LIMIT, cursor },
      tenantId: tid,
    });
    return { items: r.fee_items, page: r.page };
  });
  return rows.map(feeItemFromApi).sort((a, b) => a.name.localeCompare(b.name));
}

export async function apiCreateFeeItem(input: NewFeeItem): Promise<void> {
  const forYear = input.appliesTo === "form_level" ? input.yearGroup ?? null : null;
  await apiClient().post("/v1/tenants/{tenantId}/finance/fee-items", {
    path: { tenantId: input.tenantId },
    body: {
      term_id: input.termId,
      name: input.name,
      amount_minor: input.amountCents,
      applies_to: input.appliesTo,
      form_level: forYear?.year ?? null,
    },
    tenantId: input.tenantId,
  });
}

export async function apiUpdateFeeItem(id: string, change: { name: string; amountCents: number }, tenantId?: string): Promise<void> {
  const tid = tenantIdOrThrow(tenantId);
  await apiClient().patch("/v1/tenants/{tenantId}/finance/fee-items/{feeItemId}", {
    path: { tenantId: tid, feeItemId: id },
    body: { name: change.name, amount_minor: change.amountCents },
    tenantId: tid,
  });
}

export async function apiDeleteFeeItem(id: string, tenantId?: string): Promise<void> {
  const tid = tenantIdOrThrow(tenantId);
  await apiClient().post("/v1/tenants/{tenantId}/finance/fee-items/{feeItemId}/archive", {
    path: { tenantId: tid, feeItemId: id },
    tenantId: tid,
  });
}

// ---------------------------------------------------------------- billing runs

export async function apiFetchBillingInputs(tenantId: string, termId: string): Promise<{ students: BillableStudent[]; invoiced: Set<string> }> {
  const [learners, memberships, classes, invoices] = await Promise.all([
    listLearnersOrEmpty(tenantId),
    listMembershipsOrEmpty(tenantId),
    listClassesOrEmpty(tenantId),
    listInvoicesForTerm(tenantId, termId),
  ]);
  const { classByLearner } = learnerLookups(tenantId, learners, memberships, classes);
  return {
    students: learners.map((l) => {
      const cls = classByLearner.get(l.id);
      return { id: l.id, boarding: l.boarding, formLevel: cls?.form_level ?? null, classLevel: cls?.level ?? null };
    }),
    invoiced: new Set(invoices.map((i) => i.learner_id)),
  };
}

export async function apiBillTerm(input: { termId: string; dueOn: string }, tenantId?: string): Promise<BillTermResult> {
  const tid = tenantIdOrThrow(tenantId);
  const res = await apiClient().post("/v1/tenants/{tenantId}/finance/billing-runs", {
    path: { tenantId: tid },
    body: { term_id: input.termId, due_on: input.dueOn },
    tenantId: tid,
  });
  return {
    created: res.billing_run.created,
    totalCents: res.billing_run.total_minor,
    alreadyBilled: res.billing_run.already_billed,
  };
}

// ---------------------------------------------------------------- collection overview, payments & proofs

export async function apiFetchFeesCollection(tenantId: string, term?: Term | null): Promise<FeesCollection> {
  const current = term === undefined ? await apiFetchTenantCurrentTerm(tenantId) : term;
  const termId = current?.id ?? null;

  if (!termId) {
    return {
      term: null,
      invoices: [],
      outstanding: [],
      overpaid: [],
      pendingProofs: [],
      school: { paybill: null, till: null },
    };
  }

  const [apiInvoices, apiProofs, learners, memberships, classes] = await Promise.all([
    listInvoicesForTerm(tenantId, termId),
    listPendingProofs(tenantId),
    listLearnersOrEmpty(tenantId),
    listMembershipsOrEmpty(tenantId),
    listClassesOrEmpty(tenantId),
  ]);

  const { learnerById, classByLearner } = learnerLookups(tenantId, learners, memberships, classes);
  const studentInfo = (learnerId: string) => {
    const l = learnerById.get(learnerId);
    const cls = classByLearner.get(learnerId);
    return l ? { full_name: l.full_name, classes: cls ? { name: cls.name } : null } : null;
  };

  const invoices: RawInvoiceRow[] = apiInvoices.map((i) => ({
    id: i.id,
    total_cents: i.total_minor,
    charges_cents: i.charges_minor,
    paid_cents: i.paid_minor,
    students: studentInfo(i.learner_id),
  }));

  const invoiceById = new Map(apiInvoices.map((i) => [i.id, i]));
  const proofs: RawProofRow[] = apiProofs
    .filter((p) => invoiceById.has(p.invoice_id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((p) => {
      const inv = invoiceById.get(p.invoice_id)!;
      return {
        id: p.id,
        file_path: null,
        file_name: p.file?.file_name ?? null,
        note: p.note,
        uploaded_at: p.created_at,
        sms_text: p.sms_text,
        txn_source: p.txn_source,
        txn_code: p.txn_code,
        txn_amount_cents: p.txn_amount_minor,
        txn_at: p.txn_at,
        txn_payee: p.txn_payee,
        txn_payee_number: p.txn_payee_number,
        txn_account: p.txn_account,
        fee_invoices: {
          id: inv.id,
          total_cents: inv.total_minor,
          paid_cents: inv.paid_minor,
          students: studentInfo(inv.learner_id),
        },
      };
    });

  const overpaid: OverpaidRow[] = apiInvoices
    .filter((i) => i.overpaid_minor > 0 || i.unapplied_minor > 0)
    .map((i) => ({
      id: i.id,
      total_cents: i.total_minor,
      paid_cents: i.paid_minor + i.unapplied_minor,
      overpaid_cents: i.overpaid_minor + i.unapplied_minor,
      students: studentInfo(i.learner_id),
      terms: current ? { name: current.name } : null,
    }))
    .sort((a, b) => b.overpaid_cents - a.overpaid_cents);

  return {
    term: current,
    ...shapeFeesCollection({ invoices, proofs, overpaid }),
    school: { paybill: null, till: null },
  };
}

export async function apiSearchPayableInvoices(termId: string, q: string, tenantId?: string): Promise<PayableInvoice[]> {
  const tid = tenantIdOrThrow(tenantId);
  const needle = q.trim().toLowerCase();
  if (!needle) return [];

  const [invoices, learners, memberships, classes] = await Promise.all([
    listInvoicesForTerm(tid, termId),
    listLearnersOrEmpty(tid),
    listMembershipsOrEmpty(tid),
    listClassesOrEmpty(tid),
  ]);
  const { learnerById, classByLearner } = learnerLookups(tid, learners, memberships, classes);

  const out: PayableInvoice[] = [];
  for (const inv of invoices) {
    if (inv.balance_minor <= 0) continue;
    const l = learnerById.get(inv.learner_id);
    if (!l) continue;
    if (!l.full_name.toLowerCase().includes(needle) && !l.admission_no.toLowerCase().includes(needle)) continue;
    const cls = classByLearner.get(inv.learner_id);
    out.push({
      id: inv.id,
      studentName: `${l.full_name} · ${l.admission_no}`,
      cls: cls?.name ?? "—",
      balanceCents: inv.balance_minor,
    });
    if (out.length >= 8) break;
  }
  return out;
}

export async function apiRecordPayment(
  input: { invoiceId: string; cents: number; method: PaymentMethodValue; reference: string; proofId?: string | null },
  tenantId?: string,
): Promise<void> {
  const tid = tenantIdOrThrow(tenantId);
  await apiClient().post("/v1/tenants/{tenantId}/finance/payments", {
    path: { tenantId: tid },
    body: {
      invoice_id: input.invoiceId,
      amount_minor: input.cents,
      method: input.method,
      reference: input.reference.trim() || null,
      proof_id: input.proofId ?? null,
    },
    tenantId: tid,
  });
}

export async function apiRejectPaymentProof(input: { proofId: string; reason: string }, tenantId?: string): Promise<void> {
  const reason = rejectionReason(input.reason);
  if (!reason) throw new Error("Say why, in a few words: the family will read it.");
  const tid = tenantIdOrThrow(tenantId);
  await apiClient().post("/v1/tenants/{tenantId}/finance/proofs/{proofId}/reject", {
    path: { tenantId: tid, proofId: input.proofId },
    body: { reason },
    tenantId: tid,
  });
}
