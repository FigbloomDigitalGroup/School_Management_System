import { describe, it } from "jsr:@std/testing/bdd";
import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
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
    { id: STUDENT_ID, tenant_id: TENANT_ID, full_name: "Faith Achieng", profile_id: null },
    { id: OTHER_STUDENT_ID, tenant_id: OTHER_TENANT_ID, full_name: "Someone Else", profile_id: null },
  ]);
  admin.onCreateUser = (attrs) => ({
    data: { user: { id: "new-student-1", email: attrs.email } },
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
  return new Request("https://example.com/provision-student", {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
}

const validBody = { tenant_id: TENANT_ID, student_id: STUDENT_ID };

describe("provision-student handle", () => {
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
    const res = await handle(request({ tenant_id: TENANT_ID }), { admin, asUser });
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
    const res = await handle(request({ ...validBody, student_id: OTHER_STUDENT_ID }), { admin, asUser });
    assertEquals(res.status, 400);
    assertEquals(admin.rowsIn("profiles").find((p) => p.id === "new-student-1"), undefined);
  });

  it("rejects a learner who already has a login", async () => {
    const { admin, asUser } = makeClients();
    admin.seed("students", [{ id: STUDENT_ID, tenant_id: TENANT_ID, full_name: "Faith Achieng", profile_id: "already-has-one" }]);
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 409);
  });

  it("creates the login with an auto-generated ST-prefixed login_id, links the student, and logs an audit event", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.ok, true);
    assertEquals(out.login_id, "ST-0001");
    assertMatch(out.password, /^[a-hjkmnp-zA-HJ-NP-Z2-9]{10}$/);

    const created = admin.rowsIn("profiles").find((p) => p.id === "new-student-1");
    assertEquals(created?.role, "student");
    assertEquals(created?.login_id, "ST-0001");
    assertEquals(created?.tenant_id, TENANT_ID);
    assertEquals(created?.must_change_password, true);
    assertEquals(created?.full_name, "Faith Achieng");

    const student = admin.rowsIn("students").find((s) => s.id === STUDENT_ID);
    assertEquals(student?.profile_id, "new-student-1");

    const audit = admin.rowsIn("audit_events")[0];
    assertMatch(audit.event, /Faith Achieng/);
    assertMatch(audit.event, /ST-0001/);
  });

  it("increments the login_id per tenant", async () => {
    const { admin, asUser } = makeClients();
    admin.seed("profiles", [
      { id: SCHOOL_ADMIN_ID, role: "school_admin", full_name: "Green Valley Admin", tenant_id: TENANT_ID },
      { id: "existing-student-1", role: "student", tenant_id: TENANT_ID, login_id: "ST-0001" },
    ]);
    const res = await handle(request(validBody), { admin, asUser });
    const out = await res.json();
    assertEquals(out.login_id, "ST-0002");
  });

  it("rolls back the profile and auth account if linking the student fails", async () => {
    const { admin, asUser } = makeClients();
    admin.failNextWrite("students", "update failed");
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 500);
    assertEquals(admin.deletedUserIds, ["new-student-1"]);
    assertEquals(admin.rowsIn("profiles").find((p) => p.id === "new-student-1"), undefined);
  });

  // QA 15 (FIG-1248, FIG-1470): the audit entry is the record of who made the account, so an account that cannot be recorded is taken
  // back out and the reply says it was not made (it used to be a plain success with the password).
  it("QA15-AUDIT-IGNORED FIG-1470 (fixed): an audit entry that cannot be written rolls the account back and says it was not made", async () => {
    const { admin, asUser } = makeClients();
    admin.failNextWrite("audit_events", "audit insert failed");
    const res = await handle(request(validBody), { admin, asUser });
    const out = await res.json();
    assertEquals(res.status, 500);
    assertMatch(out.error, /audit log, so the account was not created/);
    assert(!out.password && !out.login_id, "no password is handed out for an account that was removed");
    assertEquals(admin.deletedUserIds, ["new-student-1"]);
    assertEquals(admin.rowsIn("profiles").find((p) => p.id === "new-student-1"), undefined);
    assertEquals(admin.rowsIn("students").find((s) => s.id === STUDENT_ID)?.profile_id ?? null, null, "the learner is unlinked again");
  });

  it("QA15-AUDIT-IGNORED FIG-1470: if the rollback itself fails, the reply says a half-made account may be left", async () => {
    const { admin, asUser } = makeClients();
    // the audit insert fails, and by then the account is made, so the profile delete of the rollback fails as well
    const realFrom = admin.from.bind(admin);
    admin.from = (table: string) => {
      if (table === "audit_events") {
        admin.failNextWrite("audit_events", "audit insert failed");
        admin.failNextWrite("profiles", "profile delete failed");
      }
      return realFrom(table);
    };
    const res = await handle(request(validBody), { admin, asUser });
    const out = await res.json();
    assertEquals(res.status, 500);
    assertMatch(out.error, /could not be fully removed/);
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
      admin.seed("students", [{ id: STUDENT_ID, tenant_id: TENANT_ID, full_name: "Faith Achieng", profile_id: null }]);
      admin.seed("organization_admins", [{ id: "link-1", profile_id: ORG_ADMIN_ID, organization_id: ORG_ID }]);
      admin.seed("organizations", [{ id: ORG_ID, status: "active" }]);
      admin.onCreateUser = (attrs) => ({ data: { user: { id: "new-student-1", email: attrs.email } }, error: null });
      const asUser = new FakeSupabaseClient();
      asUser.authUser = { id: ORG_ADMIN_ID };

      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 200);
    });

    it("refuses an org_admin whose organization is suspended (FIG-1312)", async () => {
      const admin = new FakeSupabaseClient();
      const ORG_ADMIN_ID = "org-admin-1";
      const ORG_ID = "org-1";
      admin.seed("profiles", [{ id: ORG_ADMIN_ID, role: "org_admin", full_name: "Grace Wambui" }]);
      admin.seed("tenants", [{ id: TENANT_ID, name: "Green Valley School", slug: "green-valley", organization_id: ORG_ID }]);
      admin.seed("students", [{ id: STUDENT_ID, tenant_id: TENANT_ID, full_name: "Faith Achieng", profile_id: null }]);
      admin.seed("organization_admins", [{ id: "link-1", profile_id: ORG_ADMIN_ID, organization_id: ORG_ID }]);
      admin.seed("organizations", [{ id: ORG_ID, status: "suspended" }]);
      admin.onCreateUser = (attrs) => ({ data: { user: { id: "new-student-1", email: attrs.email } }, error: null });
      const asUser = new FakeSupabaseClient();
      asUser.authUser = { id: ORG_ADMIN_ID };

      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 403);
      assertEquals(admin.rowsIn("profiles").length, 1);
    });
  });
});

describe("provision-student login_id numbering", () => {
  it("numbers past the first 1000 learners, where a row count would stop", async () => {
    const { admin, asUser } = makeClients();
    admin.seed("profiles", [
      { id: SCHOOL_ADMIN_ID, role: "school_admin", full_name: "Green Valley Admin", tenant_id: TENANT_ID },
      { id: "s-a", role: "student", tenant_id: TENANT_ID, login_id: "ST-0999" },
      { id: "s-b", role: "student", tenant_id: TENANT_ID, login_id: "ST-1000" },
      { id: "s-c", role: "student", tenant_id: TENANT_ID, login_id: "ST-1203" },
    ]);
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals((await res.json()).login_id, "ST-1204");
  });

  it("answers 500 and creates nothing when the numbering lookup fails", async () => {
    const { admin, asUser } = makeClients();
    admin.failNextRpc("database unavailable");
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 500);
    assertEquals(admin.rowsIn("students").find((s) => s.id === STUDENT_ID)?.profile_id, null);
    assertEquals(admin.deletedUserIds, []);
  });
});
