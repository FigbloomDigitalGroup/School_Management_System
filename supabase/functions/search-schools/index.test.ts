import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle } from "./index.ts";

function makeClient() {
  const admin = new FakeSupabaseClient();
  admin.seed("tenants", [
    { id: "t1", name: "Alliance High School", slug: "alliance", county: "Kiambu", status: "active" },
    { id: "t2", name: "Alliance Girls High School", slug: "alliance-girls", county: "Kiambu", status: "active" },
    { id: "t3", name: "Green Valley Academy", slug: "green-valley", county: "Nairobi", status: "active" },
    { id: "t4", name: "Pending New School", slug: "pending-school", county: "Nairobi", status: "onboarding" },
  ]);
  return admin;
}

function request(body: unknown, opts: { method?: string } = {}) {
  const method = opts.method ?? "POST";
  return new Request("https://example.com/search-schools", {
    method,
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
}

describe("search-schools handle", () => {
  it("answers an OPTIONS preflight with CORS headers, no auth required", async () => {
    const admin = makeClient();
    const res = await handle(request({ query: "alliance" }, { method: "OPTIONS" }), { admin });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("rejects non-POST requests", async () => {
    const admin = makeClient();
    const res = await handle(request({ query: "alliance" }, { method: "GET" }), { admin });
    assertEquals(res.status, 405);
  });

  it("requires no Authorization header -- this is the pre-auth school picker", async () => {
    const admin = makeClient();
    const res = await handle(request({ query: "alliance" }), { admin });
    assertEquals(res.status, 200);
  });

  it("returns an empty list for a too-short query, without erroring", async () => {
    const admin = makeClient();
    const res = await handle(request({ query: "a" }), { admin });
    const out = await res.json();
    assertEquals(out.schools, []);
  });

  it("matches by case-insensitive substring", async () => {
    const admin = makeClient();
    const res = await handle(request({ query: "GREEN" }), { admin });
    const out = await res.json();
    assertEquals(out.schools.length, 1);
    assertEquals(out.schools[0].name, "Green Valley Academy");
  });

  it("excludes a school that isn't active", async () => {
    const admin = makeClient();
    const res = await handle(request({ query: "pending" }), { admin });
    const out = await res.json();
    assertEquals(out.schools, []);
  });

  it("matches more than one school for a shared name fragment", async () => {
    const admin = makeClient();
    const res = await handle(request({ query: "alliance" }), { admin });
    const out = await res.json();
    assertEquals(out.schools.length, 2);
  });

  it("caps results at 8", async () => {
    const admin = makeClient();
    admin.seed("tenants", Array.from({ length: 12 }, (_, i) => ({
      id: `many-${i}`, name: `Many School ${i}`, slug: `many-${i}`, county: "Nairobi", status: "active",
    })));
    const res = await handle(request({ query: "many" }), { admin });
    const out = await res.json();
    assertEquals(out.schools.length, 8);
  });

  it("escapes ilike wildcards in the query so % and _ are treated literally", async () => {
    const admin = makeClient();
    admin.seed("tenants", [
      { id: "t5", name: "100% Academy", slug: "hundred-percent", county: "Nairobi", status: "active" },
      { id: "t6", name: "1000 Academy", slug: "thousand", county: "Nairobi", status: "active" },
    ]);
    const res = await handle(request({ query: "100%" }), { admin });
    const out = await res.json();
    assertEquals(out.schools.length, 1);
    assertEquals(out.schools[0].name, "100% Academy");
  });
});
