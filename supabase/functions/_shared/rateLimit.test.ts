import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { callerKey, clientAddress, clientIpConfig, type ClientIpConfig, dbLimiter, normaliseAddress, overallKey, UNKNOWN_CLIENT } from "./rateLimit.ts";

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

/** Runs `fn` with these settings in the environment, then puts it back. */
async function withEnv(vars: Record<string, string>, fn: () => Promise<void>) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
  try { await fn(); } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const req = (headers: Record<string, string>) => new Request("https://example.com/f", { method: "POST", headers });
const CLOUD: ClientIpConfig = { header: "cf-connecting-ip", hops: 1 };
/** figbloom-platform: ALB appends the client, Envoy appends the ALB. */
const AWS: ClientIpConfig = { header: "x-forwarded-for", hops: 2 };
const ALB = "10.0.1.23";

describe("clientIpConfig", () => {
  const env = (vars: Record<string, string>) => ({ get: (k: string) => vars[k] });
  it("defaults to Supabase Cloud: cf-connecting-ip, one hop", () => {
    assertEquals(clientIpConfig(env({})), CLOUD);
  });
  it("reads the AWS settings", () => {
    assertEquals(clientIpConfig(env({ CLIENT_IP_HEADER: " X-Forwarded-For ", TRUSTED_PROXY_HOPS: "2" })), AWS);
  });
  it("treats an invalid hop count as 1, never as more trust", () => {
    for (const bad of ["0", "-1", "1.5", "two", "11"]) assertEquals(clientIpConfig(env({ TRUSTED_PROXY_HOPS: bad })).hops, 1, bad);
  });
});

describe("normaliseAddress", () => {
  it("keeps IPv4 and IPv6, and drops a port the proxy added", () => {
    assertEquals(normaliseAddress("203.0.113.7"), "203.0.113.7");
    assertEquals(normaliseAddress("203.0.113.7:8080"), "203.0.113.7");
    assertEquals(normaliseAddress("2001:DB8::21F:5BFF:FEBF"), "2001:db8::21f:5bff:febf");
    assertEquals(normaliseAddress("[2001:db8::1]:8080"), "2001:db8::1");
    assertEquals(normaliseAddress("::ffff:203.0.113.7"), "::ffff:203.0.113.7");
  });
  it("refuses anything that isn't an address", () => {
    for (const bad of ["", "unknown", "evil.example", "999.1.1.1", "1.2.3", "1.2.3.4.5", "<script>", "1.2.3.4; drop"]) {
      assertEquals(normaliseAddress(bad), null, bad);
    }
  });
});

describe("clientAddress on Supabase Cloud (cf-connecting-ip, 1 hop)", () => {
  it("reads Cloudflare's CF-Connecting-IP", () => {
    assertEquals(clientAddress(req({ "cf-connecting-ip": "203.0.113.7" }), CLOUD), "203.0.113.7");
  });
  it("ignores X-Forwarded-For entirely, however many entries the caller sends", () => {
    for (const xff of ["6.6.6.6", "6.6.6.6, 7.7.7.7", "1.1.1.1, 2.2.2.2, 3.3.3.3, 4.4.4.4"]) {
      assertEquals(clientAddress(req({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": xff }), CLOUD), "203.0.113.7");
    }
  });
  it("without the header, or with something that isn't an address in it, the caller is unknown", () => {
    assertEquals(clientAddress(req({}), CLOUD), UNKNOWN_CLIENT);
    assertEquals(clientAddress(req({ "x-forwarded-for": "6.6.6.6" }), CLOUD), UNKNOWN_CLIENT);
    assertEquals(clientAddress(req({ "cf-connecting-ip": "not-an-ip" }), CLOUD), UNKNOWN_CLIENT);
  });
});

describe("clientAddress on AWS (x-forwarded-for, 2 hops: ALB then Envoy)", () => {
  it("reads the address the ALB appended, second from the right", () => {
    assertEquals(clientAddress(req({ "x-forwarded-for": `203.0.113.7, ${ALB}` }), AWS), "203.0.113.7");
  });
  it("ignores everything the caller put to the left of it", () => {
    for (const spoof of ["6.6.6.6", "6.6.6.6, 7.7.7.7", "198.51.100.1, 198.51.100.2, 198.51.100.3", "garbage, , x"]) {
      assertEquals(clientAddress(req({ "x-forwarded-for": `${spoof}, 203.0.113.7, ${ALB}` }), AWS), "203.0.113.7", spoof);
    }
  });
  it("ignores a cf-connecting-ip the caller sends (there is no Cloudflare in front)", () => {
    assertEquals(clientAddress(req({ "cf-connecting-ip": "6.6.6.6", "x-forwarded-for": `203.0.113.7, ${ALB}` }), AWS), "203.0.113.7");
  });
  it("is unknown with fewer entries than proxies (the request didn't come through both)", () => {
    assertEquals(clientAddress(req({ "x-forwarded-for": ALB }), AWS), UNKNOWN_CLIENT);
    assertEquals(clientAddress(req({}), AWS), UNKNOWN_CLIENT);
  });
  it("reads an ALB entry that carries the client port", () => {
    assertEquals(clientAddress(req({ "x-forwarded-for": `[2001:db8::7]:51234, ${ALB}` }), AWS), "2001:db8::7");
  });
});

describe("spoofing never buys a new allowance", () => {
  it("on Supabase Cloud: rotating X-Forwarded-For and a missing CF-Connecting-IP stay in one bucket", async () => {
    const keys = new Set<string>();
    for (let i = 0; i < 20; i++) keys.add(await callerKey(req({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": `10.9.${i}.1, 172.16.${i}.9` }), "resolve-login-id"));
    assertEquals(keys.size, 1);
    const unknown = new Set<string>();
    for (let i = 0; i < 20; i++) unknown.add(await callerKey(req({ "x-forwarded-for": `10.9.${i}.1` }), "resolve-login-id"));
    assertEquals(unknown.size, 1);
  });

  it("on AWS: rotating the entries the caller writes stays in one bucket; a different real client is another", async () => {
    await withEnv({ CLIENT_IP_HEADER: "x-forwarded-for", TRUSTED_PROXY_HOPS: "2" }, async () => {
      const keys = new Set<string>();
      for (let i = 0; i < 20; i++) {
        keys.add(await callerKey(req({ "x-forwarded-for": `10.9.${i}.1, 172.16.${i}.9, 203.0.113.7, ${ALB}`, "cf-connecting-ip": `6.6.6.${i}` }), "search-schools"));
      }
      assertEquals(keys.size, 1);
      assertNotEquals([...keys][0], await callerKey(req({ "x-forwarded-for": `198.51.100.9, ${ALB}` }), "search-schools"));
    });
  });

  it("everyone without a usable address shares one allowance per function (never unlimited)", async () => {
    const a = await callerKey(req({}), "signup-organization");
    assertEquals(a, await callerKey(req({ "cf-connecting-ip": "nonsense" }), "signup-organization"));
    assertNotEquals(a, await callerKey(req({}), "search-schools"));
    // and it is a real key, counted like any other
    let counted = 0;
    const admin = { rpc: (_n: string, args: Record<string, unknown>) => { if (args.p_key === a) counted++; return Promise.resolve({ data: counted <= 1, error: null }); } };
    const limiter = dbLimiter(admin, "signup-organization", 1, "1 hour");
    assertEquals(await limiter(a), true);
    assertEquals(await limiter(await callerKey(req({ "x-forwarded-for": "6.6.6.6" }), "signup-organization")), false);
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
