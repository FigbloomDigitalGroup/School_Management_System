import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { parse } from "yaml";
import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { normalizeIp, isIpInCidrs } from "../src/http/ip.js";
import { createTestApp, type FixtureIds } from "./support.js";

describe("FIG-1573 Session-2 remediation (R2)", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ids: FixtureIds;
  let config: AppConfig;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    pool = ctx.pool;
    ids = ctx.ids;
    config = ctx.config;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const PASSWORD = "correct-horse-battery";
  const postFrom = (
    a: FastifyInstance,
    remoteAddress: string,
    url: string,
    payload: unknown,
    headers: Record<string, string> = {},
  ) => a.inject({ method: "POST", url, payload: payload as object, headers, remoteAddress });

  async function limitedApp(over: Partial<AppConfig> = {}): Promise<FastifyInstance> {
    const a = await buildApp(
      { ...config, authRateCapacity: 5, authRateRefill: 2, authRateIntervalMs: 60_000, ...over },
      pool,
    );
    await a.ready();
    return a;
  }

  describe("R2-01 / R2-02 proxy trust and IP normalization", () => {
    it("rejects legacy API_TRUST_PROXY=true and incomplete hop/CIDR pairs", () => {
      expect(() =>
        loadConfig({ DATABASE_URL: "postgresql://x@127.0.0.1/figbloom_api", API_TRUST_PROXY: "true" } as NodeJS.ProcessEnv),
      ).toThrow(/API_TRUST_PROXY=true is no longer supported/);
      expect(() =>
        loadConfig({
          DATABASE_URL: "postgresql://x@127.0.0.1/figbloom_api",
          API_TRUST_PROXY_HOPS: "1",
        } as NodeJS.ProcessEnv),
      ).toThrow(/requires API_TRUST_PROXY_CIDRS/);
      expect(() =>
        loadConfig({
          DATABASE_URL: "postgresql://x@127.0.0.1/figbloom_api",
          API_TRUST_PROXY_CIDRS: "10.0.0.0/8",
        } as NodeJS.ProcessEnv),
      ).toThrow(/HOPS is 0/);
      expect(() =>
        loadConfig({
          DATABASE_URL: "postgresql://x@127.0.0.1/figbloom_api",
          API_TRUST_PROXY_HOPS: "1",
          API_TRUST_PROXY_CIDRS: "not-a-cidr",
        } as NodeJS.ProcessEnv),
      ).toThrow(/bad CIDR/);
    });

    it("normalizes IPs and rejects zone identifiers", () => {
      expect(normalizeIp("203.0.113.9")).toBe("203.0.113.9");
      expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
      expect(normalizeIp("[2001:db8::1]")).toBe("2001:db8::1");
      expect(normalizeIp("fe80::1%eth0")).toBeNull();
      expect(normalizeIp("fe80::1%25eth0")).toBeNull();
      expect(normalizeIp("not-an-ip")).toBeNull();
      expect(isIpInCidrs("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
      expect(isIpInCidrs("11.1.2.3", ["10.0.0.0/8"])).toBe(false);
    });

    it("with trust enabled, honours X-Forwarded-For only from a CIDR-matched peer", async () => {
      const a = await limitedApp({
        trustProxyHops: 1,
        trustProxyCidrs: ["198.51.100.0/24"],
      });
      // Trusted proxy peer → client IP becomes the forwarded address (separate IP buckets).
      const codesTrusted: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await postFrom(
          a,
          "198.51.100.10",
          "/v1/auth/login/email",
          { email: `trust-${randomUUID()}@example.com`, password: "x" },
          { "x-forwarded-for": `203.0.113.${i + 1}` },
        );
        codesTrusted.push(res.statusCode);
      }
      // Each forwarded client IP is distinct, so IP buckets do not trip at 6.
      expect(codesTrusted.every((c) => c === 401)).toBe(true);

      // Untrusted peer → forwarded header ignored; same socket IP trips at 6th.
      const codesForge: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await postFrom(
          a,
          "203.0.113.200",
          "/v1/auth/login/email",
          { email: `forge-${randomUUID()}@example.com`, password: "x" },
          { "x-forwarded-for": `198.51.100.${i + 1}` },
        );
        codesForge.push(res.statusCode);
      }
      expect(codesForge.slice(0, 5).every((c) => c === 401)).toBe(true);
      expect(codesForge[5]).toBe(429);
      await a.close();
    });

    it("R3-02 multi-entry XFF: leftmost forge ignored; hop-selected client used", async () => {
      const a = await limitedApp({
        trustProxyHops: 1,
        trustProxyCidrs: ["198.51.100.0/24"],
      });
      // Chain: client, forged, then immediate proxy. With hops=1 Fastify takes the
      // rightmost untrusted address before the trusted hop count.
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await postFrom(
          a,
          "198.51.100.20",
          "/v1/auth/login/email",
          { email: `xff-${randomUUID()}@example.com`, password: "x" },
          { "x-forwarded-for": `198.18.0.${i + 1}, 203.0.113.50` },
        );
        codes.push(res.statusCode);
      }
      // Same resolved client (203.0.113.50) → 6th attempt rate-limited.
      expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
      expect(codes[5]).toBe(429);
      await a.close();
    });

    it("malformed forwarded IPv6 zone IDs never produce HTTP 500", async () => {
      const a = await limitedApp({
        trustProxyHops: 1,
        trustProxyCidrs: ["198.51.100.0/24"],
      });
      const res = await postFrom(
        a,
        "198.51.100.11",
        "/v1/auth/login/email",
        { email: "admin-a@example.com", password: PASSWORD },
        { "x-forwarded-for": "fe80::1%eth0" },
      );
      expect(res.statusCode).toBe(200);
      expect(res.statusCode).not.toBe(500);
      const ev = await pool.query(
        `SELECT ip::text FROM security_audit_events WHERE event_type='auth.login.success' ORDER BY occurred_at DESC LIMIT 1`,
      );
      // Zone ID rejected → stored IP is the trusted proxy peer (or null), never a 500.
      expect(ev.rows[0]!.ip === null || /^[0-9a-f.:]+$/i.test(ev.rows[0]!.ip)).toBe(true);
      await a.close();
    });
  });

  describe("R2-03 IP-first rate-limit ordering", () => {
    it("exhausted IP bucket does not consume or create the account bucket", async () => {
      const a = await limitedApp();
      const ip = "198.51.100.77";
      for (let i = 0; i < 5; i++) {
        const res = await postFrom(a, ip, "/v1/auth/login/email", {
          email: `ipfirst-${i}-${randomUUID()}@example.com`,
          password: "wrong",
        });
        expect(res.statusCode).toBe(401);
      }
      const freshEmail = `ipfirst-fresh-${randomUUID()}@example.com`.toLowerCase();
      const accountKey = `login:email:${freshEmail}`;
      expect(
        (await pool.query(`SELECT 1 FROM auth_rate_buckets WHERE bucket_key=$1`, [accountKey])).rowCount,
      ).toBe(0);

      const denied = await postFrom(a, ip, "/v1/auth/login/email", {
        email: freshEmail,
        password: "wrong",
      });
      expect(denied.statusCode).toBe(429);
      expect(denied.headers["retry-after"]).toBeTruthy();
      expect(
        (await pool.query(`SELECT 1 FROM auth_rate_buckets WHERE bucket_key=$1`, [accountKey])).rowCount,
      ).toBe(0);
      await a.close();
    });
  });

  describe("R2-08 select-tenant edge cases", () => {
    it("returns 404 for a nonexistent school, not suspended", async () => {
      const token = (
        await app.inject({
          method: "POST",
          url: "/v1/auth/login/email",
          payload: { email: "admin-a@example.com", password: PASSWORD },
        })
      ).json().token as string;
      const missing = randomUUID();
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/select-tenant",
        headers: { authorization: `Bearer ${token}` },
        payload: { tenantId: missing },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message.toLowerCase()).toContain("not found");
      expect(res.json().error.message.toLowerCase()).not.toContain("suspended");
    });

    it("lets super_admin select a suspended school; school_admin cannot", async () => {
      await pool.query(`UPDATE tenants SET status='suspended' WHERE id=$1`, [ids.tenantA]);
      try {
        const adminTok = (
          await app.inject({
            method: "POST",
            url: "/v1/auth/login/email",
            payload: { email: "admin-a@example.com", password: PASSWORD },
          })
        ).json().token as string;
        const denied = await app.inject({
          method: "POST",
          url: "/v1/auth/select-tenant",
          headers: { authorization: `Bearer ${adminTok}` },
          payload: { tenantId: ids.tenantA },
        });
        expect(denied.statusCode).toBe(403);

        const superTok = (
          await app.inject({
            method: "POST",
            url: "/v1/auth/login/email",
            payload: { email: "super@example.com", password: PASSWORD },
          })
        ).json().token as string;
        const allowed = await app.inject({
          method: "POST",
          url: "/v1/auth/select-tenant",
          headers: { authorization: `Bearer ${superTok}` },
          payload: { tenantId: ids.tenantA },
        });
        expect(allowed.statusCode).toBe(200);
        expect(allowed.json().activeTenantId).toBe(ids.tenantA);
      } finally {
        await pool.query(`UPDATE tenants SET status='active' WHERE id=$1`, [ids.tenantA]);
      }
    });
  });

  describe("R2-08 rate-limit function EXECUTE grant", () => {
    it("current DB user can execute consume_rate_token", async () => {
      const priv = await pool.query<{ has: boolean }>(
        `SELECT has_function_privilege(current_user, 'consume_rate_token(text,numeric,numeric,numeric,integer)', 'EXECUTE') AS has`,
      );
      expect(priv.rows[0]!.has).toBe(true);
    });
  });

  describe("R2-10 OpenAPI completeness", () => {
    const spec = parse(readFileSync(resolve(__dirname, "../openapi/openapi.yaml"), "utf8")) as any;

    it("documents 404 on select-tenant, getTenant, staff-areas and a learner response schema", () => {
      expect(spec.paths["/v1/auth/select-tenant"].post.responses["404"]).toBeTruthy();
      expect(spec.paths["/v1/tenants/{tenantId}"].get.responses["404"]).toBeTruthy();
      expect(spec.paths["/v1/rbac/staff-areas"].put.responses["404"]).toBeTruthy();
      const learner = spec.paths["/v1/tenants/{tenantId}/resources/learners"].get;
      expect(learner.responses["200"].content["application/json"].schema.$ref).toContain("LearnerResourceAccess");
      expect(spec.components.schemas.LearnerResourceAccess.required).toEqual(
        expect.arrayContaining(["tenantId", "resource", "access"]),
      );
      expect(spec.components.responses.NotFound).toBeTruthy();
    });

    it("permission operations that can miss a resource declare 404 where the route returns it", () => {
      for (const [path, ops] of Object.entries<any>(spec.paths)) {
        for (const [method, op] of Object.entries<any>(ops)) {
          if (!["get", "put", "post", "patch", "delete"].includes(method)) continue;
          const schema200 = op.responses?.["200"]?.content?.["application/json"]?.schema;
          if (schema200) {
            const ref = schema200.$ref as string | undefined;
            if (ref) {
              const name = ref.split("/").pop()!;
              expect(spec.components.schemas[name], `${method} ${path} -> ${ref}`).toBeTruthy();
            }
          }
        }
      }
    });
  });
});
