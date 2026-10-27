import { describe, it } from "jsr:@std/testing/bdd";
import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle } from "./index.ts";

const TENANT_ID = "tenant-1";
const OTHER_TENANT_ID = "tenant-2";
const ORG_ID = "org-1";

function makeClients(callerId: string) {
  const admin = new FakeSupabaseClient();
  admin.seed("tenants", [
    { id: TENANT_ID, name: "Green Valley", organization_id: ORG_ID },
    { id: OTHER_TENANT_ID, name: "Riverside", organization_id: null },
  ]);
  admin.seed("profiles", [
    { id: "school-admin", role: "school_admin", full_name: "Mary Admin", tenant_id: TENANT_ID },
    { id: "other-admin", role: "school_admin", full_name: "Other Admin", tenant_id: OTHER_TENANT_ID },
    { id: "org-admin", role: "org_admin", full_name: "Grace Org", tenant_id: null },
    { id: "parent", role: "parent", full_name: "Peter Parent", tenant_id: TENANT_ID },
    { id: "other-parent", role: "parent", full_name: "Paul Parent", tenant_id: TENANT_ID },
    { id: "student-login", role: "student", full_name: "Esther Wanjiru", tenant_id: TENANT_ID, login_id: "ST-0001", must_change_password: false },
    { id: "teacher", role: "teacher", full_name: "Otieno Ouma", tenant_id: TENANT_ID, login_id: "TC-0001" },
    { id: "super", role: "super_admin", full_name: "Figbloom Staff", tenant_id: null },
  ]);
  admin.seed("organization_admins", [{ id: "link-1", profile_id: "org-admin", organization_id: ORG_ID }]);
  admin.seed("students", [{ id: "student-1", tenant_id: TENANT_ID, profile_id: "student-login" }]);
  admin.seed("guardians", [{ id: "g1", tenant_id: TENANT_ID, profile_id: "parent", student_id: "student-1" }]);
  admin.seed("password_reset_requests", [
    { id: "req-1", tenant_id: TENANT_ID, profile_id: "student-login", resolved_at: null },
  ]);
  const asUser = new FakeSupabaseClient();
  asUser.authUser = { id: callerId };
  return { admin, asUser };
}

function request(body: unknown, opts: { method?: string; auth?: string | null } = {}) {
  const method = opts.method ?? "POST";
  const headers = new Headers();
  if (opts.auth !== null) headers.set("Authorization", opts.auth ?? "Bearer token");
  return new Request("https://example.com/reset-user-password", {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
}

async function reset(callerId: string, profileId: string) {
  const clients = makeClients(callerId);
  const res = await handle(request({ profile_id: profileId }), clients);
  return { res, ...clients };
}

describe("reset-user-password handle", () => {
  it("answers an OPTIONS preflight with CORS headers", async () => {
    const res = await handle(request({}, { method: "OPTIONS", auth: null }), makeClients("school-admin"));
    assertEquals(res.status, 200);
  });

  it("rejects a request with no Authorization header", async () => {
    const res = await handle(request({ profile_id: "teacher" }, { auth: null }), makeClients("school-admin"));
    assertEquals(res.status, 401);
  });

  it("lets the school's own admin reset a learner: new password, must change it, request closed, audited", async () => {
    const { res, admin } = await reset("school-admin", "student-login");
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.ok, true);
    assertEquals(out.login_id, "ST-0001");
    assert(typeof out.password === "string" && out.password.length >= 8);

    assertEquals(admin.updatedUsers, [{ id: "student-login", attrs: { password: out.password } }]);
    assertEquals(admin.rowsIn("profiles").find((p) => p.id === "student-login")!.must_change_password, true);
    const req = admin.rowsIn("password_reset_requests")[0];
    assert(req.resolved_at);
    assertEquals(req.resolved_by, "school-admin");
    const audit = admin.rowsIn("audit_events")[0];
    assertEquals(audit.tenant_id, TENANT_ID);
    assertEquals(audit.category, "access");
    assertMatch(audit.event, /Esther Wanjiru \(ST-0001\)/);
  });

  it("refuses a school admin from another school", async () => {
    const { res, admin } = await reset("other-admin", "teacher");
    assertEquals(res.status, 403);
    assertEquals(admin.updatedUsers.length, 0);
  });

  it("lets an org admin reset someone at a school their organization owns", async () => {
    const { res } = await reset("org-admin", "teacher");
    assertEquals(res.status, 200);
  });

  it("lets Figbloom staff reset any school account", async () => {
    const { res } = await reset("super", "teacher");
    assertEquals(res.status, 200);
  });

  it("lets a parent reset their own child's learner login", async () => {
    const { res, admin } = await reset("parent", "student-login");
    assertEquals(res.status, 200);
    assertMatch(admin.rowsIn("audit_events")[0].actor_label, /parent/);
  });

  it("refuses a parent resetting someone else's child", async () => {
    const { res, admin } = await reset("other-parent", "student-login");
    assertEquals(res.status, 403);
    assertEquals(admin.updatedUsers.length, 0);
  });

  it("refuses a parent resetting a staff account", async () => {
    const { res } = await reset("parent", "teacher");
    assertEquals(res.status, 403);
  });

  it("refuses a teacher without the people area", async () => {
    const { res } = await reset("teacher", "student-login");
    assertEquals(res.status, 403);
  });

  describe("a teacher or other staff member with the people area (20261030000000)", () => {
    function withSecretary() {
      const clients = makeClients("secretary");
      clients.admin.seed("profiles", [
        ...clients.admin.rowsIn("profiles"),
        { id: "secretary", role: "staff", full_name: "Sarah Secretary", tenant_id: TENANT_ID, login_id: "SF-0001" },
        { id: "bursar", role: "staff", full_name: "Ben Bursar", tenant_id: TENANT_ID, login_id: "SF-0002" },
      ]);
      clients.admin.seed("staff_permissions", [
        { tenant_id: TENANT_ID, profile_id: "secretary", area: "people" },
        { tenant_id: TENANT_ID, profile_id: "bursar", area: "fees" },
      ]);
      return clients;
    }

    it("resets a learner's or a teacher's password", async () => {
      for (const target of ["student-login", "teacher"]) {
        const clients = withSecretary();
        const res = await handle(request({ profile_id: target }), clients);
        assertEquals(res.status, 200);
        assertMatch(clients.admin.rowsIn("audit_events")[0].actor_label, /people/);
      }
    });

    it("never resets a full admin's password", async () => {
      const clients = withSecretary();
      const res = await handle(request({ profile_id: "school-admin" }), clients);
      assertEquals(res.status, 403);
      assertEquals(clients.admin.updatedUsers.length, 0);
    });

    it("never resets someone who holds an admin area (the bursar has fees, which the secretary doesn't)", async () => {
      const clients = withSecretary();
      const res = await handle(request({ profile_id: "bursar" }), clients);
      assertEquals(res.status, 403);
      assertEquals(clients.admin.updatedUsers.length, 0);
    });

    it("never resets someone whose access comes from a school role", async () => {
      const clients = withSecretary();
      clients.admin.seed("school_roles", [{ id: "role-1", tenant_id: TENANT_ID, name: "Exams officer", areas: ["academics"] }]);
      clients.admin.seed("staff_role_assignments", [{ tenant_id: TENANT_ID, profile_id: "teacher", role_id: "role-1" }]);
      const res = await handle(request({ profile_id: "teacher" }), clients);
      assertEquals(res.status, 403);
    });

    it("is refused at another school", async () => {
      const clients = withSecretary();
      clients.admin.seed("profiles", [
        ...clients.admin.rowsIn("profiles"),
        { id: "riverside-teacher", role: "teacher", full_name: "Rita Riverside", tenant_id: OTHER_TENANT_ID },
      ]);
      const res = await handle(request({ profile_id: "riverside-teacher" }), clients);
      assertEquals(res.status, 403);
    });
  });

  it("won't reset accounts outside a school (they use the emailed link)", async () => {
    const { res } = await reset("super", "org-admin");
    assertEquals(res.status, 404);
  });

  it("won't reset the caller's own password", async () => {
    const { res } = await reset("school-admin", "school-admin");
    assertEquals(res.status, 400);
  });

  it("reports a failure to set the password, and changes nothing else", async () => {
    const clients = makeClients("school-admin");
    clients.admin.failNextUserUpdate = "boom";
    const res = await handle(request({ profile_id: "student-login" }), clients);
    assertEquals(res.status, 500);
    assertEquals(clients.admin.rowsIn("password_reset_requests")[0].resolved_at, null);
    assertEquals(clients.admin.rowsIn("audit_events").length, 0);
  });
});
