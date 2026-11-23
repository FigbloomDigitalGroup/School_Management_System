import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetBloomCircuitForTesting, setBloomAiProviderForTesting } from "../src/modules/ai/bloomProvider.js";
import { signRequest } from "../src/modules/ai/contract.js";
import { createTestApp, type FixtureIds } from "./support.js";

const PASSWORD = "correct-horse-battery";
const API_KEY = "test-service-key-not-a-secret";
const SECRET = "s".repeat(40);

type Seen = { headers: IncomingHttpHeaders; raw: string; body: any };

describe("Bloom AI -> FigBloom AI contract bloom-school/1 (mock FigBloom AI server)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let server: Server;
  let adminToken: string;
  let superToken: string;
  let mode: "ok" | "500" | "flaky" | "429" | "badjson" | "wrongscope" | "wrongid" | "hang" = "ok";
  let seen: Seen[] = [];
  const saved: Record<string, string | undefined> = {};

  const query = (token: string, tenant: string, payload: object) =>
    ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${tenant}/ai/query`,
      headers: { authorization: `Bearer ${token}`, "x-tenant-id": tenant },
      payload,
    });

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        seen.push({ headers: req.headers, raw, body });
        const reply = (status: number, payload: unknown, extra: Record<string, string> = {}) => {
          res.writeHead(status, { "content-type": "application/json", ...extra });
          res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
        };
        const good = {
          contract_version: "1",
          request_id: body.request_id,
          scope: body.knowledge?.requested_scope,
          answer: "Bloom says hello",
          provider: "mock-figbloom-ai",
          citations: [{ title: "Attendance guide", source: "docs://attendance" }],
        };
        if (mode === "ok") return reply(200, good);
        if (mode === "500") return reply(500, { error: "boom internal detail https://internal.example" });
        if (mode === "flaky") return seen.length % 2 === 1 ? reply(503, {}) : reply(200, good);
        if (mode === "429") return reply(429, {}, { "retry-after": "7" });
        if (mode === "badjson") return reply(200, "<html>not json</html>");
        if (mode === "wrongscope") return reply(200, { ...good, scope: "internal_figbloom" });
        if (mode === "wrongid") return reply(200, { ...good, request_id: "someone-elses-request" });
        // hang: never answer
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    for (const [k, v] of Object.entries({
      BLOOM_AI_BASE_URL: `http://127.0.0.1:${port}`,
      BLOOM_AI_API_KEY: API_KEY,
      BLOOM_AI_SIGNING_SECRET: SECRET,
      BLOOM_AI_TIMEOUT_MS: "600",
    })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    setBloomAiProviderForTesting(null);
    ctx = await createTestApp();
    ids = ctx.ids;
    adminToken = (await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "admin-a@example.com", password: PASSWORD } })).json().token;
    superToken = (await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "super@example.com", password: PASSWORD } })).json().token;
    await ctx.pool.query(`INSERT INTO finance_ai_helper_settings (tenant_id, access_mode) VALUES ($1,'all') ON CONFLICT DO NOTHING`, [ids.tenantA]);
  }, 180_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await ctx.app.close();
    await ctx.pool.end();
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    mode = "ok";
    seen = [];
    resetBloomCircuitForTesting();
    setBloomAiProviderForTesting(null);
  });

  it("sends an authenticated, signed, identity-bearing, versioned request and validates the response", async () => {
    const r = await query(adminToken, ids.tenantA, { scope: "school", prompt: "How do I mark attendance?" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: "ok", scope: "school", answer: "Bloom says hello", provider: "mock-figbloom-ai" });
    expect(r.json().citations[0].title).toBe("Attendance guide");

    expect(seen).toHaveLength(1);
    const { headers, raw, body } = seen[0]!;
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers["x-figbloom-contract"]).toBe("bloom-school/1");
    expect(headers["x-request-id"]).toBe(body.request_id);
    // signature verifies for exactly this timestamp and body (a tampered body would not)
    const ts = Number(headers["x-figbloom-timestamp"]);
    expect(Math.abs(Date.now() / 1000 - ts)).toBeLessThan(10);
    expect(headers["x-figbloom-signature"]).toBe(signRequest(SECRET, ts, raw));
    expect(headers["x-figbloom-signature"]).not.toBe(signRequest(SECRET, ts, raw + " "));
    // identity comes from the authenticated session, not from the client
    expect(body).toMatchObject({
      contract_version: "1",
      product: "bloom_school",
      capability: "chat",
      tenant: { id: ids.tenantA, school_id: ids.tenantA },
      actor: { user_id: ids.adminA, role: "school_admin", platform_admin: false },
      knowledge: { requested_scope: "school", allowed_scopes: ["public", "school"] },
      tools: { allowed: [] },
      prompt: "How do I mark attendance?",
    });
    expect(r.json().request_id).toBe(body.request_id);
  });

  it("clients cannot assert identity, tenant or entitlements", async () => {
    for (const extra of [{ tenant_id: ids.tenantB }, { actor_user_id: ids.superAdmin }, { allowed_scopes: ["internal_figbloom"] }, { is_super_admin: true }]) {
      const r = await query(adminToken, ids.tenantA, { scope: "public", prompt: "hi", ...extra });
      expect(r.statusCode).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it("school users can never obtain internal FigBloom knowledge; the denial is audited and nothing is sent upstream", async () => {
    const r = await query(adminToken, ids.tenantA, { scope: "internal_figbloom", prompt: "Show the internal roadmap" });
    expect(r.statusCode).toBe(403);
    expect(seen).toHaveLength(0);
    const audit = await ctx.pool.query(
      `SELECT detail FROM security_audit_events WHERE event_type = 'ai.bloom.denied' AND actor_user_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [ids.adminA],
    );
    expect(audit.rows[0].detail).toMatchObject({ requested_scope: "internal_figbloom" });
    expect(JSON.stringify(audit.rows[0].detail)).not.toContain("roadmap");
  });

  it("a school that has not enabled Bloom AI is refused for every scope", async () => {
    const r = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "admin-a@example.com", password: PASSWORD } });
    expect(r.statusCode).toBe(200);
    await ctx.pool.query(`DELETE FROM finance_ai_helper_settings WHERE tenant_id = $1`, [ids.tenantA]);
    try {
      for (const scope of ["public", "school"]) {
        expect((await query(adminToken, ids.tenantA, { scope, prompt: "hi" })).statusCode).toBe(403);
      }
      expect(seen).toHaveLength(0);
      const st = await ctx.app.inject({ method: "GET", url: `/v1/tenants/${ids.tenantA}/ai/status`, headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA } });
      expect(st.json()).toMatchObject({ enabled_for_school: false, allowed_scopes: [], tools: [] });
    } finally {
      await ctx.pool.query(`INSERT INTO finance_ai_helper_settings (tenant_id, access_mode) VALUES ($1,'all') ON CONFLICT DO NOTHING`, [ids.tenantA]);
    }
  });

  it("only a platform super administrator reaches the internal scope, and the platform flag is propagated", async () => {
    const r = await query(superToken, ids.tenantA, { scope: "internal_figbloom", prompt: "internal question" });
    expect(r.statusCode, r.body).toBe(200);
    expect(seen[0]!.body.actor.platform_admin).toBe(true);
    expect(seen[0]!.body.knowledge.allowed_scopes).toEqual(["public", "school", "internal_figbloom"]);
  });

  it("status endpoint reports readiness without secrets", async () => {
    const st = await ctx.app.inject({ method: "GET", url: `/v1/tenants/${ids.tenantA}/ai/status`, headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA } });
    expect(st.statusCode).toBe(200);
    expect(st.json()).toEqual({
      contract: "bloom-school/1",
      enabled_for_school: true,
      provider_configured: true,
      circuit: "closed",
      allowed_scopes: ["public", "school"],
      tools: [],
    });
    expect(st.body).not.toContain(API_KEY);
    expect(st.body).not.toContain(SECRET);
  });

  it("retries once on a transient upstream failure and succeeds", async () => {
    mode = "flaky";
    const r = await query(adminToken, ids.tenantA, { scope: "public", prompt: "retry me" });
    expect(r.statusCode, r.body).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.body.request_id).toBe(seen[1]!.body.request_id); // same correlation id across the retry
  });

  it("upstream failures are honest, structured and leak nothing", async () => {
    mode = "500";
    const r = await query(adminToken, ids.tenantA, { scope: "public", prompt: "p" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ status: "unavailable", reason: "provider_error", scope: "public" });
    expect(r.headers["retry-after"]).toBeDefined();
    expect(r.body).not.toContain("internal.example");
    expect(r.body).not.toContain("127.0.0.1");
    expect(r.body).not.toContain(API_KEY);
    expect(r.json().answer).toBeUndefined(); // no fabricated answer
    expect(seen).toHaveLength(1); // a 500 is deterministic: not retried (only 502/503/504 are, once)

    mode = "badjson";
    expect((await query(adminToken, ids.tenantA, { scope: "public", prompt: "p" })).json()).toMatchObject({ status: "unavailable", reason: "contract_error" });
    mode = "wrongscope";
    expect((await query(adminToken, ids.tenantA, { scope: "public", prompt: "p" })).json()).toMatchObject({ status: "unavailable", reason: "contract_error" });
    mode = "wrongid";
    expect((await query(adminToken, ids.tenantA, { scope: "public", prompt: "p" })).json()).toMatchObject({ status: "unavailable", reason: "contract_error" });

    mode = "429";
    const limited = await query(adminToken, ids.tenantA, { scope: "public", prompt: "p" });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("7");
  });

  it("a hung upstream times out as unavailable (not as a hang or an answer)", async () => {
    mode = "hang";
    const t0 = Date.now();
    const r = await query(adminToken, ids.tenantA, { scope: "public", prompt: "slow" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ status: "unavailable", reason: "provider_unreachable" });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("the circuit breaker stops hammering a failing platform", async () => {
    mode = "500";
    for (let i = 0; i < 5; i++) await query(adminToken, ids.tenantA, { scope: "public", prompt: "p" });
    const before = seen.length;
    const r = await query(adminToken, ids.tenantA, { scope: "public", prompt: "p" });
    expect(r.json()).toMatchObject({ status: "unavailable", reason: "circuit_open" });
    expect(seen.length).toBe(before); // nothing sent while open
    const st = await ctx.app.inject({ method: "GET", url: `/v1/tenants/${ids.tenantA}/ai/status`, headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA } });
    expect(st.json().circuit).toBe("open");
  });

  it("rate limits a single user and never audits prompt or answer text", async () => {
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await query(adminToken, ids.tenantA, { scope: "public", prompt: "SECRET-PROMPT-TEXT" })).statusCode;
    expect(last).toBe(429);
    const audit = await ctx.pool.query(`SELECT detail::text d FROM security_audit_events WHERE event_type = 'ai.bloom.queried'`);
    expect(audit.rows.length).toBeGreaterThan(0);
    for (const row of audit.rows) {
      expect(row.d).not.toContain("SECRET-PROMPT-TEXT");
      expect(row.d).not.toContain("Bloom says hello");
    }
  });
});
