import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { BASE, createFakeApi, type FakeApi, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiTokenStore } from "./client";
import { apiLoginWithSchool, apiLookupSchool, parseSchoolLookup, schoolFromInput, SchoolNotFoundError } from "./schoolLookupApi";
import { createMemoryTokenStore, type TokenStore } from "./tokenStore";

const T = "9f4659ad-93e8-4599-b636-bda735b85149";
const lookup = (slug: string) => `GET /v1/public/schools/${slug}`;
const login = { token: "tok-1", expiresAt: "2099-01-01T00:00:00.000Z", user: { id: "u1", full_name: "Amina", email: null, must_change_password: true, platform_role: null }, activeTenantId: T };

let api: FakeApi;
let store: TokenStore;
function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  store = createMemoryTokenStore(null);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(store);
}
afterEach(() => { vi.unstubAllGlobals(); resetApiClient(); initBackend({ kind: "supabase" }); });

describe("what a person types for the school", () => {
  it("takes the plain address in any case, with stray spaces", () => {
    expect(schoolFromInput("alliance")).toEqual({ slug: "alliance" });
    expect(schoolFromInput("  Alliance-High ")).toEqual({ slug: "alliance-high" });
  });
  it("takes a pasted address of the school's pages", () => {
    expect(schoolFromInput("https://app.example.org/s/Alliance/student")).toEqual({ slug: "alliance" });
    expect(schoolFromInput("/s/alliance")).toEqual({ slug: "alliance" });
    expect(schoolFromInput("app.example.org/s/alliance?x=1")).toEqual({ slug: "alliance" });
  });
  it("takes the school's UUID as it is", () => {
    expect(schoolFromInput(T.toUpperCase())).toEqual({ tenantId: T });
  });
  it("refuses what cannot be an address, without asking the server", () => {
    for (const bad of ["", "  ", "ab", "has space", "under_score", "a".repeat(41), "x/y", "https://example.org/"]) expect(schoolFromInput(bad)).toBeNull();
  });
});

describe("the school lookup", () => {
  it("asks for the exact address with no session and no school, and reads the school's id and name", async () => {
    boot({ [lookup("alliance")]: { body: { tenant_id: T, name: "Alliance High School" } } });
    expect(await apiLookupSchool("Alliance")).toEqual({ tenantId: T, name: "Alliance High School" });
    const call = api.callsTo(lookup("alliance"))[0]!;
    expect(call.headers.authorization).toBeUndefined();
    expect(call.headers["x-tenant-id"]).toBeUndefined();
  });

  it("does not ask for a UUID", async () => {
    boot({});
    expect(await apiLookupSchool(T)).toEqual({ tenantId: T, name: null });
    expect(api.calls).toHaveLength(0);
  });

  it("says one thing for an unknown school, a refused address and one the server answers 404 for", async () => {
    boot({ [lookup("nowhere")]: { status: 404, body: { error: { code: "not_found", message: "Not found" } } } });
    await expect(apiLookupSchool("nowhere")).rejects.toBeInstanceOf(SchoolNotFoundError);
    await expect(apiLookupSchool("no way")).rejects.toBeInstanceOf(SchoolNotFoundError);
    expect(api.calls).toHaveLength(1);
  });

  it("passes on throttling and outages, and never makes up a school from an answer it does not understand", async () => {
    boot({ [lookup("alliance")]: { status: 429, body: { error: { code: "rate_limited", message: "Slow down" } }, headers: { "retry-after": "30" } } });
    await expect(apiLookupSchool("alliance")).rejects.toMatchObject({ code: "rate_limited" });
    expect(() => parseSchoolLookup({ name: "No id" })).toThrow(/not understood/);
    expect(() => parseSchoolLookup({ tenant_id: "not-a-uuid" })).toThrow(/not understood/);
    expect(() => parseSchoolLookup(null)).toThrow(/not understood/);
    expect(parseSchoolLookup({ tenant_id: T })).toEqual({ tenantId: T, name: null });
  });
});

describe("signing in with a school address and a login ID", () => {
  it("finds the school, then signs in with its UUID, and keeps the session", async () => {
    boot({
      [lookup("alliance")]: { body: { tenant_id: T, name: "Alliance High School" } },
      "POST /v1/auth/login/login-id": { body: login },
    });
    const res = await apiLoginWithSchool("alliance", " ST-0001 ", "One-time-pass1");
    expect(res.user.must_change_password).toBe(true);
    expect(api.callsTo("POST /v1/auth/login/login-id")[0]!.body).toEqual({ tenantId: T, loginId: "ST-0001", password: "One-time-pass1" });
    expect(store.get()).toMatchObject({ token: "tok-1", userId: "u1" });
  });

  it("never sends the password when the school is not found, and keeps no session", async () => {
    boot({ [lookup("nowhere")]: { status: 404, body: { error: { code: "not_found", message: "x" } } } });
    await expect(apiLoginWithSchool("nowhere", "ST-0001", "pw")).rejects.toBeInstanceOf(SchoolNotFoundError);
    expect(api.callsTo("POST /v1/auth/login/login-id")).toHaveLength(0);
    expect(store.get()).toBeNull();
  });

  it("is the server's usual 401 for a wrong login ID or password, with no session kept", async () => {
    boot({
      [lookup("alliance")]: { body: { tenant_id: T, name: "Alliance" } },
      "POST /v1/auth/login/login-id": { status: 401, body: { error: { code: "unauthorized", message: "Invalid credentials" } } },
    });
    await expect(apiLoginWithSchool("alliance", "ST-0001", "wrong")).rejects.toMatchObject({ code: "unauthorized" });
    expect(store.get()).toBeNull();
  });
});
