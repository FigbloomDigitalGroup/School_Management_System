import { describe, expect, it, vi } from "vitest";
import { createTestClient } from "../testing/fakeApi";
import { createApiClient, fillPath, queryString } from "./client";
import { ApiError, isApiError } from "./errors";
import { createMemoryTokenStore } from "./tokenStore";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try { await p; } catch (e) { if (isApiError(e)) return e; throw e; }
  throw new Error("expected the call to fail");
}

describe("fillPath and queryString", () => {
  it("fills and encodes path parameters", () => {
    expect(fillPath("/v1/tenants/{tenantId}/learners/{id}", { tenantId: "a b", id: "x/y" })).toBe("/v1/tenants/a%20b/learners/x%2Fy");
  });
  it("refuses a hole in the path", () => {
    expect(() => fillPath("/v1/tenants/{tenantId}", {})).toThrow(/tenantId/);
    expect(() => fillPath("/v1/tenants/{tenantId}", { tenantId: "" })).toThrow(/tenantId/);
  });
  it("leaves out undefined and null query values and repeats arrays", () => {
    expect(queryString({ limit: 200, cursor: undefined, q: null, s: ["a", "b"] })).toBe("?limit=200&s=a&s=b");
    expect(queryString({})).toBe("");
    expect(queryString(undefined)).toBe("");
  });
});

describe("what every call sends", () => {
  it("sends the bearer token, a request id, and the active school", async () => {
    const { client, api } = createTestClient({ "GET /v1/auth/me": { body: { ok: true } } });
    client.setActiveTenant(TENANT);
    await client.get("/v1/auth/me", {});
    const [call] = api.calls;
    expect(call?.headers.authorization).toBe("Bearer tok-1");
    expect(call?.headers["x-request-id"]).toBe("req-test-0001");
    expect(call?.headers["x-tenant-id"]).toBe(TENANT);
    expect(call?.headers.accept).toBe("application/json");
    expect(call?.headers["content-type"]).toBeUndefined();
  });

  it("lets one call name another school, or none", async () => {
    const { client, api } = createTestClient({ "GET /v1/auth/me": { body: {} } });
    client.setActiveTenant(TENANT);
    await client.get("/v1/auth/me", { tenantId: OTHER });
    await client.get("/v1/auth/me", { tenantId: null });
    expect(api.calls[0]?.headers["x-tenant-id"]).toBe(OTHER);
    expect(api.calls[1]?.headers["x-tenant-id"]).toBeUndefined();
  });

  it("sends a JSON body with its content type, and an idempotency key when given", async () => {
    const { client, api } = createTestClient({ "POST /v1/auth/reauth": { body: { ok: true, valid_for_seconds: 300 } } });
    await client.post("/v1/auth/reauth", { body: { password: "pw" }, idempotencyKey: "key-12345678" });
    const call = api.calls[0]!;
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers["idempotency-key"]).toBe("key-12345678");
    expect(call.body).toEqual({ password: "pw" });
  });

  it("puts path parameters and the query in the address", async () => {
    const { client, api } = createTestClient({ [`GET /v1/tenants/${TENANT}/school-profile`]: { body: {} } });
    await client.get("/v1/tenants/{tenantId}/school-profile", { path: { tenantId: TENANT } });
    expect(api.calls[0]?.url).toBe(`/v1/tenants/${TENANT}/school-profile`);
    const { client: c2, api: a2 } = createTestClient({ "GET /v1/rbac/permissions": { body: {} } });
    await c2.get("/v1/rbac/permissions", { query: { limit: 200, cursor: "abc" } });
    expect(a2.calls[0]?.url).toBe("/v1/rbac/permissions?limit=200&cursor=abc");
  });

  it("makes no request, and says 401, when nobody is signed in", async () => {
    const { client, api } = createTestClient({}, { session: null });
    const err = await failure(client.get("/v1/auth/me", {}));
    expect(err.code).toBe("unauthorized");
    expect(api.calls).toHaveLength(0);
  });

  it("sends no token and no school on a call made before sign-in", async () => {
    const { client, api } = createTestClient({ "POST /v1/auth/login/email": { body: {} } }, { session: null });
    client.setActiveTenant(TENANT);
    await client.post("/v1/auth/login/email", { body: { email: "a@b.co", password: "x" }, auth: false });
    expect(api.calls[0]?.headers.authorization).toBeUndefined();
    expect(api.calls[0]?.headers["x-tenant-id"]).toBeUndefined();
  });
});

describe("answers", () => {
  it("returns the parsed body, and undefined for an empty one", async () => {
    const { client } = createTestClient({ "GET /v1/auth/me": { body: { a: 1 } }, "POST /v1/auth/logout": { status: 204 } });
    expect(await client.get("/v1/auth/me", {})).toEqual({ a: 1 });
    expect(await client.post("/v1/auth/logout", {})).toBeUndefined();
  });

  it("turns an error body into an ApiError with the server's code, message, id and details", async () => {
    const { client } = createTestClient({
      "POST /v1/auth/reauth": {
        status: 400,
        body: { error: { code: "validation_error", message: "Bad input", request_id: "srv-req-1", details: [{ field: "password", code: "too_short", message: "Too short" }] } },
      },
    });
    const err = await failure(client.post("/v1/auth/reauth", { body: { password: "" } }));
    expect(err).toMatchObject({ status: 400, code: "validation_error", message: "Bad input", requestId: "srv-req-1" });
    expect(err.details).toEqual([{ field: "password", code: "too_short", message: "Too short" }]);
  });

  it("reads Retry-After on a 429", async () => {
    const { client } = createTestClient({ "GET /v1/auth/me": { status: 429, headers: { "retry-after": "17" }, body: { error: { code: "rate_limited", message: "slow" } } } });
    const err = await failure(client.get("/v1/auth/me", {}));
    expect(err.code).toBe("rate_limited");
    expect(err.retryAfterSeconds).toBe(17);
  });

  it("copes with a body that is not JSON (a proxy's page)", async () => {
    const fetchHtml = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as typeof fetch;
    const client = createApiClient({ baseUrl: "https://api.test", store: createMemoryTokenStore({ token: "t", expiresAt: "2099-01-01T00:00:00Z" }), fetch: fetchHtml });
    const err = await failure(client.get("/v1/auth/me", {}));
    expect(err).toMatchObject({ status: 502, code: "internal_error" });
  });

  it("reports a network failure as network_error", async () => {
    const { client } = createTestClient({ "GET /v1/auth/me": { networkError: true } });
    expect((await failure(client.get("/v1/auth/me", {}))).code).toBe("network_error");
  });

  it("gives up after the time limit", async () => {
    const { client } = createTestClient({ "GET /v1/auth/me": { hang: true } });
    const err = await failure(client.get("/v1/auth/me", { timeoutMs: 20 }));
    expect(err.code).toBe("timeout");
  });

  it("stops when the caller aborts", async () => {
    const { client } = createTestClient({ "GET /v1/auth/me": { hang: true } });
    const ctl = new AbortController();
    const p = failure(client.get("/v1/auth/me", { signal: ctl.signal }));
    ctl.abort();
    expect((await p).code).toBe("aborted");
  });
});

describe("a 401", () => {
  const unauthorized = { status: 401, body: { error: { code: "unauthorized", message: "no" } } };

  it("ends the session and tells the app", async () => {
    const { client, store } = createTestClient({ "GET /v1/auth/me": unauthorized });
    const onSignedOut = vi.fn();
    client.setAuthHandlers({ onSignedOut });
    await failure(client.get("/v1/auth/me", {}));
    expect(store.get()).toBeNull();
    expect(onSignedOut).toHaveBeenCalledWith("unauthorized");
  });

  it("keeps the session where it only means a wrong password or code", async () => {
    const { client, store } = createTestClient({ "POST /v1/auth/reauth": unauthorized });
    const onSignedOut = vi.fn();
    client.setAuthHandlers({ onSignedOut });
    await failure(client.post("/v1/auth/reauth", { body: { password: "x" }, keepSessionOn401: true }));
    expect(store.get()).not.toBeNull();
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("does not end a session that another tab has since replaced", async () => {
    const { client, store } = createTestClient({
      "GET /v1/auth/me": () => { store.set({ token: "tok-2", expiresAt: "2099-01-01T00:00:00Z" }); return unauthorized; },
    });
    await failure(client.get("/v1/auth/me", {}));
    expect(store.get()?.token).toBe("tok-2");
  });

  it("is not session loss on a call made without a session (a wrong sign-in password)", async () => {
    const { client } = createTestClient({ "POST /v1/auth/login/email": unauthorized }, { session: null });
    const onSignedOut = vi.fn();
    client.setAuthHandlers({ onSignedOut });
    const err = await failure(client.post("/v1/auth/login/email", { body: { email: "a@b.co", password: "x" }, auth: false }));
    expect(err.code).toBe("unauthorized");
    expect(onSignedOut).not.toHaveBeenCalled();
  });
});

describe("a token past its own expiry", () => {
  it("is cleared without a request, and tells the app", async () => {
    const { client, api, store } = createTestClient({}, { session: { token: "old", expiresAt: "2020-01-01T00:00:00Z" } });
    const onSignedOut = vi.fn();
    client.setAuthHandlers({ onSignedOut });
    const err = await failure(client.get("/v1/auth/me", {}));
    expect(err.code).toBe("unauthorized");
    expect(api.calls).toHaveLength(0);
    expect(store.get()).toBeNull();
    expect(onSignedOut).toHaveBeenCalledWith("expired");
  });
});

describe("reauth_required and mfa_required", () => {
  const reauth = { status: 403, body: { error: { code: "reauth_required", message: "Confirm your password to continue" } } };

  it("asks the app once, and retries once when it says yes", async () => {
    let n = 0;
    const { client, api } = createTestClient({ "POST /v1/auth/mfa/disable": () => (++n === 1 ? reauth : { body: { disabled: true } }) });
    const onReauthRequired = vi.fn().mockResolvedValue(true);
    client.setAuthHandlers({ onReauthRequired });
    expect(await client.post("/v1/auth/mfa/disable", { body: { code: "123456" } })).toEqual({ disabled: true });
    expect(onReauthRequired).toHaveBeenCalledTimes(1);
    expect(api.callsTo("POST /v1/auth/mfa/disable")).toHaveLength(2);
  });

  it("throws the original error when the app says no, or has no handler", async () => {
    const { client, api } = createTestClient({ "POST /v1/auth/mfa/disable": reauth });
    expect((await failure(client.post("/v1/auth/mfa/disable", { body: { code: "123456" } }))).code).toBe("reauth_required");
    client.setAuthHandlers({ onReauthRequired: async () => false });
    expect((await failure(client.post("/v1/auth/mfa/disable", { body: { code: "123456" } }))).code).toBe("reauth_required");
    expect(api.calls).toHaveLength(2);
  });

  it("does not retry twice when the retry is refused again", async () => {
    const { client, api } = createTestClient({ "POST /v1/auth/mfa/disable": reauth });
    client.setAuthHandlers({ onReauthRequired: async () => true });
    expect((await failure(client.post("/v1/auth/mfa/disable", { body: { code: "123456" } }))).code).toBe("reauth_required");
    expect(api.calls).toHaveLength(2);
  });

  it("opens one prompt for calls refused together", async () => {
    let ok = false;
    const { client } = createTestClient({ "GET /v1/auth/me": () => (ok ? { body: { a: 1 } } : reauth) });
    let release: (v: boolean) => void = () => {};
    const onReauthRequired = vi.fn(() => new Promise<boolean>((r) => { release = (v) => { ok = v; r(v); }; }));
    client.setAuthHandlers({ onReauthRequired });
    const both = Promise.all([client.get("/v1/auth/me", {}), client.get("/v1/auth/me", {})]);
    await new Promise((r) => setTimeout(r, 10));
    release(true);
    expect(await both).toEqual([{ a: 1 }, { a: 1 }]);
    expect(onReauthRequired).toHaveBeenCalledTimes(1);
  });

  it("hands mfa_required to its own handler", async () => {
    let n = 0;
    const { client } = createTestClient({
      "GET /v1/auth/me": () => (++n === 1 ? { status: 403, body: { error: { code: "mfa_required", message: "challenge" } } } : { body: { a: 1 } }),
    });
    const onMfaRequired = vi.fn().mockResolvedValue(true);
    client.setAuthHandlers({ onMfaRequired });
    expect(await client.get("/v1/auth/me", {})).toEqual({ a: 1 });
    expect(onMfaRequired.mock.calls[0]?.[0]).toMatchObject({ code: "mfa_required" });
  });
});
