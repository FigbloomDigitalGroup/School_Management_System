import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals, assertMatch } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle } from "./index.ts";

const SCHOOL_ADMIN_ID = "school-admin-1";
const TENANT_ID = "tenant-1";
const TEACHER_ID = "teacher-1";
const OTHER_TENANT_ID = "tenant-2";

function makeClients(opts: { role?: string; callerTenantId?: string; targetRole?: string } = {}) {
  const admin = new FakeSupabaseClient();
  admin.seed("profiles", [
    { id: SCHOOL_ADMIN_ID, role: opts.role ?? "school_admin", full_name: "Green Valley Admin", tenant_id: opts.callerTenantId ?? TENANT_ID },
    { id: TEACHER_ID, role: opts.targetRole ?? "teacher", full_name: "Grace Achieng", tenant_id: TENANT_ID },
  ]);
  admin.seed("tenants", [{ id: TENANT_ID, name: "Green Valley School", slug: "green-valley" }]);

  const asUser = new FakeSupabaseClient();
  asUser.authUser = { id: SCHOOL_ADMIN_ID };

  return { admin, asUser };
}

function request(body: unknown, opts: { method?: string; auth?: string | null } = {}) {
  const method = opts.method ?? "POST";
  const headers = new Headers();
  if (opts.auth !== null) headers.set("Authorization", opts.auth ?? "Bearer token");
  return new Request("https://example.com/delete-account", {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
}

const validBody = { tenant_id: TENANT_ID, profile_id: TEACHER_ID };

describe("delete-account handle", () => {
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

  it("rejects a teacher without the people area", async () => {
    const { admin, asUser } = makeClients({ role: "teacher" });
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 403);
  });

  it("rejects a parent, whatever a stray grant row says", async () => {
    const { admin, asUser } = makeClients({ role: "parent" });
    admin.seed("staff_permissions", [{ tenant_id: TENANT_ID, profile_id: SCHOOL_ADMIN_ID, area: "people" }]);
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 403);
  });

  describe("a teacher or other staff member with the people area (20261030000000)", () => {
    function withPeople(targetRole = "teacher") {
      const clients = makeClients({ role: "staff", targetRole });
      clients.admin.seed("staff_permissions", [{ tenant_id: TENANT_ID, profile_id: SCHOOL_ADMIN_ID, area: "people" }]);
      return clients;
    }

    it("removes a teacher", async () => {
      const { admin, asUser } = withPeople();
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 200);
      assertEquals(admin.deletedUserIds, [TEACHER_ID]);
    });

    it("never removes an administrator", async () => {
      const { admin, asUser } = withPeople("school_admin");
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 403);
      assertEquals(admin.deletedUserIds, []);
    });

    it("is refused with only another area", async () => {
      const { admin, asUser } = makeClients({ role: "staff" });
      admin.seed("staff_permissions", [{ tenant_id: TENANT_ID, profile_id: SCHOOL_ADMIN_ID, area: "fees" }]);
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 403);
    });
  });

  it("rejects a body missing required fields", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ tenant_id: TENANT_ID }), { admin, asUser });
    assertEquals(res.status, 400);
  });

  it("rejects deleting your own account", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ tenant_id: TENANT_ID, profile_id: SCHOOL_ADMIN_ID }), { admin, asUser });
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

  it("rejects a target who isn't staff (e.g. a student/parent/guardian profile)", async () => {
    const { admin, asUser } = makeClients({ targetRole: "parent" });
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 400);
  });

  it("rejects a target belonging to a different tenant", async () => {
    const { admin, asUser } = makeClients();
    admin.seed("profiles", [
      { id: SCHOOL_ADMIN_ID, role: "school_admin", full_name: "Green Valley Admin", tenant_id: TENANT_ID },
      { id: TEACHER_ID, role: "teacher", full_name: "Grace Achieng", tenant_id: OTHER_TENANT_ID },
    ]);
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 400);
  });

  it("removes the profile and the login when there's no history blocking it", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.ok, true);
    assertEquals(admin.rowsIn("profiles").find((p) => p.id === TEACHER_ID), undefined);
    assertEquals(admin.deletedUserIds, [TEACHER_ID]);
  });

  it("removes other staff (a librarian, a guard) the same way", async () => {
    const { admin, asUser } = makeClients({ targetRole: "staff" });
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 200);
    assertEquals(admin.deletedUserIds, [TEACHER_ID]);
  });

  it("translates a foreign-key violation into a friendly, non-blocking-looking error and keeps the profile", async () => {
    const { admin, asUser } = makeClients();
    admin.failNextWrite("profiles", "update or delete on table \"profiles\" violates foreign key constraint \"attendance_taken_by_fkey\"");
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 409);
    const out = await res.json();
    assertMatch(out.error, /Grace Achieng/);
    assertMatch(out.error, /records on file/);
    assertEquals(admin.rowsIn("profiles").find((p) => p.id === TEACHER_ID)?.id, TEACHER_ID);
    assertEquals(admin.deletedUserIds, []);
  });

  it("still reports success if the profile is gone but the login itself failed to delete, with a warning", async () => {
    const { admin, asUser } = makeClients();
    const originalDeleteUser = admin.auth.admin.deleteUser;
    // deno-lint-ignore no-explicit-any
    (admin.auth.admin as any).deleteUser = async (id: string) => {
      await originalDeleteUser(id);
      return { error: { message: "auth service unavailable" } };
    };
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.ok, true);
    assertMatch(out.warning, /Grace Achieng/);
    assertEquals(admin.rowsIn("profiles").find((p) => p.id === TEACHER_ID), undefined);
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
      admin.seed("profiles", [
        { id: ORG_ADMIN_ID, role: "org_admin", full_name: "Grace Wambui" },
        { id: TEACHER_ID, role: "teacher", full_name: "Grace Achieng", tenant_id: TENANT_ID },
      ]);
      admin.seed("tenants", [{ id: TENANT_ID, name: "Green Valley School", slug: "green-valley", organization_id: ORG_ID }]);
      admin.seed("organization_admins", [{ id: "link-1", profile_id: ORG_ADMIN_ID, organization_id: ORG_ID }]);
      const asUser = new FakeSupabaseClient();
      asUser.authUser = { id: ORG_ADMIN_ID };

      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 200);
    });

    it("rejects an org_admin who doesn't administer this school's organization", async () => {
      const admin = new FakeSupabaseClient();
      const ORG_ADMIN_ID = "org-admin-1";
      admin.seed("profiles", [
        { id: ORG_ADMIN_ID, role: "org_admin", full_name: "Grace Wambui" },
        { id: TEACHER_ID, role: "teacher", full_name: "Grace Achieng", tenant_id: TENANT_ID },
      ]);
      admin.seed("tenants", [{ id: TENANT_ID, name: "Green Valley School", slug: "green-valley", organization_id: "org-1" }]);
      const asUser = new FakeSupabaseClient();
      asUser.authUser = { id: ORG_ADMIN_ID };

      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 403);
    });
  });
});
