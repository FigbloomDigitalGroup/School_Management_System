import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals, assertMatch } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle } from "./index.ts";

function makeClient() {
  const admin = new FakeSupabaseClient();
  admin.onCreateUser = (attrs) => ({
    data: { user: { id: "new-org-admin-1", email: attrs.email } },
    error: null,
  });
  return admin;
}

function request(body: unknown, opts: { method?: string } = {}) {
  const method = opts.method ?? "POST";
  return new Request("https://example.com/signup-organization", {
    method,
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
}

const validBody = {
  name: "Nakuru County Schools",
  slug: "nakuru-county-schools",
  kind: "county",
  county: "Nakuru",
  admin_full_name: "Grace Wambui",
  admin_email: "grace@nakuru.go.ke",
  admin_password: "a-real-password-123",
};

describe("signup-organization handle", () => {
  it("answers an OPTIONS preflight with CORS headers, no auth required", async () => {
    const admin = makeClient();
    const res = await handle(request(validBody, { method: "OPTIONS" }), { admin });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("rejects non-POST requests", async () => {
    const admin = makeClient();
    const res = await handle(request(validBody, { method: "GET" }), { admin });
    assertEquals(res.status, 405);
  });

  it("requires no Authorization header at all -- there is no caller to check", async () => {
    const admin = makeClient();
    const res = await handle(request(validBody), { admin });
    assertEquals(res.status, 200);
  });

  it("rejects a missing organization name", async () => {
    const admin = makeClient();
    const res = await handle(request({ ...validBody, name: "" }), { admin });
    assertEquals(res.status, 400);
  });

  it("rejects an invalid slug", async () => {
    const admin = makeClient();
    const res = await handle(request({ ...validBody, slug: "N" }), { admin });
    assertEquals(res.status, 400);
  });

  it("rejects a reserved slug", async () => {
    const admin = makeClient();
    const res = await handle(request({ ...validBody, slug: "admin" }), { admin });
    assertEquals(res.status, 400);
  });

  it("rejects an invalid organization kind", async () => {
    const admin = makeClient();
    const res = await handle(request({ ...validBody, kind: "school" }), { admin });
    assertEquals(res.status, 400);
  });

  it("rejects a short password", async () => {
    const admin = makeClient();
    const res = await handle(request({ ...validBody, admin_password: "short" }), { admin });
    assertEquals(res.status, 400);
  });

  it("409s when the slug is already taken", async () => {
    const admin = makeClient();
    admin.seed("organizations", [{ id: "existing-org", slug: validBody.slug, name: "Already here" }]);
    const res = await handle(request(validBody), { admin });
    assertEquals(res.status, 409);
  });

  it("creates the organization pending, the org_admin account, the link, and an audit event", async () => {
    const admin = makeClient();
    const res = await handle(request(validBody), { admin });
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.ok, true);
    assertEquals(out.slug, validBody.slug);

    const orgs = admin.rowsIn("organizations");
    assertEquals(orgs.length, 1);
    assertEquals(orgs[0].status, "pending");
    assertEquals(orgs[0].created_by, null);

    const profiles = admin.rowsIn("profiles");
    const created = profiles.find((p) => p.id === "new-org-admin-1");
    assertEquals(created?.role, "org_admin");
    assertEquals(created?.tenant_id, null);

    const links = admin.rowsIn("organization_admins");
    assertEquals(links.length, 1);
    assertEquals(links[0].profile_id, "new-org-admin-1");
    assertEquals(links[0].organization_id, orgs[0].id);
    assertEquals(links[0].added_by, null);

    const audit = admin.rowsIn("audit_events")[0];
    assertMatch(audit.event, /Nakuru County Schools/);
    assertMatch(audit.event, /pending/);
  });

  it("reports a 409 when the email is already registered", async () => {
    const admin = makeClient();
    // The real Supabase Auth message, not a paraphrase — "already registered"
    // alone would silently defeat the substring check (a bug found and fixed
    // in invite-admin/invite-org-admin earlier this session).
    admin.onCreateUser = () => ({ data: { user: null }, error: { message: "A user with this email address has already been registered" } });
    const res = await handle(request(validBody), { admin });
    assertEquals(res.status, 409);
  });

  it("rolls back the auth account if the organization insert fails", async () => {
    const admin = makeClient();
    admin.failNextWrite("organizations", "insert failed");
    const res = await handle(request(validBody), { admin });
    assertEquals(res.status, 500);
    assertEquals(admin.deletedUserIds, ["new-org-admin-1"]);
  });

  it("rolls back the organization and auth account if the profile insert fails", async () => {
    const admin = makeClient();
    admin.failNextWrite("profiles", "insert failed");
    const res = await handle(request(validBody), { admin });
    assertEquals(res.status, 500);
    assertEquals(admin.deletedUserIds, ["new-org-admin-1"]);
    assertEquals(admin.rowsIn("organizations").length, 0);
  });

  it("rolls back the profile, organization and auth account if the organization_admins link fails", async () => {
    const admin = makeClient();
    admin.failNextWrite("organization_admins", "link failed");
    const res = await handle(request(validBody), { admin });
    assertEquals(res.status, 500);
    assertEquals(admin.deletedUserIds, ["new-org-admin-1"]);
    assertEquals(admin.rowsIn("organizations").length, 0);
    assertEquals(admin.rowsIn("profiles").find((p) => p.id === "new-org-admin-1"), undefined);
  });
});
