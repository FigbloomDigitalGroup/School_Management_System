import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { accountCapabilities, isNotOnApiError } from "../capabilities";
import { DEFAULT_NOTIFICATION_PREFERENCES, fetchMyNotificationPreferences, notificationTopicsFor, setMyNotificationPreference } from "../notificationPreferences";
import { fetchMyProfile, setMyPassword, updateMyAvatarUrl, updateMyProfile } from "../profile";
import { BASE, createFakeApi, type FakeApi, type FakeRoute } from "../testing/fakeApi";
import { apiMfaDisable, apiMfaRegenerateRecoveryCodes, apiPasswordProblem } from "./authApi";
import { resetApiClient, setApiActiveTenant, setApiAuthHandlers, setApiTokenStore } from "./client";
import { apiFetchNotificationPreferences, apiSetNotificationPreferences } from "./accountApi";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const U = "33333333-3333-4333-8333-333333333333";

const me = {
  user: { id: U, full_name: "David Kamau", email: "teacher@alliance.sc.ke", must_change_password: false, platform_role: null },
  session: { id: "s", activeTenantId: T },
  memberships: [
    { tenantId: T2, role: "teacher", loginId: "TC-0009", tenantStatus: "active" },
    { tenantId: T, role: "teacher", loginId: "TC-0001", tenantStatus: "active" },
  ],
  membershipsComplete: true,
  authz: { role: "teacher", tenantId: T, isSuperAdmin: false },
};

const prefs = { fee_reminders: true, absence_today: false, results_published: true, general_notices: true, chat_messages: false, updated_at: null };

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

describe("account capabilities", () => {
  it("offers the editable profile, photo and calls on Supabase; the password, two-step and real choices only on the API", () => {
    initBackend({ kind: "supabase" });
    expect(accountCapabilities()).toEqual({ editProfile: true, photo: true, calls: true, security: false, notificationChoices: false });
    initBackend({ kind: "api", apiUrl: BASE });
    expect(accountCapabilities()).toEqual({ editProfile: false, photo: false, calls: false, security: true, notificationChoices: true });
  });
});

describe("the profile on the API", () => {
  it("reads who is signed in from /auth/me, with the sign-in ID of the school being used, and invents no phone or photo", async () => {
    boot({ "GET /v1/auth/me": { body: me } });
    expect(await fetchMyProfile(U)).toEqual({
      full_name: "David Kamau", phone: null, alt_phone: null, avatar_url: null, login_id: "TC-0001", email: "teacher@alliance.sc.ke",
    });
    // /auth/me is an identity call: no school header
    expect(api.callsTo("GET /v1/auth/me")[0]!.headers["x-tenant-id"]).toBeUndefined();
  });

  it("falls back to the first membership when no school is open, and to no sign-in ID for a person with none", async () => {
    boot({ "GET /v1/auth/me": { body: { ...me, memberships: [{ tenantId: T2, role: "teacher", loginId: "TC-0009", tenantStatus: "active" }] } } });
    setApiActiveTenant(null);
    expect((await fetchMyProfile(U)).login_id).toBe("TC-0009");
    boot({ "GET /v1/auth/me": { body: { ...me, memberships: [] } } });
    expect((await fetchMyProfile(U)).login_id).toBeNull();
  });

  it("refuses the changes the API has no endpoint for, loudly, and makes no call", async () => {
    boot({});
    for (const run of [
      () => updateMyProfile(U, { full_name: "New Name", phone: null }),
      () => setMyPassword(U, "a-new-password-1"),
      () => updateMyAvatarUrl(U, "https://x.test/a.png"),
    ]) {
      await expect(run()).rejects.toSatisfy(isNotOnApiError);
    }
    expect(api.calls).toHaveLength(0);
  });
});

describe("notification choices on the API", () => {
  it("reads the server's choices into the app's names", async () => {
    boot({ "GET /v1/me/notification-preferences": { body: { preferences: prefs } } });
    expect(await fetchMyNotificationPreferences(U)).toEqual({
      feeReminders: true, absenceToday: false, resultsPublished: true, generalNotices: true, chatMessages: false,
    });
    expect(api.callsTo("GET /v1/me/notification-preferences")[0]!.headers["x-tenant-id"]).toBeUndefined();
  });

  it("sends only the switch that changed, under the server's names", async () => {
    boot({ "PATCH /v1/me/notification-preferences": { body: { preferences: { ...prefs, chat_messages: true } } } });
    await setMyNotificationPreference(U, { chatMessages: true });
    expect(api.callsTo("PATCH /v1/me/notification-preferences")[0]!.body).toEqual({ chat_messages: true });
    const saved = await apiSetNotificationPreferences({ generalNotices: false, feeReminders: undefined });
    expect(api.callsTo("PATCH /v1/me/notification-preferences")[1]!.body).toEqual({ general_notices: false });
    expect(saved.chatMessages).toBe(true);
  });

  it("surfaces a refusal instead of pretending it saved", async () => {
    boot({ "PATCH /v1/me/notification-preferences": { status: 400, body: { error: { code: "validation_error", message: "at least one preference field is required" } } } });
    await expect(apiSetNotificationPreferences({})).rejects.toMatchObject({ code: "validation_error" });
  });

  it("offers a family all five choices and everyone else notices and chat; the defaults are unchanged", () => {
    expect(notificationTopicsFor("parent").map((t) => t.key)).toEqual(["feeReminders", "absenceToday", "resultsPublished", "generalNotices", "chatMessages"]);
    for (const role of ["teacher", "school_admin", "staff"] as const) {
      expect(notificationTopicsFor(role).map((t) => t.key)).toEqual(["generalNotices", "chatMessages"]);
    }
    expect(DEFAULT_NOTIFICATION_PREFERENCES.generalNotices).toBe(false);
    boot({ "GET /v1/me/notification-preferences": { body: { preferences: prefs } } });
    return expect(apiFetchNotificationPreferences()).resolves.toMatchObject({ absenceToday: false });
  });
});

describe("the password rule", () => {
  it("is the server's: 10 or more characters with letters and numbers", () => {
    expect(apiPasswordProblem("short1")).toMatch(/at least 10/);
    expect(apiPasswordProblem("123456789012")).toMatch(/letters and numbers/);
    expect(apiPasswordProblem("abcdefghijkl")).toMatch(/letters and numbers/);
    expect(apiPasswordProblem("abcdefghi1")).toBeNull();
    expect(apiPasswordProblem("abcdefgh1")).toMatch(/at least 10/);
  });
});

describe("two-step verification calls", () => {
  it("turns off with the code, keeping the session when the code is wrong", async () => {
    boot({ "POST /v1/auth/mfa/disable": { status: 401, body: { error: { code: "unauthorized", message: "Invalid MFA code" } } } });
    await expect(apiMfaDisable("123456")).rejects.toMatchObject({ code: "unauthorized" });
    expect(api.callsTo("POST /v1/auth/mfa/disable")[0]!.body).toEqual({ code: "123456" });
    api.on("POST /v1/auth/mfa/disable", { body: { disabled: true } });
    await apiMfaDisable("654321");
  });

  it("asks for the password again when the server says so, and retries the same call once it is confirmed", async () => {
    let first = true;
    boot({
      "POST /v1/auth/mfa/recovery-codes/regenerate": () => {
        if (first) { first = false; return { status: 403, body: { error: { code: "reauth_required", message: "Confirm your password to continue" } } }; }
        return { body: { recoveryCodes: ["aaaa-bbbb", "cccc-dddd"] } };
      },
    });
    const onReauthRequired = vi.fn(async () => true);
    setApiAuthHandlers({ onReauthRequired });
    await expect(apiMfaRegenerateRecoveryCodes("123456")).resolves.toEqual(["aaaa-bbbb", "cccc-dddd"]);
    expect(onReauthRequired).toHaveBeenCalledTimes(1);
    const calls = api.callsTo("POST /v1/auth/mfa/recovery-codes/regenerate");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toEqual({ code: "123456" });
  });

  it("gives up with the original refusal when the password is not confirmed", async () => {
    boot({ "POST /v1/auth/mfa/recovery-codes/regenerate": { status: 403, body: { error: { code: "reauth_required", message: "Confirm your password to continue" } } } });
    setApiAuthHandlers({ onReauthRequired: async () => false });
    await expect(apiMfaRegenerateRecoveryCodes("123456")).rejects.toMatchObject({ code: "reauth_required" });
    expect(api.callsTo("POST /v1/auth/mfa/recovery-codes/regenerate")).toHaveLength(1);
  });
});
