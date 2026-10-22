import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals, assertMatch } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle } from "./index.ts";

const ORG_ADMIN_ID = "org-admin-1";

function makeClients(opts: { role?: string } = {}) {
  const admin = new FakeSupabaseClient();
  admin.seed("profiles", [
    { id: ORG_ADMIN_ID, role: opts.role ?? "org_admin", full_name: "Grace Wambui", email: "grace@nakuru.go.ke" },
  ]);

  const asUser = new FakeSupabaseClient();
  asUser.authUser = { id: ORG_ADMIN_ID };

  return { admin, asUser };
}

function request(body: unknown, opts: { method?: string; auth?: string | null } = {}) {
  const method = opts.method ?? "POST";
  const headers = new Headers();
  if (opts.auth !== null) headers.set("Authorization", opts.auth ?? "Bearer token");
  return new Request("https://example.com/create-organization", {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
}

const validBody = {
  name: "Rift Valley Academies",
  slug: "rift-valley-academies",
  kind: "group_owner",
  county: "Uasin Gishu",
};

describe("create-organization handle", () => {
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

  it("rejects a caller who is not an org_admin", async () => {
    const { admin, asUser } = makeClients({ role: "school_admin" });
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 403);
  });

  it("rejects a missing organization name", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ ...validBody, name: "" }), { admin, asUser });
    assertEquals(res.status, 400);
  });

  it("rejects an invalid slug", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ ...validBody, slug: "N" }), { admin, asUser });
    assertEquals(res.status, 400);
  });

  it("rejects a reserved slug", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ ...validBody, slug: "admin" }), { admin, asUser });
    assertEquals(res.status, 400);
  });

  it("rejects an invalid organization kind", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ ...validBody, kind: "school" }), { admin, asUser });
    assertEquals(res.status, 400);
  });

  it("409s when the slug is already taken", async () => {
    const { admin, asUser } = makeClients();
    admin.seed("organizations", [{ id: "existing-org", slug: validBody.slug, name: "Already here" }]);
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 409);
  });

  it("creates the organization pending, links the caller's own profile, and logs an audit event", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.ok, true);
    assertEquals(out.slug, validBody.slug);

    const orgs = admin.rowsIn("organizations");
    assertEquals(orgs.length, 1);
    assertEquals(orgs[0].status, "pending");
    assertEquals(orgs[0].created_by, ORG_ADMIN_ID);
    assertEquals(orgs[0].contact_name, "Grace Wambui");
    assertEquals(orgs[0].contact_email, "grace@nakuru.go.ke");

    // no new auth account or profile -- the caller's own login now covers
    // this organization too, the same as any other create-or-link path.
    const profiles = admin.rowsIn("profiles");
    assertEquals(profiles.length, 1);

    const links = admin.rowsIn("organization_admins");
    assertEquals(links.length, 1);
    assertEquals(links[0].profile_id, ORG_ADMIN_ID);
    assertEquals(links[0].organization_id, orgs[0].id);
    assertEquals(links[0].added_by, ORG_ADMIN_ID);

    const audit = admin.rowsIn("audit_events")[0];
    assertMatch(audit.event, /Rift Valley Academies/);
    assertMatch(audit.event, /pending/);
    assertMatch(audit.actor_label, /Grace Wambui/);
  });

  it("honors an explicit contact email over the caller's own", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ ...validBody, contact_email: "office@riftvalley.ac.ke" }), { admin, asUser });
    assertEquals(res.status, 200);
    assertEquals(admin.rowsIn("organizations")[0].contact_email, "office@riftvalley.ac.ke");
  });

  it("rolls back the organization if the organization_admins link fails", async () => {
    const { admin, asUser } = makeClients();
    admin.failNextWrite("organization_admins", "link failed");
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 500);
    assertEquals(admin.rowsIn("organizations").length, 0);
  });
});
