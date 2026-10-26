import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { callerKey, dbLimiter } from "./rateLimit.ts";

const from = (ip: string | null) =>
  new Request("https://example.com/f", { method: "POST", headers: ip ? { "x-forwarded-for": ip } : undefined });

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

  it("uses the first address of a forwarded chain, and never contains the address itself", async () => {
    const key = await callerKey(from("1.2.3.4, 10.0.0.1"), "x");
    assertEquals(key, await callerKey(from("1.2.3.4"), "x"));
    assertEquals(key.includes("1.2.3.4"), false);
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
});
