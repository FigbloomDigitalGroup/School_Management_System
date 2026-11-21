import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { COMMUNICATIONS_REQUEST_SCHEMAS } from "../src/http/routes/communications.js";
import { createTestApp, type FixtureIds } from "./support.js";
import { loadSpec, responseSchema, validate } from "./support/openapiConformance.js";

type Json = any;
const spec = loadSpec();
const PASSWORD = "correct-horse-battery";

function communicationsOps(): string[] {
  const out: string[] = [];
  for (const [p, item] of Object.entries<Json>(spec.paths)) {
    for (const [m, op] of Object.entries<Json>(item)) {
      if (op?.tags?.includes("communications")) out.push(`${m.toUpperCase()} ${p}`);
    }
  }
  return out.sort();
}

describe("Stage 12 OpenAPI communications contract (OA-6)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let adminToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    adminToken = (
      await ctx.app.inject({
        method: "POST",
        url: "/v1/auth/login/email",
        payload: { email: "admin-a@example.com", password: PASSWORD },
      })
    ).json().token;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("every communications request schema matches its OpenAPI request body", () => {
    const drift: string[] = [];
    for (const [key, schema] of Object.entries(COMMUNICATIONS_REQUEST_SCHEMAS)) {
      const [method, path] = key.split(" ") as [string, string];
      const body = spec.paths[path]?.[method.toLowerCase()]?.requestBody?.content?.["application/json"]?.schema;
      if (!body?.$ref) {
        drift.push(`${key}: no $ref request body`);
        continue;
      }
      const documented = String(body.$ref).slice(2).split("/").reduce((cur: Json, k: string) => cur?.[k], spec);
      const runtime = z.toJSONSchema(schema, { unrepresentable: "any" }) as Json;
      delete runtime.$schema;
      if (!isDeepStrictEqual(documented.required?.sort(), runtime.required?.sort()) && documented.required) {
        const runtimeReq = new Set(runtime.required ?? []);
        for (const r of documented.required as string[]) {
          if (!runtimeReq.has(r) && !(r in (runtime.properties ?? {}))) drift.push(`${key}: missing ${r}`);
        }
      }
      if (documented.additionalProperties !== false) drift.push(`${key}: request body is not closed`);
      if (
        !isDeepStrictEqual(Object.keys(documented.properties ?? {}).sort(), Object.keys(runtime.properties ?? {}).sort())
      ) {
        drift.push(`${key}: property set drift`);
      }
    }
    expect(drift).toEqual([]);
  });

  it("route parity: every communications route is documented and every documented communications op is routed", () => {
    const routed = new Set<string>();
    for (const r of ctx.app.routeTable) {
      const method = r.method.toUpperCase();
      if (method === "HEAD" || method === "OPTIONS") continue;
      if (
        r.url.startsWith("/v1/tenants/:tenantId/communications") ||
        r.url.startsWith("/v1/tenants/:tenantId/gate-visits")
      ) {
        routed.add(`${method} ${r.url.replace(/:([A-Za-z]+)/g, "{$1}")}`);
      }
    }
    expect([...routed].sort()).toEqual(communicationsOps());
    expect(communicationsOps().length).toBe(10);
  });

  it("OA-6 runtime tour: every communications & gate-visits endpoint conforms to its OpenAPI 2xx response schema", async () => {
    const headers = { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA };
    const checked: string[] = [];

    function assertSchema(method: string, specPath: string, status: number, body: unknown) {
      const schema = responseSchema(spec, method, specPath, status);
      expect(typeof schema, `${method} ${specPath} ${status}`).toBe("object");
      const errs = validate(spec, schema, body);
      expect(errs, `${method} ${specPath} ${status}: ${errs.join("; ")}`).toEqual([]);
      checked.push(`${method} ${specPath}`);
    }

    // 1. POST /communications/announcements
    const createAnn = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements`,
      headers,
      payload: { subject: "OA6 Notice", body: "Body", audience: { kind: "whole_school" }, channels: ["in_app", "sms"] },
    });
    expect(createAnn.statusCode).toBe(201);
    assertSchema("POST", "/v1/tenants/{tenantId}/communications/announcements", 201, createAnn.json());
    const annId = createAnn.json().announcement.id as string;

    // 2. GET /communications/announcements
    const listAnn = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements`,
      headers,
    });
    expect(listAnn.statusCode).toBe(200);
    assertSchema("GET", "/v1/tenants/{tenantId}/communications/announcements", 200, listAnn.json());

    // 3. POST /communications/announcements/{announcementId}/publish
    const pubAnn = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements/${annId}/publish`,
      headers,
    });
    expect(pubAnn.statusCode).toBe(200);
    assertSchema("POST", "/v1/tenants/{tenantId}/communications/announcements/{announcementId}/publish", 200, pubAnn.json());

    // 4. GET /communications/announcements/{announcementId}
    const getAnn = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements/${annId}`,
      headers,
    });
    expect(getAnn.statusCode).toBe(200);
    assertSchema("GET", "/v1/tenants/{tenantId}/communications/announcements/{announcementId}", 200, getAnn.json());

    // 5. GET /communications/announcements/inbox
    const inbox = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements/inbox`,
      headers,
    });
    expect(inbox.statusCode).toBe(200);
    assertSchema("GET", "/v1/tenants/{tenantId}/communications/announcements/inbox", 200, inbox.json());

    // 6. POST /communications/announcements/{announcementId}/read (204)
    const readAnn = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements/${annId}/read`,
      headers,
    });
    expect(readAnn.statusCode).toBe(204);
    expect(readAnn.body).toBe("");
    checked.push("POST /v1/tenants/{tenantId}/communications/announcements/{announcementId}/read");

    // 7. POST /gate-visits
    const createVisit = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/gate-visits`,
      headers,
      payload: { visitor_name: "OA6 Visitor", purpose: "Contract tour", host_kind: "office" },
    });
    expect(createVisit.statusCode).toBe(201);
    assertSchema("POST", "/v1/tenants/{tenantId}/gate-visits", 201, createVisit.json());
    const visitId = createVisit.json().visit.id as string;

    // 8. GET /gate-visits
    const listVisits = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/gate-visits`,
      headers,
    });
    expect(listVisits.statusCode).toBe(200);
    assertSchema("GET", "/v1/tenants/{tenantId}/gate-visits", 200, listVisits.json());

    // 9. GET /gate-visits/{visitId}
    const getVisit = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/gate-visits/${visitId}`,
      headers,
    });
    expect(getVisit.statusCode).toBe(200);
    assertSchema("GET", "/v1/tenants/{tenantId}/gate-visits/{visitId}", 200, getVisit.json());

    // 10. POST /gate-visits/{visitId}/advance
    const advVisit = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/gate-visits/${visitId}/advance`,
      headers,
      payload: { status: "at_reception" },
    });
    expect(advVisit.statusCode).toBe(200);
    assertSchema("POST", "/v1/tenants/{tenantId}/gate-visits/{visitId}/advance", 200, advVisit.json());

    expect(checked.sort()).toEqual(communicationsOps());
  });
});
