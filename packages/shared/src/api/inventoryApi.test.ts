import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { canReadMyItems, inventoryCapabilities, NotOnApiError } from "../capabilities";
import { chargeLearner, fetchIssueCharges, voidFeeCharge } from "../feeCharges";
import {
  closeInventoryIssue, fetchInventory, fetchInventoryIssues, fetchInventoryPeople, fetchMyInventory,
  issueInventoryItem, issueInventoryToClass, saveInventoryItem, setItemRetired,
} from "../inventory";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { inventoryIssueFromApi, inventoryItemFromApi } from "./inventoryApi";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const YEAR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const I1 = "i1111111-1111-4111-8111-111111111111";
const I2 = "i2222222-2222-4222-8222-222222222222";
const S1 = "51111111-1111-4111-8111-111111111111";
const S2 = "52222222-2222-4222-8222-222222222222";
const U_STAFF = "61111111-1111-4111-8111-111111111111";
const ISS1 = "71111111-1111-4111-8111-111111111111";
const ISS2 = "72222222-2222-4222-8222-222222222222";

const stamp = { created_at: "2026-11-20T08:00:00Z", updated_at: "2026-11-20T08:00:00Z" };
const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const list = (key: string, items: unknown[], next: string | null = null): FakeReply => ({ body: { [key]: items, page: page(next) } });
const refused = (code: string, status: number, message = "no") => ({ status, body: { error: { code, message } } });

const apiItem = (o: Record<string, unknown> = {}) => ({
  id: I1,
  tenant_id: T,
  name: "KLB Biology Form 2",
  category: "textbooks",
  tracking: "stock",
  quantity: 10,
  asset_tag: "BIO-F2",
  condition: "good",
  location: "Library store",
  retired_at: null,
  ...stamp,
  ...o,
});

const apiIssue = (o: Record<string, unknown> = {}) => ({
  id: ISS1,
  tenant_id: T,
  item_id: I1,
  learner_id: S1,
  holder_user_id: null,
  quantity: 2,
  status: "out",
  issued_at: "2026-11-22T09:00:00Z",
  due_on: "2026-12-31",
  closed_at: null,
  ...o,
});

const apiLearner = (o: Record<string, unknown> = {}) => ({
  id: S1, tenantId: T, admission_no: "ADM-1001", full_name: "Amina Ochieng", gender: "female",
  date_of_birth: "2011-03-14", boarding: false, active: true, archived_at: null, ...stamp, ...o,
});

const apiStaff = (o: Record<string, unknown> = {}) => ({
  id: "81111111-1111-4111-8111-111111111111", tenantId: T, full_name: "David Kamau",
  staff_title: "Senior Mathematics Teacher", classification: "teacher",
  phone: null, email: "teacher@alliance.sc.ke", userId: U_STAFF, active: true, archived_at: null, ...stamp, ...o,
});

const apiYear = (o: Record<string, unknown> = {}) => ({
  id: YEAR, tenantId: T, label: "2026", starts_on: "2026-01-01", ends_on: "2026-12-31", is_current: true, ...stamp, ...o,
});

const apiClass = (o: Record<string, unknown> = {}) => ({
  id: C1, tenantId: T, academic_year_id: YEAR, name: "Form 1 East", form_level: 1, education_level: "secondary",
  pathway: null, stream: "East", class_teacher_staff_id: null, active: true, archived_at: null, ...stamp, ...o,
});

let api: FakeApi;
const P = `/v1/tenants/${T}`;

function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: U_STAFF }));
  setApiActiveTenant(T);
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

describe("capabilities, mappers, and feeCharges guards", () => {
  it("disables unsupported inventory controls on API and enables all on Supabase", () => {
    initBackend({ kind: "supabase" });
    expect(inventoryCapabilities()).toEqual({
      editItem: true, unretireItem: true, itemCostAndNotes: true, issueHistory: true, issueNote: true, chargeToFees: true, stockMovements: true,
      stockInsights: true, sickBayUsesStock: true, reportMaxDays: null,
    });
    initBackend({ kind: "api", apiUrl: BASE });
    expect(inventoryCapabilities()).toEqual({
      editItem: false, unretireItem: false, itemCostAndNotes: false, issueHistory: false, issueNote: false, chargeToFees: false, stockMovements: true,
      stockInsights: false, sickBayUsesStock: false, reportMaxDays: 366,
    });
  });

  it("maps API items and issues to shared domain types", () => {
    expect(inventoryItemFromApi(apiItem() as never)).toMatchObject({
      id: I1, name: "KLB Biology Form 2", category: "textbooks", tracking: "stock", quantity: 10,
      asset_tag: "BIO-F2", location: "Library store", purchased_on: null, unit_cost_cents: null, notes: null,
    });
    // a stock line's unit, consumable flag and reorder level come from the API (and read as "none" from an API that does not send them)
    expect(inventoryItemFromApi(apiItem({ unit: "kg", consumable: true, reorder_level: 10 }) as never)).toMatchObject({ unit: "kg", consumable: true, reorder_level: 10 });
    expect(inventoryItemFromApi(apiItem() as never)).toMatchObject({ unit: null, consumable: false, reorder_level: null });
    expect(inventoryIssueFromApi(apiIssue() as never)).toMatchObject({
      id: ISS1, item_id: I1, student_id: S1, profile_id: null, quantity: 2, status: "out", due_on: "2026-12-31",
    });
  });

  it("returns an empty map for fetchIssueCharges and throws NotOnApiError for chargeLearner/voidFeeCharge on API", async () => {
    boot({});
    expect(await fetchIssueCharges(T)).toEqual(new Map());
    await expect(chargeLearner({ studentId: S1, amountCents: 50000, reason: "Lost book", issueId: ISS1 })).rejects.toBeInstanceOf(NotOnApiError);
    await expect(voidFeeCharge("ch-1", "Found")).rejects.toBeInstanceOf(NotOnApiError);
    expect(api.calls).toHaveLength(0);
  });
});

describe("fetchInventory, fetchInventoryIssues, and fetchMyInventory on API", () => {
  it("computes out and available counts per item and sorts alphabetically", async () => {
    boot({
      [`GET ${P}/inventory/items`]: list("items", [
        apiItem({ id: I2, name: "Projector", category: "ict", tracking: "asset", quantity: 1, asset_tag: "PRJ-1" }),
        apiItem({ id: I1, name: "Biology Book", quantity: 10 }),
      ]),
      [`GET ${P}/inventory/issues`]: list("issues", [
        apiIssue({ id: ISS1, item_id: I1, quantity: 3 }),
        apiIssue({ id: ISS2, item_id: I2, learner_id: null, holder_user_id: U_STAFF, quantity: 1 }),
      ]),
    });

    const items = await fetchInventory(T);
    expect(items.map((i) => [i.name, i.out, i.available])).toEqual([
      ["Biology Book", 3, 7],
      ["Projector", 1, 0],
    ]);
  });

  it("hydrates issue rows with item, learner, and staff details and tolerates 403 on directory reads", async () => {
    boot({
      [`GET ${P}/inventory/issues`]: list("issues", [
        apiIssue({ id: ISS1, item_id: I1, learner_id: S1, holder_user_id: null }),
        apiIssue({ id: ISS2, item_id: I1, learner_id: null, holder_user_id: U_STAFF, quantity: 1 }),
      ]),
      [`GET ${P}/inventory/items`]: list("items", [apiItem()]),
      [`GET ${P}/learners`]: list("learners", [apiLearner()]),
      [`GET ${P}/staff`]: list("staff", [apiStaff()]),
    });

    const rows = await fetchInventoryIssues(T);
    expect(rows.map((r) => [r.holderKind, r.holderName, r.holderDetail, r.itemName])).toEqual([
      ["learner", "Amina Ochieng", "ADM ADM-1001", "KLB Biology Form 2"],
      ["staff", "David Kamau", "Senior Mathematics Teacher", "KLB Biology Form 2"],
    ]);

    boot({
      [`GET ${P}/inventory/issues`]: list("issues", [apiIssue()]),
      [`GET ${P}/inventory/items`]: list("items", [apiItem()]),
      [`GET ${P}/learners`]: refused("forbidden", 403),
      [`GET ${P}/staff`]: refused("forbidden", 403),
    });

    const fallback = await fetchInventoryIssues(T);
    expect(fallback[0]?.holderName).toBe("Unknown");
  });

  it("filters fetchMyInventory to the caller's holder_user_id", async () => {
    boot({
      [`GET ${P}/inventory/issues`]: list("issues", [
        apiIssue({ id: ISS1, learner_id: S1, holder_user_id: null }),
        apiIssue({ id: ISS2, learner_id: null, holder_user_id: U_STAFF, quantity: 1 }),
      ]),
      [`GET ${P}/inventory/items`]: list("items", [apiItem()]),
    });

    const mine = await fetchMyInventory(U_STAFF);
    expect(mine.map((r) => r.id)).toEqual([ISS2]);
  });
});

describe("saveInventoryItem, setItemRetired, issueInventoryItem, and closeInventoryIssue on API", () => {
  const input = {
    name: "  Microscope  ",
    category: "lab_equipment" as const,
    tracking: "asset" as const,
    quantity: 5,
    asset_tag: "LAB-01",
    condition: "new" as const,
    location: "Lab 1",
    purchased_on: null,
    unit_cost_cents: null,
    notes: null,
  };

  it("creates an item forcing quantity=1 for assets and translates duplicate asset_tag conflicts", async () => {
    boot({
      [`POST ${P}/inventory/items`]: { status: 201, body: { item: apiItem({ tracking: "asset", quantity: 1 }) } },
    });

    await saveInventoryItem(T, input);
    expect(api.calls[0]?.body).toEqual({
      name: "Microscope",
      category: "lab_equipment",
      tracking: "asset",
      quantity: 1,
      asset_tag: "LAB-01",
      condition: "new",
      location: "Lab 1",
    });

    boot({
      [`POST ${P}/inventory/items`]: refused("conflict", 409, "An inventory item with this asset_tag already exists"),
    });
    await expect(saveInventoryItem(T, input)).rejects.toThrow("Another item already has that asset tag.");
  });

  it("adds a stock line with its unit, consumable flag and reorder level, and may start it at 0", async () => {
    boot({
      [`POST ${P}/inventory/items`]: { status: 201, body: { item: apiItem({ unit: "kg", consumable: true, reorder_level: 20, quantity: 0 }) } },
    });
    await saveInventoryItem(T, {
      ...input, name: "Rice", category: "kitchen", tracking: "stock", quantity: 0, asset_tag: null, location: null, unit: " kg ", consumable: true, reorder_level: 20,
    });
    expect(api.calls[0]?.body).toEqual({
      name: "Rice", category: "kitchen", tracking: "stock", quantity: 0, asset_tag: null, condition: "new", location: null, unit: "kg", consumable: true, reorder_level: 20,
    });

    // a plain stock line (textbooks) says no unit and not consumable; blank unit and no reorder level are null
    await saveInventoryItem(T, { ...input, name: "Atlas", category: "textbooks", tracking: "stock", quantity: 12, unit: "", consumable: false, reorder_level: null });
    expect(api.calls[1]?.body).toMatchObject({ quantity: 12, unit: null, consumable: false, reorder_level: null });
  });

  it("refuses a stock line with a negative or fractional count before asking the API", async () => {
    boot({});
    await expect(saveInventoryItem(T, { ...input, tracking: "stock", quantity: -1 })).rejects.toThrow("Quantity must be a whole number, 0 or more.");
    await expect(saveInventoryItem(T, { ...input, tracking: "stock", quantity: 2.5 })).rejects.toThrow("Quantity must be a whole number, 0 or more.");
    expect(api.calls).toHaveLength(0);
  });

  it("throws NotOnApiError when editing an item or unretiring a retired item", async () => {
    boot({});
    await expect(saveInventoryItem(T, input, I1)).rejects.toBeInstanceOf(NotOnApiError);
    await expect(setItemRetired(I1, false)).rejects.toBeInstanceOf(NotOnApiError);
    expect(api.calls).toHaveLength(0);
  });

  it("retires an item with a bodyless POST", async () => {
    boot({
      [`POST ${P}/inventory/items/${I1}/retire`]: { status: 200, body: { item: apiItem({ retired_at: "2026-11-24T10:00:00Z" }) } },
    });

    await setItemRetired(I1, true);
    expect(api.calls[0]?.path).toBe(`${P}/inventory/items/${I1}/retire`);
    expect(api.calls[0]?.body).toBeUndefined();
  });

  it("issues an item to a learner or staff holder and closes an issue", async () => {
    boot({
      [`POST ${P}/inventory/issues`]: { status: 201, body: { issue: apiIssue() } },
      [`POST ${P}/inventory/issues/${ISS1}/close`]: { status: 200, body: { issue: apiIssue({ status: "lost" }) } },
    });

    await issueInventoryItem({
      tenantId: T,
      itemId: I1,
      holder: { kind: "staff", profileId: U_STAFF },
      quantity: 1,
      dueOn: "2026-12-31",
      note: "ignored on API",
    });
    expect(api.calls[0]?.body).toEqual({
      item_id: I1,
      learner_id: null,
      holder_user_id: U_STAFF,
      quantity: 1,
      due_on: "2026-12-31",
    });

    await closeInventoryIssue(ISS1, "lost", "good", "  Never returned  ");
    expect(api.calls[1]?.body).toEqual({
      status: "lost",
      returned_condition: null,
      note: "Never returned",
    });
  });
});

describe("issueInventoryToClass and fetchInventoryPeople on API", () => {
  it("issues one copy only to active learners in the class who do not already hold one", async () => {
    boot({
      [`GET ${P}/inventory/items/${I1}`]: { body: { item: apiItem({ quantity: 5 }) } },
      [`GET ${P}/class-memberships`]: list("memberships", [
        { id: "m1", tenantId: T, learner_id: S1, class_id: C1, active: true },
        { id: "m2", tenantId: T, learner_id: S2, class_id: C1, active: true },
      ]),
      [`GET ${P}/learners`]: list("learners", [apiLearner({ id: S1 }), apiLearner({ id: S2, admission_no: "ADM-1002", full_name: "Brian Kamau" })]),
      [`GET ${P}/inventory/issues`]: list("issues", [apiIssue({ item_id: I1, learner_id: S1, quantity: 1 })]),
      [`POST ${P}/inventory/issues`]: { status: 201, body: { issue: apiIssue({ id: ISS2, learner_id: S2, quantity: 1 }) } },
    });

    const count = await issueInventoryToClass(I1, C1, "2026-12-31");
    expect(count).toBe(1);
    const posts = api.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ item_id: I1, learner_id: S2, holder_user_id: null, quantity: 1, due_on: "2026-12-31" });
  });

  it("refuses before issuing any copy when available stock is too low", async () => {
    boot({
      [`GET ${P}/inventory/items/${I1}`]: { body: { item: apiItem({ quantity: 1 }) } },
      [`GET ${P}/class-memberships`]: list("memberships", [
        { id: "m1", tenantId: T, learner_id: S1, class_id: C1, active: true },
        { id: "m2", tenantId: T, learner_id: S2, class_id: C1, active: true },
      ]),
      [`GET ${P}/learners`]: list("learners", [apiLearner({ id: S1 }), apiLearner({ id: S2 })]),
      [`GET ${P}/inventory/issues`]: list("issues", []),
    });

    await expect(issueInventoryToClass(I1, C1, null)).rejects.toThrow("Not enough copies on the shelf");
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("reports how many learners were issued when one class-issue call fails", async () => {
    let posts = 0;
    boot({
      [`GET ${P}/inventory/items/${I1}`]: { body: { item: apiItem({ quantity: 5 }) } },
      [`GET ${P}/class-memberships`]: list("memberships", [
        { id: "m1", tenantId: T, learner_id: S1, class_id: C1, active: true },
        { id: "m2", tenantId: T, learner_id: S2, class_id: C1, active: true },
      ]),
      [`GET ${P}/learners`]: list("learners", [apiLearner({ id: S1 }), apiLearner({ id: S2 })]),
      [`GET ${P}/inventory/issues`]: list("issues", []),
      [`POST ${P}/inventory/issues`]: () => {
        posts += 1;
        return posts === 1
          ? { status: 201, body: { issue: apiIssue({ id: ISS1, learner_id: S1, quantity: 1 }) } }
          : refused("validation_error", 400, "Not enough copies available");
      },
    });

    await expect(issueInventoryToClass(I1, C1, null)).rejects.toThrow("Issued to 1 of 2 learners before failing: Not enough copies available");
  });

  it("loads learners, user-linked staff only, and current-year classes in fetchInventoryPeople", async () => {
    boot({
      [`GET ${P}/learners`]: list("learners", [apiLearner({ id: S1 })]),
      [`GET ${P}/staff`]: list("staff", [
        apiStaff({ userId: U_STAFF, full_name: "David Kamau" }),
        apiStaff({ id: "82222222-2222-4222-8222-222222222222", userId: null, full_name: "Directory Only" }),
      ]),
      [`GET ${P}/academic-years`]: list("academic_years", [apiYear()]),
      [`GET ${P}/classes`]: list("classes", [apiClass()]),
      [`GET ${P}/class-memberships`]: list("memberships", [{ id: "m1", tenantId: T, learner_id: S1, class_id: C1, active: true }]),
    });

    const people = await fetchInventoryPeople(T);
    expect(people.learners).toEqual([{ id: S1, full_name: "Amina Ochieng", admission_no: "ADM-1001", class_id: C1 }]);
    expect(people.staff).toEqual([{ id: U_STAFF, full_name: "David Kamau", role: "teacher", staff_title: "Senior Mathematics Teacher" }]);
    expect(people.classes).toEqual([{ id: C1, name: "Form 1 East" }]);
  });

  it("checks canReadMyItems on Supabase vs API", () => {
    expect(canReadMyItems([], "teacher")).toBe(true);

    initBackend({ kind: "api", apiUrl: BASE });
    expect(canReadMyItems([], "teacher")).toBe(false);
    expect(canReadMyItems(["inventory"], "teacher")).toBe(true);
    expect(canReadMyItems([], "school_admin")).toBe(true);
  });
});
