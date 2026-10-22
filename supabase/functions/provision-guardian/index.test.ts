import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals, assertMatch } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle } from "./index.ts";

const SCHOOL_ADMIN_ID = "school-admin-1";
const TENANT_ID = "tenant-1";
const STUDENT_ID = "student-1";
const OTHER_TENANT_ID = "tenant-2";
const OTHER_STUDENT_ID = "student-other-tenant";

function makeClients(opts: { role?: string; callerTenantId?: string } = {}) {
  const admin = new FakeSupabaseClient();
  admin.seed("profiles", [
    { id: SCHOOL_ADMIN_ID, role: opts.role ?? "school_admin", full_name: "Green Valley Admin", tenant_id: opts.callerTenantId ?? TENANT_ID },
  ]);
  admin.seed("tenants", [{ id: TENANT_ID, name: "Green Valley School", slug: "green-valley" }]);
  admin.seed("students", [
    { id: STUDENT_ID, tenant_id: TENANT_ID, full_name: "Faith Achieng" },
    { id: OTHER_STUDENT_ID, tenant_id: OTHER_TENANT_ID, full_name: "Someone Else" },
  ]);
  admin.onCreateUser = (attrs) => ({
    data: { user: { id: "new-parent-1", email: attrs.email } },
    error: null,
  });

  const asUser = new FakeSupabaseClient();
  asUser.authUser = { id: SCHOOL_ADMIN_ID };

  return { admin, asUser };
}

function request(body: unknown, opts: { method?: string; auth?: string | null } = {}) {
  const method = opts.method ?? "POST";
  const headers = new Headers();
  if (opts.auth !== null) headers.set("Authorization", opts.auth ?? "Bearer token");
  return new Request("https://example.com/provision-guardian", {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
}

const validBody = {
  tenant_id: TENANT_ID,
  full_name: "Rose Achieng",
  students: [{ student_id: STUDENT_ID, relationship: "mother" as const, is_primary_payer: true }],
};

describe("provision-guardian handle", () => {
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

  it("rejects a caller who is none of super_admin/org_admin/school_admin", async () => {
    const { admin, asUser } = makeClients({ role: "teacher" });
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 403);
  });

  it("rejects a body missing required fields", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ tenant_id: TENANT_ID, full_name: "Rose Achieng" }), { admin, asUser });
    assertEquals(res.status, 400);
  });

  it("rejects an unknown relationship", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ ...validBody, students: [{ student_id: STUDENT_ID, relationship: "aunt" }] }), { admin, asUser });
    assertEquals(res.status, 400);
  });

  it("404s when the tenant does not exist", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ ...validBody, tenant_id: "missing" }), { admin, asUser });
    assertEquals(res.status, 404);
  });

  it("rejects a DIFFERENT school's school_admin", async () => {
    const { admin, asUser } = makeClients({ callerTenantId: OTHER_TENANT_ID });
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 403);
  });

  it("rejects a student_id that does not belong to this tenant", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ ...validBody, students: [{ student_id: OTHER_STUDENT_ID }] }), { admin, asUser });
    assertEquals(res.status, 400);
    assertEquals(admin.rowsIn("guardians").length, 0);
    assertEquals(admin.rowsIn("profiles").find((p) => p.id === "new-parent-1"), undefined);
  });

  it("creates the guardian with an auto-generated PT-prefixed login_id, links the student, and logs an audit event", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.ok, true);
    assertEquals(out.login_id, "PT-0001");
    assertEquals(out.password, "figbloom-dev");

    const created = admin.rowsIn("profiles").find((p) => p.id === "new-parent-1");
    assertEquals(created?.role, "parent");
    assertEquals(created?.login_id, "PT-0001");
    assertEquals(created?.tenant_id, TENANT_ID);

    const links = admin.rowsIn("guardians");
    assertEquals(links.length, 1);
    assertEquals(links[0].profile_id, "new-parent-1");
    assertEquals(links[0].student_id, STUDENT_ID);
    assertEquals(links[0].relationship, "mother");
    assertEquals(links[0].is_primary_payer, true);

    const audit = admin.rowsIn("audit_events")[0];
    assertMatch(audit.event, /Rose Achieng/);
    assertMatch(audit.event, /PT-0001/);
  });

  it("links multiple students in one call", async () => {
    const { admin, asUser } = makeClients();
    admin.seed("students", [
      { id: STUDENT_ID, tenant_id: TENANT_ID, full_name: "Faith Achieng" },
      { id: "student-2", tenant_id: TENANT_ID, full_name: "Faith's Sibling" },
    ]);
    const res = await handle(request({ ...validBody, students: [{ student_id: STUDENT_ID }, { student_id: "student-2" }] }), { admin, asUser });
    assertEquals(res.status, 200);
    assertEquals(admin.rowsIn("guardians").length, 2);
  });

  it("increments the login_id per tenant, defaults relationship to guardian", async () => {
    const { admin, asUser } = makeClients();
    admin.seed("profiles", [
      { id: SCHOOL_ADMIN_ID, role: "school_admin", full_name: "Green Valley Admin", tenant_id: TENANT_ID },
      { id: "existing-parent-1", role: "parent", tenant_id: TENANT_ID, login_id: "PT-0001" },
    ]);
    const res = await handle(request({ tenant_id: TENANT_ID, full_name: "Second Parent", students: [{ student_id: STUDENT_ID }] }), { admin, asUser });
    const out = await res.json();
    assertEquals(out.login_id, "PT-0002");
    assertEquals(admin.rowsIn("guardians")[0].relationship, "guardian");
  });

  it("rolls back the profile and auth account if the guardians insert fails", async () => {
    const { admin, asUser } = makeClients();
    admin.failNextWrite("guardians", "insert failed");
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 500);
    assertEquals(admin.deletedUserIds, ["new-parent-1"]);
    assertEquals(admin.rowsIn("profiles").find((p) => p.id === "new-parent-1"), undefined);
  });

  describe("super_admin / org_admin callers", () => {
    it("allows a super_admin", async () => {
      const { admin, asUser } = makeClients({ role: "super_admin", callerTenantId: undefined });
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 200);
    });

    it("allows an org_admin administering this school's organization", async () => {
      const admin = new FakeSupabaseClient();
      const ORG_ADMIN_ID = "org-admin-1";
      const ORG_ID = "org-1";
      admin.seed("profiles", [{ id: ORG_ADMIN_ID, role: "org_admin", full_name: "Grace Wambui" }]);
      admin.seed("tenants", [{ id: TENANT_ID, name: "Green Valley School", slug: "green-valley", organization_id: ORG_ID }]);
      admin.seed("students", [{ id: STUDENT_ID, tenant_id: TENANT_ID, full_name: "Faith Achieng" }]);
      admin.seed("organization_admins", [{ id: "link-1", profile_id: ORG_ADMIN_ID, organization_id: ORG_ID }]);
      admin.onCreateUser = (attrs) => ({ data: { user: { id: "new-parent-1", email: attrs.email } }, error: null });
      const asUser = new FakeSupabaseClient();
      asUser.authUser = { id: ORG_ADMIN_ID };

      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 200);
    });
  });
});
