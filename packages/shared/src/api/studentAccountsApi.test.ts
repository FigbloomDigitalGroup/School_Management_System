import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { BASE, createFakeApi, type FakeApi, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { apiCreateStudentAccount, apiFetchStudentAccountStatuses, STUDENT_ACCOUNT_STATUS_CONCURRENCY } from "./studentAccountsApi";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const L1 = "10000001-1111-4111-8111-111111111111";
const L2 = "10000002-1111-4111-8111-111111111111";
const P = `/v1/tenants/${T}`;

const status = (learnerId: string, loginId: string | null) => ({
  learner_id: learnerId, has_login: loginId !== null, login_id: loginId,
  account_status: loginId ? "active" : null, must_change_password: loginId ? false : null,
  created_at: loginId ? "2026-11-01T08:00:00Z" : null, password_set_at: null, last_sign_in_at: null, revoked_logins: 0,
});
const issued = (learnerId: string) => ({
  learner_id: learnerId, user_id: "20000001-1111-4111-8111-111111111111", login_id: "ST-0001",
  must_change_password: true, one_time_password: "once-only-password",
});
const refused = (code: string, statusCode: number, message: string) => ({ status: statusCode, body: { error: { code, message } } });

let api: FakeApi;

function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: "office" }));
  setApiActiveTenant(T);
  return api;
}

afterEach(() => { vi.unstubAllGlobals(); resetApiClient(); initBackend({ kind: "supabase" }); });

describe("learner login status on the People page", () => {
  it("reads one status per unique learner and returns only the login ids for the current page", async () => {
    boot({
      [`GET ${P}/learners/${L1}/student-account`]: { body: { account: status(L1, "ST-0001") } },
      [`GET ${P}/learners/${L2}/student-account`]: { body: { account: status(L2, null) } },
    });

    const logins = await apiFetchStudentAccountStatuses(T, [L1, L2, L1]);

    expect([...logins]).toEqual([[L1, "ST-0001"], [L2, null]]);
    expect(api.calls).toHaveLength(2);
    expect(api.calls.every((call) => call.method === "GET")).toBe(true);
    expect(STUDENT_ACCOUNT_STATUS_CONCURRENCY).toBe(4);
  });

  it("limits concurrent status reads to four", async () => {
    const ids = [L1, L2, "10000003-1111-4111-8111-111111111111", "10000004-1111-4111-8111-111111111111", "10000005-1111-4111-8111-111111111111", "10000006-1111-4111-8111-111111111111"];
    const routes = Object.fromEntries(ids.map((id) => [`GET ${P}/learners/${id}/student-account`, { body: { account: status(id, null) } }]));
    boot(routes);
    let inFlight = 0;
    let maxInFlight = 0;
    const underlyingFetch = api.fetch;
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try { return await underlyingFetch(input, init); } finally { inFlight -= 1; }
    }) as typeof fetch);

    await apiFetchStudentAccountStatuses(T, ids);

    expect(maxInFlight).toBe(STUDENT_ACCOUNT_STATUS_CONCURRENCY);
    expect(api.calls).toHaveLength(ids.length);
  });
  it("does not issue a read for an empty page", async () => {
    boot({});
    await expect(apiFetchStudentAccountStatuses(T, [])).resolves.toEqual(new Map());
    expect(api.calls).toHaveLength(0);
  });

  it("preserves an authorization refusal instead of treating a hidden status as no login", async () => {
    boot({ [`GET ${P}/learners/${L1}/student-account`]: refused("forbidden", 403, "Insufficient permissions") });
    await expect(apiFetchStudentAccountStatuses(T, [L1])).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });
});

describe("creating a learner login", () => {
  it("returns the login id and one-time password from the create answer", async () => {
    boot({ [`POST ${P}/learners/${L1}/student-account`]: { status: 201, body: { account: issued(L1) } } });

    await expect(apiCreateStudentAccount(T, L1)).resolves.toEqual({ ok: true, login_id: "ST-0001", password: "once-only-password" });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.method).toBe("POST");
    expect(api.calls[0]!.body).toBeUndefined();
  });

  it("does not turn a duplicate account refusal into another credential", async () => {
    boot({ [`POST ${P}/learners/${L1}/student-account`]: refused("conflict", 409, "This learner already has a login") });
    await expect(apiCreateStudentAccount(T, L1)).rejects.toMatchObject({ code: "conflict", status: 409 });
  });
});
