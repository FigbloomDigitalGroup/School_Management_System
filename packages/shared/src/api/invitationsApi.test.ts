import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { BASE, createFakeApi, type FakeApi, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import {
  acceptInviteLink, apiInviteGuardian, apiInviteStaff, apiIssueMemberReset, apiListGuardianInvitations, apiRevokeGuardianInvitation,
  apiRevokeStaffInvitation, guardianInviteMethod, resetPasswordLink,
} from "./invitationsApi";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const G = "22222222-2222-4222-8222-222222222222";
const L = "33333333-3333-4333-8333-333333333333";
const INV = "44444444-4444-4444-8444-444444444444";
const U = "55555555-5555-4555-8555-555555555555";
const P = `/v1/tenants/${T}`;
const refused = (status: number, code: string, message = "no") => ({ status, body: { error: { code, message } } });

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

describe("inviting a member of staff", () => {
  it("sends the address, role and name, and answers when it expires and how it was delivered", async () => {
    boot({ [`POST ${P}/invitations`]: { status: 201, body: { invitation: { id: INV, role: "teacher", expires_at: "2026-11-27T10:00:00Z", delivery: "sent" } } } });
    const r = await apiInviteStaff({ tenantId: T, email: "  amina@school.test ", role: "teacher", fullName: " Amina Noor " });
    expect(r).toEqual({ id: INV, expiresAt: "2026-11-27T10:00:00Z", delivery: "sent", token: null });
    expect(api.callsTo(`POST ${P}/invitations`)[0]!.body).toEqual({ email: "amina@school.test", role: "teacher", full_name: "Amina Noor" });
  });

  it("leaves the name out when there is none, and hands back the one-time token when the e-mail was not sent", async () => {
    boot({ [`POST ${P}/invitations`]: { status: 201, body: { invitation: { id: INV, role: "staff", expires_at: "2026-11-27T10:00:00Z", delivery: "not_configured", token: "tok-once" } } } });
    const r = await apiInviteStaff({ tenantId: T, email: "x@school.test", role: "staff", fullName: "   " });
    expect(api.callsTo(`POST ${P}/invitations`)[0]!.body).toEqual({ email: "x@school.test", role: "staff" });
    expect(r).toMatchObject({ delivery: "not_configured", token: "tok-once" });
  });

  it("passes on a person who already belongs to the school (409) and a missing permission (403)", async () => {
    boot({ [`POST ${P}/invitations`]: refused(409, "conflict", "This person already belongs to the school") });
    await expect(apiInviteStaff({ tenantId: T, email: "a@b.co", role: "teacher" })).rejects.toMatchObject({ code: "conflict", message: "This person already belongs to the school" });
    api.on(`POST ${P}/invitations`, refused(403, "forbidden"));
    await expect(apiInviteStaff({ tenantId: T, email: "a@b.co", role: "teacher" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("revokes an open invitation by its id", async () => {
    boot({ [`POST ${P}/invitations/${INV}/revoke`]: { body: { revoked: true } } });
    await apiRevokeStaffInvitation(T, INV);
    expect(api.callsTo(`POST ${P}/invitations/${INV}/revoke`)).toHaveLength(1);
  });
});

describe("inviting a guardian", () => {
  it("picks e-mail first, then the phone, and says so when the record has neither", () => {
    expect(guardianInviteMethod({ email: "r@x.co", phone: "0712" })).toBe("email");
    expect(guardianInviteMethod({ email: " ", phone: "0712 345 678" })).toBe("sms");
    expect(guardianInviteMethod({ email: null, phone: null })).toBeNull();
  });

  it("invites one guardian for one learner and answers the delivery", async () => {
    boot({ [`POST ${P}/guardians/${G}/invitations`]: { status: 201, body: { invitation: { id: INV, method: "email", expires_at: "2026-11-27T10:00:00Z", delivery: "not_configured", token: "code-once" } } } });
    const r = await apiInviteGuardian({ tenantId: T, guardianId: G, learnerId: L, method: "email" });
    expect(r).toEqual({ id: INV, method: "email", expiresAt: "2026-11-27T10:00:00Z", delivery: "not_configured", token: "code-once" });
    expect(api.callsTo(`POST ${P}/guardians/${G}/invitations`)[0]!.body).toEqual({ learner_id: L, method: "email" });
  });

  it("is refused for a guardian who already has a login (409)", async () => {
    boot({ [`POST ${P}/guardians/${G}/invitations`]: refused(409, "conflict", "Guardian already has a live login") });
    await expect(apiInviteGuardian({ tenantId: T, guardianId: G, learnerId: L, method: "sms" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("lists the open invitations, with the contact the server masked, asking for no more than 200", async () => {
    boot({
      [`GET ${P}/guardian-invitations`]: {
        body: {
          invitations: [{
            id: INV, guardian_id: G, learner_id: L, contact_method: "email", contact_hint: "r***@gmail.com", status: "pending", delivery_status: "sent",
            created_at: "2026-11-24T10:00:00Z", expires_at: "2026-11-27T10:00:00Z", accepted_at: null,
          }],
        },
      },
    });
    expect(await apiListGuardianInvitations(T, "pending")).toEqual([{
      id: INV, guardianId: G, learnerId: L, method: "email", contactHint: "r***@gmail.com", status: "pending", deliveryStatus: "sent",
      createdAt: "2026-11-24T10:00:00Z", expiresAt: "2026-11-27T10:00:00Z", acceptedAt: null,
    }]);
    const q = api.callsTo(`GET ${P}/guardian-invitations`)[0]!.query;
    expect(q.get("status")).toBe("pending");
    expect(q.get("limit")).toBe("200");
    await apiListGuardianInvitations(T);
    expect(api.callsTo(`GET ${P}/guardian-invitations`)[1]!.query.has("status")).toBe(false);
  });

  it("revokes an open guardian invitation", async () => {
    boot({ [`POST ${P}/guardian-invitations/${INV}/revoke`]: { body: { revoked: true } } });
    await apiRevokeGuardianInvitation(T, INV);
    expect(api.callsTo(`POST ${P}/guardian-invitations/${INV}/revoke`)).toHaveLength(1);
  });
});

describe("a password reset for a member", () => {
  it("issues a one-time token for the person's sign-in", async () => {
    boot({ [`POST ${P}/members/${U}/password-reset`]: { status: 201, body: { reset: { expires_at: "2026-11-24T11:00:00Z", delivery: "not_configured", token: "reset-once" } } } });
    expect(await apiIssueMemberReset(T, U)).toEqual({ expiresAt: "2026-11-24T11:00:00Z", token: "reset-once" });
  });

  it("is refused without a recent password confirmation unless the app asks for it, and then retried", async () => {
    let first = true;
    boot({
      [`POST ${P}/members/${U}/password-reset`]: () => {
        if (first) { first = false; return refused(403, "reauth_required", "Confirm your password to continue"); }
        return { status: 201, body: { reset: { expires_at: "2026-11-24T11:00:00Z", delivery: "not_configured", token: "reset-2" } } };
      },
    });
    const { setApiAuthHandlers } = await import("./client");
    setApiAuthHandlers({ onReauthRequired: async () => true });
    expect((await apiIssueMemberReset(T, U)).token).toBe("reset-2");
    expect(api.callsTo(`POST ${P}/members/${U}/password-reset`)).toHaveLength(2);
  });
});

describe("the links an e-mail would carry", () => {
  it("are the web's own addresses with the token in the query, encoded, whatever the origin's trailing slash", () => {
    expect(acceptInviteLink("https://app.test/", "a b+c")).toBe("https://app.test/accept-invite?token=a%20b%2Bc");
    expect(resetPasswordLink("http://localhost:5214", "t1")).toBe("http://localhost:5214/reset-password?token=t1");
  });
});
