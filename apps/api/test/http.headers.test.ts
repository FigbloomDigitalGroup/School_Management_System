import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";
import { buildApp } from "../src/app.js";
import { isExactHttpOrigin, loadConfig, type AppConfig } from "../src/config.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

/** FIG-1622 / AD-12: security headers, CORS and server timeouts. */
describe("security headers, CORS and server timeouts", () => {
  let ctx: Ctx;
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 120_000);

  afterAll(async () => {
    for (const a of apps) await a.close().catch(() => undefined);
    await ctx.app.close();
    await ctx.pool.end();
  });

  async function appWith(overrides: Partial<AppConfig>) {
    const a = await buildApp({ ...ctx.config, ...overrides }, ctx.runtimePool);
    apps.push(a);
    return a;
  }

  it("every response carries the API header set: nosniff, CSP none + frame-ancestors none, no framing, no referrer, no-store, no x-powered-by", async () => {
    const login = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email: "admin-a@example.com", password: "correct-horse-battery" },
    });
    const token = login.json().token as string;
    const responses = [
      await ctx.app.inject({ method: "GET", url: "/livez" }), // 200
      await ctx.app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${token}` } }), // authenticated 200
      await ctx.app.inject({ method: "GET", url: "/v1/auth/me" }), // 401
      await ctx.app.inject({ method: "GET", url: "/nope" }), // 404
      await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "x" } }), // 400
    ];
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 401, 404, 400]);
    for (const r of responses) {
      const h = r.headers;
      expect(h["x-content-type-options"], r.statusCode.toString()).toBe("nosniff");
      expect(h["content-security-policy"]).toContain("default-src 'none'");
      expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(h["x-frame-options"]).toBe("DENY");
      expect(h["referrer-policy"]).toBe("no-referrer");
      expect(h["cache-control"]).toBe("no-store");
      expect(h["x-powered-by"]).toBeUndefined();
      expect(h["strict-transport-security"]).toBeUndefined(); // off by default (no TLS terminated here)
    }
  });

  it("HSTS is sent only when explicitly enabled", async () => {
    const a = await appWith({ hstsEnabled: true });
    const r = await a.inject({ method: "GET", url: "/livez" });
    expect(r.headers["strict-transport-security"]).toMatch(/max-age=15552000.*includeSubDomains/);
  });

  it("CORS: with no configured origin no CORS header is ever sent", async () => {
    const r = await ctx.app.inject({ method: "GET", url: "/livez", headers: { origin: "https://app.example.com" } });
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    const pre = await ctx.app.inject({
      method: "OPTIONS",
      url: "/v1/auth/login/email",
      headers: { origin: "https://app.example.com", "access-control-request-method": "POST" },
    });
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("CORS: an allowlisted origin is echoed exactly; others, subdomains and look-alikes get nothing; never '*' and never credentials", async () => {
    const a = await appWith({ corsAllowedOrigins: ["https://app.example.com"], corsMaxAgeSeconds: 600 });
    const ok = await a.inject({ method: "GET", url: "/livez", headers: { origin: "https://app.example.com" } });
    expect(ok.headers["access-control-allow-origin"]).toBe("https://app.example.com");
    expect(String(ok.headers["vary"] ?? "")).toMatch(/Origin/i);
    expect(ok.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(ok.headers["access-control-expose-headers"]).toMatch(/X-Request-Id/i);
    for (const origin of [
      "https://evil.example.com",
      "https://app.example.com.evil.test",
      "https://sub.app.example.com",
      "http://app.example.com",
      "null",
    ]) {
      const r = await a.inject({ method: "GET", url: "/livez", headers: { origin } });
      expect(r.headers["access-control-allow-origin"], origin).toBeUndefined();
    }
  });

  it("CORS preflight: explicit methods and headers (including Idempotency-Key and X-Tenant-Id), bounded cache, no wildcard", async () => {
    const a = await appWith({ corsAllowedOrigins: ["https://app.example.com"], corsMaxAgeSeconds: 600 });
    const pre = await a.inject({
      method: "OPTIONS",
      url: "/v1/auth/login/email",
      headers: {
        origin: "https://app.example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type,idempotency-key,x-tenant-id",
      },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("https://app.example.com");
    expect(pre.headers["access-control-allow-methods"]).toBe("GET, POST, PUT, DELETE");
    expect(String(pre.headers["access-control-allow-headers"]).toLowerCase()).toContain("idempotency-key");
    expect(String(pre.headers["access-control-allow-headers"]).toLowerCase()).toContain("x-tenant-id");
    expect(pre.headers["access-control-max-age"]).toBe("600");
    expect(String(pre.headers["access-control-allow-origin"])).not.toBe("*");
    // A preflight from an unlisted origin is not approved.
    const bad = await a.inject({
      method: "OPTIONS",
      url: "/v1/auth/login/email",
      headers: { origin: "https://evil.example.com", "access-control-request-method": "POST" },
    });
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("configuration refuses wildcards, paths, trailing slashes, 'null' and non-http origins", () => {
    const base = { DATABASE_URL: "postgresql://figbloom_app:x@127.0.0.1:58322/figbloom_api" };
    for (const bad of ["*", "null", "https://app.example.com/", "https://app.example.com/path", "ftp://x.example.com", "app.example.com", "https://a.example.com,*"]) {
      expect(() => loadConfig({ ...base, CORS_ALLOWED_ORIGINS: bad }), bad).toThrow(/CORS_ALLOWED_ORIGINS/);
    }
    const ok = loadConfig({ ...base, CORS_ALLOWED_ORIGINS: "https://a.example.com, http://localhost:5173" });
    expect(ok.corsAllowedOrigins).toEqual(["https://a.example.com", "http://localhost:5173"]);
    expect(isExactHttpOrigin("https://a.example.com:8443")).toBe(true);
    expect(loadConfig(base).corsAllowedOrigins).toEqual([]);
  });

  it("server timeouts are set deliberately: keep-alive outlives common load balancer idle timeouts; headers timeout exceeds it", async () => {
    const a = await appWith({});
    expect(a.server.keepAliveTimeout).toBe(65_000); // > 60 s ALB-style idle timeout
    expect(a.server.headersTimeout).toBe(66_000);
    expect(a.server.requestTimeout).toBe(30_000);
    const base = { DATABASE_URL: "postgresql://figbloom_app:x@127.0.0.1:58322/figbloom_api" };
    expect(() => loadConfig({ ...base, SERVER_KEEP_ALIVE_TIMEOUT_MS: "70000", SERVER_HEADERS_TIMEOUT_MS: "60000" })).toThrow(/HEADERS_TIMEOUT/);
  });

  it("the 64 KiB body limit is kept", async () => {
    const big = "x".repeat(70 * 1024);
    const r = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: "a@b.co", password: big }),
    });
    expect(r.statusCode).toBe(413);
  });
});
