import { afterEach, describe, expect, it, vi } from "vitest";
import { recordPayment } from "../adminFees";
import { initBackend } from "../backend";
import { fetchCollectionPage, fetchFeesExtras, fetchLargestBalances, fetchTermAmounts } from "../feesPaging";
import { fetchInventoryItem, fetchInventorySummary, fetchIssuesPage, fetchItemIssues, fetchRegisterPage } from "../inventoryPaging";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { forgetTermData } from "./feesApi";
import { createMemoryTokenStore } from "./tokenStore";

/**
 * The paged reads that came from `main` (feesPaging.ts, inventoryPaging.ts) on the API build: the same functions, answered from the
 * API's own lists and paged here. The Supabase side of each is read from the database and is not tested here.
 */

const T = "11111111-1111-4111-8111-111111111111";
const YEAR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TERM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const L1 = "10000001-1111-4111-8111-111111111111";
const L2 = "10000002-1111-4111-8111-111111111111";
const L3 = "10000003-1111-4111-8111-111111111111";
const INV1 = "20000001-1111-4111-8111-111111111111";
const INV2 = "20000002-1111-4111-8111-111111111111";
const INV3 = "20000003-1111-4111-8111-111111111111";
const PROOF1 = "40000001-1111-4111-8111-111111111111";
const IT1 = "a1111111-1111-4111-8111-111111111111";
const IT2 = "a2222222-2222-4222-8222-222222222222";
const ISS1 = "71111111-1111-4111-8111-111111111111";
const ISS2 = "72222222-2222-4222-8222-222222222222";

const stamp = { created_at: "2026-05-01T08:00:00Z", updated_at: "2026-05-01T08:00:00Z" };
const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const list = (key: string, items: unknown[]): FakeReply => ({ body: { [key]: items, page: page() } });

const year = { id: YEAR, tenantId: T, label: "2026", starts_on: "2026-01-01", ends_on: "2026-12-31", is_current: true, ...stamp };
const term = { id: TERM, tenantId: T, academic_year_id: YEAR, index: 2, label: "Term 2, 2026", starts_on: "2026-05-01", ends_on: "2026-08-01", is_current: true, ...stamp };
const klass = { id: C1, tenantId: T, academic_year_id: YEAR, name: "Form 2 East", form_level: 2, education_level: "secondary", pathway: null, stream: "East", class_teacher_staff_id: null, active: true, archived_at: null, ...stamp };
const learner = (id: string, name: string, adm: string) => ({ id, tenantId: T, admission_no: adm, full_name: name, gender: "female", boarding: false, date_of_birth: null, active: true, archived_at: null, ...stamp });
const membership = (learnerId: string) => ({ id: `m-${learnerId}`, tenantId: T, learner_id: learnerId, class_id: C1, academic_year_id: YEAR, active: true, archived_at: null, ...stamp });
const invoice = (id: string, learnerId: string, total: number, paid: number, status: string, o: Record<string, unknown> = {}) => ({
  id, tenantId: T, learner_id: learnerId, term_id: TERM, currency: "KES", due_on: "2026-05-15", lines_minor: total, charges_minor: 10_000, adjustments_minor: 0,
  total_minor: total, paid_minor: paid, balance_minor: total - paid, overpaid_minor: 0, unapplied_minor: 0, status, billing_run_id: null,
  created_at: "2026-05-01T08:00:00Z", voided_at: null, void_reason: null, ...o,
});
const proof = {
  id: PROOF1, tenantId: T, invoice_id: INV1, submitted_by: "u2", submitted_via: "guardian", note: "Paid via paybill",
  file: { file_name: "slip.pdf", content_type: "application/pdf", byte_size: 1024, storage_status: "metadata_only", object_available: false },
  sms_text: null, txn_source: null, txn_code: null, txn_amount_minor: null, currency: "KES", txn_at: null, txn_payee: null, txn_payee_number: null,
  txn_account: null, status: "pending", payment_id: null, reviewed_by: null, reviewed_at: null, rejection_reason: null, created_at: "2026-05-02T09:05:00Z",
};

const item = (id: string, name: string, o: Record<string, unknown> = {}) => ({
  id, tenant_id: T, name, category: "textbooks", tracking: "stock", quantity: 10, asset_tag: null, condition: "good", location: null, retired_at: null, ...stamp, ...o,
});
const issue = (id: string, itemId: string, o: Record<string, unknown> = {}) => ({
  id, tenant_id: T, item_id: itemId, learner_id: L1, holder_user_id: null, quantity: 2, status: "out", issued_at: "2026-11-22T09:00:00Z", due_on: "2026-12-31", closed_at: null, ...o,
});

const P = `/v1/tenants/${T}`;
let api: FakeApi;

function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: "u1" }));
  setApiActiveTenant(T);
  forgetTermData();
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

const feesRoutes = (): Record<string, FakeRoute> => ({
  [`GET ${P}/academic-years`]: list("academic_years", [year]),
  [`GET ${P}/academic-terms`]: list("terms", [term]),
  [`GET ${P}/classes`]: list("classes", [klass]),
  [`GET ${P}/learners`]: list("learners", [learner(L1, "Amina Otieno", "ADM-101"), learner(L2, "Brian Kamau", "ADM-102"), learner(L3, "Cynthia Wanjiru", "ADM-103")]),
  [`GET ${P}/class-memberships`]: list("memberships", [membership(L1), membership(L2), membership(L3)]),
  [`GET ${P}/finance/invoices`]: list("invoices", [
    invoice(INV1, L1, 2_550_000, 1_000_000, "part_paid"),
    invoice(INV2, L2, 1_000_000, 1_000_000, "paid"),
    invoice(INV3, L3, 3_000_000, 0, "overdue"),
    invoice("voided-1", L1, 9_999_999, 0, "voided"),
  ]),
  [`GET ${P}/finance/proofs`]: list("proofs", [proof]),
  [`POST ${P}/finance/payments`]: { status: 201, body: { payment: { id: "pay1" } } },
});

describe("Fees page reads on the API build", () => {
  it("gives the term's amounts without voided invoices, and the largest balances with names from the same read", async () => {
    boot(feesRoutes());

    const amounts = await fetchTermAmounts(T, TERM);
    expect(amounts.map((a) => [a.id, a.total_cents, a.paid_cents, a.status])).toEqual([
      [INV1, 2_550_000, 1_000_000, "part_paid"],
      [INV2, 1_000_000, 1_000_000, "paid"],
      [INV3, 3_000_000, 0, "overdue"],
    ]);

    const largest = await fetchLargestBalances(amounts);
    expect(largest).toEqual([
      { id: INV3, name: "Cynthia Wanjiru", cls: "Form 2 East", billed: 3_000_000, charges: 10_000, paid: 0 },
      { id: INV1, name: "Amina Otieno", cls: "Form 2 East", billed: 2_550_000, charges: 10_000, paid: 1_000_000 },
    ]);
  });

  it("filters, searches and pages the collection list by learner name", async () => {
    boot(feesRoutes());

    const owing = await fetchCollectionPage(T, TERM, { filter: "owing", offset: 0, limit: 10 });
    expect(owing.total).toBe(2);
    expect(owing.rows.map((r) => r.studentName)).toEqual(["Amina Otieno", "Cynthia Wanjiru"]);
    expect(owing.rows[0]).toMatchObject({ id: INV1, admissionNo: "ADM-101", cls: "Form 2 East", total: 2_550_000, charges: 10_000, paid: 1_000_000, dueOn: "2026-05-15", status: "part_paid" });
    expect(owing.rows[0]).not.toHaveProperty("learnerId");

    expect((await fetchCollectionPage(T, TERM, { filter: "overdue", offset: 0, limit: 10 })).rows.map((r) => r.id)).toEqual([INV3]);
    expect((await fetchCollectionPage(T, TERM, { filter: "nothing_paid", offset: 0, limit: 10 })).rows.map((r) => r.id)).toEqual([INV3]);
    expect((await fetchCollectionPage(T, TERM, { filter: "part_paid", offset: 0, limit: 10 })).rows.map((r) => r.id)).toEqual([INV1]);
    expect((await fetchCollectionPage(T, TERM, { filter: "paid", offset: 0, limit: 10 })).rows.map((r) => r.id)).toEqual([INV2]);

    // a search matches the name, the admission number or the class
    expect((await fetchCollectionPage(T, TERM, { filter: "all", query: "adm-102", offset: 0, limit: 10 })).rows.map((r) => r.studentName)).toEqual(["Brian Kamau"]);
    expect((await fetchCollectionPage(T, TERM, { filter: "all", query: "form 2", offset: 0, limit: 10 })).total).toBe(3);
    expect((await fetchCollectionPage(T, TERM, { filter: "all", query: "nobody", offset: 0, limit: 10 })).total).toBe(0);

    const second = await fetchCollectionPage(T, TERM, { filter: "all", offset: 2, limit: 2 });
    expect(second.total).toBe(3);
    expect(second.rows.map((r) => r.studentName)).toEqual(["Cynthia Wanjiru"]);
  });

  it("gives the proofs to review and the overpayments", async () => {
    boot(feesRoutes());
    const extras = await fetchFeesExtras(T, TERM);
    expect(extras.pendingProofs).toHaveLength(1);
    expect(extras.pendingProofs[0]).toMatchObject({ id: PROOF1, studentName: "Amina Otieno", file_name: "slip.pdf", file_path: null });
    expect(extras.overpaid).toEqual([]);
    expect(extras.school).toEqual({ paybill: null, till: null });

    // no term open: nothing to review
    expect((await fetchFeesExtras(T, null)).pendingProofs).toEqual([]);
  });

  it("reads the term's invoices once for the parts of one page, and again after a payment", async () => {
    boot(feesRoutes());
    await fetchTermAmounts(T, TERM);
    await fetchCollectionPage(T, TERM, { filter: "all", offset: 0, limit: 10 });
    await fetchCollectionPage(T, TERM, { filter: "owing", offset: 0, limit: 10 });
    expect(api.callsTo(`GET ${P}/finance/invoices`)).toHaveLength(1);

    await recordPayment({ invoiceId: INV3, cents: 100_000, method: "cash", reference: "" });
    await fetchCollectionPage(T, TERM, { filter: "all", offset: 0, limit: 10 });
    expect(api.callsTo(`GET ${P}/finance/invoices`)).toHaveLength(2);
  });
});

const inventoryRoutes = (): Record<string, FakeRoute> => ({
  [`GET ${P}/inventory/items`]: list("items", [
    item(IT2, "Projector", { category: "ict", tracking: "asset", quantity: 1, asset_tag: "PRJ-1", location: "Staff room" }),
    item(IT1, "Biology Book", { asset_tag: "BIO-F2", location: "Library store" }),
  ]),
  [`GET ${P}/inventory/issues`]: list("issues", [
    issue(ISS1, IT1, { quantity: 3, due_on: "2026-01-01" }),
    issue(ISS2, IT2, { learner_id: null, holder_user_id: "u9", quantity: 1, due_on: "2099-01-01" }),
  ]),
  [`GET ${P}/learners`]: list("learners", [learner(L1, "Amina Otieno", "ADM-101")]),
  [`GET ${P}/staff`]: list("staff", []),
});

describe("Inventory screen reads on the API build", () => {
  it("pages the register by name, and searches name, tag, location and category", async () => {
    boot(inventoryRoutes());

    const all = await fetchRegisterPage(T, { offset: 0, limit: 10 });
    expect(all.rows.map((r) => r.name)).toEqual(["Biology Book", "Projector"]);
    expect(all.total).toBe(2);
    expect(all.rows[0]).toMatchObject({ out: 3, available: 7, unit: null, consumable: false, reorder_level: null });

    expect((await fetchRegisterPage(T, { query: "prj", offset: 0, limit: 10 })).rows.map((r) => r.name)).toEqual(["Projector"]);
    expect((await fetchRegisterPage(T, { query: "library", offset: 0, limit: 10 })).rows.map((r) => r.name)).toEqual(["Biology Book"]);
    expect((await fetchRegisterPage(T, { query: "ict", offset: 0, limit: 10 })).rows.map((r) => r.name)).toEqual(["Projector"]);
    expect((await fetchRegisterPage(T, { offset: 1, limit: 1 })).rows.map((r) => r.name)).toEqual(["Projector"]);
  });

  it("adds up the cards from the register and what is out", async () => {
    boot(inventoryRoutes());
    expect(await fetchInventorySummary(T, new Date("2026-06-01T00:00:00Z"))).toEqual({ items: 2, copiesOwned: 11, out: 4, overdue: 1, lost: 0 });
  });

  it("pages what is out and what is overdue, and finds one item and its issues", async () => {
    boot(inventoryRoutes());
    const now = new Date("2026-06-01T00:00:00Z");

    const out = await fetchIssuesPage(T, { filter: "out", offset: 0, limit: 10, now });
    expect(out.total).toBe(2);
    const overdue = await fetchIssuesPage(T, { filter: "overdue", offset: 0, limit: 10, now });
    expect(overdue.rows.map((r) => r.id)).toEqual([ISS1]);
    expect((await fetchIssuesPage(T, { filter: "out", query: "amina", offset: 0, limit: 10, now })).rows.map((r) => r.id)).toEqual([ISS1]);

    expect((await fetchInventoryItem(IT2)).name).toBe("Projector");
    await expect(fetchInventoryItem("missing")).rejects.toThrow("not on the register");
    expect((await fetchItemIssues(IT1)).map((r) => r.id)).toEqual([ISS1]);
  });
});
