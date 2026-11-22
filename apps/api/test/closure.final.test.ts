import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { InMemoryStorageProvider, setStorageProviderForTesting } from "../src/modules/storage/storageProvider.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

// Final-closure regression tests: R-6 (export list visibility), R-7 (catalogue lineage), CA-09 (transport escalation).
const PASSWORD = "correct-horse-battery";

describe("final closure: R-6, R-7, CA-09", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let adminToken: string;
  let teacherToken: string;
  let driverToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    const login = async (payload: object, path = "/v1/auth/login/email") =>
      (await ctx.app.inject({ method: "POST", url: path, payload })).json().token as string;
    adminToken = await login({ email: "admin-a@example.com", password: PASSWORD });
    teacherToken = await login({ tenantId: ids.tenantA, loginId: "TC-0001", password: PASSWORD }, "/v1/auth/login/login-id");

    const driverId = randomUUID();
    await ctx.pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, status)
       SELECT $1, 'drv-cl@example.com', password_hash, 'Driver CL', 'active' FROM users WHERE id = $2`,
      [driverId, ids.adminA],
    );
    await ctx.pool.query(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'driver', 'DR-9901')`, [driverId, ids.tenantA]);
    driverToken = await login({ email: "drv-cl@example.com", password: PASSWORD });
    (globalThis as { __clDriverId?: string }).__clDriverId = driverId;
  }, 120_000);

  afterAll(async () => {
    if (ctx) {
      await ctx.app.close();
      await ctx.pool.end();
    }
  });

  const call = (tok: string, method: "GET" | "POST" | "PUT", path: string, payload?: unknown) =>
    ctx.app.inject({
      method,
      url: `/v1/tenants/${ids.tenantA}${path}`,
      headers: { authorization: `Bearer ${tok}`, "x-tenant-id": ids.tenantA },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  it("API contract: the documented upload response describes upload.requiredHeaders and matches the real response", async () => {
    const mem = new InMemoryStorageProvider();
    setStorageProviderForTesting(mem);
    try {
      const res = await call(adminToken, "POST", "/storage/objects", {
        owner_resource_type: "general", original_filename: "c.pdf", content_type: "application/pdf", byte_size: 10,
      });
      expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
      const doc = parseYaml(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../openapi/openapi.yaml"), "utf8")) as any;
      const schema = doc.paths["/v1/tenants/{tenantId}/storage/objects"].post.responses["201"].content["application/json"].schema;
      expect(schema.required).toEqual(["object", "upload"]);
      const ready = schema.properties.upload.oneOf.find((s: any) => s.properties.status.enum[0] === "ready");
      expect(ready.properties.requiredHeaders.additionalProperties.type).toBe("string");
      expect(Object.keys(ready.properties)).toEqual(expect.arrayContaining(Object.keys(res.json().upload)));
    } finally {
      setStorageProviderForTesting(null);
    }
  });

  it("R-6: the export list shows only datasets the caller may read; the single-job and download checks are unchanged", async () => {
    const mk = async (dataset: string) => {
      const r = await call(adminToken, "POST", "/reports/exports", { dataset, format: "csv", filters: {} });
      expect(r.statusCode, JSON.stringify(r.json())).toBe(202);
      return r.json().export_job.id as string;
    };
    const overviewJob = await mk("overview");
    const financeJob = await mk("finance");

    const adminList = await call(adminToken, "GET", "/reports/exports");
    const adminDatasets = (adminList.json().exports as { dataset: string }[]).map((e) => e.dataset);
    expect(adminDatasets).toEqual(expect.arrayContaining(["overview", "finance"]));

    // Give the teacher role overview-read only (no finance) for this test, then restore.
    await ctx.pool.query(`INSERT INTO role_permissions (role, permission_code) VALUES ('teacher', 'resource.report.overview.read') ON CONFLICT DO NOTHING`);
    try {
      const list = await call(teacherToken, "GET", "/reports/exports");
      expect(list.statusCode, JSON.stringify(list.json())).toBe(200);
      const rows = list.json().exports as { id: string; dataset: string }[];
      expect(rows.map((r) => r.id)).toContain(overviewJob);
      expect(rows.map((r) => r.id)).not.toContain(financeJob);
      expect(rows.every((r) => r.dataset === "overview")).toBe(true);
      expect((await call(teacherToken, "GET", `/reports/exports/${financeJob}`)).statusCode).toBe(403);
      expect((await call(teacherToken, "GET", `/reports/exports/${overviewJob}`)).statusCode).toBe(200);
    } finally {
      await ctx.pool.query(`DELETE FROM role_permissions WHERE role = 'teacher' AND permission_code = 'resource.report.overview.read'`);
    }
  });

  it("R-7: re-importing the base code of a superseded catalogue entry is detected as a duplicate of its current version", async () => {
    const base = `/academics/cbe/curriculum-catalogue`;
    const batch = (code: string) =>
      call(adminToken, "POST", `${base}/import-batches`, {
        source_organisation: "KICD Public Curriculum Designs",
        source_title: "Closure lineage fixture",
        retrieved_at: "2026-11-22",
        entries: [{ entry_kind: "learning_area", code, title: `Lineage ${code}` }],
      });
    const first = await batch("CL-R7-A");
    expect(first.statusCode, JSON.stringify(first.json())).toBe(201);
    expect(first.json().batch.imported_count).toBe(1);
    const v1 = (first.json().imported_entry_ids as string[])[0]!;

    const sup = await call(adminToken, "POST", `${base}/entries/${v1}/supersede`, { title: "Lineage v2", review_note: "revision" });
    expect(sup.statusCode, JSON.stringify(sup.json())).toBe(201);
    const v2 = sup.json().entry.id as string;

    const again = await batch("CL-R7-A");
    expect(again.statusCode).toBe(201);
    expect(again.json().batch.imported_count).toBe(0);
    expect(again.json().batch.duplicate_count).toBe(1);
    const n = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM curriculum_reference_entries WHERE tenant_id = $1 AND entry_kind = 'learning_area' AND code ILIKE 'CL-R7-A%' AND verification_status <> 'superseded'`,
      [ids.tenantA],
    );
    expect(n.rows[0]!.n).toBe(1);

    // A second revision keeps the lineage walk working (v1 -> v2 -> v3).
    const sup2 = await call(adminToken, "POST", `${base}/entries/${v2}/supersede`, { title: "Lineage v3", review_note: "revision 2" });
    expect(sup2.statusCode, JSON.stringify(sup2.json())).toBe(201);
    const third = await batch("cl-r7-a");
    expect(third.json().batch.imported_count).toBe(0);
    expect(third.json().batch.duplicate_count).toBe(1);

    // Other tenants and unrelated codes are unaffected.
    const fresh = await batch("CL-R7-B");
    expect(fresh.json().batch.imported_count).toBe(1);
  });

  it("CA-09: escalation never lowers severity and keeps the first escalation record", async () => {
    const driverId = (globalThis as { __clDriverId?: string }).__clDriverId!;
    const v = (await call(adminToken, "POST", "/vehicles", { plate_number: "KDA 901C", capacity: 30 })).json().vehicle.id as string;
    const r = (await call(adminToken, "POST", "/transport-routes", { name: "Route CL" })).json().route.id as string;
    expect((await call(adminToken, "POST", `/vehicles/${v}/assignments`, { driver_user_id: driverId, route_id: r })).statusCode).toBe(204);
    const trip = await call(driverToken, "POST", "/driver/trips", { vehicle_id: v, direction: "to_school" });
    expect(trip.statusCode, JSON.stringify(trip.json())).toBe(201);
    const tripId = trip.json().trip.id as string;
    expect((await call(driverToken, "POST", `/trips/${tripId}/events`, { event_type: "incident", note: "Escalation fixture" })).statusCode).toBe(201);
    const incidentId = (await call(adminToken, "GET", `/trips/${tripId}/incidents`)).json().incidents[0].id as string;
    const esc = (body: object) => call(adminToken, "POST", `/trips/${tripId}/incidents/${incidentId}/escalate`, body);

    const first = await esc({ reason: "first escalation", severity: "critical" });
    expect(first.statusCode, JSON.stringify(first.json())).toBe(200);
    expect(first.json().incident.severity).toBe("critical");
    const firstAt = first.json().incident.escalated_at as string;

    const second = await esc({ reason: "second escalation lower", severity: "high" });
    expect(second.statusCode).toBe(200);
    expect(second.json().incident.severity).toBe("critical"); // not lowered
    expect(second.json().incident.escalation_reason).toBe("first escalation"); // first record kept
    expect(second.json().incident.escalated_at).toBe(firstAt);
    expect(second.json().incident.escalated_by).toBe(ids.adminA);

    const ev = await ctx.pool.query<{ detail: { severityBefore: string; severityAfter: string } }>(
      `SELECT detail FROM security_audit_events WHERE event_type = 'transport.incident.escalated' AND detail->>'incidentId' = $1 ORDER BY occurred_at`,
      [incidentId],
    );
    expect(ev.rows.map((x) => [x.detail.severityBefore, x.detail.severityAfter])).toEqual([
      ["medium", "critical"],
      ["critical", "critical"],
    ]);
  });
});
