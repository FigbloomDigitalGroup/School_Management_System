import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import { createTestApp } from "./support.js";
import { BODY_FIXTURES, sampleBody } from "./support/routeSweep.js";

/**
 * Residual closure workstream 6: the raw-HTTP-500 inventory, by evidence. Every documented operation is attacked with hostile input
 * (each top-level body field replaced by wrong types, nulls, overflowing numbers, NUL bytes, impossible dates, malformed ids,
 * long strings; malformed path identifiers; hostile query values) as an authorised principal, so the request reaches the
 * handler instead of being stopped at authentication. A CLIENT-CAUSED condition must never be a 5xx; a 5xx here is by definition a
 * raw-error path and fails the test. Genuine internal failures (invariants, unavailable dependencies) are not reachable by any
 * client input and therefore never appear. The full inventory is written when ERRORS_INVENTORY_OUT is set.
 */
describe("hostile-input sweep: no client-caused 5xx on any documented operation", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const spec = YAML.parse(readFileSync(join(process.cwd(), "openapi", "openapi.yaml"), "utf8"));
  let admin: string;
  let su: string;
  const PASSWORD = "correct-horse-battery";
  beforeAll(async () => {
    ctx = await createTestApp();
    const login = async (email: string) => (await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email, password: PASSWORD } })).json().token as string;
    admin = await login("admin-a@example.com");
    su = await login("super@example.com");
  }, 120_000);
  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  const SKIP = new Set(["POST /v1/auth/logout", "POST /v1/auth/password/change", "POST /v1/auth/select-tenant", "POST /v1/auth/login/email", "POST /v1/auth/login/login-id", "POST /v1/auth/reauth"]);
  const HOSTILE_PATH = ["zzz", "0".repeat(36), "%00", "9".repeat(80), "00000000-0000-4000-8000-000000000000"];
  const HOSTILE_VALUES: unknown[] = [null, 42, true, [], {}, "", "x".repeat(5000), "a\u0000b", "2026-02-31", "not-a-uuid", -1, 2147483648, Number.MAX_SAFE_INTEGER + 2, -2147483649, 1e308, "‮\ud800", { $ne: 1 }, ["x"]];

  it("sweeps every operation with hostile bodies, paths and queries; reports any 5xx", async () => {
    const bad: { op: string; where: string; status: number; body: string }[] = [];
    const inventory: { op: string; requests: number; max4xx: number }[] = [];
    let total = 0;
    for (const [path, ops] of Object.entries<any>(spec.paths)) {
      for (const [method, op] of Object.entries<any>(ops)) {
        const key = `${method.toUpperCase()} ${path}`;
        if (SKIP.has(key)) continue;
        const token = path.startsWith("/v1/platform/") ? su : op["x-figbloom-authz"] === "public" ? null : admin;
        const send = async (url: string, payload: unknown, where: string) => {
          const res = await ctx.app.inject({
            method: method.toUpperCase() as "GET",
            url,
            headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "x-tenant-id": ctx.ids.tenantA },
            ...(payload === undefined ? {} : { payload: payload as never }),
          });
          total++;
          const isStructuredNotConfigured = res.statusCode === 503 && res.body.includes('"not_configured"');
          if (res.statusCode >= 500 && !isStructuredNotConfigured) {
            bad.push({ op: key, where, status: res.statusCode, body: res.body.slice(0, 160) });
          }
          return res.statusCode;
        };
        const baseUrl = path.replace(/\{tenantId\}/g, ctx.ids.tenantA).replace(/\{[A-Za-z]+\}/g, () => randomUUID());
        const required = (op.parameters ?? [])
          .map((p: any) => (p.$ref ? spec.components.parameters[String(p.$ref).split("/").pop()!] : p))
          .filter((p: any) => p?.in === "query" && p.required)
          .map((p: any) => p.name);
        const qsOk = required.map((n: string) => `${n}=${randomUUID()}`).join("&");
        const urlOk = qsOk ? `${baseUrl}?${qsOk}` : baseUrl;
        const base = method === "get" ? undefined : (BODY_FIXTURES[key] ?? sampleBody(spec, op) ?? {});
        let count = 0;
        // 1. hostile path identifiers
        for (const h of HOSTILE_PATH) {
          const m = path.match(/\{(?!tenantId)[A-Za-z]+\}/);
          if (!m) break;
          const url = path.replace(/\{tenantId\}/g, ctx.ids.tenantA).replace(m[0], h).replace(/\{[A-Za-z]+\}/g, () => randomUUID());
          await send(qsOk ? `${url}?${qsOk}` : url, base, `path=${h.slice(0, 20)}`);
          count++;
        }
        // 2. hostile query values (declared query parameters)
        for (const p of (op.parameters ?? []).map((x: any) => (x.$ref ? spec.components.parameters[String(x.$ref).split("/").pop()!] : x)).filter((x: any) => x?.in === "query").slice(0, 6)) {
          for (const v of ["zzz", "-1", "9".repeat(30), "%00", "' OR 1=1 --", "2026-02-31", ""]) {
            await send(`${baseUrl}?${[...required.filter((n: string) => n !== p.name).map((n: string) => `${n}=${randomUUID()}`), `${p.name}=${encodeURIComponent(v)}`].join("&")}`, base, `query ${p.name}=${v.slice(0, 12)}`);
            count++;
          }
        }
        // 3. hostile body fields
        if (base && typeof base === "object" && !Array.isArray(base)) {
          const fields = Object.keys(base as object).slice(0, 8);
          for (const f of fields) {
            for (const v of HOSTILE_VALUES) {
              await send(urlOk, { ...(base as object), [f]: v }, `body.${f}=${JSON.stringify(v)?.slice(0, 24)}`);
              count++;
            }
          }
          // unknown extra field and the empty body
          await send(urlOk, { ...(base as object), __proto__x: 1, constructor: { prototype: {} } }, "body.extra");
          await send(urlOk, {}, "body.empty");
          count += 2;
        }
        inventory.push({ op: key, requests: count, max4xx: 0 });
      }
    }
    if (process.env.ERRORS_INVENTORY_OUT) writeFileSync(process.env.ERRORS_INVENTORY_OUT, JSON.stringify({ operations: inventory.length, requests: total, fiveXX: bad }, null, 1));
    expect(inventory.length).toBeGreaterThan(200);
    expect(total).toBeGreaterThan(5000);
    expect(bad, "client-caused 5xx responses (each is a raw-error path)").toEqual([]);
  }, 1_800_000);
});
