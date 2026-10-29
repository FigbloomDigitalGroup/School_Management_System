import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { callerKey, dbLimiter, overallKey } from "./rateLimit.ts";

/** A request from this address, as hosted Supabase's edge (Cloudflare) sets it. */
const from = (ip: string | null, extra: Record<string, string> = {}) =>
  new Request("https://example.com/f", { method: "POST", headers: { ...(ip ? { "cf-connecting-ip": ip } : {}), ...extra } });

describe("callerKey", () => {
  it("is the same for the same address and function", async () => {
    assertEquals(await callerKey(from("1.2.3.4"), "search-schools"), await callerKey(from("1.2.3.4"), "search-schools"));
  });

  it("differs between addresses", async () => {
    assertNotEquals(await callerKey(from("1.2.3.4"), "search-schools"), await callerKey(from("1.2.3.5"), "search-schools"));
  });

  it("differs between functions, so one function's traffic never counts against another's", async () => {
    assertNotEquals(await callerKey(from("1.2.3.4"), "search-schools"), await callerKey(from("1.2.3.4"), "signup-organization"));
  });

  it("never contains the address itself", async () => {
    assertEquals((await callerKey(from("1.2.3.4"), "x")).includes("1.2.3.4"), false);
  });

  // FIG-1336: a header the caller writes must not buy a fresh allowance
  it("ignores x-forwarded-for, which the caller writes, unless the deployment names it", async () => {
    const a = await callerKey(from("1.2.3.4", { "x-forwarded-for": "9.9.9.1" }), "x");
    const b = await callerKey(from("1.2.3.4", { "x-forwarded-for": "9.9.9.2" }), "x");
    assertEquals(a, b);
    assertEquals(await callerKey(from(null, { "x-forwarded-for": "9.9.9.1" }), "x"), await callerKey(from(null, { "x-forwarded-for": "9.9.9.2" }), "x"));
  });

  it("with CLIENT_IP_HEADER=x-forwarded-for, counts the last address, the one the deployment's proxy added", async () => {
    Deno.env.set("CLIENT_IP_HEADER", "x-forwarded-for");
    try {
      const spoofed = await callerKey(from(null, { "x-forwarded-for": "6.6.6.6, 203.0.113.7" }), "x");
      assertEquals(spoofed, await callerKey(from(null, { "x-forwarded-for": "7.7.7.7, 203.0.113.7" }), "x"));
      assertNotEquals(spoofed, await callerKey(from(null, { "x-forwarded-for": "6.6.6.6, 198.51.100.9" }), "x"));
    } finally {
      Deno.env.delete("CLIENT_IP_HEADER");
    }
  });
});

describe("overallKey", () => {
  it("is one key for the function, or for one school's share, whatever the request says", async () => {
    assertEquals(await overallKey("resolve-login-id", "t1"), await overallKey("resolve-login-id", "t1"));
    assertNotEquals(await overallKey("resolve-login-id", "t1"), await overallKey("resolve-login-id", "t2"));
    assertNotEquals(await overallKey("search-schools"), await overallKey("signup-organization"));
  });
});

describe("dbLimiter", () => {
  it("passes the key, limit and window to note_login_lookup", async () => {
    let seen: Record<string, unknown> | null = null;
    const admin = { rpc: (_name: string, args: Record<string, unknown>) => { seen = args; return Promise.resolve({ data: true, error: null }); } };
    assertEquals(await dbLimiter(admin, "f", 5, "1 hour")("k"), true);
    assertEquals(seen, { p_key: "k", p_limit: 5, p_window: "1 hour" });
  });

  it("answers false when the database says the caller is over its allowance", async () => {
    const admin = { rpc: () => Promise.resolve({ data: false, error: null }) };
    assertEquals(await dbLimiter(admin, "f", 5, "1 hour")("k"), false);
  });

  it("lets the call through when the limiter itself fails", async () => {
    const admin = { rpc: () => Promise.resolve({ data: null, error: { message: "function note_login_lookup does not exist" } }) };
    assertEquals(await dbLimiter(admin, "f", 5, "1 hour")("k"), true);
  });

  it("refuses instead, when asked to fail closed", async () => {
    const admin = { rpc: () => Promise.resolve({ data: null, error: { message: "down" } }) };
    assertEquals(await dbLimiter(admin, "f", 5, "1 hour", { failClosed: true })("k"), false);
  });
});
