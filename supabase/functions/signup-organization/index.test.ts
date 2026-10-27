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

/** Lets every attempt through, unless a test says otherwise. */
const open = async () => true;
const deps = (admin: FakeSupabaseClient) => ({ admin, withinLimit: open });

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
    const res = await handle(request(validBody, { method: "OPTIONS" }), deps(admin));
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("rejects non-POST requests", async () => {
    const admin = makeClient();
    const res = await handle(request(validBody, { method: "GET" }), deps(admin));
    assertEquals(res.status, 405);
  });

  it("requires no Authorization header at all -- there is no caller to check", async () => {
    const admin = makeClient();
    const res = await handle(request(validBody), deps(admin));
    assertEquals(res.status, 200);
  });

  it("rejects a missing organization name", async () => {
    const admin = makeClient();
    const res = await handle(request({ ...validBody, name: "" }), deps(admin));
    assertEquals(res.status, 400);
  });

  it("rejects an invalid slug", async () => {
    const admin = makeClient();
    const res = await handle(request({ ...validBody, slug: "N" }), deps(admin));
    assertEquals(res.status, 400);
  });

  it("rejects a reserved slug", async () => {
    const admin = makeClient();
    const res = await handle(request({ ...validBody, slug: "admin" }), deps(admin));
    assertEquals(res.status, 400);
  });

  it("rejects an invalid organization kind", async () => {
    const admin = makeClient();
    const res = await handle(request({ ...validBody, kind: "school" }), deps(admin));
    assertEquals(res.status, 400);
  });

  it("rejects a short password", async () => {
    const admin = makeClient();
    const res = await handle(request({ ...validBody, admin_password: "short" }), deps(admin));
    assertEquals(res.status, 400);
  });

  it("409s when the slug is already taken", async () => {
    const admin = makeClient();
    admin.seed("organizations", [{ id: "existing-org", slug: validBody.slug, name: "Already here" }]);
    const res = await handle(request(validBody), deps(admin));
    assertEquals(res.status, 409);
  });

  it("creates the organization active (no approval step for now), the org_admin account, the link, and an audit event", async () => {
    const admin = makeClient();
    const res = await handle(request(validBody), deps(admin));
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.ok, true);
    assertEquals(out.slug, validBody.slug);

    const orgs = admin.rowsIn("organizations");
    assertEquals(orgs.length, 1);
    assertEquals(orgs[0].status, "active");
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
    assertEquals(/pending/.test(audit.event), false);
  });

  it("reports a 409 when the email is already registered", async () => {
    const admin = makeClient();
    // The real Supabase Auth message, not a paraphrase — "already registered"
    // alone would silently defeat the substring check (a bug found and fixed
    // in invite-admin/invite-org-admin earlier this session).
    admin.onCreateUser = () => ({ data: { user: null }, error: { message: "A user with this email address has already been registered" } });
    const res = await handle(request(validBody), deps(admin));
    assertEquals(res.status, 409);
  });

  it("rolls back the auth account if the organization insert fails", async () => {
    const admin = makeClient();
    admin.failNextWrite("organizations", "insert failed");
    const res = await handle(request(validBody), deps(admin));
    assertEquals(res.status, 500);
    assertEquals((await res.json()).error, "Could not create the organization. Try again.");
    assertEquals(admin.deletedUserIds, ["new-org-admin-1"]);
  });

  it("rolls back the organization and auth account if the profile insert fails", async () => {
    const admin = makeClient();
    admin.failNextWrite("profiles", "insert failed");
    const res = await handle(request(validBody), deps(admin));
    assertEquals(res.status, 500);
    assertEquals((await res.json()).error, "Could not finish creating the account. Try again.");
    assertEquals(admin.deletedUserIds, ["new-org-admin-1"]);
    assertEquals(admin.rowsIn("organizations").length, 0);
  });

  it("rolls back the profile, organization and auth account if the organization_admins link fails", async () => {
    const admin = makeClient();
    admin.failNextWrite("organization_admins", "link failed");
    const res = await handle(request(validBody), deps(admin));
    assertEquals(res.status, 500);
    assertEquals((await res.json()).error, "Could not finish creating the account. Try again.");
    assertEquals(admin.deletedUserIds, ["new-org-admin-1"]);
    assertEquals(admin.rowsIn("organizations").length, 0);
    assertEquals(admin.rowsIn("profiles").find((p) => p.id === "new-org-admin-1"), undefined);
  });
  it("never hands the auth service's own error message to the caller", async () => {
    const admin = makeClient();
    admin.onCreateUser = () => ({ data: { user: null }, error: { message: "duplicate key value violates unique constraint users_pkey" } });
    const res = await handle(request(validBody), deps(admin));
    assertEquals(res.status, 500);
    const raw = await res.text();
    assertEquals(raw.includes("users_pkey"), false);
    assertEquals(JSON.parse(raw).error, "Could not create the account. Try again.");
  });

  describe("abuse protection", () => {
    it("answers 429 without creating anything once the caller is over its allowance", async () => {
      const admin = makeClient();
      const res = await handle(request(validBody), { admin, withinLimit: async () => false });
      assertEquals(res.status, 429);
      assertEquals((await res.json()).error, "Too many sign-up attempts from here. Wait a while and try again.");
      assertEquals(admin.rowsIn("organizations").length, 0);
      assertEquals(admin.rowsIn("profiles").length, 0);
    });

    it("counts a malformed request against the allowance too, before reading it", async () => {
      const admin = makeClient();
      let counted = 0;
      const res = await handle(new Request("https://example.com/signup-organization", { method: "POST", body: "not json" }),
        { admin, withinLimit: async () => { counted++; return true; } });
      assertEquals(res.status, 400);
      assertEquals(counted, 1);
    });
  });
});
