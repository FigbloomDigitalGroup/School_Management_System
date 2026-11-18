import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import { createTestApp } from "./support.js";
import { hashPassword } from "../src/modules/identity/password.js";

/**
 * FIG-1604: a user whose must_change_password flag is set may use only
 * POST /v1/auth/password/change, POST /v1/auth/logout and GET /v1/auth/me.
 * Every other registered route answers 403 until the password is changed.
 */
describe("FIG-1604 forced password change across the whole route table", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const PASSWORD = "correct-horse-battery";
  const NEW_PASSWORD = "brand-new-horse-77";
  const ALLOWED = new Set(["POST /v1/auth/password/change", "POST /v1/auth/logout", "GET /v1/auth/me"]);

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 120_000);
  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  async function newUser(
    email: string,
    kind: "school_admin" | "org_admin",
    mustChange: boolean,
  ): Promise<string> {
    const id = randomUUID();
    await ctx.pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, status, must_change_password)
       VALUES ($1, $2, $3, $4, 'active', $5)`,
      [id, email, await hashPassword(PASSWORD), email, mustChange],
    );
    if (kind === "school_admin") {
      await ctx.pool.query(
        `INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'school_admin', $3)`,
        [id, ctx.ids.tenantA, `AD-${String(1000 + Math.floor(Math.random() * 8999))}`],
      );
    } else {
      await ctx.pool.query(
        `INSERT INTO organization_memberships (user_id, organization_id, role) VALUES ($1, $2, 'org_admin')`,
        [id, ctx.ids.orgA],
      );
    }
    return id;
  }

  async function login(email: string): Promise<string> {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return res.json().token as string;
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}`, "x-tenant-id": ctx.ids.tenantA });

  it("the reported failure: GET /v1/org/schools is refused for a user who must change password", async () => {
    await newUser("forced-org@example.com", "org_admin", true);
    const token = await login("forced-org@example.com");
    const res = await ctx.app.inject({ method: "GET", url: "/v1/org/schools", headers: bearer(token) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/password change required/i);

    // Control: the same endpoint answers 200 once the flag is clear.
    const changed = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/password/change",
      headers: bearer(token),
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(changed.statusCode).toBe(200);
    const after = await ctx.app.inject({ method: "GET", url: "/v1/org/schools", headers: bearer(token) });
    expect(after.statusCode).toBe(200);
  });

  /**
   * Valid bodies for routes whose handler validates the body BEFORE authenticating. The OpenAPI
   * schema generator cannot produce them (patterns, at-least-one-field rules), and a 400 would
   * mask the gate. A 400 is treated as a test failure below, so a new validation-first route
   * must add a fixture here.
   */
  const BODY_FIXTURES: Record<string, unknown> = {
    "PATCH /v1/tenants/{tenantId}/guardians/{guardianId}": { full_name: "Fixture Guardian" },
    // PatchLearnerRequest has no required fields (every field is optional, at least one must be
    // present), so the schema generator produces {} and the refine would answer 400 first.
    "PATCH /v1/tenants/{tenantId}/learners/{learnerId}": { full_name: "Fixture Learner" },
    "PATCH /v1/tenants/{tenantId}/school-profile": { county: "Nairobi" },
    "POST /v1/tenants/{tenantId}/staff": { full_name: "Fixture Staff" },
    "PATCH /v1/tenants/{tenantId}/staff/{staffId}": { full_name: "Fixture Staff" },
  };

  /** Build a minimal body from the documented request schema so validation does not mask the gate. */
  function sampleBody(spec: any, op: any): unknown {
    const schema = op?.requestBody?.content?.["application/json"]?.schema;
    if (!schema) return undefined;
    const resolve = (s: any): any => {
      if (s?.$ref) {
        const name = String(s.$ref).split("/").pop()!;
        return resolve(spec.components.schemas[name]);
      }
      return s;
    };
    const make = (raw: any): unknown => {
      const s = resolve(raw);
      if (!s) return {};
      if (s.enum) return s.enum[0];
      const type = Array.isArray(s.type) ? s.type.find((t: string) => t !== "null") : s.type;
      if (type === "string") return s.format === "uuid" ? randomUUID() : "x";
      if (type === "integer" || type === "number") return s.minimum ?? 1;
      if (type === "boolean") return false;
      if (type === "array") return s.minItems ? [make(s.items)] : [];
      const out: Record<string, unknown> = {};
      for (const key of s.required ?? []) out[key] = make(s.properties?.[key]);
      return out;
    };
    return make(schema);
  }

  it("every authenticated route is refused, except the three allowlisted ones", async () => {
    await newUser("forced-admin@example.com", "school_admin", true);
    const token = await login("forced-admin@example.com");
    const spec = YAML.parse(readFileSync(join(process.cwd(), "openapi", "openapi.yaml"), "utf8"));

    const publicOps = new Set<string>();
    for (const [path, ops] of Object.entries<any>(spec.paths)) {
      for (const [method, op] of Object.entries<any>(ops)) {
        if (op["x-figbloom-authz"] === "public") publicOps.add(`${method.toUpperCase()} ${path}`);
      }
    }

    const seen = new Set<string>();
    const refused: string[] = [];
    const validationFirst: string[] = [];
    for (const route of ctx.app.routeTable) {
      const method = route.method.toUpperCase();
      if (method === "HEAD" || method === "OPTIONS") continue;
      const openapiPath = route.url.replace(/:([A-Za-z]+)/g, "{$1}");
      const key = `${method} ${openapiPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (publicOps.has(key) || ALLOWED.has(`${method} ${route.url}`)) continue;

      const op = spec.paths[openapiPath]?.[method.toLowerCase()];
      const pathUrl = route.url.replace(/:[A-Za-z]+/g, () => randomUUID());
      // Required query parameters from the contract, so query validation cannot mask the gate.
      const required = (op?.parameters ?? [])
        .map((p: any) => (p.$ref ? spec.components.parameters[String(p.$ref).split("/").pop()!] : p))
        .filter((p: any) => p?.in === "query" && p.required);
      const qs = required
        .map((p: any) => `${p.name}=${p.schema?.format === "uuid" ? randomUUID() : "1"}`)
        .join("&");
      const url = qs ? `${pathUrl}?${qs}` : pathUrl;
      const payload =
        method === "GET" || method === "DELETE" ? undefined : (BODY_FIXTURES[key] ?? sampleBody(spec, op) ?? {});
      const res = await ctx.app.inject({
        method: method as "GET",
        url,
        headers: bearer(token),
        payload: (method === "DELETE" ? sampleBody(spec, op) : payload) as never,
      });
      if (res.statusCode === 400) validationFirst.push(key);
      expect(res.statusCode, key).toBe(403);
      expect(res.json().error.message, key).toMatch(/password change required/i);
      refused.push(key);
    }
    expect(refused.length).toBeGreaterThan(20);
    // The sweep must be able to see routes at all; guard against it silently covering nothing.
    expect(refused).toContain("GET /v1/org/schools");
    expect(refused).toContain("GET /v1/rbac/permissions");
    expect(refused).toContain("POST /v1/auth/select-tenant");
    // No route may answer a validation error instead of the gate: that would prove nothing.
    expect(validationFirst).toEqual([]);
    for (const key of Object.keys(BODY_FIXTURES)) expect(refused, key).toContain(key);
  });

  it("the allowlist is exact: other methods and alternate paths for the same resources get no exemption", async () => {
    await newUser("forced-alt@example.com", "school_admin", true);
    const token = await login("forced-alt@example.com");
    const h = bearer(token);
    const send = (method: string, url: string, payload?: unknown) =>
      ctx.app.inject({ method: method as "GET", url, headers: h, payload: payload as never });
    // Same paths, methods the allowlist does not name: never a 200, never reaching a handler.
    for (const [method, url] of [
      ["POST", "/v1/auth/me"],
      ["PUT", "/v1/auth/password/change"],
      ["GET", "/v1/auth/logout"],
      ["GET", "/v1/auth/password/change"],
      ["DELETE", "/v1/auth/me"],
      ["GET", "/v1/auth/me/"],
      ["GET", "/v1/auth/me/extra"],
      ["POST", "/v1/auth/logout/"],
      ["GET", "/V1/AUTH/ME"],
    ] as const) {
      const res = await send(method, url, method === "GET" || method === "DELETE" ? undefined : {});
      expect([403, 404, 405], `${method} ${url}`).toContain(res.statusCode);
    }
    // Neighbouring authenticated routes stay refused.
    for (const url of ["/v1/auth/select-tenant", "/v1/org/schools", "/v1/rbac/permissions"]) {
      const res = await send(url.endsWith("select-tenant") ? "POST" : "GET", url, url.endsWith("select-tenant") ? { tenantId: ctx.ids.tenantA } : undefined);
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error.message).toMatch(/password change required/i);
    }
  });

  it("the three allowlisted endpoints stay usable while the flag is set", async () => {
    await newUser("forced-allow@example.com", "school_admin", true);
    const token = await login("forced-allow@example.com");
    const me = await ctx.app.inject({ method: "GET", url: "/v1/auth/me", headers: bearer(token) });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.must_change_password).toBe(true);
    const out = await ctx.app.inject({ method: "POST", url: "/v1/auth/logout", headers: bearer(token) });
    expect(out.statusCode).toBe(200);

    const token2 = await login("forced-allow@example.com");
    const changed = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/password/change",
      headers: bearer(token2),
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().user.must_change_password).toBe(false);

    // Normal access is restored once the password has been changed (a fresh login, as the
    // change revokes the session that made it).
    const loginAgain = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email: "forced-allow@example.com", password: NEW_PASSWORD },
    });
    expect(loginAgain.statusCode).toBe(200);
    const restored = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ctx.ids.tenantA}`,
      headers: bearer(loginAgain.json().token as string),
    });
    expect(restored.statusCode).toBe(200);
  });

  it("a delegated org admin cannot use delegated permissions until the password is changed", async () => {
    const delegate = await newUser("forced-delegate@example.com", "org_admin", true);
    const admin = await login("admin-a@example.com");
    const grant = await ctx.app.inject({
      method: "POST",
      url: "/v1/rbac/org-delegations",
      headers: bearer(admin),
      payload: { delegateUserId: delegate, permissionCodes: ["tenant.read", "rbac.staff_areas.manage"] },
    });
    expect(grant.statusCode).toBe(200);

    const token = await login("forced-delegate@example.com");
    const blocked = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ctx.ids.tenantA}`,
      headers: bearer(token),
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.message).toMatch(/password change required/i);
    const blockedWrite = await ctx.app.inject({
      method: "PUT",
      url: "/v1/rbac/staff-areas",
      headers: bearer(token),
      payload: { userId: ctx.ids.teacherA, areas: ["fees"] },
    });
    expect(blockedWrite.statusCode).toBe(403);
    expect(blockedWrite.json().error.message).toMatch(/password change required/i);
    // The delegation never took effect: no area was changed.
    const areas = await ctx.pool.query(`SELECT 1 FROM staff_area_grants WHERE user_id = $1 AND area = 'fees'`, [
      ctx.ids.teacherA,
    ]);
    expect(areas.rowCount).toBe(0);

    const changed = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/password/change",
      headers: bearer(token),
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(changed.statusCode).toBe(200);
    const ok = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ctx.ids.tenantA}`,
      headers: bearer(token),
    });
    expect(ok.statusCode).toBe(200);
  });

  it("a user whose flag is false is unaffected", async () => {
    const token = await login("admin-a@example.com");
    const res = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ctx.ids.tenantA}`,
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(200);
  });
});
