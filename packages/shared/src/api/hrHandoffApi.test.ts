import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { EdgeError } from "../edge";
import {
  fetchHrHandoffStatus, fetchHrStatus, HR_STATUS_HIDDEN, hrHandoffStatusFrom, hrItemMode, hrLaunchProblem, isHttpsLink, mayOfferHr, requestFigbloomHr,
  requestHrLink, type HrLaunchProblem,
} from "../hrHandoff";
import { BASE, createFakeApi, type FakeApi, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const U = "22222222-2222-4222-8222-222222222222";
const P = `/v1/tenants/${T}/me/hr`;
const LINK = "https://hr.example.org/enter?code=ONE-TIME-CODE-xyz";

const refused = (status: number, code: string, message: string, headers?: Record<string, string>) => ({ status, body: { error: { code, message } }, headers });
const STATUS = (connection: string | null, extra: Record<string, unknown> = {}) =>
  ({ body: { enabled: connection !== null, connection, requested_at: null, can_request_hr: connection === "not_connected", ...extra } });

let api: FakeApi;

/** `active` is the tab's own school: null for the launch tab, which is not inside a school's route. */
function boot(routes: Record<string, FakeRoute>, active: string | null = T) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: U }));
  setApiActiveTenant(active);
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

const failure = <A,>(run: () => Promise<A>) => run().then(() => null, (e: unknown) => e as EdgeError);

describe("fetchHrStatus on the API build", () => {
  it("asks the API in the school's path and header, with no body, and reads the answer as open-hr's", async () => {
    boot({ [`GET ${P}/handoff-status`]: STATUS("setting_up", { requested_at: "2026-11-20T08:30:00.000Z", can_request_hr: true }) });
    expect(await fetchHrStatus(T)).toEqual({ enabled: true, connection: "setting_up", requestedAt: "2026-11-20T08:30:00.000Z", canRequestHr: true });
    expect(api.calls).toHaveLength(1);
    const call = api.calls[0]!;
    expect(call.url).toBe(`${P}/handoff-status`); // nothing names a person
    expect(call.headers["authorization"]).toBe("Bearer tok");
    expect(call.headers["x-tenant-id"]).toBe(T);
  });

  it("reads each connection, and the item follows it: connected and unknown launch, the others open the page", async () => {
    const modes: Record<string, "launch" | "page"> = { connected: "launch", unknown: "launch", setting_up: "page", not_connected: "page" };
    for (const [connection, mode] of Object.entries(modes)) {
      boot({ [`GET ${P}/handoff-status`]: STATUS(connection) });
      const status = await fetchHrStatus(T);
      expect(status.connection).toBe(connection);
      expect(hrItemMode(true, status)).toBe(mode);
    }
  });

  it("switched off on the API (enabled false), or an answer it does not know, is hidden", async () => {
    boot({ [`GET ${P}/handoff-status`]: { body: { enabled: false, connection: null, requested_at: null, can_request_hr: false } } });
    expect(await fetchHrStatus(T)).toEqual(HR_STATUS_HIDDEN);
    expect(hrItemMode(true, await fetchHrStatus(T))).toBeNull();
    boot({ [`GET ${P}/handoff-status`]: { body: { enabled: true, connection: "something_new" } } });
    expect(await fetchHrStatus(T)).toEqual(HR_STATUS_HIDDEN);
  });

  it("a 403 (not someone who may have HR & Payroll, or no membership) is hidden, not an error", async () => {
    boot({ [`GET ${P}/handoff-status`]: refused(403, "forbidden", "Missing permission") });
    expect(await fetchHrStatus(T)).toEqual(HR_STATUS_HIDDEN);
  });

  it("any other failure is thrown as an EdgeError with the API's code, so the page says it could not check", async () => {
    boot({ [`GET ${P}/handoff-status`]: refused(503, "service_unavailable", "busy") });
    const err = await failure(() => fetchHrStatus(T));
    expect(err).toBeInstanceOf(EdgeError);
    expect(err).toMatchObject({ status: 503, code: "service_unavailable" });
    boot({ [`GET ${P}/handoff-status`]: { networkError: true } });
    expect(await failure(() => fetchHrStatus(T))).toMatchObject({ code: "network_error" });
    boot({ [`GET ${P}/handoff-status`]: refused(429, "rate_limited", "Too many", { "retry-after": "12" }) });
    expect(await failure(() => fetchHrStatus(T))).toMatchObject({ status: 429, code: "rate_limited", message: "Too many attempts. Try again in 12 seconds." });
  });

  it("takes the school from its argument, not from the tab: the launch tab has no active school", async () => {
    boot({ [`GET /v1/tenants/${OTHER}/me/hr/handoff-status`]: STATUS("connected") }, null);
    expect((await fetchHrStatus(OTHER)).connection).toBe("connected");
    expect(api.calls[0]!.headers["x-tenant-id"]).toBe(OTHER);
  });

  it("is the Supabase path (no API call) on a Supabase build", async () => {
    boot({});
    initBackend({ kind: "supabase" });
    await expect(fetchHrStatus(T)).rejects.toThrow(); // no Supabase client in a test: it got as far as asking for it
    expect(api.calls).toEqual([]);
  });
});

describe("fetchHrHandoffStatus (the phone's three-way answer) on the API build", () => {
  it("works the old answer out from the API's status", async () => {
    const cases: [string | null, string][] = [[null, "off"], ["not_connected", "not_enabled"], ["setting_up", "available"], ["connected", "available"], ["unknown", "available"]];
    for (const [connection, expected] of cases) {
      boot({ [`GET ${P}/handoff-status`]: STATUS(connection) });
      expect(await fetchHrHandoffStatus(T), String(connection)).toBe(expected);
    }
  });

  it("a 403 is 'forbidden'; another failure is thrown", async () => {
    boot({ [`GET ${P}/handoff-status`]: refused(403, "forbidden", "no") });
    expect(await fetchHrHandoffStatus(T)).toBe("forbidden");
    boot({ [`GET ${P}/handoff-status`]: refused(500, "internal_error", "x") });
    await expect(fetchHrHandoffStatus(T)).rejects.toThrow();
  });

  it("hrHandoffStatusFrom is pure: a hidden status is off", () => {
    expect(hrHandoffStatusFrom(HR_STATUS_HIDDEN)).toBe("off");
    expect(hrHandoffStatusFrom({ enabled: true, connection: null, requestedAt: null, canRequestHr: false })).toBe("off");
  });
});

describe("requestFigbloomHr on the API build", () => {
  it("POSTs with no body and no content type, and answers the time of the first request", async () => {
    boot({ [`POST ${P}/handoff-request`]: { body: { requested_at: "2026-11-20T08:30:00.000Z" } } });
    expect(await requestFigbloomHr(T)).toEqual({ requestedAt: "2026-11-20T08:30:00.000Z" });
    const call = api.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.body).toBeUndefined();
    expect(call.headers["content-type"]).toBeUndefined(); // a JSON type with an empty body is a 400 on this API
    expect(call.headers["x-tenant-id"]).toBe(T);
  });

  it("'already connected' keeps its code, so the page shows the new state instead of an error", async () => {
    boot({ [`POST ${P}/handoff-request`]: refused(409, "already_connected", "Figbloom HR is already connected.") });
    const err = await failure(() => requestFigbloomHr(T));
    expect(err).toBeInstanceOf(EdgeError);
    expect(err).toMatchObject({ status: 409, code: "already_connected", message: "Figbloom HR is already connected." });
  });

  it("off (403 handoff_off) keeps its code and is not read as 'forbidden'", async () => {
    boot({ [`POST ${P}/handoff-request`]: refused(403, "handoff_off", "HR & Payroll isn't switched on.") });
    expect(await failure(() => requestFigbloomHr(T))).toMatchObject({ status: 403, code: "handoff_off", message: "HR & Payroll isn't switched on." });
  });

  it("an answer with no time is a sentence, not a crash", async () => {
    boot({ [`POST ${P}/handoff-request`]: { body: {} } });
    await expect(requestFigbloomHr(T)).rejects.toThrow("Couldn't send the request. Try again.");
  });

  it("is the Supabase path (no API call) on a Supabase build", async () => {
    boot({});
    initBackend({ kind: "supabase" });
    await expect(requestFigbloomHr(T)).rejects.toThrow();
    expect(api.calls).toEqual([]);
  });
});

describe("requestHrLink on the API build", () => {
  it("POSTs with no body and hands back the link and its expiry untouched", async () => {
    boot({ [`POST ${P}/handoff`]: { body: { url: LINK, expires_at: "2026-11-25T10:01:00.000Z" } } });
    expect(await requestHrLink(T)).toEqual({ url: LINK, expires_at: "2026-11-25T10:01:00.000Z" });
    const call = api.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${P}/handoff`);
    expect(call.body).toBeUndefined();
    expect(call.headers["content-type"]).toBeUndefined();
    expect(isHttpsLink(LINK)).toBe(true);
  });

  it("an expiry the platform did not give is null", async () => {
    boot({ [`POST ${P}/handoff`]: { body: { url: LINK, expires_at: null } } });
    expect((await requestHrLink(T)).expires_at).toBeNull();
  });

  it("takes the school from its argument: the launch tab opens in a tab with no active school", async () => {
    boot({ [`POST /v1/tenants/${OTHER}/me/hr/handoff`]: { body: { url: LINK, expires_at: null } } }, null);
    await requestHrLink(OTHER);
    expect(api.calls[0]!.headers["x-tenant-id"]).toBe(OTHER);
  });

  it("never writes the link (it holds a one-time code) to the console, and no error carries it", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    boot({ [`POST ${P}/handoff`]: { body: { url: LINK, expires_at: null } } });
    await requestHrLink(T);
    boot({ [`POST ${P}/handoff`]: { body: { url: "", expires_at: null } } });
    const err = await failure(() => requestHrLink(T));
    expect(err).toMatchObject({ status: 502, code: "hr_bad_answer" });
    expect(JSON.stringify([err?.message, err?.code, err?.status])).not.toContain("ONE-TIME-CODE");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("a missing link is the API's 'answered badly' (unreachable), not a crash", async () => {
    boot({ [`POST ${P}/handoff`]: { body: { expires_at: null } } });
    const err = await failure(() => requestHrLink(T));
    expect(err).toBeInstanceOf(EdgeError);
    expect(hrLaunchProblem(err)).toBe("unreachable");
  });

  it("is the Supabase path (no API call) on a Supabase build", async () => {
    boot({});
    initBackend({ kind: "supabase" });
    await expect(requestHrLink(T)).rejects.toThrow();
    expect(api.calls).toEqual([]);
  });
});

describe("what the launch tab says for each refusal of the API", () => {
  const problemFor = async (status: number, code: string, headers?: Record<string, string>): Promise<HrLaunchProblem> => {
    boot({ [`POST ${P}/handoff`]: refused(status, code, "A sentence from the server.", headers) });
    const err = await failure(() => requestHrLink(T));
    expect(err).toBeInstanceOf(EdgeError);
    return hrLaunchProblem(err);
  };

  it("not on for the school: the school can ask Figbloom for it", async () => {
    expect(await problemFor(409, "target_not_enabled")).toBe("not_enabled");
    expect(await problemFor(409, "school_not_linked")).toBe("not_enabled");
  });

  it("switched on but still being prepared", async () => {
    expect(await problemFor(409, "target_not_linked")).toBe("setting_up");
    expect(await problemFor(409, "target_no_handoff_url")).toBe("setting_up");
  });

  it("the platform down (503 hr_unavailable) or answering badly (502 hr_bad_answer) reads as unreachable", async () => {
    expect(await problemFor(503, "hr_unavailable", { "retry-after": "30" })).toBe("unreachable");
    expect(await problemFor(502, "hr_bad_answer")).toBe("unreachable");
  });

  it("switched off on the API (403 handoff_off) reads as unreachable, not as 'only administrators'", async () => {
    expect(await problemFor(403, "handoff_off")).toBe("unreachable");
  });

  it("someone who may not open HR, a rate limit and an ended session", async () => {
    expect(await problemFor(403, "forbidden")).toBe("forbidden");
    expect(await problemFor(429, "rate_limited", { "retry-after": "20" })).toBe("rate_limited");
    expect(await problemFor(401, "unauthorized")).toBe("session");
  });

  it("the network down is unreachable", async () => {
    boot({ [`POST ${P}/handoff`]: { networkError: true } });
    expect(hrLaunchProblem(await failure(() => requestHrLink(T)))).toBe("unreachable");
  });
});

describe("who is asked at all", () => {
  it("the same people as on Supabase: the school's admin, an acting org admin, and a Fees-area holder (the API still decides)", () => {
    expect(mayOfferHr("school_admin", [])).toBe(true);
    expect(mayOfferHr("org_admin", [], true)).toBe(true);
    expect(mayOfferHr("staff", ["fees"])).toBe(true);
    expect(mayOfferHr("teacher", ["fees"])).toBe(true);
    expect(mayOfferHr("teacher", ["people"])).toBe(false);
    expect(mayOfferHr("parent", ["fees"])).toBe(false);
  });
});
