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

function makeClients(opts: { role?: string } = {}) {
  const admin = new FakeSupabaseClient();
  admin.seed("profiles", [
    { id: SUPER_ADMIN_ID, role: opts.role ?? "super_admin", full_name: "Jane Figbloom" },
  ]);
  admin.seed("tenants", [{ id: TENANT_ID, name: "Green Valley School" }]);
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
    admin.onCreateUser = () => ({ data: { user: null }, error: { message: "Email already registered" } });
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
});
