import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { BASE, createFakeApi, type FakeApi, type FakeRoute } from "../testing/fakeApi";
import {
  apiApprovePlatformOrgSignup,
  apiConfirmOrgSignup,
  apiFetchPlatformOrgSignups,
  apiRejectPlatformOrgSignup,
  apiReissuePlatformOrgSetup,
  apiRequestOrgSignup,
  isoToMillis,
  orgSignupAwaitsReview,
  orgSignupFromApi,
} from "./orgSignupApi";
import { resetApiClient, setApiTokenStore } from "./client";
import { isApiError } from "./errors";
import { createMemoryTokenStore } from "./tokenStore";

const U = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";
let api: FakeApi;
function boot(routes: Record<string, FakeRoute>, signedIn = true) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(createMemoryTokenStore(signedIn ? { token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: U } : null));
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resetApiClient(); initBackend({ kind: "supabase" }); });

const raw = (over: Record<string, unknown> = {}) => ({
  id: ID, name: "Kijani Trust", kind: "group_owner", county: null, contactPhone: null, adminFullName: "Wanjiru", adminEmail: "w@example.org",
  status: "pending_review", createdAt: "2026-11-26T10:00:00.000000Z", verifiedAt: "2026-11-26T10:05:00.000000Z", decidedAt: null, decidedByName: null,
  decisionReason: null, organizationId: null, organizationSlug: null, ...over,
});

describe("organisation sign-up: the public calls", () => {
  it("asks for an organisation with no session and no school, sends no password, and leaves out what was not typed", async () => {
    boot({ "POST /v1/signup/organizations": { status: 202, body: { status: "received" } } }, false);
    await apiRequestOrgSignup({ name: "  Kijani Trust ", kind: "county", county: "  ", contactPhone: "", adminFullName: " Wanjiru ", adminEmail: " W@Example.org " });
    const call = api.calls[0]!;
    expect(call).toMatchObject({ method: "POST", path: "/v1/signup/organizations" });
    expect(call.body).toEqual({ name: "Kijani Trust", kind: "county", admin_full_name: "Wanjiru", admin_email: "W@Example.org" });
    expect(call.headers["authorization"]).toBeUndefined();
    expect(call.headers["x-tenant-id"]).toBeUndefined();
  });

  it("sends the optional county and phone when they were typed, even with a session on the device", async () => {
    boot({ "POST /v1/signup/organizations": { status: 202, body: { status: "received" } } });
    await apiRequestOrgSignup({ name: "Kijani Trust", kind: "group_owner", county: " Kiambu ", contactPhone: " 0712 345 678 ", adminFullName: "W", adminEmail: "w@example.org" });
    expect(api.calls[0]!.body).toMatchObject({ county: "Kiambu", contact_phone: "0712 345 678" });
    expect(api.calls[0]!.headers["authorization"]).toBeUndefined();
  });

  it("lets the person's own limits and 'not available' through as errors, with the server's words kept", async () => {
    boot({ "POST /v1/signup/organizations": { status: 503, headers: { "retry-after": "300" }, body: { error: { code: "service_unavailable", message: "Sign-up is not available right now" } } } }, false);
    const err = await apiRequestOrgSignup({ name: "Kijani Trust", kind: "group_owner", adminFullName: "W", adminEmail: "w@example.org" }).then(() => null, (e: unknown) => e);
    expect(isApiError(err) && err.code).toBe("service_unavailable");
    boot({ "POST /v1/signup/organizations": { status: 429, headers: { "retry-after": "30" }, body: { error: { code: "rate_limited", message: "Too many requests" } } } }, false);
    const limited = await apiRequestOrgSignup({ name: "Kijani Trust", kind: "group_owner", adminFullName: "W", adminEmail: "w@example.org" }).then(() => null, (e: unknown) => e);
    expect(isApiError(limited) && limited.code).toBe("rate_limited");
  });

  it("confirms the address with the trimmed token and no session", async () => {
    boot({ "POST /v1/signup/organizations/verify": { body: { status: "confirmed" } } }, false);
    await apiConfirmOrgSignup("  abc-token-abc-token-abc-token  ");
    expect(api.calls[0]!.body).toEqual({ token: "abc-token-abc-token-abc-token" });
    expect(api.calls[0]!.headers["authorization"]).toBeUndefined();
    boot({ "POST /v1/signup/organizations/verify": { status: 400, body: { error: { code: "validation_error", message: "The link is invalid or has expired" } } } }, false);
    const err = await apiConfirmOrgSignup("x".repeat(30)).then(() => null, (e: unknown) => e);
    expect(isApiError(err) && err.status).toBe(400);
  });
});

describe("organisation sign-up: the platform's calls", () => {
  it("lists every page of the requests, optionally of one status, as identity calls", async () => {
    boot({
      "GET /v1/platform/org-signups": (call) =>
        call.query.get("cursor") === "c2"
          ? { body: { items: [raw({ id: "b" })], page: { limit: 200, next_cursor: null } } }
          : { body: { items: [raw({ id: "a" })], page: { limit: 200, next_cursor: "c2" } } },
    });
    const all = await apiFetchPlatformOrgSignups("pending_review");
    expect(all.map((s) => s.id)).toEqual(["a", "b"]);
    expect(api.calls).toHaveLength(2);
    for (const c of api.calls) {
      expect(c.query.get("status")).toBe("pending_review");
      expect(c.headers["x-tenant-id"]).toBeUndefined();
      expect(c.headers["authorization"]).toBe("Bearer tok");
    }
  });

  it("approves with no body unless the reviewer typed an address, and keeps the link only when the server could not send it", async () => {
    boot({
      [`POST /v1/platform/org-signups/${ID}/approve`]: {
        body: { signup: raw({ status: "approved", organizationSlug: "kijani-trust" }), organization: { id: "o1", slug: "kijani-trust" }, setup: { expiresAt: "2026-12-03T10:00:00Z", delivery: "sent" } },
      },
    });
    const sent = await apiApprovePlatformOrgSignup(ID);
    expect(api.calls[0]!.body).toEqual({});
    expect(sent.organization.slug).toBe("kijani-trust");
    expect(sent.setup).toEqual({ expiresAt: "2026-12-03T10:00:00Z", delivery: "sent", token: null });

    boot({
      [`POST /v1/platform/org-signups/${ID}/approve`]: {
        body: { signup: raw({ status: "approved" }), organization: { id: "o1", slug: "typed-one" }, setup: { expiresAt: "2026-12-03T10:00:00Z", delivery: "not_configured", token: "secret-link-token" } },
      },
    });
    const byHand = await apiApprovePlatformOrgSignup(ID, "  typed-one ");
    expect(api.calls[0]!.body).toEqual({ slug: "typed-one" });
    expect(byHand.setup.token).toBe("secret-link-token");
  });

  it("never invents a link: a 'sent' answer that carries a token is ignored", async () => {
    boot({ [`POST /v1/platform/org-signups/${ID}/approve`]: { body: { signup: raw(), organization: { id: "o", slug: "s" }, setup: { expiresAt: "x", delivery: "sent", token: "stray" } } } });
    expect((await apiApprovePlatformOrgSignup(ID)).setup.token).toBeNull();
  });

  it("surfaces the server's words for a conflict (an address that already has an account)", async () => {
    boot({ [`POST /v1/platform/org-signups/${ID}/approve`]: { status: 409, body: { error: { code: "conflict", message: "This e-mail address already has an account, so the request cannot be approved." } } } });
    const err = await apiApprovePlatformOrgSignup(ID).then(() => null, (e: unknown) => e);
    expect(isApiError(err) && err.status).toBe(409);
    expect(isApiError(err) && err.message).toMatch(/already has an account/);
  });

  it("rejects with a trimmed reason or none, and says whether a notice went out", async () => {
    boot({ [`POST /v1/platform/org-signups/${ID}/reject`]: { body: { signup: raw({ status: "rejected", decisionReason: "no" }), notified: true } } });
    const r = await apiRejectPlatformOrgSignup(ID, "  Cannot verify  ");
    expect(api.calls[0]!.body).toEqual({ reason: "Cannot verify" });
    expect(r.notified).toBe(true);
    await apiRejectPlatformOrgSignup(ID);
    expect(api.calls[1]!.body).toEqual({});
  });

  it("re-issues a link with no body", async () => {
    boot({ [`POST /v1/platform/org-signups/${ID}/reissue-setup`]: { body: { setup: { expiresAt: "2026-12-03T10:00:00Z", delivery: "not_configured", token: "again" } } } });
    const s = await apiReissuePlatformOrgSetup(ID);
    expect(api.calls[0]!.body).toBeUndefined();
    expect(s).toEqual({ expiresAt: "2026-12-03T10:00:00Z", delivery: "not_configured", token: "again" });
  });
});

describe("organisation sign-up: reading a request", () => {
  it("cuts the server's microseconds to milliseconds so every browser can read the times", () => {
    const s = orgSignupFromApi(raw({ decidedAt: "2026-11-27T08:30:15.987654Z" }));
    expect(s.createdAt).toBe("2026-11-26T10:00:00.000Z");
    expect(s.verifiedAt).toBe("2026-11-26T10:05:00.000Z");
    expect(s.decidedAt).toBe("2026-11-27T08:30:15.987Z");
    expect(Number.isNaN(Date.parse(s.createdAt))).toBe(false);
    expect(orgSignupFromApi(raw({ verifiedAt: null })).verifiedAt).toBeNull();
    expect(isoToMillis("2026-11-26T10:00:00Z")).toBe("2026-11-26T10:00:00Z");
  });
  it("falls back to a quiet value for a kind or status this build does not know", () => {
    expect(orgSignupFromApi(raw({ kind: "mystery", status: "mystery" }))).toMatchObject({ kind: "group_owner", status: "pending_email" });
  });
  it("is waiting for review only once the address is confirmed and nobody has decided", () => {
    expect(orgSignupAwaitsReview({ status: "pending_review" })).toBe(true);
    for (const status of ["pending_email", "approved", "rejected", "expired"] as const) expect(orgSignupAwaitsReview({ status })).toBe(false);
  });
});
