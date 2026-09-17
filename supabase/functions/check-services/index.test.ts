import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle } from "./index.ts";

const SUPER_ADMIN_ID = "super-admin-1";

function makeClients(opts: { role?: string } = {}) {
  const admin = new FakeSupabaseClient();
  admin.seed("profiles", [{ id: SUPER_ADMIN_ID, role: opts.role ?? "super_admin" }]);

  const asUser = new FakeSupabaseClient();
  asUser.authUser = { id: SUPER_ADMIN_ID };

  return { admin, asUser };
}

function request(opts: { method?: string; auth?: string | null } = {}) {
  const headers = new Headers();
  if (opts.auth !== null) headers.set("Authorization", opts.auth ?? "Bearer token");
  return new Request("https://example.com/check-services", { method: opts.method ?? "POST", headers });
}

describe("check-services handle", () => {
  it("answers an OPTIONS preflight with CORS headers, no auth required", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ method: "OPTIONS", auth: null }), { admin, asUser });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("rejects non-POST requests", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ method: "GET" }), { admin, asUser });
    assertEquals(res.status, 405);
  });

  it("rejects a request with no Authorization header", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ auth: null }), { admin, asUser });
    assertEquals(res.status, 401);
  });

  it("rejects when the token does not resolve to a user", async () => {
    const { admin, asUser } = makeClients();
    asUser.authUser = null;
    const res = await handle(request(), { admin, asUser });
    assertEquals(res.status, 401);
  });

  it("rejects a caller who is not a super_admin", async () => {
    const { admin, asUser } = makeClients({ role: "school_admin" });
    const res = await handle(request(), { admin, asUser });
    assertEquals(res.status, 403);
  });

  it("reports mpesa as not_configured when no Daraja secrets are set", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request(), { admin, asUser });
    assertEquals(res.status, 200);
    const out = await res.json();
    const mpesa = out.results.find((r: { service: string }) => r.service === "mpesa");
    assertEquals(mpesa.status, "not_configured");
  });

  it("reports supabase ok and logs both checks to service_status", async () => {
    const { admin, asUser } = makeClients();
    admin.seed("tenants", [{ id: "t1" }]);
    const res = await handle(request(), { admin, asUser });
    assertEquals(res.status, 200);
    const out = await res.json();
    const supabase = out.results.find((r: { service: string }) => r.service === "supabase");
    assertEquals(supabase.status, "ok");
    assertEquals(typeof supabase.latency_ms, "number");

    const logged = admin.rowsIn("service_status");
    assertEquals(logged.length, 2);
    assertEquals(logged.map((r) => r.service).sort(), ["mpesa", "supabase"]);
  });

  it("reports supabase down when the query fails", async () => {
    const { admin, asUser } = makeClients();
    admin.failNextRead("tenants", "connection refused");
    const res = await handle(request(), { admin, asUser });
    const out = await res.json();
    const supabase = out.results.find((r: { service: string }) => r.service === "supabase");
    assertEquals(supabase.status, "down");
    assertEquals(supabase.detail, "connection refused");
  });
});
