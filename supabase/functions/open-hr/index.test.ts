import { describe, it } from "jsr:@std/testing/bdd";
import { assert, assertEquals, assertFalse, assertMatch } from "jsr:@std/assert";
import { FakeSupabaseClient, type Row } from "../_shared/fakeSupabase.ts";
import { FakePlatform } from "../_shared/fakePlatform.ts";
import { CONNECTION_CACHE_SECONDS, handle, realEmail, UNKNOWN_CACHE_SECONDS, type ConnectionCache } from "./index.ts";

const SCHOOL = "11111111-1111-4111-8111-111111111111";
const OTHER_SCHOOL = "22222222-2222-4222-8222-222222222222";
const UNKNOWN_SCHOOL = "33333333-3333-4333-8333-333333333333";
const ORG = "org-1";

const PEOPLE: Row[] = [
  { id: "principal", role: "school_admin", full_name: "Mary Principal", tenant_id: SCHOOL, email: " Mary@Reu.ac.ke " },
  { id: "id-admin", role: "school_admin", full_name: "Ann Login", tenant_id: SCHOOL, email: "ad-0002@login.reu.figbloom.internal" },
  { id: "bursar", role: "staff", full_name: "Ben Bursar", tenant_id: SCHOOL, email: null },
  { id: "teacher", role: "teacher", full_name: "Tom Teacher", tenant_id: SCHOOL, email: "tom@reu.ac.ke" },
  { id: "parent", role: "parent", full_name: "Pat Parent", tenant_id: SCHOOL, email: "pat@example.com" },
  { id: "other-admin", role: "school_admin", full_name: "Olga Other", tenant_id: OTHER_SCHOOL, email: "olga@other.ac.ke" },
  { id: "org-admin", role: "org_admin", full_name: "Grace Org", tenant_id: null, email: "grace@group.org" },
  { id: "super", role: "super_admin", full_name: "Figbloom Staff", tenant_id: null, email: "staff@figbloom.org" },
];

interface Setup {
  caller: string;
  /** platform_settings PLATFORM_HANDOFF_ENABLED */
  switchedOn?: boolean;
  /** platform_module_status rows: {tenant_id, module, enabled, checked_at} */
  moduleStatus?: Row[];
  /** the auth user's own email (a synthetic one for an ID login) */
  authEmail?: string | null;
  platform?: FakePlatform | null;
}

/**
 * hr_handoff_status() (20261105700000), for the fake: who (the school's admin, an org admin of an active
 * organisation owning it, a teacher or staff member with the fees area; never Figbloom staff; anyone else is refused),
 * then the switch, then the school known to the platform (platform_links), then a "no" from the platform in the last hour.
 */
function hrHandoffStatus(admin: FakeSupabaseClient, callerId: string, switchedOn: boolean, tenantId: string): string {
  const me = admin.rowsIn("profiles").find((p) => p.id === callerId);
  const school = admin.rowsIn("tenants").find((t) => t.id === tenantId);
  let allowed = false;
  if (me && school) {
    if (me.role === "school_admin") allowed = me.tenant_id === tenantId;
    else if (me.role === "org_admin") {
      allowed = admin.rowsIn("organization_admins").some((l) => l.profile_id === me.id && l.organization_id === school.organization_id)
        && admin.rowsIn("organizations").some((o) => o.id === school.organization_id && o.status === "active");
    } else if (me.role === "teacher" || me.role === "staff") {
      allowed = me.tenant_id === tenantId
        && admin.rowsIn("staff_permissions").some((p) => p.profile_id === me.id && p.tenant_id === tenantId && p.area === "fees");
    }
  }
  if (!allowed) return "forbidden";
  if (!switchedOn) return "off";
  if (!admin.rowsIn("platform_links").some((l) => l.kind === "tenant" && l.local_id === tenantId)) return "not_linked";
  const no = admin.rowsIn("platform_module_status").find((s) => s.tenant_id === tenantId && s.module === "hr" && !s.enabled
    && Date.now() - Date.parse(s.checked_at) < 3600_000);
  return no ? "not_enabled" : "available";
}

function setup({ caller, switchedOn = true, moduleStatus = [], authEmail, platform }: Setup) {
  const admin = new FakeSupabaseClient();
  admin.seed("tenants", [
    { id: SCHOOL, name: "Reu Academy", organization_id: ORG },
    { id: OTHER_SCHOOL, name: "Other School", organization_id: "org-2" },
    { id: UNKNOWN_SCHOOL, name: "New School", organization_id: ORG },
  ]);
  admin.seed("profiles", PEOPLE);
  admin.seed("organizations", [{ id: ORG, status: "active" }, { id: "org-2", status: "active" }]);
  admin.seed("organization_admins", [{ id: "l1", profile_id: "org-admin", organization_id: ORG }]);
  admin.seed("staff_permissions", [
    { tenant_id: SCHOOL, profile_id: "bursar", area: "fees" },
    { tenant_id: SCHOOL, profile_id: "teacher", area: "people" },
  ]);
  admin.seed("platform_links", [
    { kind: "tenant", local_id: SCHOOL, platform_id: "pt-1" },
    { kind: "tenant", local_id: OTHER_SCHOOL, platform_id: "pt-2" },
  ]);
  admin.seed("platform_module_status", moduleStatus);
  admin.rpcAnswers.platform_record_module_status = (a) => {
    const rows = admin.rowsIn("platform_module_status");
    const row = { tenant_id: a.p_tenant_id, module: a.p_module, enabled: a.p_enabled, reason: a.p_enabled ? null : a.p_reason, checked_at: new Date().toISOString() };
    const i = rows.findIndex((r) => r.tenant_id === a.p_tenant_id && r.module === a.p_module);
    if (i >= 0) rows[i] = row; else rows.push(row);
    return null;
  };
  // 20261124100000: the first request is kept, and its time is the answer
  admin.rpcAnswers.platform_record_hr_request = (a) => {
    const t = admin.rowsIn("tenants").find((r) => r.id === a.p_tenant_id);
    if (!t) return null;
    if (!t.hr_requested_at) Object.assign(t, { hr_requested_at: new Date().toISOString(), hr_requested_by: a.p_profile_id });
    return t.hr_requested_at;
  };

  const asUser = new FakeSupabaseClient();
  const me = PEOPLE.find((p) => p.id === caller);
  asUser.authUser = { id: caller, email: authEmail === undefined ? me?.email ?? null : authEmail };
  // the database refuses (42501) anyone who may not have the item at that school
  const rpc = asUser.rpc.bind(asUser);
  asUser.rpc = (name: string, args: Row) => {
    if (name !== "hr_handoff_status") return rpc(name, args);
    const status = hrHandoffStatus(admin, caller, switchedOn, String(args.p_tenant_id));
    return Promise.resolve(status === "forbidden"
      ? { data: null, error: { message: "HR & Payroll is for the school's administrators and the bursar.", code: "42501" } }
      : { data: status, error: null });
  };

  const fake = platform === undefined ? new FakePlatform() : platform;
  if (fake) {
    fake.tenants.set(SCHOOL, { tenant_id: "pt-1", name: "Reu Academy", local_slug: "reu", organization_local_id: ORG });
    fake.tenants.set(OTHER_SCHOOL, { tenant_id: "pt-2", name: "Other School", local_slug: "other", organization_local_id: "org-2" });
    fake.enableModule("hr", SCHOOL);
  }
  return { admin, asUser, fake, client: fake ? fake.client() : null, connections: new Map() as ConnectionCache };
}

function request(body: unknown, opts: { method?: string; auth?: string | null } = {}) {
  const method = opts.method ?? "POST";
  const headers = new Headers();
  if (opts.auth !== null) headers.set("Authorization", opts.auth ?? "Bearer user-jwt");
  return new Request("https://example.com/open-hr", {
    method, headers, body: method === "GET" || method === "OPTIONS" ? undefined : JSON.stringify(body),
  });
}

async function open(s: Setup, tenantId = SCHOOL) {
  const deps = setup(s);
  const res = await handle(request({ tenant_id: tenantId }), deps);
  return { res, out: await res.json(), ...deps };
}

describe("open-hr: who", () => {
  for (const caller of ["principal", "bursar", "org-admin"]) {
    it(`${caller} gets a one-time HR link for their school`, async () => {
      const { res, out, fake } = await open({ caller });
      assertEquals(res.status, 200);
      assertMatch(out.url, /^https:\/\/hr\.platform\.test\/api\/platform\/handoff\?code=code-\d+$/);
      assert(out.expires_at);
      assertEquals(fake!.handoffs.length, 1);
      assertEquals(fake!.handoffs[0]!.target, "hr");
      assertEquals(fake!.handoffs[0]!.tenant_local_id, SCHOOL);
      assertEquals(fake!.handoffs[0]!.person.external_id, caller);
    });
  }

  for (const [caller, why] of [
    ["teacher", "a teacher without the fees area"],
    ["parent", "a parent"],
    ["other-admin", "another school's admin"],
    ["super", "Figbloom staff"],
  ] as const) {
    it(`refuses ${why}, without asking the platform`, async () => {
      const { res, out, fake } = await open({ caller });
      assertEquals(res.status, 403);
      assertEquals(out.code, "forbidden");
      assertEquals(fake!.calls.length, 0);
    });
  }

  it("refuses an org admin for a school outside their organisation", async () => {
    const { res, fake } = await open({ caller: "org-admin" }, OTHER_SCHOOL);
    assertEquals(res.status, 403);
    assertEquals(fake!.calls.length, 0);
  });

  it("refuses an org admin whose organisation is suspended", async () => {
    const deps = setup({ caller: "org-admin" });
    deps.admin.rowsIn("organizations").find((o) => o.id === ORG)!.status = "suspended";
    const res = await handle(request({ tenant_id: SCHOOL }), deps);
    assertEquals(res.status, 403);
  });

  it("needs a signed-in caller and a school id", async () => {
    const deps = setup({ caller: "principal" });
    assertEquals((await handle(request({ tenant_id: SCHOOL }, { auth: null }), deps)).status, 401);
    deps.asUser.authUser = null;
    assertEquals((await handle(request({ tenant_id: SCHOOL }), deps)).status, 401);
    const deps2 = setup({ caller: "principal" });
    assertEquals((await handle(request({ tenant_id: "reu" }), deps2)).status, 400);
    assertEquals((await handle(request({}), deps2)).status, 400);
    assertEquals((await handle(request({}, { method: "GET" }), deps2)).status, 405);
    assertEquals((await handle(request({}, { method: "OPTIONS", auth: null }), deps2)).status, 200);
  });
});

describe("open-hr: the switch", () => {
  it("while PLATFORM_HANDOFF_ENABLED is off, refuses even the school's admin and never calls the platform", async () => {
    const { res, out, fake } = await open({ caller: "principal", switchedOn: false });
    assertEquals(res.status, 403);
    assertEquals(out.code, "handoff_off");
    assertEquals(fake!.calls.length, 0);
    assertEquals(fake!.tokensIssued, 0);
  });

  it("without the PLATFORM_* secrets, says so (503)", async () => {
    const { res, out } = await open({ caller: "principal", platform: null });
    assertEquals(res.status, 503);
    assertEquals(out.code, "platform_not_configured");
  });
});

describe("open-hr: who the platform is told about", () => {
  it("sends the caller's profile with their real email, trimmed and lower-cased", async () => {
    const { fake } = await open({ caller: "principal" });
    assertEquals(fake!.handoffs[0]!.person, { external_id: "principal", name: "Mary Principal", email: "mary@reu.ac.ke", role: "school_admin" });
  });

  it("a synthetic sign-in address is no email: null", async () => {
    const { res, fake } = await open({ caller: "id-admin" });
    assertEquals(res.status, 200);
    assertEquals(fake!.handoffs[0]!.person.email, null);
  });

  it("no email on the profile: the sign-in email, if it is a real one", async () => {
    const real = await open({ caller: "bursar", authEmail: "Ben@Reu.ac.ke" });
    assertEquals(real.fake!.handoffs[0]!.person.email, "ben@reu.ac.ke");
    const synthetic = await open({ caller: "bursar", authEmail: "st-0009@login.reu.figbloom.internal" });
    assertEquals(synthetic.fake!.handoffs[0]!.person.email, null);
  });

  it("the org admin goes as org_admin", async () => {
    const { fake } = await open({ caller: "org-admin" });
    assertEquals(fake!.handoffs[0]!.person.role, "org_admin");
  });

  it("realEmail matches the database's platform_real_email()", () => {
    assertEquals(realEmail(" A@B.co "), "a@b.co");
    assertEquals(realEmail("x@login.reu.figbloom.internal"), null);
    assertEquals(realEmail("x@example.invalid"), null);
    assertEquals(realEmail("not an email"), null);
    assertEquals(realEmail(""), null);
    assertEquals(realEmail(null), null);
  });
});

describe("open-hr: the platform's answers", () => {
  it("a link is remembered as HR on, and audited without the code", async () => {
    const { res, out, admin } = await open({ caller: "principal" });
    assertEquals(res.status, 200);
    const row = admin.rowsIn("platform_module_status").find((r) => r.tenant_id === SCHOOL)!;
    assertEquals([row.module, row.enabled, row.reason], ["hr", true, null]);
    const audit = admin.rowsIn("audit_events");
    assertEquals(audit.length, 1);
    assertEquals(audit[0]!.actor_id, "principal");
    assertFalse(JSON.stringify(audit).includes(new URL(out.url).searchParams.get("code")!));
  });

  for (const [code, arrange] of [
    ["target_not_enabled", (p: FakePlatform) => p.modules.get("hr")!.enabled.delete(SCHOOL)],
    ["target_not_linked", (p: FakePlatform) => p.modules.get("hr")!.linked.delete(SCHOOL)],
    ["target_no_handoff_url", (p: FakePlatform) => { p.modules.get("hr")!.handoffUrl = null; }],
  ] as const) {
    it(`409 ${code}: a clear refusal, and the item hides for an hour`, async () => {
      const deps = setup({ caller: "principal" });
      arrange(deps.fake!);
      const res = await handle(request({ tenant_id: SCHOOL }), deps);
      const out = await res.json();
      assertEquals(res.status, 409);
      assertEquals(out.code, code);
      assertMatch(out.error, /HR & Payroll/);
      const row = deps.admin.rowsIn("platform_module_status").find((r) => r.tenant_id === SCHOOL)!;
      assertEquals([row.enabled, row.reason], [false, code]);
      assertEquals(hrHandoffStatus(deps.admin, "principal", true, SCHOOL), "not_enabled");
      assertEquals(deps.admin.rowsIn("audit_events").length, 0);
    });
  }

  it("after a 'no' in the last hour, a click still asks again, and a 'yes' shows the item again", async () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    const deps = setup({ caller: "principal", moduleStatus: [{ tenant_id: SCHOOL, module: "hr", enabled: false, reason: "target_not_enabled", checked_at: recent }] });
    assertEquals(hrHandoffStatus(deps.admin, "principal", true, SCHOOL), "not_enabled");
    const res = await handle(request({ tenant_id: SCHOOL }), deps);
    assertEquals(res.status, 200);
    assertEquals(hrHandoffStatus(deps.admin, "principal", true, SCHOOL), "available");
  });

  it("a school the platform doesn't know yet (no platform_links row): not linked, no platform call", async () => {
    const { res, out, fake } = await open({ caller: "org-admin" }, UNKNOWN_SCHOOL);
    assertEquals(res.status, 409);
    assertEquals(out.code, "school_not_linked");
    assertEquals(fake!.calls.length, 0);
  });

  it("the platform answering 404 for the school: not linked", async () => {
    const deps = setup({ caller: "principal" });
    deps.fake!.tenants.delete(SCHOOL);
    const res = await handle(request({ tenant_id: SCHOOL }), deps);
    assertEquals(res.status, 409);
    assertEquals((await res.json()).code, "school_not_linked");
  });

  for (const down of [0, 500, 503]) {
    it(`the platform ${down ? `answering ${down}` : "unreachable"}: 503, try again, nothing remembered`, async () => {
      const deps = setup({ caller: "principal" });
      deps.fake!.down = down;
      const res = await handle(request({ tenant_id: SCHOOL }), deps);
      const out = await res.json();
      assertEquals(res.status, 503);
      assertEquals(out.code, "platform_unavailable");
      assertMatch(out.error, /Try again/);
      assertEquals(deps.admin.rowsIn("platform_module_status").length, 0);
    });
  }

  it("the platform throttling: 429", async () => {
    const deps = setup({ caller: "principal" });
    deps.fake!.down = 429;
    const res = await handle(request({ tenant_id: SCHOOL }), deps);
    assertEquals(res.status, 429);
    assertEquals((await res.json()).code, "rate_limited");
  });

  it("never hands the browser a non-https address", async () => {
    const deps = setup({ caller: "principal" });
    deps.fake!.modules.get("hr")!.handoffUrl = "javascript:alert(1)//";
    const res = await handle(request({ tenant_id: SCHOOL }), deps);
    assertEquals(res.status, 502);
    assertEquals((await res.json()).code, "platform_bad_answer");
  });

  it("a failed status check is an error, not a pass", async () => {
    const deps = setup({ caller: "principal" });
    deps.asUser.rpc = () => Promise.resolve({ data: null, error: { message: "boom", code: "XX000" } });
    const res = await handle(request({ tenant_id: SCHOOL }), deps);
    assertEquals(res.status, 500);
    assertEquals(deps.fake!.calls.length, 0);
  });
});

// ------------------------------------------------------------------ status and request (HR_CONNECT_SPEC.md)

async function act(deps: ReturnType<typeof setup> & { now?: () => number }, action: string, tenantId = SCHOOL) {
  const res = await handle(request({ tenant_id: tenantId, action }), deps);
  return { res, out: await res.json() };
}

const schoolRow = (deps: ReturnType<typeof setup>, id = SCHOOL) => deps.admin.rowsIn("tenants").find((t) => t.id === id)!;

describe("open-hr status: whether HR is there for the school", () => {
  it("HR on and linked: connected, nothing requested", async () => {
    const deps = setup({ caller: "principal" });
    const { res, out } = await act(deps, "status");
    assertEquals(res.status, 200);
    assertEquals(out, { enabled: true, connection: "connected", requested_at: null, can_request_hr: true });
    assertEquals(deps.fake!.calls.map((c) => `${c.method} ${c.path}`), ["GET /tenants/pt-1/modules/hr", "GET /tenants/pt-1/links/hr"]);
    assertEquals(deps.fake!.handoffs.length, 0);
  });

  it("HR on but not linked by HR yet: setting_up", async () => {
    const deps = setup({ caller: "bursar" });
    deps.fake!.modules.get("hr")!.linked.delete(SCHOOL);
    assertEquals((await act(deps, "status")).out.connection, "setting_up");
  });

  it("HR not switched on: not_connected (the link isn't asked)", async () => {
    const deps = setup({ caller: "org-admin" });
    deps.fake!.modules.get("hr")!.enabled.delete(SCHOOL);
    assertEquals((await act(deps, "status")).out.connection, "not_connected");
    assertEquals(deps.fake!.calls.length, 1);
  });

  it("a school the platform doesn't know (no platform_links row): not_connected without asking the platform", async () => {
    const deps = setup({ caller: "org-admin" });
    const { res, out } = await act(deps, "status", UNKNOWN_SCHOOL);
    assertEquals(res.status, 200);
    assertEquals(out.connection, "not_connected");
    assertEquals(deps.fake!.calls.length, 0);
  });

  it("a platform_links row without the platform's id: not_connected", async () => {
    const deps = setup({ caller: "principal" });
    deps.admin.rowsIn("platform_links").find((l) => l.local_id === SCHOOL)!.platform_id = null;
    assertEquals((await act(deps, "status")).out.connection, "not_connected");
    assertEquals(deps.fake!.calls.length, 0);
  });

  for (const down of [0, 500]) {
    it(`the platform ${down ? `answering ${down}` : "unreachable"}: unknown`, async () => {
      const deps = setup({ caller: "principal" });
      deps.fake!.down = down;
      const { res, out } = await act(deps, "status");
      assertEquals(res.status, 200);
      assertEquals(out.connection, "unknown");
    });
  }

  it("without the PLATFORM_* secrets: unknown", async () => {
    assertEquals((await act(setup({ caller: "principal", platform: null }), "status")).out.connection, "unknown");
  });

  it("switched off: enabled false, and the platform isn't asked", async () => {
    const deps = setup({ caller: "principal", switchedOn: false });
    const { res, out } = await act(deps, "status");
    assertEquals(res.status, 200);
    assertEquals(out, { enabled: false, connection: null, requested_at: null, can_request_hr: false });
    assertEquals(deps.fake!.tokensIssued, 0);
  });

  for (const caller of ["teacher", "parent", "other-admin", "super"]) {
    it(`refuses ${caller} (403), without asking the platform`, async () => {
      const deps = setup({ caller });
      const { res, out } = await act(deps, "status");
      assertEquals(res.status, 403);
      assertEquals(out.code, "forbidden");
      assertEquals(deps.fake!.calls.length, 0);
    });
  }

  it("is kept a minute per school (the platform's cache_seconds at most), and asked again after", async () => {
    let t = 1_000_000;
    const deps = { ...setup({ caller: "principal" }), now: () => t };
    await act(deps, "status");
    deps.fake!.modules.get("hr")!.enabled.delete(SCHOOL);
    assertEquals((await act(deps, "status")).out.connection, "connected");
    assertEquals(deps.fake!.calls.length, 2);
    t += CONNECTION_CACHE_SECONDS * 1000 + 1;
    assertEquals((await act(deps, "status")).out.connection, "not_connected");
  });

  it("an unknown answer is kept only briefly", async () => {
    let t = 1_000_000;
    const deps = { ...setup({ caller: "principal" }), now: () => t };
    deps.fake!.down = 503;
    assertEquals((await act(deps, "status")).out.connection, "unknown");
    deps.fake!.down = null;
    t += UNKNOWN_CACHE_SECONDS * 1000 + 1;
    assertEquals((await act(deps, "status")).out.connection, "connected");
  });

  it("says when the school asked for HR", async () => {
    const deps = setup({ caller: "principal" });
    deps.fake!.modules.get("hr")!.enabled.delete(SCHOOL);
    schoolRow(deps).hr_requested_at = "2026-11-20T08:30:00+00:00";
    assertEquals((await act(deps, "status")).out.requested_at, "2026-11-20T08:30:00.000Z");
  });

  it("an unknown action is refused", async () => {
    const { res, out } = await act(setup({ caller: "principal" }), "delete");
    assertEquals(res.status, 400);
    assertEquals(out.code, "unknown_action");
  });

  it("needs a signed-in caller (the gateway may not check the JWT)", async () => {
    const deps = setup({ caller: "principal" });
    assertEquals((await handle(request({ tenant_id: SCHOOL, action: "status" }, { auth: null }), deps)).status, 401);
    deps.asUser.authUser = null;
    assertEquals((await act(deps, "status")).res.status, 401);
  });
});

describe("open-hr request: asking Figbloom for HR", () => {
  it("records the first request (who and when), audits it, and answers its time", async () => {
    const deps = setup({ caller: "bursar" });
    deps.fake!.modules.get("hr")!.enabled.delete(SCHOOL);
    const { res, out } = await act(deps, "request");
    assertEquals(res.status, 200);
    const school = schoolRow(deps);
    assertEquals(school.hr_requested_by, "bursar");
    assertEquals(out.requested_at, new Date(String(school.hr_requested_at)).toISOString());
    const audit = deps.admin.rowsIn("audit_events");
    assertEquals(audit.length, 1);
    assertEquals([audit[0]!.actor_id, audit[0]!.actor_label, audit[0]!.event], ["bursar", "Ben Bursar", "Asked Figbloom for HR & Payroll"]);
    assertEquals(deps.fake!.handoffs.length, 0);
  });

  it("is idempotent: asking again keeps and answers the first time, and isn't audited again", async () => {
    const deps = setup({ caller: "principal" });
    deps.fake!.modules.get("hr")!.enabled.delete(SCHOOL);
    Object.assign(schoolRow(deps), { hr_requested_at: "2026-11-20T08:30:00+00:00", hr_requested_by: "bursar" });
    const { res, out } = await act(deps, "request");
    assertEquals(res.status, 200);
    assertEquals(out.requested_at, "2026-11-20T08:30:00.000Z");
    assertEquals(schoolRow(deps).hr_requested_by, "bursar");
    assertEquals(deps.admin.rowsIn("audit_events").length, 0);
  });

  it("then the status shows it", async () => {
    const deps = setup({ caller: "principal" });
    deps.fake!.modules.get("hr")!.enabled.delete(SCHOOL);
    const asked = (await act(deps, "request")).out.requested_at;
    const { out } = await act(deps, "status");
    assertEquals([out.connection, out.requested_at], ["not_connected", asked]);
  });

  it("a school the platform doesn't know yet can ask too", async () => {
    const deps = setup({ caller: "org-admin" });
    const { res } = await act(deps, "request", UNKNOWN_SCHOOL);
    assertEquals(res.status, 200);
    assertEquals(schoolRow(deps, UNKNOWN_SCHOOL).hr_requested_by, "org-admin");
  });

  it("the platform unreachable (unknown): the request is still recorded", async () => {
    const deps = setup({ caller: "principal" });
    deps.fake!.down = 0;
    assertEquals((await act(deps, "request")).res.status, 200);
    assert(schoolRow(deps).hr_requested_at);
  });

  it("409 already_connected when HR is connected or being set up; nothing recorded", async () => {
    const connected = setup({ caller: "principal" });
    const a = await act(connected, "request");
    assertEquals([a.res.status, a.out.code], [409, "already_connected"]);
    const settingUp = setup({ caller: "principal" });
    settingUp.fake!.modules.get("hr")!.linked.delete(SCHOOL);
    const b = await act(settingUp, "request");
    assertEquals([b.res.status, b.out.code], [409, "already_connected"]);
    for (const d of [connected, settingUp]) assertEquals(schoolRow(d).hr_requested_at, undefined);
  });

  for (const caller of ["teacher", "parent", "other-admin", "super"]) {
    it(`refuses ${caller} (403); nothing recorded`, async () => {
      const deps = setup({ caller });
      const { res, out } = await act(deps, "request");
      assertEquals([res.status, out.code], [403, "forbidden"]);
      assertEquals(schoolRow(deps).hr_requested_at, undefined);
    });
  }

  it("switched off: refused (handoff_off), nothing recorded, the platform not asked", async () => {
    const deps = setup({ caller: "principal", switchedOn: false });
    const { res, out } = await act(deps, "request");
    assertEquals([res.status, out.code], [403, "handoff_off"]);
    assertEquals(deps.fake!.calls.length, 0);
    assertEquals(schoolRow(deps).hr_requested_at, undefined);
  });

  it("forgets the school's kept connection, so the next status asks again", async () => {
    const deps = setup({ caller: "principal" });
    deps.fake!.modules.get("hr")!.enabled.delete(SCHOOL);
    await act(deps, "status");
    assert(deps.connections.has(SCHOOL));
    await act(deps, "request");
    assertFalse(deps.connections.has(SCHOOL));
  });
});

describe("open-hr open: with the other actions", () => {
  it("a refusal from POST /handoffs forgets the kept connection, so the card asks again", async () => {
    const deps = setup({ caller: "principal" });
    await act(deps, "status");
    assert(deps.connections.has(SCHOOL));
    deps.fake!.modules.get("hr")!.linked.delete(SCHOOL);
    const res = await handle(request({ tenant_id: SCHOOL }), deps);
    assertEquals(res.status, 409);
    assertFalse(deps.connections.has(SCHOOL));
  });

  it("action \"open\" is the same as no action", async () => {
    const { res, out } = await act(setup({ caller: "principal" }), "open");
    assertEquals(res.status, 200);
    assertMatch(out.url, /^https:/);
  });
});
