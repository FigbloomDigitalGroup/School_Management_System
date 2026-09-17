import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle } from "./index.ts";

const TENANT_ID = "tenant-1";
const OTHER_TENANT_ID = "tenant-2";

function makeClient() {
  const admin = new FakeSupabaseClient();
  admin.seed("tenants", [
    { id: TENANT_ID, slug: "green-valley", status: "active" },
    { id: OTHER_TENANT_ID, slug: "riverside", status: "active" },
  ]);
  admin.seed("profiles", [
    { id: "profile-1", tenant_id: TENANT_ID, role: "teacher", full_name: "Otieno Ouma", login_id: "TC-0001" },
    { id: "profile-2", tenant_id: OTHER_TENANT_ID, role: "teacher", full_name: "Someone Else", login_id: "TC-0001" },
  ]);
  return admin;
}

function request(body: unknown, opts: { method?: string } = {}) {
  const method = opts.method ?? "POST";
  return new Request("https://example.com/resolve-login-id", {
    method,
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
}

describe("resolve-login-id handle", () => {
  it("answers an OPTIONS preflight with CORS headers, no auth required", async () => {
    const admin = makeClient();
    const res = await handle(request({ tenant_id: TENANT_ID, login_id: "TC-0001" }, { method: "OPTIONS" }), { admin });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("rejects non-POST requests", async () => {
    const admin = makeClient();
    const res = await handle(request({ tenant_id: TENANT_ID, login_id: "TC-0001" }, { method: "GET" }), { admin });
    assertEquals(res.status, 405);
  });

  it("rejects a body missing required fields", async () => {
    const admin = makeClient();
    const res = await handle(request({ tenant_id: TENANT_ID }), { admin });
    assertEquals(res.status, 400);
  });

  it("resolves the right account's name and synthetic email", async () => {
    const admin = makeClient();
    const res = await handle(request({ tenant_id: TENANT_ID, login_id: "TC-0001" }), { admin });
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.ok, true);
    assertEquals(out.full_name, "Otieno Ouma");
    assertEquals(out.email, "tc-0001@login.green-valley.figbloom.internal");
  });

  it("is case-insensitive on the typed login_id", async () => {
    const admin = makeClient();
    const res = await handle(request({ tenant_id: TENANT_ID, login_id: "tc-0001" }), { admin });
    const out = await res.json();
    assertEquals(out.full_name, "Otieno Ouma");
  });

  it("resolves the OTHER tenant's own account with the same login_id, not the first one found", async () => {
    const admin = makeClient();
    const res = await handle(request({ tenant_id: OTHER_TENANT_ID, login_id: "TC-0001" }), { admin });
    const out = await res.json();
    assertEquals(out.full_name, "Someone Else");
    assertEquals(out.email, "tc-0001@login.riverside.figbloom.internal");
  });

  it("404s with a generic message for a login_id that doesn't exist at all", async () => {
    const admin = makeClient();
    const res = await handle(request({ tenant_id: TENANT_ID, login_id: "TC-9999" }), { admin });
    assertEquals(res.status, 404);
    const out = await res.json();
    assertEquals(out.error, "We couldn't find that ID at this school. Check with the school office.");
  });

  it("404s (not another school's account) for a real login_id under the WRONG tenant_id", async () => {
    const admin = makeClient();
    admin.seed("profiles", [
      { id: "profile-1", tenant_id: TENANT_ID, role: "teacher", full_name: "Otieno Ouma", login_id: "TC-0001" },
    ]);
    const res = await handle(request({ tenant_id: OTHER_TENANT_ID, login_id: "TC-0001" }), { admin });
    assertEquals(res.status, 404);
  });

  it("404s for a tenant that does not exist", async () => {
    const admin = makeClient();
    const res = await handle(request({ tenant_id: "missing", login_id: "TC-0001" }), { admin });
    assertEquals(res.status, 404);
  });

  it("404s for a tenant that isn't active", async () => {
    const admin = makeClient();
    admin.seed("tenants", [{ id: TENANT_ID, slug: "green-valley", status: "onboarding" }]);
    const res = await handle(request({ tenant_id: TENANT_ID, login_id: "TC-0001" }), { admin });
    assertEquals(res.status, 404);
  });
});
