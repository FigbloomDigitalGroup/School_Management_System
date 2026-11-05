import { describe, it } from "jsr:@std/testing/bdd";
import { assert, assertEquals, assertFalse } from "jsr:@std/assert";
import { FakeSupabaseClient, type Row } from "../_shared/fakeSupabase.ts";
import { FakePlatform, PLATFORM_CONFIG } from "../_shared/fakePlatform.ts";
import { PlatformClient } from "../_shared/platformClient.ts";
import { FakeHr, HR_BASE } from "../_shared/fakeHr.ts";
import { handle, hrUrlFromEnv, NOT_READY } from "./index.ts";

const SCHOOL = "11111111-1111-4111-8111-111111111111";
const OTHER_SCHOOL = "22222222-2222-4222-8222-222222222222";
const UNLINKED_SCHOOL = "33333333-3333-4333-8333-333333333333";

const PEOPLE: Row[] = [
  { id: "teacher", role: "teacher", tenant_id: SCHOOL, archived_at: null },
  { id: "principal", role: "school_admin", tenant_id: SCHOOL, archived_at: null },
  { id: "cook", role: "staff", tenant_id: SCHOOL, archived_at: null },
  { id: "driver", role: "driver", tenant_id: SCHOOL, archived_at: null },
  { id: "new-teacher", role: "teacher", tenant_id: SCHOOL, archived_at: null },
  { id: "unlinked-teacher", role: "teacher", tenant_id: SCHOOL, archived_at: null },
  { id: "archived", role: "teacher", tenant_id: SCHOOL, archived_at: "2026-10-01T00:00:00Z" },
  { id: "parent", role: "parent", tenant_id: SCHOOL, archived_at: null },
  { id: "other-teacher", role: "teacher", tenant_id: OTHER_SCHOOL, archived_at: null },
  { id: "far-teacher", role: "teacher", tenant_id: UNLINKED_SCHOOL, archived_at: null },
  { id: "org-admin", role: "org_admin", tenant_id: null, archived_at: null },
  { id: "super", role: "super_admin", tenant_id: null, archived_at: null },
];

interface Setup {
  caller: string;
  /** platform_settings MY_HR_ENABLED */
  switchedOn?: boolean;
  /** platform_module_status rows */
  moduleStatus?: Row[];
  platform?: FakePlatform | null;
  hrUrl?: string | null;
}

/** my_hr_status() (20261105710000), for the fake: the caller's own active staff profile, the switch, the school linked, a recent "no". */
function myHrStatus(admin: FakeSupabaseClient, callerId: string, switchedOn: boolean): string {
  const me = admin.rowsIn("profiles").find((p) => p.id === callerId);
  if (!me || !me.tenant_id || !["teacher", "driver", "staff", "school_admin"].includes(String(me.role)) || me.archived_at) return "not_staff";
  if (!switchedOn) return "off";
  if (!admin.rowsIn("platform_links").some((l) => l.kind === "tenant" && l.local_id === me.tenant_id)) return "not_linked";
  const no = admin.rowsIn("platform_module_status").find((s) => s.tenant_id === me.tenant_id && s.module === "hr" && !s.enabled
    && ["target_not_enabled", "target_not_linked"].includes(String(s.reason)) && Date.now() - Date.parse(String(s.checked_at)) < 3600_000);
  return no ? "not_enabled" : "available";
}

const OCT = "aaaaaaaa-0000-4000-8000-000000000010";
const OTHERS = "bbbbbbbb-0000-4000-8000-000000000099";
/** One published payslip as HR's my_hr_payslip passes it on (salary_history less tenant_id and the account number). */
const OCT_SLIP = {
  id: OCT, employee_id: "EMP-001", employee_name: "Tom Teacher", pay_period: "2026-10", country: "Kenya", currency: "KES",
  basic_salary: 45000, house_allowance: 5000, gross_pay: 50000, paye: 6000, nssf_deduction: 1080, shif: 1375, housing_levy: 750,
  total_deductions: 9205, net_pay: 40795, bank_name: "KCB", account_number_last4: "4321", run_status: "paid",
  approved_at: "2026-10-27T09:00:00Z", paid_at: "2026-10-28T09:00:00Z",
};

function setup({ caller, switchedOn = true, moduleStatus = [], platform, hrUrl = HR_BASE }: Setup) {
  const admin = new FakeSupabaseClient();
  admin.seed("profiles", PEOPLE);
  admin.seed("platform_links", [
    { kind: "tenant", local_id: SCHOOL, platform_id: "pt-1" },
    { kind: "tenant", local_id: OTHER_SCHOOL, platform_id: "pt-2" },
  ]);
  admin.seed("platform_module_status", moduleStatus);

  const asUser = new FakeSupabaseClient();
  asUser.authUser = { id: caller, email: `${caller}@reu.ac.ke` };
  const rpc = asUser.rpc.bind(asUser);
  asUser.rpc = (name: string, args: Row) => name === "my_hr_status"
    ? Promise.resolve({ data: myHrStatus(admin, caller, switchedOn), error: null })
    : rpc(name, args);

  const hr = new FakeHr();
  hr.link(SCHOOL, "company-reu");
  hr.link(OTHER_SCHOOL, "company-other");
  hr.hire("company-reu", "teacher", { number: "EMP-001", name: "Tom Teacher" });
  hr.hire("company-reu", "principal", { number: "EMP-002", name: "Mary Principal" });
  hr.hire("company-reu", "cook", { number: "EMP-003", name: "Cate Cook" });
  hr.hire("company-reu", "driver", { number: "EMP-004", name: "Dan Driver" });
  hr.hire("company-reu", "new-teacher", { number: "EMP-005", name: "Nina New", draft: true });
  hr.hire("company-other", "other-teacher", { number: "EMP-900", name: "Olga Other" });
  hr.payslips.set("EMP-001", [OCT_SLIP]);
  hr.payslips.set("EMP-900", [{ ...OCT_SLIP, id: OTHERS, employee_id: "EMP-900", employee_name: "Olga Other" }]);

  const fake = platform === undefined ? new FakePlatform() : platform;
  return { admin, asUser, hr, fake, deps: { admin, asUser, client: fake ? fake.client() : null, hrUrl, fetch: hr.fetch } };
}

function request(body: unknown, opts: { method?: string; auth?: string | null } = {}) {
  const method = opts.method ?? "POST";
  const headers = new Headers();
  if (opts.auth !== null) headers.set("Authorization", opts.auth ?? "Bearer user-jwt");
  return new Request("https://example.com/my-hr", {
    method, headers, body: method === "GET" || method === "OPTIONS" ? undefined : JSON.stringify(body),
  });
}

async function ask(s: Setup, body: Record<string, unknown>) {
  const ctx = setup(s);
  const res = await handle(request(body), ctx.deps);
  const type = res.headers.get("content-type") ?? "";
  const out = type.startsWith("application/json") ? await res.json() : null;
  return { res, out, ...ctx };
}

describe("my-hr: who", () => {
  for (const caller of ["teacher", "principal", "cook", "driver"]) {
    it(`${caller} gets their own summary from HR`, async () => {
      const { res, out, hr } = await ask({ caller }, { route: "summary" });
      assertEquals(res.status, 200);
      assertEquals(out.status, "active");
      assertEquals(hr.calls.length, 1);
      assertEquals(hr.calls[0]!.path, "summary");
      assertEquals(hr.calls[0]!.school, SCHOOL);
      assertEquals(hr.calls[0]!.person, caller);
      assert(hr.calls[0]!.token.startsWith("token-"));
    });
  }

  for (const [caller, why] of [
    ["parent", "a parent"],
    ["archived", "an archived teacher"],
    ["org-admin", "an org admin"],
    ["super", "Figbloom staff"],
    ["nobody", "someone with no profile"],
  ] as const) {
    it(`refuses ${why}, without asking HR or the platform`, async () => {
      const { res, out, hr, fake } = await ask({ caller }, { route: "payslips" });
      assertEquals(res.status, 403);
      assertEquals(out.code, "forbidden");
      assertEquals(hr.calls.length, 0);
      assertEquals(fake!.tokensIssued, 0);
    });
  }

  it("still refuses an archived profile if the database rule were to let it through (checked again)", async () => {
    const ctx = setup({ caller: "archived" });
    ctx.asUser.rpc = () => Promise.resolve({ data: "available", error: null });
    const res = await handle(request({ route: "summary" }), ctx.deps);
    assertEquals(res.status, 403);
    assertEquals(ctx.hr.calls.length, 0);
  });

  it("needs a signed-in caller, POST and a known route", async () => {
    const ctx = setup({ caller: "teacher" });
    assertEquals((await handle(request({ route: "summary" }, { auth: null }), ctx.deps)).status, 401);
    assertEquals((await handle(request({ route: "summary" }, { method: "GET" }), ctx.deps)).status, 405);
    assertEquals((await handle(request({}, { method: "OPTIONS", auth: null }), ctx.deps)).status, 200);
    assertEquals((await handle(request({ route: "salaries" }), ctx.deps)).status, 400);
    assertEquals((await handle(request({}), ctx.deps)).status, 400);
    assertEquals((await handle(request({ route: "payslip" }), ctx.deps)).status, 400);
    assertEquals((await handle(request({ route: "payslip", payslip_id: "../../admin" }), ctx.deps)).status, 400);
    assertEquals((await handle(request({ route: "payslip_pdf", payslip_id: OCT }), ctx.deps)).status, 400);
    assertEquals((await handle(request({ route: "attendance", from: "2026-01-01", to: "2026-06-30" }), ctx.deps)).status, 400);
    assertEquals((await handle(request({ route: "attendance", from: "yesterday" }), ctx.deps)).status, 400);
    assertEquals((await handle(request({ route: "attendance", from: "2026-11-05", to: "2026-11-01" }), ctx.deps)).status, 400);
    ctx.asUser.authUser = null;
    assertEquals((await handle(request({ route: "summary" }), ctx.deps)).status, 401);
    assertEquals(ctx.hr.calls.length, 0);
  });
});

describe("my-hr: the school and the person come from the session only", () => {
  it("ignores a school and person in the body", async () => {
    const { res, hr } = await ask({ caller: "teacher" }, {
      route: "payslips", tenant_id: OTHER_SCHOOL, school: OTHER_SCHOOL, person: "other-teacher",
      profile_id: "other-teacher", "x-figbloom-school": OTHER_SCHOOL, "x-figbloom-person": "other-teacher",
    });
    assertEquals(res.status, 200);
    assertEquals(hr.calls[0]!.school, SCHOOL);
    assertEquals(hr.calls[0]!.person, "teacher");
  });

  it("ignores school and person headers on the request", async () => {
    const ctx = setup({ caller: "teacher" });
    const req = request({ route: "summary" });
    req.headers.set("x-figbloom-school", OTHER_SCHOOL);
    req.headers.set("x-figbloom-person", "other-teacher");
    const res = await handle(req, ctx.deps);
    assertEquals(res.status, 200);
    assertEquals(ctx.hr.calls[0]!.school, SCHOOL);
    assertEquals(ctx.hr.calls[0]!.person, "teacher");
  });

  it("can't fetch another school's teacher's payslip by its id", async () => {
    const { res, out } = await ask({ caller: "teacher" }, { route: "payslip", payslip_id: OTHERS });
    assertEquals(res.status, 404);
    assertEquals(out.code, "not_found");
  });

  it("passes the attendance dates on as a query", async () => {
    const { res, out, hr } = await ask({ caller: "teacher" }, { route: "attendance", from: "2026-10-01", to: "2026-10-31" });
    assertEquals(res.status, 200);
    assertEquals(hr.calls[0]!.path, "attendance");
    assertEquals(hr.calls[0]!.search, "?from=2026-10-01&to=2026-10-31");
    assertEquals(out.from, "2026-10-01");
  });

  for (const route of ["payslips", "leave", "kpis"]) {
    it(`passes ${route} through as HR sent it`, async () => {
      const { res, out, hr } = await ask({ caller: "teacher" }, { route });
      assertEquals(res.status, 200);
      assertEquals(hr.calls[0]!.path, route);
      assert(out && typeof out === "object");
      assertEquals(res.headers.get("cache-control"), "no-store");
    });
  }
});

describe("my-hr: the switch and the setup", () => {
  it("while MY_HR_ENABLED is off, refuses everyone and never calls HR or the platform", async () => {
    const { res, out, hr, fake } = await ask({ caller: "teacher", switchedOn: false }, { route: "summary" });
    assertEquals(res.status, 403);
    assertEquals(out.code, "my_hr_off");
    assertEquals(hr.calls.length, 0);
    assertEquals(fake!.tokensIssued, 0);
  });

  it("a school the platform doesn't know: refused, HR not asked", async () => {
    const { res, out, hr } = await ask({ caller: "far-teacher" }, { route: "summary" });
    assertEquals(res.status, 409);
    assertEquals(out.code, "school_not_linked");
    assertEquals(hr.calls.length, 0);
  });

  it("a recent \"HR isn't on\" from the platform is asked again (HR decides)", async () => {
    const { res, hr } = await ask({
      caller: "teacher",
      moduleStatus: [{ tenant_id: SCHOOL, module: "hr", enabled: false, reason: "target_not_enabled", checked_at: new Date().toISOString() }],
    }, { route: "summary" });
    assertEquals(res.status, 200);
    assertEquals(hr.calls.length, 1);
  });

  it("without the PLATFORM_* secrets or HR_MY_HR_URL, says so (503)", async () => {
    let r = await ask({ caller: "teacher", platform: null }, { route: "summary" });
    assertEquals(r.res.status, 503);
    assertEquals(r.out.code, "not_configured");
    r = await ask({ caller: "teacher", hrUrl: null }, { route: "summary" });
    assertEquals(r.res.status, 503);
    assertEquals(r.out.code, "not_configured");
  });

  it("HR_MY_HR_URL must be https; a trailing slash is dropped", () => {
    const env = (v?: string) => ({ get: (k: string) => (k === "HR_MY_HR_URL" ? v : undefined) });
    assertEquals(hrUrlFromEnv(env("https://hr.example/api/integrations/my-hr/")), "https://hr.example/api/integrations/my-hr");
    assertEquals(hrUrlFromEnv(env("http://hr.example/api/integrations/my-hr")), null);
    assertEquals(hrUrlFromEnv(env("not a url")), null);
    assertEquals(hrUrlFromEnv(env(undefined)), null);
  });
});

describe("my-hr: HR's answers, as a person reads them", () => {
  it("not linked in HR -> 'Your HR record isn't ready yet'", async () => {
    const { res, out } = await ask({ caller: "unlinked-teacher" }, { route: "summary" });
    assertEquals(res.status, 404);
    assertEquals(out.code, "not_linked");
    assertEquals(out.error, NOT_READY);
  });

  it("a draft employee (onboarding not approved) -> 200 pending_hr with the same sentence, and no pay data", async () => {
    const { res, out } = await ask({ caller: "new-teacher" }, { route: "payslips" });
    assertEquals(res.status, 200);
    assertEquals(out, { status: "pending_hr", message: NOT_READY });
  });

  it("HR's switch off (503 my_hr_off) -> 503 hr_off", async () => {
    const ctx = setup({ caller: "teacher" });
    ctx.hr.enabled = false;
    const res = await handle(request({ route: "summary" }), ctx.deps);
    assertEquals(res.status, 503);
    const out = await res.json();
    assertEquals(out.code, "hr_off");
    assert(/switched off/.test(out.error));
  });

  it("HR refusing the school (403 school_not_linked) -> 502 hr_not_connected", async () => {
    const ctx = setup({ caller: "teacher" });
    ctx.hr.companies.delete(SCHOOL);
    const res = await handle(request({ route: "summary" }), ctx.deps);
    assertEquals(res.status, 502);
    assertEquals((await res.json()).code, "hr_not_connected");
  });

  it("429 -> rate_limited; 500 and unreachable -> hr_unavailable", async () => {
    for (const [down, status, code] of [[429, 429, "rate_limited"], [500, 503, "hr_unavailable"], [0, 503, "hr_unavailable"]] as const) {
      const ctx = setup({ caller: "teacher" });
      ctx.hr.down = down;
      const res = await handle(request({ route: "leave" }), ctx.deps);
      assertEquals(res.status, status);
      assertEquals((await res.json()).code, code);
    }
  });

  it("the platform token can't be had -> 503, HR not called", async () => {
    const ctx = setup({ caller: "teacher" });
    ctx.deps.client = new PlatformClient({ ...PLATFORM_CONFIG, clientSecret: "wrong" }, { fetch: ctx.fake!.fetch });
    const res = await handle(request({ route: "summary" }), ctx.deps);
    assertEquals(res.status, 503);
    assertEquals(ctx.hr.calls.length, 0);
  });

  it("a 401 from HR is retried once with a fresh token", async () => {
    const ctx = setup({ caller: "teacher" });
    ctx.hr.rejectNext = 1;
    const res = await handle(request({ route: "summary" }), ctx.deps);
    assertEquals(res.status, 200);
    assertEquals(ctx.hr.calls.length, 2);
    assertEquals(ctx.fake!.tokensIssued, 2);
    assertFalse(ctx.hr.calls[0]!.token === ctx.hr.calls[1]!.token);
  });

  it("HR refusing a date range (400) -> 400 with HR's own sentence", async () => {
    const ctx = setup({ caller: "teacher" });
    ctx.hr.rawAnswer = { status: 400, body: JSON.stringify({ error: { code: "bad_request", message: "Choose a range of 93 days or less." } }), type: "application/json" };
    const res = await handle(request({ route: "attendance", from: "2026-10-01", to: "2026-10-31" }), ctx.deps);
    assertEquals(res.status, 400);
    assertEquals(await res.json(), { error: "Choose a range of 93 days or less.", code: "bad_request" });
  });

  it("a 401 twice (HR doesn't accept Schools' token) -> 502 hr_not_connected", async () => {
    const ctx = setup({ caller: "teacher" });
    ctx.hr.rejectNext = 2;
    const res = await handle(request({ route: "summary" }), ctx.deps);
    assertEquals(res.status, 502);
    assertEquals((await res.json()).code, "hr_not_connected");
    assertEquals(ctx.hr.calls.length, 2);
  });

  it("HR answering something that isn't JSON -> 502", async () => {
    const ctx = setup({ caller: "teacher" });
    ctx.hr.rawAnswer = { status: 200, body: "<html>oops</html>", type: "text/html" };
    const res = await handle(request({ route: "kpis" }), ctx.deps);
    assertEquals(res.status, 502);
  });

  it("the token is reused between calls (one per warm isolate)", async () => {
    const ctx = setup({ caller: "teacher" });
    await handle(request({ route: "summary" }), ctx.deps);
    await handle(request({ route: "leave" }), ctx.deps);
    assertEquals(ctx.fake!.tokensIssued, 1);
  });
});

describe("my-hr: one payslip (laid out and printed by the web app; HR has no server-side PDF)", () => {
  it("passes on every saved figure from GET payslips/:id", async () => {
    const { res, out, hr } = await ask({ caller: "teacher" }, { route: "payslip", payslip_id: OCT });
    assertEquals(res.status, 200);
    assertEquals(out, { status: "active", payslip: OCT_SLIP });
    assertEquals(hr.calls[0]!.path, `payslips/${OCT}`);
    assertEquals(res.headers.get("cache-control"), "no-store");
  });

  it("never asks HR for its PDF route", async () => {
    const { hr } = await ask({ caller: "teacher" }, { route: "payslip", payslip_id: OCT });
    assertFalse(hr.calls.some((c) => c.path.endsWith("/pdf")));
  });

  it("a payslip that isn't theirs (or doesn't exist) -> 404", async () => {
    const { res, out } = await ask({ caller: "teacher" }, { route: "payslip", payslip_id: "cccccccc-0000-4000-8000-000000000000" });
    assertEquals(res.status, 404);
    assertEquals(out.error, "That payslip isn't available.");
  });

  it("a draft employee gets pending_hr, not a payslip", async () => {
    const { res, out } = await ask({ caller: "new-teacher" }, { route: "payslip", payslip_id: OCT });
    assertEquals(res.status, 200);
    assertEquals(out, { status: "pending_hr", message: NOT_READY });
  });
});
