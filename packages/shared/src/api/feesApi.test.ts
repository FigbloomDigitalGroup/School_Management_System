import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFeesCollection, fetchTenantCurrentTerm, recordPayment, rejectPaymentProof, searchPayableInvoices } from "../adminFees";
import { initBackend } from "../backend";
import { feesCapabilities } from "../capabilities";
import { billTerm, createFeeItem, deleteFeeItem, fetchBillingInputs, fetchSchoolYearGroups, fetchTermFeeItems, updateFeeItem } from "../feeStructure";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { feeItemFromApi } from "./feesApi";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const YEAR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TERM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const L1 = "10000001-1111-4111-8111-111111111111";
const L2 = "10000002-1111-4111-8111-111111111111";
const INV1 = "20000001-1111-4111-8111-111111111111";
const INV2 = "20000002-1111-4111-8111-111111111111";
const FI1 = "30000001-1111-4111-8111-111111111111";
const PROOF1 = "40000001-1111-4111-8111-111111111111";

const stamp = { created_at: "2026-05-01T08:00:00Z", updated_at: "2026-05-01T08:00:00Z" };
const year = (o: Record<string, unknown> = {}) => ({ id: YEAR, tenantId: T, label: "2026", starts_on: "2026-01-01", ends_on: "2026-12-31", is_current: true, ...stamp, ...o });
const term = (o: Record<string, unknown> = {}) => ({ id: TERM, tenantId: T, academic_year_id: YEAR, index: 2, label: "Term 2, 2026", starts_on: "2026-05-01", ends_on: "2026-08-01", is_current: true, ...stamp, ...o });
const klass = (o: Record<string, unknown> = {}) => ({ id: C1, tenantId: T, academic_year_id: YEAR, name: "Form 2 East", form_level: 2, education_level: "secondary", pathway: null, stream: "East", class_teacher_staff_id: null, active: true, archived_at: null, ...stamp, ...o });
const learner = (o: Record<string, unknown> = {}) => ({ id: L1, tenantId: T, admission_no: "ADM-101", full_name: "Amina Otieno", gender: "female", boarding: true, date_of_birth: null, active: true, archived_at: null, ...stamp, ...o });
const membership = (learnerId: string, classId: string) => ({ id: `m-${learnerId}`, tenantId: T, learner_id: learnerId, class_id: classId, academic_year_id: YEAR, active: true, archived_at: null, ...stamp });
const feeItem = (o: Record<string, unknown> = {}) => ({ id: FI1, tenantId: T, term_id: TERM, name: "Tuition", amount_minor: 2_500_000, currency: "KES", applies_to: "all", form_level: null, active: true, archived_at: null, ...stamp, ...o });
const invoice = (o: Record<string, unknown> = {}) => ({
  id: INV1, tenantId: T, learner_id: L1, term_id: TERM, currency: "KES", due_on: "2026-05-15",
  lines_minor: 2_500_000, charges_minor: 50_000, adjustments_minor: 0, total_minor: 2_550_000, paid_minor: 1_000_000,
  balance_minor: 1_550_000, overpaid_minor: 0, unapplied_minor: 0, status: "part_paid", billing_run_id: null,
  created_at: "2026-05-01T08:00:00Z", voided_at: null, void_reason: null, ...o,
});
const proof = (o: Record<string, unknown> = {}) => ({
  id: PROOF1, tenantId: T, invoice_id: INV1, submitted_by: "u2", submitted_via: "guardian", note: "Paid via paybill",
  file: { file_name: "slip.pdf", content_type: "application/pdf", byte_size: 1024, storage_status: "metadata_only", object_available: false },
  sms_text: "SFC1234ABC Confirmed. Ksh10,000.00", txn_source: "mpesa", txn_code: "SFC1234ABC", txn_amount_minor: 1_000_000,
  currency: "KES", txn_at: "2026-05-02T09:00:00Z", txn_payee: "School", txn_payee_number: "123456", txn_account: "ADM-101",
  status: "pending", payment_id: null, reviewed_by: null, reviewed_at: null, rejection_reason: null, created_at: "2026-05-02T09:05:00Z", ...o,
});
const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const list = (key: string, items: unknown[], next: string | null = null): FakeReply => ({ body: { [key]: items, page: page(next) } });
const refused = (code: string, status: number, message = "no") => ({ status, body: { error: { code, message } } });

let api: FakeApi;
const P = `/v1/tenants/${T}`;

function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: "u1" }));
  setApiActiveTenant(T);
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

describe("feesCapabilities & mapping", () => {
  it("disables invoiceSignatures and proofFiles on API and enables both on Supabase", () => {
    initBackend({ kind: "supabase" });
    expect(feesCapabilities()).toEqual({ invoiceSignatures: true, proofFiles: true });
    initBackend({ kind: "api", apiUrl: BASE });
    expect(feesCapabilities()).toEqual({ invoiceSignatures: false, proofFiles: false });
  });

  it("maps FinanceFeeItem to FeeItem", () => {
    expect(feeItemFromApi(feeItem() as never)).toEqual({
      id: FI1, tenant_id: T, term_id: TERM, name: "Tuition", amount_cents: 2_500_000, applies_to: "all", form_level: null, level: null,
    });
  });
});

describe("fee items, year groups & billing", () => {
  it("fetches current term, school year groups, and active fee items sorted by name", async () => {
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/academic-terms`]: list("terms", [term()]),
      [`GET ${P}/classes`]: list("classes", [klass()]),
      [`GET ${P}/finance/fee-items`]: list("fee_items", [feeItem({ id: "f2", name: "Uniform" }), feeItem({ id: FI1, name: "Boarding" })]),
    });

    const cur = await fetchTenantCurrentTerm(T);
    expect(cur?.name).toBe("Term 2, 2026");
    const groups = await fetchSchoolYearGroups(T);
    expect(groups.map((g) => g.key)).toEqual(["secondary:2"]);
    const items = await fetchTermFeeItems(TERM);
    expect(items.map((i) => i.name)).toEqual(["Boarding", "Uniform"]);
  });

  it("creates, updates, and archives fee items via finance endpoints", async () => {
    boot({
      [`POST ${P}/finance/fee-items`]: { status: 201, body: { fee_item: feeItem() } },
      [`PATCH ${P}/finance/fee-items/${FI1}`]: { status: 200, body: { fee_item: feeItem({ name: "Tuition 2" }) } },
      [`POST ${P}/finance/fee-items/${FI1}/archive`]: { status: 200, body: { fee_item: feeItem({ active: false }) } },
    });

    await createFeeItem({ tenantId: T, termId: TERM, name: "Tuition", amountCents: 2_500_000, appliesTo: "form_level", yearGroup: { level: "secondary", year: 2 } });
    await updateFeeItem(FI1, { name: "Tuition 2", amountCents: 2_600_000 });
    await deleteFeeItem(FI1);

    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST ${P}/finance/fee-items`,
      `PATCH ${P}/finance/fee-items/${FI1}`,
      `POST ${P}/finance/fee-items/${FI1}/archive`,
    ]);
    expect(api.calls[0]?.body).toEqual({ term_id: TERM, name: "Tuition", amount_minor: 2_500_000, applies_to: "form_level", form_level: 2 });
    expect(api.calls[1]?.body).toEqual({ name: "Tuition 2", amount_minor: 2_600_000 });
  });

  it("fetches billing inputs and runs a billing run on the API", async () => {
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/learners`]: list("learners", [learner({ id: L1 }), learner({ id: L2, boarding: false })]),
      [`GET ${P}/class-memberships`]: list("memberships", [membership(L1, C1), membership(L2, C1)]),
      [`GET ${P}/classes`]: list("classes", [klass()]),
      [`GET ${P}/finance/invoices`]: list("invoices", [invoice({ learner_id: L1 })]),
      [`POST ${P}/finance/billing-runs`]: { status: 201, body: { billing_run: { billing_run_id: "br1", created: 1, already_billed: 1, nothing_to_bill: 0, total_minor: 2_500_000 } } },
    });

    const inputs = await fetchBillingInputs(T, TERM);
    expect(inputs.students).toHaveLength(2);
    expect(inputs.invoiced.has(L1)).toBe(true);
    expect(inputs.invoiced.has(L2)).toBe(false);

    const res = await billTerm({ termId: TERM, dueOn: "2026-05-15", invoices: [] });
    expect(res).toEqual({ created: 1, totalCents: 2_500_000, alreadyBilled: 1 });
  });
});

describe("collection, search, payments & proofs", () => {
  it("loads term collection with joined learner/class names, pending proofs, and overpaid invoices", async () => {
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/academic-terms`]: list("terms", [term()]),
      [`GET ${P}/finance/invoices`]: list("invoices", [
        invoice(),
        invoice({ id: INV2, learner_id: L2, total_minor: 1_000_000, paid_minor: 1_000_000, balance_minor: 0, overpaid_minor: 0, unapplied_minor: 200_000, status: "paid" }),
        invoice({ id: "voided-1", learner_id: L2, status: "voided" }),
      ]),
      [`GET ${P}/finance/proofs`]: list("proofs", [proof()]),
      [`GET ${P}/learners`]: list("learners", [learner({ id: L1 }), learner({ id: L2, full_name: "Brian Kamau", admission_no: "ADM-102" })]),
      [`GET ${P}/class-memberships`]: list("memberships", [membership(L1, C1)]),
      [`GET ${P}/classes`]: list("classes", [klass()]),
    });

    const col = await fetchFeesCollection(T);
    expect(col.invoices).toHaveLength(2);
    expect(col.outstanding).toEqual([
      { id: INV1, name: "Amina Otieno", cls: "Form 2 East", billed: 2_550_000, charges: 50_000, paid: 1_000_000 },
    ]);
    expect(col.overpaid).toHaveLength(1);
    expect(col.overpaid[0]?.overpaid_cents).toBe(200_000);
    expect(col.pendingProofs).toHaveLength(1);
    expect(col.pendingProofs[0]?.studentName).toBe("Amina Otieno");
    expect(col.pendingProofs[0]?.file_path).toBeNull();
    expect(col.pendingProofs[0]?.file_name).toBe("slip.pdf");
  });

  it("degrades gracefully when a fees-only bursar gets 403 on learners/classes", async () => {
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/academic-terms`]: list("terms", [term()]),
      [`GET ${P}/finance/invoices`]: list("invoices", [invoice()]),
      [`GET ${P}/finance/proofs`]: list("proofs", []),
      [`GET ${P}/learners`]: refused("forbidden", 403),
      [`GET ${P}/class-memberships`]: refused("forbidden", 403),
      [`GET ${P}/classes`]: refused("forbidden", 403),
    });

    const col = await fetchFeesCollection(T);
    expect(col.invoices).toHaveLength(1);
    expect(col.outstanding[0]?.name).toBe("Unknown learner");
  });

  it("searches payable invoices by learner name or admission number, records a payment, and rejects a proof", async () => {
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/finance/invoices`]: list("invoices", [invoice()]),
      [`GET ${P}/learners`]: list("learners", [learner()]),
      [`GET ${P}/class-memberships`]: list("memberships", [membership(L1, C1)]),
      [`GET ${P}/classes`]: list("classes", [klass()]),
      [`POST ${P}/finance/payments`]: { status: 201, body: { payment: { id: "p1" }, invoice: invoice() } },
      [`POST ${P}/finance/proofs/${PROOF1}/reject`]: { status: 200, body: { proof: proof({ status: "rejected" }) } },
    });

    const matches = await searchPayableInvoices(TERM, "amina");
    expect(matches).toEqual([{ id: INV1, studentName: "Amina Otieno · ADM-101", cls: "Form 2 East", balanceCents: 1_550_000 }]);

    await recordPayment({ invoiceId: INV1, cents: 500_000, method: "mpesa", reference: "SFC1234ABC", proofId: PROOF1 });
    await rejectPaymentProof({ proofId: PROOF1, reviewerId: "u1", reason: "Code not found on statement" });

    expect(api.calls.find((c) => c.path === `${P}/finance/payments`)?.body).toEqual({
      invoice_id: INV1, amount_minor: 500_000, method: "mpesa", reference: "SFC1234ABC", proof_id: PROOF1,
    });
    expect(api.calls.find((c) => c.path === `${P}/finance/proofs/${PROOF1}/reject`)?.body).toEqual({
      reason: "Code not found on statement",
    });
  });
});
