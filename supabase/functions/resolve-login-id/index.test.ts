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

function request(body: unknown, opts: { method?: string; ip?: string } = {}) {
  const method = opts.method ?? "POST";
  return new Request("https://example.com/resolve-login-id", {
    method,
    headers: opts.ip ? { "x-forwarded-for": opts.ip } : undefined,
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
}

/** Lets every lookup through, unless a test says otherwise. */
const open = async () => true;
const deps = (admin: FakeSupabaseClient) => ({ admin, withinLimit: open });

describe("resolve-login-id handle", () => {
  it("answers an OPTIONS preflight with CORS headers, no auth required", async () => {
    const admin = makeClient();
    const res = await handle(request({ tenant_id: TENANT_ID, login_id: "TC-0001" }, { method: "OPTIONS" }), deps(admin));
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("rejects non-POST requests", async () => {
    const admin = makeClient();
    const res = await handle(request({ tenant_id: TENANT_ID, login_id: "TC-0001" }, { method: "GET" }), deps(admin));
    assertEquals(res.status, 405);
  });

  it("rejects a body missing required fields", async () => {
    const admin = makeClient();
    const res = await handle(request({ tenant_id: TENANT_ID }), deps(admin));
    assertEquals(res.status, 400);
  });

  it("resolves the right account's masked name and synthetic email", async () => {
    const admin = makeClient();
    const res = await handle(request({ tenant_id: TENANT_ID, login_id: "TC-0001" }), deps(admin));
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.ok, true);
    assertEquals(out.display_name, "Otieno O.");
    assertEquals(out.email, "tc-0001@login.green-valley.figbloom.internal");
  });

  it("is case-insensitive on the typed login_id", async () => {
    const admin = makeClient();
    const res = await handle(request({ tenant_id: TENANT_ID, login_id: "tc-0001" }), deps(admin));
    const out = await res.json();
    assertEquals(out.display_name, "Otieno O.");
  });

  it("resolves the OTHER tenant's own account with the same login_id, not the first one found", async () => {
    const admin = makeClient();
    const res = await handle(request({ tenant_id: OTHER_TENANT_ID, login_id: "TC-0001" }), deps(admin));
    const out = await res.json();
    assertEquals(out.display_name, "Someone E.");
    assertEquals(out.email, "tc-0001@login.riverside.figbloom.internal");
  });

  it("404s with a generic message for a login_id that doesn't exist at all", async () => {
    const admin = makeClient();
    const res = await handle(request({ tenant_id: TENANT_ID, login_id: "TC-9999" }), deps(admin));
    assertEquals(res.status, 404);
    const out = await res.json();
    assertEquals(out.error, "We couldn't find that ID at this school. Check with the school office.");
  });

  it("404s (not another school's account) for a real login_id under the WRONG tenant_id", async () => {
    const admin = makeClient();
    admin.seed("profiles", [
      { id: "profile-1", tenant_id: TENANT_ID, role: "teacher", full_name: "Otieno Ouma", login_id: "TC-0001" },
    ]);
    const res = await handle(request({ tenant_id: OTHER_TENANT_ID, login_id: "TC-0001" }), deps(admin));
    assertEquals(res.status, 404);
  });

  it("404s for a tenant that does not exist", async () => {
    const admin = makeClient();
    const res = await handle(request({ tenant_id: "missing", login_id: "TC-0001" }), deps(admin));
    assertEquals(res.status, 404);
  });

  for (const status of ["onboarding", "setup_stalled", "suspended"]) {
    it(`404s for a school that is ${status}`, async () => {
      const admin = makeClient();
      admin.seed("tenants", [{ id: TENANT_ID, slug: "green-valley", status }]);
      const res = await handle(request({ tenant_id: TENANT_ID, login_id: "TC-0001" }), deps(admin));
      assertEquals(res.status, 404);
    });
  }

  for (const status of ["trial", "overdue"]) {
    it(`still resolves the account of a school that is ${status}`, async () => {
      const admin = makeClient();
      admin.seed("tenants", [{ id: TENANT_ID, slug: "green-valley", status }]);
      const res = await handle(request({ tenant_id: TENANT_ID, login_id: "TC-0001" }), deps(admin));
      assertEquals(res.status, 200);
      const out = await res.json();
      assertEquals(out.display_name, "Otieno O.");
    });
  }

  it("never returns the full name", async () => {
    const admin = makeClient();
    const res = await handle(request({ tenant_id: TENANT_ID, login_id: "TC-0001" }), deps(admin));
    const raw = await res.text();
    assertEquals(raw.includes("Ouma"), false);
    assertEquals("full_name" in JSON.parse(raw), false);
  });

  describe("rate limit", () => {
    it("answers 429 without looking anything up once the caller is over its allowance", async () => {
      const admin = makeClient();
      const res = await handle(request({ tenant_id: TENANT_ID, login_id: "TC-0001" }), { admin, withinLimit: async () => false });
      assertEquals(res.status, 429);
      const out = await res.json();
      assertEquals(out.error, "Too many attempts. Wait a few minutes and try again.");
      assertEquals(out.display_name, undefined);
    });

    it("keys the limit on the caller's address, and never stores the address itself", async () => {
      const admin = makeClient();
      const keys: string[] = [];
      const withinLimit = async (k: string) => { keys.push(k); return true; };
      await handle(request({ tenant_id: TENANT_ID, login_id: "TC-0001" }, { ip: "203.0.113.7, 10.0.0.1" }), { admin, withinLimit });
      await handle(request({ tenant_id: TENANT_ID, login_id: "TC-0002" }, { ip: "203.0.113.7" }), { admin, withinLimit });
      await handle(request({ tenant_id: TENANT_ID, login_id: "TC-0001" }, { ip: "198.51.100.9" }), { admin, withinLimit });
      assertEquals(keys[0], keys[1]);
      assertEquals(keys[0] === keys[2], false);
      assertEquals(keys[0].includes("203.0.113.7"), false);
    });

    it("does not count a CORS preflight or a wrong method against the caller", async () => {
      const admin = makeClient();
      let calls = 0;
      const withinLimit = async () => { calls++; return true; };
      await handle(request({}, { method: "OPTIONS" }), { admin, withinLimit });
      await handle(request({}, { method: "GET" }), { admin, withinLimit });
      assertEquals(calls, 0);
    });
  });
});
