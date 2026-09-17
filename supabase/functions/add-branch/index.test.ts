import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals, assertMatch } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle } from "./index.ts";

const SCHOOL_ADMIN_ID = "school-admin-1";
const TENANT_ID = "tenant-1";

function makeClients(opts: { role?: string; tenantId?: string | null; organizationId?: string | null } = {}) {
  const admin = new FakeSupabaseClient();
  admin.seed("profiles", [
    { id: SCHOOL_ADMIN_ID, role: opts.role ?? "school_admin", full_name: "Green Valley Admin", tenant_id: opts.tenantId === undefined ? TENANT_ID : opts.tenantId },
  ]);
  admin.seed("tenants", [{ id: TENANT_ID, name: "Green Valley School", organization_id: opts.organizationId ?? null }]);
  admin.onCreateUser = (attrs) => ({
    data: { user: { id: "new-org-admin-1", email: attrs.email } },
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
  return new Request("https://example.com/add-branch", {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
}

const validBody = {
  org_name: "Green Valley Group",
  org_slug: "green-valley-group",
  admin_full_name: "Rose Achieng",
  admin_email: "rose@greenvalleygroup.example",
};

describe("add-branch handle", () => {
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

  it("rejects a caller who isn't a school_admin", async () => {
    const { admin, asUser } = makeClients({ role: "teacher" });
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 403);
  });

  it("rejects a school that already belongs to an organization", async () => {
    const { admin, asUser } = makeClients({ organizationId: "existing-org" });
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 409);
  });

  it("rejects a body missing required fields", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ org_name: "Green Valley Group" }), { admin, asUser });
    assertEquals(res.status, 400);
  });

  it("rejects an invalid slug", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ ...validBody, org_slug: "!!" }), { admin, asUser });
    assertEquals(res.status, 400);
  });

  it("rejects a reserved slug", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ ...validBody, org_slug: "admin" }), { admin, asUser });
    assertEquals(res.status, 400);
  });

  it("rejects a slug that's already taken", async () => {
    const { admin, asUser } = makeClients();
    admin.seed("organizations", [{ id: "org-x", slug: "green-valley-group" }]);
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 409);
  });

  it("rejects an email that's already in use", async () => {
    const { admin, asUser } = makeClients();
    admin.seed("profiles", [
      { id: SCHOOL_ADMIN_ID, role: "school_admin", full_name: "Green Valley Admin", tenant_id: TENANT_ID },
      { id: "someone-else", role: "parent", email: "rose@greenvalleygroup.example" },
    ]);
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 409);
  });

  it("creates the organization pending approval, links the caller's own school, creates the org_admin login, and logs an audit event", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.ok, true);
    assertEquals(out.org_slug, "green-valley-group");
    assertEquals(out.email, "rose@greenvalleygroup.example");
    assertEquals(out.password, "figbloom-dev");

    const org = admin.rowsIn("organizations").find((o) => o.slug === "green-valley-group");
    assertEquals(org?.status, "pending");
    assertEquals(org?.kind, "group_owner");

    const tenant = admin.rowsIn("tenants").find((t) => t.id === TENANT_ID);
    assertEquals(tenant?.organization_id, org?.id);

    const newAdmin = admin.rowsIn("profiles").find((p) => p.id === "new-org-admin-1");
    assertEquals(newAdmin?.role, "org_admin");
    assertEquals(newAdmin?.tenant_id, null);

    const link = admin.rowsIn("organization_admins")[0];
    assertEquals(link.profile_id, "new-org-admin-1");
    assertEquals(link.organization_id, org?.id);

    const audit = admin.rowsIn("audit_events")[0];
    assertMatch(audit.event, /Green Valley Group/);
  });

  it("rolls back the organization and tenant link if creating the login fails", async () => {
    const { admin, asUser } = makeClients();
    admin.onCreateUser = () => ({ data: { user: null }, error: { message: "boom" } });
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 500);
    assertEquals(admin.rowsIn("organizations").length, 0);
    const tenant = admin.rowsIn("tenants").find((t) => t.id === TENANT_ID);
    assertEquals(tenant?.organization_id, null);
  });
});
