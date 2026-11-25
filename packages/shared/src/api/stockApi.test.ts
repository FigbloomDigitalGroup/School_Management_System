import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { inventoryCapabilities, isNotOnApiError } from "../capabilities";
import { fetchHeadcount, fetchItemIndex, fetchUniformIssues } from "../inventoryPaging";
import {
  fetchConsumptionFlags, fetchCostPerMeal, fetchCurrentTermDates, fetchMovements, fetchSpendByMonth, fetchStockInsights, fetchStockLevels,
  fetchUsage, recordStockMovement, type MovementInput,
} from "../inventoryStock";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { isApiError } from "./errors";
import { createMemoryTokenStore } from "./tokenStore";

/**
 * Stock in and out on the API build (api/stockApi.ts), through the shared functions the screens call: what each one asks the API, and
 * how the answer becomes the rows the Supabase build produces. The API itself is a stand-in (testing/fakeApi.ts).
 */

const T = "11111111-1111-4111-8111-111111111111";
const RICE = "a1111111-1111-4111-8111-111111111111";
const FLOUR = "a2222222-2222-4222-8222-222222222222";
const SHIRT = "a3333333-3333-4333-8333-333333333333";
const BOOK = "a4444444-4444-4444-8444-444444444444";
const U_CLERK = "61111111-1111-4111-8111-111111111111";
const L1 = "10000001-1111-4111-8111-111111111111";
const ISS1 = "71111111-1111-4111-8111-111111111111";
const ISS2 = "72222222-2222-4222-8222-222222222222";
const ISS3 = "73333333-3333-4333-8333-333333333333";
const ISS4 = "74444444-4444-4444-8444-444444444444";

const P = `/v1/tenants/${T}/inventory`;
const stamp = { created_at: "2026-11-01T08:00:00Z", updated_at: "2026-11-01T08:00:00Z" };
const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const list = (key: string, items: unknown[], next: string | null = null): FakeReply => ({ body: { [key]: items, page: page(next) } });
const refused = (code: string, status: number, message: string): FakeReply => ({ status, body: { error: { code, message, request_id: "req-1" } } });

const apiItem = (id: string, name: string, o: Record<string, unknown> = {}) => ({
  id, tenant_id: T, name, category: "kitchen", tracking: "stock", quantity: 40, asset_tag: null, condition: "good", location: null, retired_at: null,
  unit: "kg", consumable: true, reorder_level: 10, ...stamp, ...o,
});
const apiMovement = (id: string, o: Record<string, unknown> = {}) => ({
  id, tenant_id: T, item_id: RICE, kind: "used", quantity: 5, unit_cost_cents: null, supplier: null, reference: null, occurred_on: "2026-11-20",
  purpose: "Lunch", meals_served: 300, note: null, recorded_by: U_CLERK, recorded_by_name: "Grace Wanjiru", created_at: "2026-11-20T11:00:00Z", ...o,
});
const apiIssue = (id: string, itemId: string, o: Record<string, unknown> = {}) => ({
  id, tenant_id: T, item_id: itemId, learner_id: L1, holder_user_id: null, quantity: 1, status: "out", issued_at: "2026-11-20T09:00:00Z", due_on: null, closed_at: null, ...o,
});
const level = (o: Record<string, unknown> = {}) => ({
  item_id: RICE, name: "Rice", category: "kitchen", unit: "kg", consumable: true, quantity: 40, reorder_level: 50, unit_cost_cents: 15000, value_cents: 600000,
  used_28d: 280, wasted_28d: 4, avg_daily_use: 10, days_of_cover: 4, low: true, last_received_on: "2026-11-10", next_delivery_on: "2026-11-27", ...o,
});

let api: FakeApi;

/** The fake API is rebuilt for every test, and the client is reset (it keeps its token store and school). Nothing else is cached in the module. */
function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: U_CLERK }));
  setApiActiveTenant(T);
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

const input = (o: Partial<MovementInput> = {}): MovementInput => ({ tenantId: T, itemId: RICE, kind: "used", quantity: 5, occurredOn: "2026-11-24", ...o });

describe("capabilities on the API build", () => {
  it("turns stock movements on and keeps the AI briefing, item edit and the 366-day report limit visible as flags", () => {
    initBackend({ kind: "api", apiUrl: BASE });
    expect(inventoryCapabilities()).toMatchObject({ stockMovements: true, stockInsights: false, sickBayUsesStock: false, editItem: false, reportMaxDays: 366, termDatesNeedAcademics: true });
    initBackend({ kind: "supabase" });
    expect(inventoryCapabilities()).toMatchObject({ stockMovements: true, stockInsights: true, sickBayUsesStock: true, editItem: true, reportMaxDays: null, termDatesNeedAcademics: false });
  });
});

describe("recordStockMovement on the API", () => {
  const ok = { status: 201, body: { movement: apiMovement("m1"), item: apiItem(RICE, "Rice") } };

  it("sends a delivery with its price, supplier and reference, trimmed, and no meals", async () => {
    boot({ [`POST ${P}/movements`]: ok });
    await recordStockMovement(input({
      kind: "received", quantity: 50, unitCostCents: 15000, supplier: "  Kitui Grains Ltd ", reference: " LPO-77 ", purpose: "ignored", mealsServed: 9, note: "  on time  ",
    }));
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.headers["x-tenant-id"]).toBe(T);
    expect(api.calls[0]!.body).toEqual({
      item_id: RICE, kind: "received", quantity: 50, occurred_on: "2026-11-24", unit_cost_cents: 15000, supplier: "Kitui Grains Ltd",
      reference: "LPO-77", purpose: null, meals_served: null, note: "on time",
    });
  });

  it("sends a day's use with its purpose and meals served, and no price or supplier (the API answers 400 to those)", async () => {
    boot({ [`POST ${P}/movements`]: ok });
    await recordStockMovement(input({ kind: "used", quantity: 12, purpose: " Lunch ", mealsServed: 310, unitCostCents: 99, supplier: "x" }));
    expect(api.calls[0]!.body).toEqual({
      item_id: RICE, kind: "used", quantity: 12, occurred_on: "2026-11-24", unit_cost_cents: null, supplier: null,
      reference: null, purpose: "Lunch", meals_served: 310, note: null,
    });
  });

  it("sends waste with a purpose but no meals, and a stock-take as a signed quantity with nothing else", async () => {
    boot({ [`POST ${P}/movements`]: ok });
    await recordStockMovement(input({ kind: "wasted", quantity: 3, purpose: "Spoilt", mealsServed: 20 }));
    await recordStockMovement(input({ kind: "adjusted", quantity: -4, purpose: "ignored", mealsServed: 1, supplier: "x", unitCostCents: 5 }));
    expect(api.calls[0]!.body).toMatchObject({ kind: "wasted", quantity: 3, purpose: "Spoilt", meals_served: null, unit_cost_cents: null, supplier: null });
    expect(api.calls[1]!.body).toEqual({
      item_id: RICE, kind: "adjusted", quantity: -4, occurred_on: "2026-11-24", unit_cost_cents: null, supplier: null,
      reference: null, purpose: null, meals_served: null, note: null,
    });
  });

  it("shows the server's own words when it refuses: not enough stock (409), written off (409), a day in the future (400)", async () => {
    boot({ [`POST ${P}/movements`]: refused("conflict", 409, "Only 5 kg of Rice in stock") });
    const err = await recordStockMovement(input({ quantity: 8 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Only 5 kg of Rice in stock");
    expect(isApiError(err) && err.code).toBe("conflict");
    expect(isApiError(err) && err.status).toBe(409);

    boot({ [`POST ${P}/movements`]: refused("conflict", 409, "Old flour has been written off") });
    await expect(recordStockMovement(input({ itemId: FLOUR }))).rejects.toThrow("Old flour has been written off");

    boot({ [`POST ${P}/movements`]: refused("validation_error", 400, "occurred_on cannot be in the future") });
    await expect(recordStockMovement(input({ occurredOn: "2030-01-01" }))).rejects.toThrow("occurred_on cannot be in the future");
  });

  it("says something a person can read when the server is down, busy, or the person may not record", async () => {
    boot({ [`POST ${P}/movements`]: { networkError: true } });
    await expect(recordStockMovement(input())).rejects.toThrow("Can't reach the server");

    boot({ [`POST ${P}/movements`]: { status: 503, body: { error: { code: "service_unavailable", message: "x" } } } });
    await expect(recordStockMovement(input())).rejects.toThrow("The service is busy");

    boot({ [`POST ${P}/movements`]: refused("forbidden", 403, "Missing permission resource.inventory.write") });
    await expect(recordStockMovement(input())).rejects.toThrow("Missing permission resource.inventory.write");
  });
});

describe("fetchMovements on the API", () => {
  it("lists one item's movements newest first with the recorder's name, and sends the item id", async () => {
    boot({
      [`GET ${P}/movements`]: list("movements", [
        apiMovement("m2", { kind: "received", quantity: 50, unit_cost_cents: 15000, supplier: "Kitui Grains Ltd", reference: "LPO-77", purpose: null, meals_served: null, occurred_on: "2026-11-21" }),
        apiMovement("m1", { recorded_by: null, recorded_by_name: null, note: "Lunch" }),
      ]),
    });
    const rows = await fetchMovements(RICE);
    expect(api.calls[0]!.query.get("item_id")).toBe(RICE);
    expect(api.calls[0]!.query.get("limit")).toBe("200");
    expect(rows.map((r) => r.id)).toEqual(["m2", "m1"]);
    expect(rows[0]).toMatchObject({
      kind: "received", quantity: 50, unit_cost_cents: 15000, supplier: "Kitui Grains Ltd", reference: "LPO-77", recordedByName: "Grace Wanjiru", recorded_by: U_CLERK,
    });
    expect(rows[1]).toMatchObject({ recordedByName: null, recorded_by: null, unit_cost_cents: null, meals_served: 300, tenant_id: T });
  });

  it("follows the cursor to the end when there are fewer than 500", async () => {
    boot({
      [`GET ${P}/movements`]: (call) => call.query.get("cursor") === "c2"
        ? list("movements", [apiMovement("m3")])
        : list("movements", [apiMovement("m1"), apiMovement("m2")], "c2"),
    });
    expect((await fetchMovements(RICE)).map((r) => r.id)).toEqual(["m1", "m2", "m3"]);
    expect(api.calls).toHaveLength(2);
  });

  it("stops paging once it has the last 500, as Supabase's history does", async () => {
    const full = (from: number) => Array.from({ length: 200 }, (_, i) => apiMovement(`m${from + i}`));
    boot({
      [`GET ${P}/movements`]: (call) => {
        const c = call.query.get("cursor");
        return c === "c2" ? list("movements", full(200), "c3") : c === "c3" ? list("movements", full(400), "c4") : list("movements", full(0), "c2");
      },
    });
    const rows = await fetchMovements(RICE);
    expect(rows).toHaveLength(500);
    expect(rows[0]!.id).toBe("m0");
    expect(rows[499]!.id).toBe("m499");
    expect(api.calls).toHaveLength(3);
  });

  it("answers with a readable error when the person may not read the register", async () => {
    boot({ [`GET ${P}/movements`]: refused("forbidden", 403, "Missing permission resource.inventory.read") });
    await expect(fetchMovements(RICE)).rejects.toThrow("Missing permission resource.inventory.read");
  });
});

describe("stock levels and the reports on the API", () => {
  it("reads the stock levels, with Supabase's names, null where there is no use or no price", async () => {
    boot({
      [`GET ${P}/stock-levels`]: {
        body: { as_of: "2026-11-24", levels: [level(), level({ item_id: FLOUR, name: "Flour", unit: null, reorder_level: null, unit_cost_cents: null, value_cents: 0, avg_daily_use: 0, days_of_cover: null, low: false, last_received_on: null, next_delivery_on: null })] },
      },
    });
    const levels = await fetchStockLevels(T);
    expect(api.calls[0]!.query.has("as_of")).toBe(false);
    expect(levels[0]).toEqual({
      item_id: RICE, name: "Rice", category: "kitchen", unit: "kg", consumable: true, quantity: 40, reorder_level: 50, unit_cost_cents: 15000, value_cents: 600000,
      used_28d: 280, wasted_28d: 4, avg_daily_use: 10, days_of_cover: 4, low: true, last_received_on: "2026-11-10", next_delivery_on: "2026-11-27",
    });
    expect(levels[1]).toMatchObject({ unit: null, reorder_level: null, unit_cost_cents: null, days_of_cover: null, avg_daily_use: 0, low: false, next_delivery_on: null });

    await fetchStockLevels(T, "2026-11-01");
    expect(api.calls[1]!.query.get("as_of")).toBe("2026-11-01");
  });

  it("reads use per item for a period and bucket", async () => {
    boot({
      [`GET ${P}/reports/usage`]: {
        body: {
          from: "2026-11-01", to: "2026-11-24", bucket: "week",
          usage: [{ item_id: RICE, period_start: "2026-11-02", used: 120, wasted: 2, received: 50, shrinkage: 1, spend_cents: 750000, used_cost_cents: 1800000 }],
        },
      },
    });
    const rows = await fetchUsage(T, "2026-11-01", "2026-11-24", "week");
    expect(api.calls[0]!.query.get("from")).toBe("2026-11-01");
    expect(api.calls[0]!.query.get("to")).toBe("2026-11-24");
    expect(api.calls[0]!.query.get("bucket")).toBe("week");
    expect(rows).toEqual([{ item_id: RICE, period_start: "2026-11-02", used: 120, wasted: 2, received: 50, shrinkage: 1, spend_cents: 750000, used_cost_cents: 1800000 }]);
    await fetchUsage(T, "2026-11-01", "2026-11-24");
    expect(api.calls[1]!.query.get("bucket")).toBe("week");
  });

  it("reads spend by month and cost per meal", async () => {
    boot({
      [`GET ${P}/reports/spend-by-month`]: { body: { from: "2026-06-01", to: "2026-11-24", spend: [{ month: "2026-11-01", category: "kitchen", spend_cents: 900000, deliveries: 4 }] } },
      [`GET ${P}/reports/cost-per-meal`]: {
        body: {
          from: "2026-06-01", to: "2026-11-24", bucket: "month",
          cost_per_meal: [
            { period_start: "2026-11-01", purpose: "Lunch", used_cost_cents: 3000000, meals_served: 10000, cost_per_meal_cents: 300 },
            { period_start: "2026-11-01", purpose: "Other", used_cost_cents: 50000, meals_served: 0, cost_per_meal_cents: null },
          ],
        },
      },
    });
    expect(await fetchSpendByMonth(T, "2026-06-01", "2026-11-24")).toEqual([{ month: "2026-11-01", category: "kitchen", spend_cents: 900000, deliveries: 4 }]);
    const meals = await fetchCostPerMeal(T, "2026-06-01", "2026-11-24");
    expect(api.calls[1]!.query.get("bucket")).toBe("month");
    expect(meals).toEqual([
      { period_start: "2026-11-01", purpose: "Lunch", used_cost_cents: 3000000, meals_served: 10000, cost_per_meal_cents: 300 },
      { period_start: "2026-11-01", purpose: "Other", used_cost_cents: 50000, meals_served: 0, cost_per_meal_cents: null },
    ]);
    await fetchCostPerMeal(T, "2026-11-01", "2026-11-24", "week");
    expect(api.calls[2]!.query.get("bucket")).toBe("week");
  });

  it("passes on the API's own refusal of a period over 400 days", async () => {
    boot({ [`GET ${P}/reports/usage`]: refused("validation_error", 400, "Ask for at most 400 days at a time") });
    await expect(fetchUsage(T, "2024-01-01", "2026-11-24", "month")).rejects.toThrow("Ask for at most 400 days at a time");
  });

  it("reads the headcount per day: sorted, the day cut to a date, with a total", async () => {
    boot({
      [`GET ${P}/reports/headcount`]: {
        body: {
          from: "2026-11-23", to: "2026-11-24",
          days: [{ day: "2026-11-24T00:00:00Z", learners: 1000, staff: 60, visitors: 6 }, { day: "2026-11-23", learners: 1000, staff: 60, visitors: 0 }],
        },
      },
    });
    expect(await fetchHeadcount(T, "2026-11-23", "2026-11-24")).toEqual([
      { day: "2026-11-23", learners: 1000, staff: 60, visitors: 0, total: 1060 },
      { day: "2026-11-24", learners: 1000, staff: 60, visitors: 6, total: 1066 },
    ]);
  });

  it("reads the flags as numbers and nulls, alarms first and explained rises last", async () => {
    const flag = (o: Record<string, unknown>) => ({
      kind: "usage_up", item_id: RICE, item_name: "Rice", category: "kitchen", unit: "kg", purpose: "Lunch", occurred_on: "2026-11-17", period_from: null,
      expected: 20, actual: 25, headcount: 1066, baseline_headcount: 1064, visitors: 2, severity: "medium", explained: false, reason: "Rice up", ...o,
    });
    boot({
      [`GET ${P}/reports/flags`]: {
        body: {
          from: "2026-09-29", to: "2026-11-24",
          flags: [
            flag({ explained: true, severity: "low", occurred_on: "2026-11-20" }),
            flag({ kind: "price_jump", severity: "high", expected: null, actual: 18000, headcount: null, baseline_headcount: null, visitors: null, unit: null, purpose: null }),
            flag({ kind: "shrinkage", severity: "medium", occurred_on: "2026-11-22" }),
          ],
        },
      },
    });
    const flags = await fetchConsumptionFlags(T, "2026-09-29", "2026-11-24");
    expect(api.calls[0]!.query.get("from")).toBe("2026-09-29");
    expect(api.calls[0]!.query.get("to")).toBe("2026-11-24");
    expect(flags.map((f) => [f.kind, f.explained])).toEqual([["price_jump", false], ["shrinkage", false], ["usage_up", true]]);
    expect(flags[0]).toMatchObject({ expected: null, actual: 18000, headcount: null, baseline_headcount: null, visitors: null, unit: null, purpose: null });
    expect(flags[1]).toMatchObject({ expected: 20, actual: 25, headcount: 1066, period_from: null, reason: "Rice up", item_name: "Rice" });
  });
});

describe("fetchCurrentTermDates on the API", () => {
  const term = (o: Record<string, unknown>) => ({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", tenantId: T, academic_year_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", index: 3, label: "Term 3, 2026",
    starts_on: "2026-08-31", ends_on: "2026-12-04", is_current: true, ...stamp, ...o,
  });

  it("returns the current term's dates", async () => {
    boot({ [`GET /v1/tenants/${T}/academic-terms`]: list("terms", [term({ id: "t2", is_current: false, starts_on: "2026-05-04", ends_on: "2026-08-07" }), term({})]) });
    expect(await fetchCurrentTermDates(T)).toEqual({ starts_on: "2026-08-31", ends_on: "2026-12-04" });
  });

  it("is null with no current term, and null (not an error) for a person who may not read terms", async () => {
    boot({ [`GET /v1/tenants/${T}/academic-terms`]: list("terms", [term({ is_current: false })]) });
    expect(await fetchCurrentTermDates(T)).toBeNull();

    boot({ [`GET /v1/tenants/${T}/academic-terms`]: refused("forbidden", 403, "Missing permission resource.academics.read") });
    expect(await fetchCurrentTermDates(T)).toBeNull();
  });

  it("still fails on a server fault, so a broken API is not mistaken for no term", async () => {
    boot({ [`GET /v1/tenants/${T}/academic-terms`]: { status: 500, body: { error: { code: "internal_error", message: "boom", request_id: "req-9" } } } });
    await expect(fetchCurrentTermDates(T)).rejects.toThrow("Something went wrong on our side. (reference req-9)");
  });
});

describe("the item index and the uniforms on the API", () => {
  it("indexes the live items by name, store and unit", async () => {
    boot({
      [`GET ${P}/items`]: list("items", [
        apiItem(RICE, "Rice"),
        apiItem(BOOK, "Biology Book", { category: "textbooks", unit: null, consumable: false, reorder_level: null, asset_tag: "BIO" }),
      ]),
    });
    expect(await fetchItemIndex(T)).toEqual([
      { id: RICE, name: "Rice", category: "kitchen", unit: "kg", consumable: true, tracking: "stock", retired_at: null },
      { id: BOOK, name: "Biology Book", category: "textbooks", unit: null, consumable: false, tracking: "stock", retired_at: null },
    ]);
  });

  it("lists the uniforms still out that were handed out in the period, by item", async () => {
    boot({
      [`GET ${P}/items`]: list("items", [
        apiItem(SHIRT, "White shirt", { category: "uniforms", unit: null, consumable: false, reorder_level: null }),
        apiItem(BOOK, "Biology Book", { category: "textbooks", unit: null, consumable: false, reorder_level: null }),
      ]),
      [`GET ${P}/issues`]: list("issues", [
        apiIssue(ISS1, SHIRT, { issued_at: "2026-11-10T09:00:00Z" }),
        apiIssue(ISS2, SHIRT, { learner_id: null, holder_user_id: U_CLERK, issued_at: "2026-11-15T12:00:00Z", quantity: 2 }),
        apiIssue(ISS3, SHIRT, { issued_at: "2026-09-01T09:00:00Z" }),
        apiIssue(ISS4, BOOK, { issued_at: "2026-11-12T09:00:00Z" }),
      ]),
    });
    const rows = await fetchUniformIssues(T, "2026-11-01", "2026-11-24");
    expect(rows).toEqual([
      { id: ISS1, item_id: SHIRT, quantity: 1, issued_at: "2026-11-10T09:00:00Z", student_id: L1, name: "White shirt" },
      { id: ISS2, item_id: SHIRT, quantity: 2, issued_at: "2026-11-15T12:00:00Z", student_id: null, name: "White shirt" },
    ]);
  });
});

describe("what is not on the API", () => {
  it("the AI briefing throws NotOnApiError and asks the API nothing", async () => {
    boot({});
    const err = await fetchStockInsights("2026-11-01", "2026-11-24").catch((e: unknown) => e);
    expect(isNotOnApiError(err)).toBe(true);
    expect((err as Error).message).toBe("The AI briefing on stock is not on the new system yet.");
    expect(api.calls).toHaveLength(0);
  });
});
