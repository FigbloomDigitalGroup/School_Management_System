import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals, assertMatch } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle } from "./index.ts";

const SUPER_ADMIN_ID = "super-admin-1";
const ORG_ID = "org-1";

function makeClients(opts: { role?: string } = {}) {
  const admin = new FakeSupabaseClient();
  admin.seed("profiles", [
    { id: SUPER_ADMIN_ID, role: opts.role ?? "super_admin", full_name: "Jane Figbloom" },
  ]);
  admin.seed("organizations", [{ id: ORG_ID, name: "Nakuru County" }]);
  admin.onCreateUser = (attrs) => ({
    data: { user: { id: "new-org-admin-1", email: attrs.email } },
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
  return new Request("https://example.com/invite-org-admin", {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
}

const validBody = {
  organization_id: ORG_ID,
  full_name: "Grace Wambui",
  email: "grace@nakuru.go.ke",
};

describe("invite-org-admin handle", () => {
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

  it("rejects a caller who is neither super_admin nor org_admin", async () => {
    const { admin, asUser } = makeClients({ role: "school_admin" });
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 403);
  });

  it("rejects a body missing required fields", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ organization_id: ORG_ID }), { admin, asUser });
    assertEquals(res.status, 400);
  });

  it("404s when the organization does not exist", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ ...validBody, organization_id: "missing" }), { admin, asUser });
    assertEquals(res.status, 404);
  });

  it("creates the org-admin account, profile, organization_admins link, and an audit event", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.ok, true);
    assertEquals(out.email, validBody.email);
    assertEquals(out.linkedExisting, false);

    const profiles = admin.rowsIn("profiles");
    const created = profiles.find((p) => p.id === "new-org-admin-1");
    assertEquals(created?.role, "org_admin");
    assertEquals(created?.tenant_id, null);

    const links = admin.rowsIn("organization_admins");
    assertEquals(links.length, 1);
    assertEquals(links[0].profile_id, "new-org-admin-1");
    assertEquals(links[0].organization_id, ORG_ID);

    const audit = admin.rowsIn("audit_events")[0];
    assertMatch(audit.event, /Grace Wambui/);
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
    assertEquals(admin.deletedUserIds, ["new-org-admin-1"]);
  });

  it("rolls back the profile and auth account if the organization_admins link fails", async () => {
    const { admin, asUser } = makeClients();
    admin.failNextWrite("organization_admins", "link failed");

    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 500);
    assertEquals(admin.deletedUserIds, ["new-org-admin-1"]);
    assertEquals(admin.rowsIn("profiles").find((p) => p.id === "new-org-admin-1"), undefined);
  });

  describe("org_admin caller (FIG-389)", () => {
    const ORG_ADMIN_ID = "org-admin-1";
    const OTHER_ORG_ID = "org-2";

    function makeOrgAdminClients(opts: { linkedOrgId?: string } = {}) {
      const admin = new FakeSupabaseClient();
      admin.seed("profiles", [{ id: ORG_ADMIN_ID, role: "org_admin", full_name: "Grace Wambui" }]);
      admin.seed("organizations", [{ id: ORG_ID, name: "Nakuru County" }]);
      if (opts.linkedOrgId !== undefined) {
        admin.seed("organization_admins", [{ id: "link-1", profile_id: ORG_ADMIN_ID, organization_id: opts.linkedOrgId }]);
      }
      admin.onCreateUser = (attrs) => ({ data: { user: { id: "new-org-admin-1", email: attrs.email } }, error: null });

      const asUser = new FakeSupabaseClient();
      asUser.authUser = { id: ORG_ADMIN_ID };
      return { admin, asUser };
    }

    it("allows an org_admin to invite a co-admin into their own organization", async () => {
      const { admin, asUser } = makeOrgAdminClients({ linkedOrgId: ORG_ID });
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 200);
      const audit = admin.rowsIn("audit_events")[0];
      assertMatch(audit.actor_label, /Grace Wambui · org admin/);
    });

    it("rejects an org_admin inviting into a DIFFERENT organization they don't administer", async () => {
      const { admin, asUser } = makeOrgAdminClients({ linkedOrgId: OTHER_ORG_ID });
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 403);
    });

    it("rejects an org_admin who administers no organization at all", async () => {
      const { admin, asUser } = makeOrgAdminClients();
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 403);
    });
  });

  describe("create-or-link an existing account (FIG-389)", () => {
    it("links an existing org_admin to a second organization instead of creating a new account", async () => {
      const { admin, asUser } = makeClients();
      admin.seed("profiles", [
        { id: SUPER_ADMIN_ID, role: "super_admin", full_name: "Jane Figbloom" },
        { id: "existing-org-admin-1", role: "org_admin", full_name: "Peter Otieno", email: validBody.email },
      ]);
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 200);
      const out = await res.json();
      assertEquals(out.linkedExisting, true);
      assertEquals(out.password, undefined);

      // no new account was created for this invite
      assertEquals(admin.rowsIn("profiles").find((p) => p.id === "new-org-admin-1"), undefined);

      const links = admin.rowsIn("organization_admins");
      assertEquals(links.length, 1);
      assertEquals(links[0].profile_id, "existing-org-admin-1");
      assertEquals(links[0].organization_id, ORG_ID);
    });

    it("rejects re-inviting someone who already administers this exact organization", async () => {
      const { admin, asUser } = makeClients();
      admin.seed("profiles", [
        { id: SUPER_ADMIN_ID, role: "super_admin", full_name: "Jane Figbloom" },
        { id: "existing-org-admin-1", role: "org_admin", full_name: "Peter Otieno", email: validBody.email },
      ]);
      admin.seed("organization_admins", [{ id: "link-1", profile_id: "existing-org-admin-1", organization_id: ORG_ID }]);
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 409);
    });

    it("rejects reusing an email that belongs to a non-org_admin account", async () => {
      const { admin, asUser } = makeClients();
      admin.seed("profiles", [
        { id: SUPER_ADMIN_ID, role: "super_admin", full_name: "Jane Figbloom" },
        { id: "some-school-admin-1", role: "school_admin", full_name: "Someone Else", email: validBody.email },
      ]);
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 409);
      assertEquals(admin.rowsIn("organization_admins").length, 0);
    });
  });
});
