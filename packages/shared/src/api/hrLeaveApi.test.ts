import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { EdgeError } from "../edge";
import { decideApproval, fetchApprovals, fetchHrLeaveAccess } from "../hrLeave";
import { BASE, createFakeApi, type FakeApi, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";
const P = `/v1/tenants/${T}/me/hr/leave`;
const refused = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });
let api: FakeApi;
function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: U }));
  setApiActiveTenant(T);
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resetApiClient(); initBackend({ kind: "supabase" }); });

describe("HR leave approvals on the API build", () => {
  it("reads the caller's access in the active school's path", async () => {
    boot({ [`GET ${P}/access`]: { body: { status: "available", approver: true } } });
    expect(await fetchHrLeaveAccess()).toEqual({ status: "available", approver: true });
    expect(api.calls[0]).toMatchObject({ url: `${P}/access`, headers: { "authorization": "Bearer tok", "x-tenant-id": T } });
  });

  it("reads approvals and keeps the connect-once code as an EdgeError", async () => {
    boot({ [`GET ${P}/approvals`]: { body: { approvals: [] } } });
    expect(await fetchApprovals()).toEqual({ approvals: [] });
    boot({ [`GET ${P}/approvals`]: refused(409, "approver_not_linked", "Open HR & Payroll once.") });
    await expect(fetchApprovals()).rejects.toMatchObject({ status: 409, code: "approver_not_linked", message: "Open HR & Payroll once." });
  });

  it("posts only the approved decision and a trimmed comment", async () => {
    boot({ [`POST ${P}/approvals/app_1/decide`]: { body: { request_status: "approved", application: { id: "app_1" } } } });
    await decideApproval("app_1", "approve", "  Looks good  ");
    expect(api.calls[0]).toMatchObject({ method: "POST", url: `${P}/approvals/app_1/decide`, body: { decision: "approve", comment: "Looks good" }, headers: { "x-tenant-id": T } });
    boot({ [`POST ${P}/approvals/app_1/decide`]: refused(409, "already_decided", "Already decided.") });
    const err = await decideApproval("app_1", "approve", "").then(() => null, (e: unknown) => e as EdgeError);
    expect(err).toBeInstanceOf(EdgeError);
    expect(err).toMatchObject({ status: 409, code: "already_decided" });
    expect(api.calls[0]!.body).toEqual({ decision: "approve" });
  });

  it("keeps the Supabase path off the API client", async () => {
    boot({});
    initBackend({ kind: "supabase" });
    await expect(fetchHrLeaveAccess()).rejects.toThrow();
    expect(api.calls).toEqual([]);
  });
});
