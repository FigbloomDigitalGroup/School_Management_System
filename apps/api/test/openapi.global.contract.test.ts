import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ACCOUNT_REQUEST_SCHEMAS } from "../src/http/routes/accounts.js";
import { AI_REQUEST_SCHEMAS } from "../src/http/routes/ai.js";
import { MFA_REQUEST_SCHEMAS } from "../src/http/routes/auth.js";
import { CURRICULUM_CATALOGUE_REQUEST_SCHEMAS } from "../src/http/routes/curriculumCatalogue.js";
import { GUARDIAN_INVITATION_REQUEST_SCHEMAS } from "../src/http/routes/guardianInvitations.js";
import { HR_LEAVE_REQUEST_SCHEMAS } from "../src/http/routes/hrLeave.js";
import { INVENTORY_STOCK_REQUEST_SCHEMAS } from "../src/http/routes/inventory.js";
import { MEDICATION_REQUEST_SCHEMAS } from "../src/http/routes/medication.js";
import { NOTIFICATION_REQUEST_SCHEMAS } from "../src/http/routes/notifications.js";
import { REPORTING_EXPORT_REQUEST_SCHEMAS } from "../src/http/routes/reporting.js";
import { STORAGE_REQUEST_SCHEMAS } from "../src/http/routes/storage.js";
import { TRANSPORT_OPERATIONS_REQUEST_SCHEMAS } from "../src/http/routes/transportOperations.js";
import { UNMATCHED_REQUEST_SCHEMAS } from "../src/http/routes/unmatchedCallbacks.js";
import { createTestApp, type FixtureIds } from "./support.js";
import { loadSpec, responseSchema, validate } from "./support/openapiConformance.js";

type Json = any;
const spec = loadSpec();
const PASSWORD = "correct-horse-battery";
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

function allDocumentedOperations(): string[] {
  const ops: string[] = [];
  for (const [p, item] of Object.entries<Json>(spec.paths ?? {})) {
    for (const [m] of Object.entries<Json>(item)) {
      if (HTTP_METHODS.has(m.toLowerCase())) {
        ops.push(`${m.toUpperCase()} ${p}`);
      }
    }
  }
  return ops.sort();
}

describe("Global OpenAPI parity, static schema completeness & Stage 12–16 runtime conformance tour (OA-1..OA-8)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let adminToken: string;
  let driverId: string;
  let learnerId: string;

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

    driverId = randomUUID();
    await ctx.pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, status)
       SELECT $1, 'driver-oa@example.com', password_hash, 'Driver OA', 'active' FROM users WHERE id = $2`,
      [driverId, ids.adminA],
    );
    await ctx.pool.query(
      `INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'driver', 'DR-0999')`,
      [driverId, ids.tenantA],
    );

    const l = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { full_name: "OA7 Learner", admission_no: "OA7-001", date_of_birth: "2014-01-15", gender: "female" },
    });
    expect(l.statusCode).toBe(201);
    learnerId = l.json().learner.id as string;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("OA-7: bidirectional routeTable parity — every registered Fastify route is in openapi.yaml and every documented op is registered", () => {
    const runtimeOps = new Set<string>();
    for (const r of ctx.app.routeTable) {
      const method = r.method.toUpperCase();
      if (method === "HEAD" || method === "OPTIONS") continue;
      const normalizedPath = r.url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
      runtimeOps.add(`${method} ${normalizedPath}`);
    }
    const specOps = new Set(allDocumentedOperations());
    const extraInRuntime = [...runtimeOps].filter((op) => !specOps.has(op));
    const extraInSpec = [...specOps].filter((op) => !runtimeOps.has(op));
    expect(extraInRuntime, "undocumented routes in app.routeTable").toEqual([]);
    expect(extraInSpec, "unimplemented operations in openapi.yaml").toEqual([]);
    expect(runtimeOps.size).toBeGreaterThanOrEqual(212);
  });

  it("REQ-19: account, guardian-invitation, unmatched-callback, MFA, AI, transport, notification, storage, export, medication and curriculum Zod request schemas match openapi.yaml", () => {
    const registry: Record<string, z.ZodType> = {
      ...ACCOUNT_REQUEST_SCHEMAS,
      ...GUARDIAN_INVITATION_REQUEST_SCHEMAS,
      ...UNMATCHED_REQUEST_SCHEMAS,
      ...MFA_REQUEST_SCHEMAS,
      ...AI_REQUEST_SCHEMAS,
      ...TRANSPORT_OPERATIONS_REQUEST_SCHEMAS,
      ...NOTIFICATION_REQUEST_SCHEMAS,
      ...STORAGE_REQUEST_SCHEMAS,
      ...REPORTING_EXPORT_REQUEST_SCHEMAS,
      ...MEDICATION_REQUEST_SCHEMAS,
      ...CURRICULUM_CATALOGUE_REQUEST_SCHEMAS,
      ...INVENTORY_STOCK_REQUEST_SCHEMAS,
      ...HR_LEAVE_REQUEST_SCHEMAS,
    };
    const drift: string[] = [];
    for (const [key, schema] of Object.entries(registry)) {
      const [method, path] = key.split(" ") as [string, string];
      const rbSchema = spec.paths[path]?.[method.toLowerCase()]?.requestBody?.content?.["application/json"]?.schema;
      if (!rbSchema) {
        drift.push(`${key}: no application/json requestBody schema in openapi.yaml`);
        continue;
      }
      const documented = rbSchema.$ref
        ? String(rbSchema.$ref).slice(2).split("/").reduce((cur: Json, k: string) => cur?.[k], spec)
        : rbSchema;
      const runtime = z.toJSONSchema(schema, { unrepresentable: "any" }) as Json;
      delete runtime.$schema;
      if (!isDeepStrictEqual(documented, runtime)) {
        drift.push(`${key}: spec and runtime schemas differ\n  spec=${JSON.stringify(documented)}\n  zod=${JSON.stringify(runtime)}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it("OA-1, OA-3, OA-4, OA-5 & OA-8: every non-204 response defines an application/json schema, pagination/404/413/requestBody contracts hold", () => {
    const missingSchemas: string[] = [];
    for (const [path, item] of Object.entries<Json>(spec.paths ?? {})) {
      for (const [method, op] of Object.entries<Json>(item)) {
        if (!HTTP_METHODS.has(method)) continue;
        const where = `${method.toUpperCase()} ${path}`;
        for (const [code, resp] of Object.entries<Json>(op.responses ?? {})) {
          const r = resp.$ref
            ? String(resp.$ref).slice(2).split("/").reduce((cur: Json, k: string) => cur?.[k], spec)
            : resp;
          const schema = r?.content?.["application/json"]?.schema;
          if (code === "204") {
            if (schema) missingSchemas.push(`${where} 204 should not have schema`);
          } else if (!schema) {
            missingSchemas.push(`${where} ${code} missing schema`);
          }
        }
      }
    }
    expect(missingSchemas).toEqual([]);

    // OA-3: All 13 Stage 12–13 list endpoints declare PageLimit, PageCursor, and PageInfo in 200 response
    const pagingPaths = [
      "/v1/tenants/{tenantId}/gate-visits",
      "/v1/tenants/{tenantId}/communications/announcements",
      "/v1/tenants/{tenantId}/communications/announcements/inbox",
      "/v1/tenants/{tenantId}/health/sick-bay/board",
      "/v1/tenants/{tenantId}/chat/conversations",
      "/v1/tenants/{tenantId}/chat/conversations/{conversationId}/messages",
      "/v1/tenants/{tenantId}/inventory/items",
      "/v1/tenants/{tenantId}/inventory/issues",
      "/v1/tenants/{tenantId}/leave-requests",
      "/v1/tenants/{tenantId}/activities",
      "/v1/tenants/{tenantId}/activities/{activityId}/members",
      "/v1/tenants/{tenantId}/vehicles",
      "/v1/tenants/{tenantId}/transport-routes",
    ];
    for (const p of pagingPaths) {
      const op = spec.paths[p]?.get;
      expect(op, p).toBeTruthy();
      const paramRefs = (op.parameters ?? []).map((x: Json) => x.$ref).filter(Boolean);
      expect(paramRefs, `${p} PageLimit`).toContain("#/components/parameters/PageLimit");
      expect(paramRefs, `${p} PageCursor`).toContain("#/components/parameters/PageCursor");
      const schema = op.responses["200"]?.content?.["application/json"]?.schema;
      expect(schema?.properties?.page?.$ref, `${p} PageInfo`).toBe("#/components/schemas/PageInfo");
    }

    // OA-4: All 8 parent-ID routes document 404
    const parentIdRoutes: Array<[string, string]> = [
      ["get", "/v1/tenants/{tenantId}/chat/conversations/{conversationId}/messages"],
      ["post", "/v1/tenants/{tenantId}/chat/conversations/{conversationId}/messages"],
      ["post", "/v1/tenants/{tenantId}/chat/conversations/{conversationId}/read"],
      ["post", "/v1/tenants/{tenantId}/activities/{activityId}/patrons"],
      ["get", "/v1/tenants/{tenantId}/activities/{activityId}/members"],
      ["post", "/v1/tenants/{tenantId}/activities/{activityId}/members"],
      ["post", "/v1/tenants/{tenantId}/vehicles/{vehicleId}/assignments"],
      ["post", "/v1/tenants/{tenantId}/transport-routes/{routeId}/stops"],
    ];
    for (const [m, p] of parentIdRoutes) {
      expect(spec.paths[p]?.[m]?.responses?.["404"], `${m.toUpperCase()} ${p} 404`).toBeTruthy();
    }

    // OA-5: inventory/issues/{issueId}/close has required requestBody and 400
    const closeOp = spec.paths["/v1/tenants/{tenantId}/inventory/issues/{issueId}/close"]?.post;
    expect(closeOp?.requestBody?.required).toBe(true);
    expect(closeOp?.responses?.["400"]).toBeTruthy();

    // OA-2 & OA-8: imports/learners/preview documents 413 PayloadTooLarge
    const previewOp = spec.paths["/v1/tenants/{tenantId}/imports/learners/preview"]?.post;
    expect(previewOp?.responses?.["413"]?.$ref).toBe("#/components/responses/PayloadTooLarge");
  });

  it("OA-1 & OA-7 runtime conformance tour: health, me, health_services, chat, inventory, leave, activities, transport, reporting, and import responses conform to openapi.yaml", async () => {
    const headers = { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA };

    function check(method: string, specPath: string, status: number, body: unknown) {
      const schema = responseSchema(spec, method, specPath, status);
      expect(typeof schema, `${method} ${specPath} ${status}`).toBe("object");
      const errs = validate(spec, schema, body);
      expect(errs, `${method} ${specPath} ${status}: ${errs.join("; ")}`).toEqual([]);
    }

    // Health endpoints
    for (const hPath of ["/livez", "/health", "/v1/health"]) {
      const r = await ctx.app.inject({ method: "GET", url: hPath });
      expect(r.statusCode).toBe(200);
      check("GET", hPath, 200, r.json());
    }
    const ready = await ctx.app.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(200);
    check("GET", "/readyz", 200, ready.json());

    // Me notifications
    const prefsGet = await ctx.app.inject({ method: "GET", url: "/v1/me/notification-preferences", headers });
    expect(prefsGet.statusCode).toBe(200);
    check("GET", "/v1/me/notification-preferences", 200, prefsGet.json());

    const prefsPatch = await ctx.app.inject({
      method: "PATCH",
      url: "/v1/me/notification-preferences",
      headers,
      payload: { general_notices: true },
    });
    expect(prefsPatch.statusCode).toBe(200);
    check("PATCH", "/v1/me/notification-preferences", 200, prefsPatch.json());

    const devReg = await ctx.app.inject({
      method: "POST",
      url: "/v1/me/device-tokens",
      headers,
      payload: { token: "fcm-oa7-token-0123456789abcdef", platform: "android" },
    });
    expect(devReg.statusCode).toBe(201);
    check("POST", "/v1/me/device-tokens", 201, devReg.json());

    const devList = await ctx.app.inject({ method: "GET", url: "/v1/me/device-tokens", headers });
    expect(devList.statusCode).toBe(200);
    check("GET", "/v1/me/device-tokens", 200, devList.json());

    // Health services (sick bay)
    const medGet = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/health/medical-settings`,
      headers,
    });
    expect(medGet.statusCode).toBe(200);
    check("GET", "/v1/tenants/{tenantId}/health/medical-settings", 200, medGet.json());

    const medPut = await ctx.app.inject({
      method: "PUT",
      url: `/v1/tenants/${ids.tenantA}/health/medical-settings`,
      headers,
      payload: { notify_guardians: "all" },
    });
    expect(medPut.statusCode).toBe(200);
    check("PUT", "/v1/tenants/{tenantId}/health/medical-settings", 200, medPut.json());

    const sbCreate = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/health/sick-bay/visits`,
      headers,
      payload: { learner_id: learnerId, complaint: "Cough", temperature_c: 37.5 },
    });
    expect(sbCreate.statusCode).toBe(201);
    check("POST", "/v1/tenants/{tenantId}/health/sick-bay/visits", 201, sbCreate.json());
    const sbVisitId = sbCreate.json().visit.id as string;

    const sbBoard = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/health/sick-bay/board`,
      headers,
    });
    expect(sbBoard.statusCode).toBe(200);
    check("GET", "/v1/tenants/{tenantId}/health/sick-bay/board", 200, sbBoard.json());

    const sbGet = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/health/sick-bay/visits/${sbVisitId}`,
      headers,
    });
    expect(sbGet.statusCode).toBe(200);
    check("GET", "/v1/tenants/{tenantId}/health/sick-bay/visits/{visitId}", 200, sbGet.json());

    const sbPatch = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/tenants/${ids.tenantA}/health/sick-bay/visits/${sbVisitId}`,
      headers,
      payload: { row_version: 1, outcome: "class", time_out: new Date().toISOString() },
    });
    expect(sbPatch.statusCode).toBe(200);
    check("PATCH", "/v1/tenants/{tenantId}/health/sick-bay/visits/{visitId}", 200, sbPatch.json());

    // Chat
    const convCreate = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/chat/conversations`,
      headers,
      payload: { peer_user_id: ids.teacherA },
    });
    expect(convCreate.statusCode).toBe(201);
    check("POST", "/v1/tenants/{tenantId}/chat/conversations", 201, convCreate.json());
    const convId = convCreate.json().conversation.id as string;

    const convList = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/chat/conversations`,
      headers,
    });
    expect(convList.statusCode).toBe(200);
    check("GET", "/v1/tenants/{tenantId}/chat/conversations", 200, convList.json());

    const msgSend = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/chat/conversations/${convId}/messages`,
      headers,
      payload: { body: "OA7 contract message" },
    });
    expect(msgSend.statusCode).toBe(201);
    check("POST", "/v1/tenants/{tenantId}/chat/conversations/{conversationId}/messages", 201, msgSend.json());

    const msgList = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/chat/conversations/${convId}/messages`,
      headers,
    });
    expect(msgList.statusCode).toBe(200);
    check("GET", "/v1/tenants/{tenantId}/chat/conversations/{conversationId}/messages", 200, msgList.json());

    // Inventory
    const itemCreate = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/inventory/items`,
      headers,
      payload: { name: "OA7 Atlas", category: "textbooks", tracking: "stock", quantity: 3 },
    });
    expect(itemCreate.statusCode).toBe(201);
    check("POST", "/v1/tenants/{tenantId}/inventory/items", 201, itemCreate.json());
    const itemId = itemCreate.json().item.id as string;

    const itemList = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/inventory/items`,
      headers,
    });
    expect(itemList.statusCode).toBe(200);
    check("GET", "/v1/tenants/{tenantId}/inventory/items", 200, itemList.json());

    const itemGet = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/inventory/items/${itemId}`,
      headers,
    });
    expect(itemGet.statusCode).toBe(200);
    check("GET", "/v1/tenants/{tenantId}/inventory/items/{itemId}", 200, itemGet.json());

    const issueCreate = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/inventory/issues`,
      headers,
      payload: { item_id: itemId, holder_user_id: ids.teacherA, quantity: 1 },
    });
    expect(issueCreate.statusCode).toBe(201);
    check("POST", "/v1/tenants/{tenantId}/inventory/issues", 201, issueCreate.json());
    const issueId = issueCreate.json().issue.id as string;

    const issueList = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/inventory/issues`,
      headers,
    });
    expect(issueList.statusCode).toBe(200);
    check("GET", "/v1/tenants/{tenantId}/inventory/issues", 200, issueList.json());

    const issueClose = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/inventory/issues/${issueId}/close`,
      headers,
      payload: { status: "returned", returned_condition: "good" },
    });
    expect(issueClose.statusCode).toBe(200);
    check("POST", "/v1/tenants/{tenantId}/inventory/issues/{issueId}/close", 200, issueClose.json());

    const itemRetire = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/inventory/items/${itemId}/retire`,
      headers,
    });
    expect(itemRetire.statusCode).toBe(200);
    check("POST", "/v1/tenants/{tenantId}/inventory/items/{itemId}/retire", 200, itemRetire.json());

    // Leave
    const leaveSub = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/leave-requests`,
      headers,
      payload: { start_on: "2026-09-01", end_on: "2026-09-02", reason: "OA7 Leave" },
    });
    expect(leaveSub.statusCode).toBe(201);
    check("POST", "/v1/tenants/{tenantId}/leave-requests", 201, leaveSub.json());
    const leaveId = leaveSub.json().leave_request.id as string;

    const leaveList = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/leave-requests`,
      headers,
    });
    expect(leaveList.statusCode).toBe(200);
    check("GET", "/v1/tenants/{tenantId}/leave-requests", 200, leaveList.json());

    const leaveCancel = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/leave-requests/${leaveId}/cancel`,
      headers,
    });
    expect(leaveCancel.statusCode).toBe(200);
    check("POST", "/v1/tenants/{tenantId}/leave-requests/{leaveId}/cancel", 200, leaveCancel.json());

    // Activities
    const actCreate = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/activities`,
      headers,
      payload: { name: "OA7 Drama Club", category: "arts" },
    });
    expect(actCreate.statusCode).toBe(201);
    check("POST", "/v1/tenants/{tenantId}/activities", 201, actCreate.json());
    const actId = actCreate.json().activity.id as string;

    const actList = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/activities`,
      headers,
    });
    expect(actList.statusCode).toBe(200);
    check("GET", "/v1/tenants/{tenantId}/activities", 200, actList.json());

    await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/activities/${actId}/members`,
      headers,
      payload: { learner_id: learnerId, role: "Member" },
    });
    const actMembers = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/activities/${actId}/members`,
      headers,
    });
    expect(actMembers.statusCode).toBe(200);
    check("GET", "/v1/tenants/{tenantId}/activities/{activityId}/members", 200, actMembers.json());

    // Transport
    const vehCreate = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/vehicles`,
      headers,
      payload: { plate_number: "KBA 777X", capacity: 15 },
    });
    expect(vehCreate.statusCode).toBe(201);
    check("POST", "/v1/tenants/{tenantId}/vehicles", 201, vehCreate.json());
    const vehId = vehCreate.json().vehicle.id as string;

    const vehList = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/vehicles`,
      headers,
    });
    expect(vehList.statusCode).toBe(200);
    check("GET", "/v1/tenants/{tenantId}/vehicles", 200, vehList.json());

    const rtCreate = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/transport-routes`,
      headers,
      payload: { name: "OA7 East Route" },
    });
    expect(rtCreate.statusCode).toBe(201);
    check("POST", "/v1/tenants/{tenantId}/transport-routes", 201, rtCreate.json());
    const rtId = rtCreate.json().route.id as string;

    const rtList = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/transport-routes`,
      headers,
    });
    expect(rtList.statusCode).toBe(200);
    check("GET", "/v1/tenants/{tenantId}/transport-routes", 200, rtList.json());

    const stopCreate = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/transport-routes/${rtId}/stops`,
      headers,
      payload: { name: "Stop OA7", sequence: 1 },
    });
    expect(stopCreate.statusCode).toBe(201);
    check("POST", "/v1/tenants/{tenantId}/transport-routes/{routeId}/stops", 201, stopCreate.json());

    await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/vehicles/${vehId}/assignments`,
      headers,
      payload: { driver_user_id: driverId, route_id: rtId },
    });

    const ltPut = await ctx.app.inject({
      method: "PUT",
      url: `/v1/tenants/${ids.tenantA}/learner-transport`,
      headers,
      payload: { learner_id: learnerId, route_id: rtId, stop_id: stopCreate.json().stop.id },
    });
    expect(ltPut.statusCode).toBe(200);
    check("PUT", "/v1/tenants/{tenantId}/learner-transport", 200, ltPut.json());

    const tripStart = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/trips`,
      headers,
      payload: { vehicle_id: vehId, driver_user_id: driverId, route_id: rtId },
    });
    expect(tripStart.statusCode).toBe(201);
    check("POST", "/v1/tenants/{tenantId}/trips", 201, tripStart.json());

    // Reporting
    const repOv = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/reports/overview`,
      headers,
    });
    expect(repOv.statusCode).toBe(200);
    check("GET", "/v1/tenants/{tenantId}/reports/overview", 200, repOv.json());

    const repAtt = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/reports/attendance-daily?date=2026-03-01`,
      headers,
    });
    expect(repAtt.statusCode).toBe(200);
    check("GET", "/v1/tenants/{tenantId}/reports/attendance-daily", 200, repAtt.json());

    const repFin = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/reports/finance-summary`,
      headers,
    });
    expect(repFin.statusCode).toBe(200);
    check("GET", "/v1/tenants/{tenantId}/reports/finance-summary", 200, repFin.json());

    // Import
    const impPrev = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/preview`,
      headers,
      payload: {
        csv: "admission_no,full_name,gender,date_of_birth,boarding\nOA7-IMP-1,Imported Learner,female,2014-01-01,false",
      },
    });
    expect(impPrev.statusCode).toBe(200);
    check("POST", "/v1/tenants/{tenantId}/imports/learners/preview", 200, impPrev.json());

    const impApply = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/apply`,
      headers,
      payload: { import_id: impPrev.json().preview.import_id },
    });
    expect(impApply.statusCode).toBe(200);
    check("POST", "/v1/tenants/{tenantId}/imports/learners/apply", 200, impApply.json());
  });
});
