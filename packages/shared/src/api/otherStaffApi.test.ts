import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { BASE, createFakeApi, type FakeApi, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { apiFetchMyStaffRecord, myStaffRecordFromApi, staffMayKeepVisitors, staffMayReadItems } from "./otherStaffApi";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";
const S = "33333333-3333-4333-8333-333333333333";
const P = `/v1/tenants/${T}`;

const apiStaff = (over: Record<string, unknown> = {}) => ({
  id: S,
  tenantId: T,
  full_name: "Grace Wambui",
  staff_title: "Librarian",
  classification: "staff",
  phone: "+254712345678",
  email: "grace@alliance.sc.ke",
  userId: U,
  active: true,
  archived_at: null,
  created_at: "2026-11-20T08:00:00Z",
  updated_at: "2026-11-20T08:00:00Z",
  ...over,
});

const refused = (code: string, status: number, message = "no") => ({ status, body: { error: { code, message } } });

let api: FakeApi;

function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: U }));
  setApiActiveTenant(T);
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

describe("myStaffRecordFromApi", () => {
  it("keeps the fields the staff home shows", () => {
    expect(myStaffRecordFromApi(apiStaff() as never)).toEqual({
      id: S,
      full_name: "Grace Wambui",
      staff_title: "Librarian",
      classification: "staff",
      phone: "+254712345678",
      email: "grace@alliance.sc.ke",
    });
  });

  it("reads a missing or blank title, phone and email as null, never as a made-up value", () => {
    expect(myStaffRecordFromApi(apiStaff({ staff_title: null, phone: null, email: null }) as never)).toMatchObject({ staff_title: null, phone: null, email: null });
    expect(myStaffRecordFromApi(apiStaff({ staff_title: "   ", phone: "", email: " " }) as never)).toMatchObject({ staff_title: null, phone: null, email: null });
  });

  it("trims a title", () => {
    expect(myStaffRecordFromApi(apiStaff({ staff_title: "  Nurse " }) as never).staff_title).toBe("Nurse");
  });
});

describe("apiFetchMyStaffRecord", () => {
  it("reads /staff/me for the school and returns the mapped record", async () => {
    boot({ [`GET ${P}/staff/me`]: { body: { staff: apiStaff() } } });
    expect(await apiFetchMyStaffRecord(T)).toMatchObject({ id: S, full_name: "Grace Wambui", staff_title: "Librarian" });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.headers["x-tenant-id"]).toBe(T);
    expect(api.calls[0]?.headers["authorization"]).toBe("Bearer tok");
  });

  it("answers null when no staff record is linked to the account (404)", async () => {
    boot({ [`GET ${P}/staff/me`]: refused("not_found", 404, "No staff record is linked to this account in this school") });
    expect(await apiFetchMyStaffRecord(T)).toBeNull();
  });

  it("does not hide a refusal or a server error as 'not linked'", async () => {
    boot({ [`GET ${P}/staff/me`]: refused("forbidden", 403, "Forbidden") });
    await expect(apiFetchMyStaffRecord(T)).rejects.toMatchObject({ code: "forbidden" });
    boot({ [`GET ${P}/staff/me`]: refused("internal_error", 500, "boom") });
    await expect(apiFetchMyStaffRecord(T)).rejects.toMatchObject({ code: "internal_error" });
  });
});

describe("staffMayReadItems", () => {
  it("is true only for the Inventory area, the one that gives resource.inventory.read", () => {
    expect(staffMayReadItems([])).toBe(false);
    expect(staffMayReadItems(["visitors"])).toBe(false);
    expect(staffMayReadItems(["leave", "fees", "medical"])).toBe(false);
    expect(staffMayReadItems(["inventory"])).toBe(true);
    expect(staffMayReadItems(["leave", "inventory"])).toBe(true);
  });
});

describe("staffMayKeepVisitors", () => {
  it("is true only for the Visitors area, the one that gives resource.visitor.read and .write", () => {
    expect(staffMayKeepVisitors([])).toBe(false);
    expect(staffMayKeepVisitors(["inventory"])).toBe(false);
    expect(staffMayKeepVisitors(["leave", "fees", "medical"])).toBe(false);
    expect(staffMayKeepVisitors(["visitors"])).toBe(true);
    expect(staffMayKeepVisitors(["medical", "visitors"])).toBe(true);
  });
});
