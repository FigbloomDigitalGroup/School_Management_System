import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { EdgeError } from "../edge";
import { fetchMyHr, fetchMyHrStatus, fetchPayslip, isMyHrPending, MY_HR_NOT_READY, readPayslips, readSummary, showsMyHr } from "../myHr";
import { BASE, createFakeApi, type FakeApi, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";
const P = `/v1/tenants/${T}/me/hr`;

const refused = (status: number, code: string, message: string, headers?: Record<string, string>) => ({ status, body: { error: { code, message } }, headers });
const SUMMARY = { status: "active", employee: { employee_number: "EMP-001", name: "Tom Teacher", job_title: "Teacher" }, company: { name: "Reu Academy" }, leave_pending: 0 };
const SLIPS = { status: "active", payslips: [{ id: "slip-1", pay_period: "2026-10", currency: "KES", gross_pay: 50000, total_deductions: 9205, net_pay: 40795, run_status: "paid" }] };

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

describe("fetchMyHrStatus on the API build", () => {
  it("asks the API for the caller's own status, in the active school, and returns it", async () => {
    boot({ [`GET ${P}/status`]: { body: { status: "available" } } });
    expect(await fetchMyHrStatus()).toBe("available");
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.headers["authorization"]).toBe("Bearer tok");
    expect(api.calls[0]!.headers["x-tenant-id"]).toBe(T);
    expect(api.calls[0]!.url).toBe(`${P}/status`); // nothing names a person or a school but the path
  });

  it("returns each of the five states; only 'available' shows the page", async () => {
    for (const status of ["not_staff", "off", "not_linked", "not_enabled", "available"] as const) {
      boot({ [`GET ${P}/status`]: { body: { status } } });
      const got = await fetchMyHrStatus();
      expect(got).toBe(status);
      expect(showsMyHr(got)).toBe(status === "available");
    }
  });

  it("an answer it does not know is 'off', so the page stays hidden", async () => {
    boot({ [`GET ${P}/status`]: { body: { status: "something_new" } } });
    expect(await fetchMyHrStatus()).toBe("off");
  });

  it("a failure is thrown (the page's hook then keeps My HR hidden)", async () => {
    boot({ [`GET ${P}/status`]: refused(503, "service_unavailable", "busy") });
    await expect(fetchMyHrStatus()).rejects.toThrow();
  });

  it("is the Supabase path (no API call) on a Supabase build", async () => {
    boot({});
    initBackend({ kind: "supabase" });
    await expect(fetchMyHrStatus()).rejects.toThrow(); // no Supabase client in a test: it got as far as asking for it
    expect(api.calls).toEqual([]);
  });
});

describe("fetchMyHr and fetchPayslip on the API build", () => {
  it("reads each section from its own route and passes HR's JSON to the readers unchanged", async () => {
    boot({
      [`GET ${P}/summary`]: { body: SUMMARY },
      [`GET ${P}/payslips`]: { body: SLIPS },
      [`GET ${P}/leave`]: { body: { status: "active", balances: [], applications: [] } },
      [`GET ${P}/kpis`]: { body: { status: "active", items: [] } },
    });
    expect(await fetchMyHr("summary")).toEqual(SUMMARY);
    expect(readSummary(await fetchMyHr("summary")).name).toBe("Tom Teacher");
    expect(readPayslips(await fetchMyHr("payslips"))).toHaveLength(1);
    await fetchMyHr("leave");
    await fetchMyHr("kpis");
    expect(api.calls.map((c) => c.path)).toEqual([`${P}/summary`, `${P}/summary`, `${P}/payslips`, `${P}/leave`, `${P}/kpis`]);
  });

  it("attendance sends the month's dates, and nothing when there are none", async () => {
    boot({ [`GET ${P}/attendance`]: { body: { status: "active", days: [] } } });
    await fetchMyHr("attendance", { from: "2026-10-01", to: "2026-10-31" });
    await fetchMyHr("attendance");
    await fetchMyHr("attendance", { from: "2026-10-01" });
    expect(api.calls.map((c) => c.url)).toEqual([`${P}/attendance?from=2026-10-01&to=2026-10-31`, `${P}/attendance`, `${P}/attendance?from=2026-10-01`]);
  });

  it("one payslip by its id, encoded in the path", async () => {
    boot({
      [`GET ${P}/payslips/slip-1`]: { body: { status: "active", payslip: { id: "slip-1", pay_period: "2026-10" } } },
      [`GET ${P}/payslips/a%2Fb`]: { body: { status: "active", payslip: { id: "a/b" } } },
    });
    expect(((await fetchPayslip("slip-1")) as { payslip: { id: string } }).payslip.id).toBe("slip-1");
    await fetchPayslip("a/b");
    expect(api.calls[1]!.path).toBe(`${P}/payslips/a%2Fb`);
  });

  it("a draft employee's pending_hr answer comes through for the screen to show", async () => {
    boot({ [`GET ${P}/payslips`]: { body: { status: "pending_hr", message: MY_HR_NOT_READY } } });
    expect(isMyHrPending(await fetchMyHr("payslips"))).toBe(true);
  });
});

describe("the API's refusals become the EdgeErrors the screen reads", () => {
  const ask = (route: Parameters<typeof fetchMyHr>[0] = "summary") => fetchMyHr(route).then(() => null, (e: unknown) => e as EdgeError);

  it("'your record isn't ready' keeps its code, so the screen shows the not-ready card with the API's sentence", async () => {
    boot({ [`GET ${P}/summary`]: refused(404, "not_linked", MY_HR_NOT_READY) });
    const err = await ask();
    expect(err).toBeInstanceOf(EdgeError);
    expect(err).toMatchObject({ code: "not_linked", status: 404, message: MY_HR_NOT_READY, cancelled: false });
    boot({ [`GET ${P}/leave`]: refused(404, "pending_hr", MY_HR_NOT_READY) });
    expect(await ask("leave")).toMatchObject({ code: "pending_hr", message: MY_HR_NOT_READY });
  });

  it("HR down, HR off, not connected, switched off here and not staff each give the API's own sentence and code", async () => {
    const cases: [number, string, string][] = [
      [503, "hr_unavailable", "HR & Payroll can't be reached right now. Try again in a minute."],
      [503, "hr_off", "My HR is switched off in Figbloom HR for now. Try again later."],
      [502, "hr_not_connected", "Figbloom HR isn't connected to this school yet. Ask Figbloom."],
      [502, "hr_bad_answer", "HR & Payroll can't be reached right now. Try again in a minute."],
      [403, "my_hr_off", "My HR isn't available yet."],
      [403, "forbidden", "My HR is for the school's staff."],
      [403, "hr_forbidden", "Figbloom HR didn't allow that."],
      [409, "school_not_linked", "This school isn't connected to Figbloom HR yet. Ask Figbloom."],
    ];
    for (const [status, code, message] of cases) {
      boot({ [`GET ${P}/kpis`]: refused(status, code, message) });
      expect(await ask("kpis"), code).toMatchObject({ status, code, message });
    }
  });

  it("an unknown payslip is the API's 'not found' sentence", async () => {
    boot({ [`GET ${P}/payslips/nope`]: refused(404, "not_found", "That payslip isn't available.") });
    const err = await fetchPayslip("nope").then(() => null, (e: unknown) => e as EdgeError);
    expect(err).toMatchObject({ code: "not_found", message: "That payslip isn't available." });
  });

  it("a rate limit says how long to wait; the network and the timeout say it in words", async () => {
    boot({ [`GET ${P}/summary`]: refused(429, "rate_limited", "Too many My HR requests.", { "retry-after": "17" }) });
    expect(await ask()).toMatchObject({ code: "rate_limited", message: "Too many attempts. Try again in 17 seconds." });
    boot({ [`GET ${P}/summary`]: { networkError: true } });
    expect(await ask()).toMatchObject({ code: "network_error", message: "Can't reach the server. Check your connection and try again." });
  });

  it("a school that is not open is a plain error, not an API call", async () => {
    boot({});
    setApiActiveTenant(null);
    await expect(fetchMyHr("summary")).rejects.toThrow("No school is open.");
    expect(api.calls).toEqual([]);
  });
});
