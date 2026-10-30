import { describe, it } from "jsr:@std/testing/bdd";
import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { captureLogs, countingLimiter, FakeMailer } from "../_shared/fakeMailer.ts";
import { handle, normalisePhone } from "./index.ts";

describe("normalisePhone", () => {
  it("converts a local 07xx number to +254", () => {
    assertEquals(normalisePhone("0712 345 678"), "+254712345678");
  });
  it("leaves an already-international number's digits alone", () => {
    assertEquals(normalisePhone("+254712345678"), "+254712345678");
  });
  it("prefixes a bare subscriber number", () => {
    assertEquals(normalisePhone("712345678"), "+254712345678");
  });
});

const SUPER_ADMIN_ID = "super-admin-1";
const TENANT_ID = "tenant-1";

function makeClients(opts: { role?: string; callerTenantId?: string } = {}) {
  const admin = new FakeSupabaseClient();
  admin.seed("profiles", [
    { id: SUPER_ADMIN_ID, role: opts.role ?? "super_admin", full_name: "Jane Figbloom", tenant_id: opts.callerTenantId ?? null },
  ]);
  admin.seed("tenants", [{ id: TENANT_ID, name: "Green Valley School", slug: "green-valley" }]);
  admin.onCreateUser = (attrs) => ({
    data: { user: { id: "new-admin-1", email: attrs.email } },
    error: null,
  });

  const asUser = new FakeSupabaseClient();
  asUser.authUser = { id: SUPER_ADMIN_ID };

  return { admin, asUser };
}

function request(body: unknown, opts: { method?: string; auth?: string | null } = {}) {
  const method = opts.method ?? "POST";
  const headers = new Headers();
  if (opts.auth !== null) headers.set("Authorization", opts.auth ?? "Bearer token");
  return new Request("https://example.com/invite-admin", {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
}

const validBody = {
  tenant_id: TENANT_ID,
  full_name: "Principal Wanjiru",
  staff_title: "Principal",
  email: "wanjiru@school.ac.ke",
};

describe("invite-admin handle", () => {
  it("answers an OPTIONS preflight with CORS headers, no auth required", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request(validBody, { method: "OPTIONS", auth: null }), { admin, asUser });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("rejects non-POST requests", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request(validBody, { method: "GET" }), { admin, asUser });
    assertEquals(res.status, 405);
  });

  it("rejects a request with no Authorization header", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request(validBody, { auth: null }), { admin, asUser });
    assertEquals(res.status, 401);
  });

  it("rejects when the token does not resolve to a user", async () => {
    const { admin, asUser } = makeClients();
    asUser.authUser = null;
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 401);
  });

  it("rejects a caller who is not a super_admin", async () => {
    const { admin, asUser } = makeClients({ role: "school_admin" });
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 403);
  });

  it("rejects a body missing required fields", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ tenant_id: TENANT_ID }), { admin, asUser });
    assertEquals(res.status, 400);
  });

  it("404s when the tenant does not exist", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ ...validBody, tenant_id: "missing" }), { admin, asUser });
    assertEquals(res.status, 404);
  });

  it("creates the admin account, profile, and an audit event", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ ...validBody, phone: "0712345678" }), { admin, asUser });
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.ok, true);
    assertEquals(out.email, validBody.email);
    assertMatch(out.password, /^[a-hjkmnp-zA-HJ-NP-Z2-9]{10}$/);

    const profiles = admin.rowsIn("profiles");
    const created = profiles.find((p) => p.id === "new-admin-1");
    assertEquals(created?.role, "school_admin");
    assertEquals(created?.tenant_id, TENANT_ID);
    assertEquals(created?.must_change_password, true);
    assertEquals(created?.phone, "+254712345678");

    const audit = admin.rowsIn("audit_events")[0];
    assertMatch(audit.event, /Principal Wanjiru/);
    assertMatch(audit.actor_label, /Jane Figbloom/);
  });

  it("reports a 409 when the email is already registered", async () => {
    const { admin, asUser } = makeClients();
    // The real Supabase Auth message, not a paraphrase — "already registered"
    // alone would silently defeat the substring check this test is guarding.
    admin.onCreateUser = () => ({ data: { user: null }, error: { message: "A user with this email address has already been registered" } });
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 409);
  });

  it("rolls back the auth account if the profile insert fails", async () => {
    const { admin, asUser } = makeClients();
    admin.failNextWrite("profiles", "insert failed");

    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 500);
    assertEquals(admin.deletedUserIds, ["new-admin-1"]);
  });

  describe("teacher/driver login_id path (FIG-398)", () => {
    it("rejects an unknown role", async () => {
      const { admin, asUser } = makeClients();
      const res = await handle(request({ ...validBody, role: "parent" }), { admin, asUser });
      assertEquals(res.status, 400);
    });

    it("creates a teacher with an auto-generated login_id instead of requiring email", async () => {
      const { admin, asUser } = makeClients();
      const res = await handle(request({ tenant_id: TENANT_ID, full_name: "Otieno Ouma", role: "teacher" }), { admin, asUser });
      assertEquals(res.status, 200);
      const out = await res.json();
      assertEquals(out.ok, true);
      assertEquals(out.login_id, "TC-0001");
      assertMatch(out.password, /^[a-hjkmnp-zA-HJ-NP-Z2-9]{10}$/);

      const created = admin.rowsIn("profiles").find((p) => p.id === "new-admin-1");
      assertEquals(created?.role, "teacher");
      assertEquals(created?.login_id, "TC-0001");
      assertEquals(created?.tenant_id, TENANT_ID);
      assertEquals(created?.must_change_password, true);
    });

    it("creates a driver with a BD-prefixed login_id", async () => {
      const { admin, asUser } = makeClients();
      const res = await handle(request({ tenant_id: TENANT_ID, full_name: "Kariuki James", role: "driver" }), { admin, asUser });
      const out = await res.json();
      assertEquals(out.login_id, "BD-0001");
    });

    it("creates other staff with an SF-prefixed login_id and their title", async () => {
      const { admin, asUser } = makeClients({ role: "school_admin", callerTenantId: TENANT_ID });
      const res = await handle(request({ tenant_id: TENANT_ID, full_name: "Lucy Njeri", role: "staff", staff_title: "Receptionist" }), { admin, asUser });
      assertEquals(res.status, 200);
      const out = await res.json();
      assertEquals(out.login_id, "SF-0001");
      const created = admin.rowsIn("profiles").find((p) => p.id === "new-admin-1");
      assertEquals(created?.role, "staff");
      assertEquals(created?.staff_title, "Receptionist");
      assertMatch(admin.rowsIn("audit_events")[0].event, /Staff member Lucy Njeri \(Receptionist, SF-0001\)/);
    });

    it("no longer sets the deprecated visitor-log flag: the visitor log is an admin area, given afterwards", async () => {
      const { admin, asUser } = makeClients();
      await handle(request({ tenant_id: TENANT_ID, full_name: "Lucy Njeri", role: "staff", handles_visitors: true }), { admin, asUser });
      assertEquals("handles_visitors" in (admin.rowsIn("profiles").find((p) => p.id === "new-admin-1") ?? {}), false);
      assertEquals(admin.rowsIn("staff_permissions").length, 0);
    });

    it("no longer creates the retired guard and receptionist roles", async () => {
      const { admin, asUser } = makeClients();
      for (const role of ["guard", "receptionist"]) {
        const res = await handle(request({ tenant_id: TENANT_ID, full_name: "Samuel Kiprono", role }), { admin, asUser });
        assertEquals(res.status, 400);
      }
    });

    it("increments the login_id per tenant+role, not globally", async () => {
      const { admin, asUser } = makeClients();
      admin.seed("profiles", [
        { id: SUPER_ADMIN_ID, role: "super_admin", full_name: "Jane Figbloom" },
        { id: "existing-teacher-1", role: "teacher", tenant_id: TENANT_ID, login_id: "TC-0001" },
        { id: "existing-driver-1", role: "driver", tenant_id: TENANT_ID, login_id: "BD-0001" },
      ]);
      const res = await handle(request({ tenant_id: TENANT_ID, full_name: "Second Teacher", role: "teacher" }), { admin, asUser });
      const out = await res.json();
      // Existing teacher count is 1 -> next is TC-0002, unaffected by the driver row.
      assertEquals(out.login_id, "TC-0002");
    });

    it("a different tenant can reuse the same sequence number", async () => {
      const OTHER_TENANT_ID = "tenant-2";
      const { admin, asUser } = makeClients();
      admin.seed("tenants", [
        { id: TENANT_ID, name: "Green Valley School", slug: "green-valley" },
        { id: OTHER_TENANT_ID, name: "Other School", slug: "other-school" },
      ]);
      const res = await handle(request({ tenant_id: OTHER_TENANT_ID, full_name: "First Teacher There", role: "teacher" }), { admin, asUser });
      const out = await res.json();
      assertEquals(out.login_id, "TC-0001");
    });

    it("allows the school's OWN school_admin to add a teacher", async () => {
      const { admin, asUser } = makeClients({ role: "school_admin", callerTenantId: TENANT_ID });
      const res = await handle(request({ tenant_id: TENANT_ID, full_name: "Otieno Ouma", role: "teacher" }), { admin, asUser });
      assertEquals(res.status, 200);
    });

    it("rejects a DIFFERENT school's school_admin adding a teacher here", async () => {
      const { admin, asUser } = makeClients({ role: "school_admin", callerTenantId: "some-other-tenant" });
      const res = await handle(request({ tenant_id: TENANT_ID, full_name: "Otieno Ouma", role: "teacher" }), { admin, asUser });
      assertEquals(res.status, 403);
    });

    it("still rejects a school_admin trying to add ANOTHER school_admin (the first-admin case stays super_admin/org_admin-only)", async () => {
      const { admin, asUser } = makeClients({ role: "school_admin", callerTenantId: TENANT_ID });
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 403);
    });
  });

  describe("a teacher or other staff member with the people area (20261031000000)", () => {
    function withArea(role: string, areas: string[], tenantId = TENANT_ID) {
      const clients = makeClients({ role, callerTenantId: tenantId });
      clients.admin.seed("staff_permissions", areas.map((area) => ({ tenant_id: tenantId, profile_id: SUPER_ADMIN_ID, area })));
      return clients;
    }

    it("adds a teacher", async () => {
      const { admin, asUser } = withArea("staff", ["people"]);
      const res = await handle(request({ tenant_id: TENANT_ID, full_name: "Otieno Ouma", role: "teacher" }), { admin, asUser });
      assertEquals(res.status, 200);
      assertMatch(admin.rowsIn("audit_events")[0].actor_label, /Jane Figbloom · people/);
    });

    it("adds a teacher when people comes from a school role", async () => {
      const { admin, asUser } = makeClients({ role: "teacher", callerTenantId: TENANT_ID });
      admin.seed("school_roles", [{ id: "role-1", tenant_id: TENANT_ID, name: "Admissions", areas: ["people"] }]);
      admin.seed("staff_role_assignments", [{ tenant_id: TENANT_ID, profile_id: SUPER_ADMIN_ID, role_id: "role-1" }]);
      const res = await handle(request({ tenant_id: TENANT_ID, full_name: "Otieno Ouma", role: "teacher" }), { admin, asUser });
      assertEquals(res.status, 200);
    });

    it("is refused when their role holds other areas only", async () => {
      const { admin, asUser } = makeClients({ role: "teacher", callerTenantId: TENANT_ID });
      admin.seed("school_roles", [{ id: "role-1", tenant_id: TENANT_ID, name: "Exams officer", areas: ["academics"] }]);
      admin.seed("staff_role_assignments", [{ tenant_id: TENANT_ID, profile_id: SUPER_ADMIN_ID, role_id: "role-1" }]);
      const res = await handle(request({ tenant_id: TENANT_ID, full_name: "Otieno Ouma", role: "teacher" }), { admin, asUser });
      assertEquals(res.status, 403);
    });

    it("never adds an administrator", async () => {
      const { admin, asUser } = withArea("teacher", ["people"]);
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 403);
    });

    it("is refused with only other areas", async () => {
      const { admin, asUser } = withArea("staff", ["fees", "visitors"]);
      const res = await handle(request({ tenant_id: TENANT_ID, full_name: "Otieno Ouma", role: "teacher" }), { admin, asUser });
      assertEquals(res.status, 403);
    });

    it("is refused at another school", async () => {
      const { admin, asUser } = withArea("teacher", ["people"], "some-other-tenant");
      const res = await handle(request({ tenant_id: TENANT_ID, full_name: "Otieno Ouma", role: "teacher" }), { admin, asUser });
      assertEquals(res.status, 403);
    });

    it("counts only for teachers and other staff, whatever a stray row says", async () => {
      const { admin, asUser } = withArea("parent", ["people"]);
      const res = await handle(request({ tenant_id: TENANT_ID, full_name: "Otieno Ouma", role: "teacher" }), { admin, asUser });
      assertEquals(res.status, 403);
    });
  });

  describe("org_admin caller (FIG-373)", () => {
    const ORG_ADMIN_ID = "org-admin-1";
    const ORG_ID = "org-1";
    const OTHER_ORG_ID = "org-2";

    function makeOrgAdminClients(opts: { tenantOrgId?: string | null; linkedOrgId?: string } = {}) {
      const admin = new FakeSupabaseClient();
      admin.seed("profiles", [{ id: ORG_ADMIN_ID, role: "org_admin", full_name: "Grace Wambui" }]);
      admin.seed("tenants", [{ id: TENANT_ID, name: "Green Valley School", organization_id: opts.tenantOrgId === undefined ? ORG_ID : opts.tenantOrgId }]);
      if (opts.linkedOrgId !== undefined) {
        admin.seed("organization_admins", [{ id: "link-1", profile_id: ORG_ADMIN_ID, organization_id: opts.linkedOrgId }]);
      }
      admin.onCreateUser = (attrs) => ({ data: { user: { id: "new-admin-1", email: attrs.email } }, error: null });

      const asUser = new FakeSupabaseClient();
      asUser.authUser = { id: ORG_ADMIN_ID };
      return { admin, asUser };
    }

    it("allows an org_admin to invite an admin for a school in their own organization", async () => {
      const { admin, asUser } = makeOrgAdminClients({ tenantOrgId: ORG_ID, linkedOrgId: ORG_ID });
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 200);
      const audit = admin.rowsIn("audit_events")[0];
      assertMatch(audit.actor_label, /Grace Wambui · org admin/);
    });

    it("rejects an org_admin inviting into a school belonging to a DIFFERENT organization", async () => {
      const { admin, asUser } = makeOrgAdminClients({ tenantOrgId: OTHER_ORG_ID, linkedOrgId: ORG_ID });
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 403);
    });

    it("rejects an org_admin who administers no organization at all", async () => {
      const { admin, asUser } = makeOrgAdminClients({ tenantOrgId: ORG_ID });
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 403);
    });

    it("rejects an org_admin when the school belongs to no organization", async () => {
      const { admin, asUser } = makeOrgAdminClients({ tenantOrgId: null, linkedOrgId: ORG_ID });
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 403);
    });
  });
});

describe("login_id numbering", () => {
  it("numbers one past the highest ID, so deleting a teacher never reissues one that still exists", async () => {
    const { admin, asUser } = makeClients();
    // TC-0002 was deleted. Three teachers remain: counting would offer TC-0004, which exists.
    admin.seed("profiles", [
      { id: SUPER_ADMIN_ID, role: "super_admin", full_name: "Jane Figbloom" },
      { id: "t1", role: "teacher", tenant_id: TENANT_ID, login_id: "TC-0001" },
      { id: "t3", role: "teacher", tenant_id: TENANT_ID, login_id: "TC-0003" },
      { id: "t4", role: "teacher", tenant_id: TENANT_ID, login_id: "TC-0004" },
    ]);
    const res = await handle(request({ tenant_id: TENANT_ID, full_name: "New Teacher", role: "teacher" }), { admin, asUser });
    assertEquals(res.status, 200);
    assertEquals((await res.json()).login_id, "TC-0005");
  });

  it("starts at 0001 when the school has none yet", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ tenant_id: TENANT_ID, full_name: "First Driver", role: "driver" }), { admin, asUser });
    assertEquals((await res.json()).login_id, "BD-0001");
  });

  it("answers 500 and creates nothing when the numbering lookup fails", async () => {
    const { admin, asUser } = makeClients();
    admin.failNextRpc("database unavailable");
    const res = await handle(request({ tenant_id: TENANT_ID, full_name: "New Teacher", role: "teacher" }), { admin, asUser });
    assertEquals(res.status, 500);
    assertEquals(admin.rowsIn("profiles").length, 1);
    assertEquals(admin.deletedUserIds, []);
  });
});

describe("invite-admin sign-in email", () => {
  const teacher = { tenant_id: TENANT_ID, full_name: "Otieno Ouma", role: "teacher", email: "otieno@gmail.com" };

  it("emails a new teacher their login ID and one-time password when there's an address and email is set up", async () => {
    const { admin, asUser } = makeClients({ role: "school_admin", callerTenantId: TENANT_ID });
    const mailer = new FakeMailer();
    const res = await handle(request(teacher), { admin, asUser, mailer, limiter: countingLimiter() });
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.emailed, { status: "sent", to: "otieno@gmail.com" });
    assertEquals(mailer.sent.length, 1);
    const sent = mailer.sent[0];
    assertEquals(sent.to, "otieno@gmail.com");
    assertEquals(sent.subject, "Your Figbloom account at Green Valley School");
    assertMatch(sent.text, /Login ID: TC-0001/);
    assertMatch(sent.text, new RegExp(`One-time password: ${out.password}`));
    assertMatch(sent.text, /https:\/\/app\.example\.test\/s\/green-valley\/teacher/);
    assertMatch(sent.text, /Jane Figbloom \(school admin\) added you/);
    // still single-use: the emailed password must be changed at first sign-in
    assertEquals(admin.rowsIn("profiles").find((p) => p.id === "new-admin-1")?.must_change_password, true);
  });

  it("emails a new school administrator at their login email", async () => {
    const { admin, asUser } = makeClients();
    const mailer = new FakeMailer();
    const res = await handle(request(validBody), { admin, asUser, mailer, limiter: countingLimiter() });
    const out = await res.json();
    assertEquals(out.emailed.status, "sent");
    assertMatch(mailer.sent[0].text, /Email: wanjiru@school\.ac\.ke/);
    assertMatch(mailer.sent[0].text, /\/s\/green-valley\/admin/);
  });

  it("sends nothing for a teacher with no email, and says so", async () => {
    const { admin, asUser } = makeClients();
    const mailer = new FakeMailer();
    const res = await handle(request({ ...teacher, email: undefined }), { admin, asUser, mailer, limiter: countingLimiter() });
    assertEquals((await res.json()).emailed, { status: "no_address" });
    assertEquals(mailer.sent.length, 0);
  });

  it("skips cleanly when email isn't set up: the account and the on-screen password are as before", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request(teacher), { admin, asUser });
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.emailed, { status: "not_configured" });
    assertEquals(out.login_id, "TC-0001");
    assertMatch(out.password, /^[a-hjkmnp-zA-HJ-NP-Z2-9]{10}$/);
  });

  it("a failed email doesn't fail the account: it's created, the password is returned, and the reason given", async () => {
    const { admin, asUser } = makeClients();
    const mailer = new FakeMailer();
    mailer.answer = { status: "failed", reason: "Resend answered 403: domain not verified" };
    const res = await handle(request(teacher), { admin, asUser, mailer, limiter: countingLimiter() });
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.emailed, { status: "failed", to: "otieno@gmail.com", reason: "Resend answered 403: domain not verified" });
    assert(out.password);
    assert(admin.rowsIn("profiles").some((p) => p.id === "new-admin-1"));
    assertEquals(admin.deletedUserIds, []);
  });

  it("a throwing mailer doesn't fail the account either, and the password never reaches the logs", async () => {
    const { admin, asUser } = makeClients();
    const mailer = new FakeMailer();
    mailer.throws = new Error("network down");
    let res: Response | undefined;
    let password = "";
    const logs = await captureLogs(async () => {
      res = await handle(request(teacher), { admin, asUser, mailer, limiter: countingLimiter() });
      password = (await res.clone().json()).password;
    });
    assertEquals(res!.status, 200);
    assertEquals((await res!.json()).emailed.status, "failed");
    assert(password);
    assert(!logs.includes(password), "password logged");
  });

  it("stops emailing past the caller's hourly limit, without failing the account", async () => {
    const { admin, asUser } = makeClients();
    const mailer = new FakeMailer();
    const res = await handle(request(teacher), { admin, asUser, mailer, limiter: countingLimiter(0) });
    assertEquals(res.status, 200);
    assertEquals((await res.json()).emailed.status, "failed");
    assertEquals(mailer.sent.length, 0);
  });

  it("refuses a contact email that doesn't look like one, before creating anything", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ ...teacher, email: "otieno at gmail" }), { admin, asUser, mailer: new FakeMailer() });
    assertEquals(res.status, 400);
    assertEquals(admin.rowsIn("profiles").length, 1);
  });
});
