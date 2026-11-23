import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createLambdaHandler, toRequest, toResult, validJwt, type LambdaHttpEvent } from "./adapter";
// @ts-expect-error: a plain .mjs build script, no types
import { parseNpmSpecifier, verifyJwtSettings } from "./build.mjs";

const SECRET = "test-jwt-secret-at-least-32-characters";
function jwt(payload: object, secret = SECRET, alg = "HS256"): string {
  const h = Buffer.from(JSON.stringify({ alg, typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const s = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

// People's sign-ins: ES256 with the server's EC key, its public half in jwks.json (as the self-hosted auth issues them)
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KID = "5861843e-403f-4e0f-9f9b-763b3d9fb0b4";
const PUBLIC_JWK = { ...(ec.publicKey.export({ format: "jwk" }) as JsonWebKey), kid: KID, alg: "ES256", use: "sig" };
function es256(payload: object, kid = KID, key = ec.privateKey): string {
  const h = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT", kid })).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const s = sign("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${h}.${p}.${s}`;
}
const KEYS = { secret: SECRET, jwks: async () => [PUBLIC_JWK] };

const event = (over: Partial<LambdaHttpEvent> & { method?: string } = {}): LambdaHttpEvent => ({
  rawPath: "/functions/v1/send-push",
  rawQueryString: "",
  headers: { "content-type": "application/json", host: "api.example" },
  body: '{"a":1}',
  ...over,
  requestContext: { http: { method: over.method ?? "POST", sourceIp: "41.90.1.2" }, domainName: "api.example" },
});

afterEach(() => { delete (globalThis as { Deno?: unknown }).Deno; });

describe("the request a function sees", () => {
  it("has the edge runtime's path (/<name>), the query, the body and the headers", async () => {
    const req = toRequest("mpesa-callback", event({ rawPath: "/functions/v1/mpesa-callback", rawQueryString: "token=abc", body: "x" }));
    expect(req.url).toBe("https://api.example/mpesa-callback?token=abc");
    expect(req.method).toBe("POST");
    expect(await req.text()).toBe("x");
    expect(req.headers.get("content-type")).toBe("application/json");
  });

  it("takes the caller's address from API Gateway, over whatever the caller claimed", () => {
    const req = toRequest("search-schools", event({ headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" } }));
    expect(req.headers.get("x-forwarded-for")).toBe("41.90.1.2");
  });

  it("decodes a base64 body, and sends none with GET", async () => {
    const bin = toRequest("x", event({ body: Buffer.from([0, 1, 2]).toString("base64"), isBase64Encoded: true }));
    expect([...new Uint8Array(await bin.arrayBuffer())]).toEqual([0, 1, 2]);
    const get = toRequest("x", event({ method: "GET", body: "ignored" }));
    expect(get.body).toBeNull();
  });

  it("puts cookies back in one header", () => {
    expect(toRequest("x", event({ cookies: ["a=1", "b=2"] })).headers.get("cookie")).toBe("a=1; b=2");
  });
});

describe("the answer API Gateway gets", () => {
  it("keeps status and headers, JSON as text", async () => {
    const r = await toResult(new Response('{"ok":true}', { status: 201, headers: { "content-type": "application/json", "x-a": "1" } }));
    expect(r).toEqual({ statusCode: 201, headers: { "content-type": "application/json", "x-a": "1" }, body: '{"ok":true}', isBase64Encoded: false });
  });

  it("sends binary as base64 and cookies separately", async () => {
    const headers = new Headers({ "content-type": "application/pdf" });
    headers.append("set-cookie", "a=1");
    headers.append("set-cookie", "b=2");
    const r = await toResult(new Response(new Uint8Array([37, 80, 68, 70]), { headers }));
    expect(r.isBase64Encoded).toBe(true);
    expect(Buffer.from(r.body, "base64").toString()).toBe("%PDF");
    expect(r.cookies).toEqual(["a=1", "b=2"]);
    expect(r.headers).not.toHaveProperty("set-cookie");
  });

  it("sends an empty body as text", async () => {
    expect(await toResult(new Response(null, { status: 204 }))).toMatchObject({ statusCode: 204, body: "", isBase64Encoded: false });
  });
});

describe("the token check (verify_jwt)", () => {
  it("accepts a person's sign-in: ES256 with the server's EC key", async () => {
    expect(await validJwt(`Bearer ${es256({ role: "authenticated", exp: inAnHour() })}`, KEYS)).toBe(true);
  });

  it("accepts the legacy HS256 keys (anon, service role) signed with the JWT secret", async () => {
    expect(await validJwt(`Bearer ${jwt({ role: "anon", exp: inAnHour() })}`, KEYS)).toBe(true);
    expect(await validJwt(`Bearer ${jwt({ role: "service_role", exp: inAnHour() })}`, KEYS)).toBe(true);
  });

  it("refuses an ES256 token from another key, an expired one, or one naming a key the server doesn't have", async () => {
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(await validJwt(`Bearer ${es256({ exp: inAnHour() }, KID, other.privateKey)}`, KEYS)).toBe(false);
    expect(await validJwt(`Bearer ${es256({ exp: Math.floor(Date.now() / 1000) - 10 })}`, KEYS)).toBe(false);
    expect(await validJwt(`Bearer ${es256({ exp: inAnHour() }, "unknown-kid")}`, KEYS)).toBe(false);
  });

  it("asks for the keys again when a token names one it doesn't know (the server rotated its key)", async () => {
    let calls = 0;
    const jwks = async (refresh?: boolean) => { calls++; return refresh ? [PUBLIC_JWK] : []; };
    expect(await validJwt(`Bearer ${es256({ exp: inAnHour() })}`, { jwks })).toBe(true);
    expect(calls).toBe(2);
  });

  it("refuses a missing, malformed, wrongly signed, expired or alg:none token", async () => {
    expect(await validJwt(null, KEYS)).toBe(false);
    expect(await validJwt("Basic abc", KEYS)).toBe(false);
    expect(await validJwt("Bearer a.b", KEYS)).toBe(false);
    expect(await validJwt(`Bearer ${jwt({ exp: inAnHour() }, "another-secret")}`, KEYS)).toBe(false);
    expect(await validJwt(`Bearer ${jwt({ exp: Math.floor(Date.now() / 1000) - 10 })}`, KEYS)).toBe(false);
    expect(await validJwt(`Bearer ${jwt({ exp: inAnHour() }, SECRET, "none")}`, KEYS)).toBe(false);
    expect(await validJwt(`Bearer ${es256({ exp: inAnHour() })}`, { secret: SECRET })).toBe(false);
  });
});

describe("running a function", () => {
  function fakeFunction(onRequest: (req: Request) => Response = () => Response.json({ ok: true })) {
    return async () => {
      const deno = (globalThis as unknown as { Deno: { serve: (h: (r: Request) => Response) => void; env: { get: (k: string) => string | undefined } } }).Deno;
      seenAtLoad = deno.env.get("DARAJA_ENV");
      deno.serve(onRequest);
    };
  }
  let seenAtLoad: string | undefined;
  const settings = { DARAJA_ENV: "production", SUPABASE_URL: "https://db.example", SUPABASE_JWT_SECRET: SECRET };

  it("loads the settings before the function, once, and hands it every request", async () => {
    let loads = 0;
    let lastEnv: Record<string, unknown> = {};
    const handler = createLambdaHandler({
      name: "search-schools", verifyJwt: false,
      loadSettings: async () => { loads++; return settings; },
      loadFunction: fakeFunction(() => {
        const env = (globalThis as unknown as { Deno: { env: { toObject: () => Record<string, unknown> } } }).Deno.env;
        lastEnv = env.toObject();
        return Response.json({ ok: true });
      }),
    });
    expect((await handler(event())).statusCode).toBe(200);
    await handler(event());
    expect(loads).toBe(1);
    expect(seenAtLoad).toBe("production");
    expect(lastEnv).toMatchObject({ SUPABASE_URL: "https://db.example", CLIENT_IP_HEADER: "x-forwarded-for", TRUSTED_PROXY_HOPS: "1" });
    expect(lastEnv).not.toHaveProperty("SUPABASE_JWT_SECRET");
  });

  it("checks the token when the function verifies (a person's ES256 sign-in too), but lets CORS preflights through", async () => {
    const jwksFor: string[] = [];
    const handler = createLambdaHandler({
      name: "send-push", verifyJwt: true, loadSettings: async () => settings, loadFunction: fakeFunction(),
      fetchJwks: async (url) => { jwksFor.push(url); return [PUBLIC_JWK]; },
    });
    const refused = await handler(event());
    expect(refused).toMatchObject({ statusCode: 401, body: JSON.stringify({ code: 401, message: "Invalid JWT" }) });
    // a browser must be able to read the refusal, or it reports "failed to send a request"
    expect(refused.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect((await handler(event({ headers: { authorization: `Bearer ${es256({ role: "authenticated", exp: inAnHour() })}` } }))).statusCode).toBe(200);
    expect((await handler(event({ headers: { authorization: `Bearer ${jwt({ exp: inAnHour() })}` } }))).statusCode).toBe(200);
    expect((await handler(event({ method: "OPTIONS" }))).statusCode).toBe(200);
    expect(jwksFor).toEqual(["https://db.example"]);
  });

  it("leaves the token to a function that doesn't verify (Safaricom sends none)", async () => {
    const handler = createLambdaHandler({ name: "mpesa-callback", verifyJwt: false, loadSettings: async () => settings, loadFunction: fakeFunction() });
    expect((await handler(event())).statusCode).toBe(200);
  });

  it("tries the start again on the next request after a failure", async () => {
    let attempts = 0;
    const handler = createLambdaHandler({
      name: "x", verifyJwt: false,
      loadSettings: async () => { if (++attempts === 1) throw new Error("throttled"); return settings; },
      loadFunction: fakeFunction(),
    });
    await expect(handler(event())).rejects.toThrow("throttled");
    expect((await handler(event())).statusCode).toBe(200);
  });

  it("says so when the function never calls Deno.serve", async () => {
    const handler = createLambdaHandler({ name: "broken", verifyJwt: false, loadSettings: async () => settings, loadFunction: async () => {} });
    await expect(handler(event())).rejects.toThrow("broken never called Deno.serve");
  });
});

describe("the build", () => {
  it("reads verify_jwt per function from config.toml, other sections ignored", () => {
    const toml = `[api]\nverify_jwt = false\n\n[functions.a]\nverify_jwt = true\n\n[functions.mpesa-callback]\nverify_jwt = false   # Safaricom\n[auth]\nverify_jwt = true\n`;
    expect(verifyJwtSettings(toml)).toEqual({ a: true, "mpesa-callback": false });
  });

  it("parses npm: imports, and refuses one without an exact version", () => {
    expect(parseNpmSpecifier("npm:@supabase/supabase-js@2.116.0")).toEqual({ name: "@supabase/supabase-js", version: "2.116.0", sub: "" });
    expect(parseNpmSpecifier("npm:fflate@0.8.2/esm")).toEqual({ name: "fflate", version: "0.8.2", sub: "/esm" });
    expect(() => parseNpmSpecifier("npm:fflate")).toThrow("exact version");
  });
});
