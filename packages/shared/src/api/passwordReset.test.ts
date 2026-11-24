import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { BASE, createFakeApi, type FakeApi, type FakeRoute } from "../testing/fakeApi";
import { apiCompletePasswordReset, apiRequestPasswordReset } from "./authApi";
import { resetApiClient, setApiTokenStore } from "./client";
import { isApiError } from "./errors";
import { createMemoryTokenStore } from "./tokenStore";

let api: FakeApi;
function boot(routes: Record<string, FakeRoute>, signedIn = false) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(createMemoryTokenStore(signedIn ? { token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: "u1" } : null));
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

describe("password reset on the API", () => {
  it("asks for the e-mail with the trimmed address, without a bearer token or tenant", async () => {
    boot({ "POST /v1/auth/password-reset/request": { status: 202, body: { status: "accepted" } } }, true);
    await apiRequestPasswordReset("  someone@school.example ");
    const [call] = api.callsTo("POST /v1/auth/password-reset/request");
    expect(call!.body).toEqual({ email: "someone@school.example" });
    expect(call!.headers.authorization).toBeUndefined();
    expect(call!.headers["x-tenant-id"]).toBeUndefined();
  });

  it("throttling still throws (the page says so instead of claiming an e-mail went out)", async () => {
    boot({ "POST /v1/auth/password-reset/request": { status: 429, body: { error: { code: "rate_limited", message: "slow down" } }, headers: { "retry-after": "5" } } });
    await expect(apiRequestPasswordReset("a@b.co")).rejects.toSatisfy((e) => isApiError(e) && e.status === 429);
  });

  it("completes with the token and the new password, unauthenticated", async () => {
    boot({ "POST /v1/auth/password-reset/complete": { body: { status: "ok" } } });
    await apiCompletePasswordReset({ token: "t".repeat(43), password: "a long new password" });
    const [call] = api.callsTo("POST /v1/auth/password-reset/complete");
    expect(call!.body).toEqual({ token: "t".repeat(43), password: "a long new password" });
    expect(call!.headers.authorization).toBeUndefined();
  });

  it("an invalid or expired token is a 401 ApiError, and a session kept in this browser is not dropped", async () => {
    boot({ "POST /v1/auth/password-reset/complete": { status: 401, body: { error: { code: "unauthorized", message: "Invalid or expired token" } } } }, true);
    await expect(apiCompletePasswordReset({ token: "x".repeat(43), password: "pw-pw-pw-pw" })).rejects.toSatisfy(
      (e) => isApiError(e) && e.code === "unauthorized",
    );
  });
});
