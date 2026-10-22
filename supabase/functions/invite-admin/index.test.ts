import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals, assertMatch } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
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

    const profiles = admin.rowsIn("profiles");
    const created = profiles.find((p) => p.id === "new-admin-1");
    assertEquals(created?.role, "school_admin");
    assertEquals(created?.tenant_id, TENANT_ID);
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
      assertEquals(out.password, "figbloom-dev");

      const created = admin.rowsIn("profiles").find((p) => p.id === "new-admin-1");
      assertEquals(created?.role, "teacher");
      assertEquals(created?.login_id, "TC-0001");
      assertEquals(created?.tenant_id, TENANT_ID);
    });

    it("creates a driver with a BD-prefixed login_id", async () => {
      const { admin, asUser } = makeClients();
      const res = await handle(request({ tenant_id: TENANT_ID, full_name: "Kariuki James", role: "driver" }), { admin, asUser });
      const out = await res.json();
      assertEquals(out.login_id, "BD-0001");
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
