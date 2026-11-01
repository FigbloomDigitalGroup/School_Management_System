import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals, assertMatch } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { FakeMailer } from "../_shared/fakeMailer.ts";
import { handle } from "./index.ts";

/** generateLink creates the account unconfirmed, with id "new-org-admin-1" and a confirmation link. */
function makeClient() {
  const admin = new FakeSupabaseClient();
  admin.onGenerateLink = (params) => {
    const user = { id: "new-org-admin-1", email: params.email, email_confirmed_at: null };
    admin.authUsers.set(user.id, user);
    return { data: { user, properties: { action_link: "https://auth.example.test/verify?token=confirm-me" } }, error: null };
  };
  return admin;
}

/** Lets every attempt through, unless a test says otherwise. */
const open = async () => true;
const deps = (admin: FakeSupabaseClient, mailer = new FakeMailer()) => ({ admin, withinLimit: open, mailer });

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

  it("creates the organization active, the org_admin account unconfirmed, the link, and an audit event, and emails the confirmation", async () => {
    const admin = makeClient();
    const mailer = new FakeMailer();
    const res = await handle(request(validBody), deps(admin, mailer));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true, confirm_email: true });

    const orgs = admin.rowsIn("organizations");
    assertEquals(orgs.length, 1);
    assertEquals(orgs[0].status, "active");
    assertEquals(orgs[0].created_by, null);

    const created = admin.rowsIn("profiles").find((p) => p.id === "new-org-admin-1");
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

  // FIG-1337: nobody can use an address they haven't proved is theirs
  describe("the address is proved before the account can be used (FIG-1337)", () => {
    it("creates the account unconfirmed, with the signer's own password, never with email_confirm", async () => {
      const admin = makeClient();
      await handle(request(validBody), deps(admin));
      assertEquals(admin.generatedLinks.length, 1);
      assertEquals(admin.generatedLinks[0].type, "signup");
      assertEquals(admin.generatedLinks[0].password, validBody.admin_password);
      assertEquals("email_confirm" in admin.generatedLinks[0], false);
      assertEquals(admin.authUsers.get("new-org-admin-1")?.email_confirmed_at, null);
    });

    it("sends the confirmation link to the address", async () => {
      const admin = makeClient();
      const mailer = new FakeMailer();
      await handle(request(validBody), deps(admin, mailer));
      assertEquals(mailer.sent.length, 1);
      assertEquals(mailer.sent[0].to, validBody.admin_email);
      assertEquals(mailer.sent[0].template, "signup-confirm");
      assertMatch(mailer.sent[0].text, /https:\/\/auth\.example\.test\/verify\?token=confirm-me/);
    });

    it("answers an address that already has an account exactly as a new one, creates nothing, and tells only the owner", async () => {
      const admin = makeClient();
      admin.seed("profiles", [{ id: "owner-1", email: validBody.admin_email, full_name: "Grace Owner", role: "org_admin" }]);
      admin.authUsers.set("owner-1", { id: "owner-1", email: validBody.admin_email, email_confirmed_at: "2026-10-01T00:00:00Z" });
      const mailer = new FakeMailer();
      const res = await handle(request(validBody), deps(admin, mailer));
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { ok: true, confirm_email: true });
      assertEquals(admin.rowsIn("organizations").length, 0);
      assertEquals(admin.generatedLinks.length, 0);
      assertEquals(mailer.sent.map((m) => [m.to, m.template]), [[validBody.admin_email, "signup-taken"]]);
    });

    it("clears an earlier sign-up that was never confirmed, and lets the real owner sign up", async () => {
      const admin = makeClient();
      admin.seed("profiles", [{ id: "squatter-1", email: validBody.admin_email, full_name: "Not Grace", role: "org_admin" }]);
      admin.authUsers.set("squatter-1", { id: "squatter-1", email: validBody.admin_email, email_confirmed_at: null });
      admin.seed("organizations", [{ id: "held-org", slug: "held", name: "Held", created_by: null }]);
      admin.seed("organization_admins", [{ id: "l1", profile_id: "squatter-1", organization_id: "held-org" }]);
      const mailer = new FakeMailer();
      const res = await handle(request(validBody), deps(admin, mailer));
      assertEquals(res.status, 200);
      assertEquals(admin.deletedUserIds, ["squatter-1"]);
      assertEquals(admin.rowsIn("organizations").map((o) => o.slug), [validBody.slug]);
      assertEquals(mailer.sent[0].template, "signup-confirm");
    });

    it("answers an Auth account left without a profile the same way, and sends nothing", async () => {
      const admin = makeClient();
      admin.onGenerateLink = () => ({ data: { user: null, properties: null }, error: { message: "A user with this email address has already been registered" } });
      const mailer = new FakeMailer();
      const res = await handle(request(validBody), deps(admin, mailer));
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { ok: true, confirm_email: true });
      assertEquals(mailer.sent.length, 0);
    });

    it("undoes the whole sign-up when the confirmation can't be sent", async () => {
      const admin = makeClient();
      const mailer = new FakeMailer();
      mailer.answer = { status: "failed", reason: "Resend answered 422" };
      const res = await handle(request(validBody), deps(admin, mailer));
      assertEquals(res.status, 502);
      assertEquals(admin.deletedUserIds, ["new-org-admin-1"]);
      assertEquals(admin.rowsIn("organizations").length, 0);
      assertEquals(admin.rowsIn("profiles").length, 0);
    });

    it("is closed, creating nothing, when there's no mailer to send the confirmation", async () => {
      const admin = makeClient();
      const mailer = new FakeMailer();
      mailer.configured = false;
      const res = await handle(request(validBody), deps(admin, mailer));
      assertEquals(res.status, 503);
      assertEquals(admin.generatedLinks.length, 0);
      assertEquals(admin.rowsIn("organizations").length, 0);
    });
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
    admin.onGenerateLink = () => ({ data: { user: null, properties: null }, error: { message: "duplicate key value violates unique constraint users_pkey" } });
    const res = await handle(request(validBody), deps(admin));
    assertEquals(res.status, 500);
    const raw = await res.text();
    assertEquals(raw.includes("users_pkey"), false);
    assertEquals(JSON.parse(raw).error, "Could not create the account. Try again.");
  });

  describe("abuse protection", () => {
    it("answers 429 without creating anything once the caller is over its allowance", async () => {
      const admin = makeClient();
      const res = await handle(request(validBody), { admin, withinLimit: async () => false, mailer: new FakeMailer() });
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
