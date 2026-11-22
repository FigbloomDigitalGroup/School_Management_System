import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";
import { parseZipEntries } from "../src/modules/reporting/ooxml.js";
import { InMemoryStorageProvider, setStorageProviderForTesting } from "../src/modules/storage/storageProvider.js";
import { workerHandlers } from "../src/worker/handlers.js";
import { runCycle } from "../src/worker/runtime.js";
import { mpesaProviderFromConfig } from "../src/modules/finance/mpesaProvider.js";
import { createPool } from "../src/db/pool.js";

const PASSWORD = "correct-horse-battery";

describe("Stage 4: XLSX & DOCX Exports + Async Export Jobs (migration 091)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let adminToken: string;
  let teacherAToken: string;
  let teacherBToken: string;
  let workerPool: ReturnType<typeof createPool>;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;

    const workerPassword = `wrk_${randomUUID().replace(/-/g, "")}`;
    await ctx.pool.query(`ALTER ROLE figbloom_worker WITH LOGIN PASSWORD '${workerPassword}'`);
    const workerUrl = new URL(process.env.MIGRATION_DATABASE_URL!);
    workerUrl.username = "figbloom_worker";
    workerUrl.password = workerPassword;
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2, applicationName: "figbloom-test-worker" });

    adminToken = (
      await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "admin-a@example.com", password: PASSWORD } })
    ).json().token as string;
    teacherAToken = (
      await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId: ids.tenantA, loginId: "TC-0001", password: PASSWORD } })
    ).json().token as string;
    teacherBToken = (
      await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId: ids.tenantB, loginId: "TC-0001", password: PASSWORD } })
    ).json().token as string;

    // Seed a normal learner via API and a legacy formula-injection learner row directly in DB
    const l = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: {
        full_name: "Alice Export",
        admission_no: "EXP-001",
        date_of_birth: "2014-05-10",
        gender: "female",
      },
    });
    expect(l.statusCode, JSON.stringify(l.json())).toBe(201);
    await ctx.pool.query(
      `INSERT INTO learners (tenant_id, full_name, admission_no, date_of_birth, gender)
       VALUES ($1, '=CMD|'' /C calc''!A0', 'EXP-002', '2014-05-10', 'male')`,
      [ids.tenantA],
    );
  }, 120_000);

  afterEach(() => {
    setStorageProviderForTesting(null);
  });

  afterAll(async () => {
    setStorageProviderForTesting(null);
    if (workerPool) await workerPool.end();
    if (ctx) {
      await ctx.app.close();
      await ctx.pool.end();
    }
  });

  it("generates valid OOXML XLSX (with formula-injection neutralization) and DOCX files synchronously", async () => {
    // 1. XLSX learners export
    const xlsxRes = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/reports/export?kind=learners&format=xlsx`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(xlsxRes.statusCode).toBe(200);
    expect(xlsxRes.headers["content-type"]).toContain("spreadsheetml.sheet");
    const xlsxEntries = parseZipEntries(xlsxRes.rawPayload);
    expect(xlsxEntries.has("[Content_Types].xml")).toBe(true);
    expect(xlsxEntries.has("xl/workbook.xml")).toBe(true);
    expect(xlsxEntries.has("xl/worksheets/sheet1.xml")).toBe(true);
    const sheetXml = xlsxEntries.get("xl/worksheets/sheet1.xml")!.toString("utf8");
    expect(sheetXml).toContain("EXP-001");
    // Formula injection MUST be neutralized with leading apostrophe & stored as inlineStr, NEVER <f>
    expect(sheetXml).toContain("&apos;=CMD|&apos; /C calc&apos;!A0");
    expect(sheetXml).not.toContain("<f>");
    // Internal DB columns must not appear
    expect(sheetXml).not.toContain("tenant_id");
    expect(sheetXml).not.toContain("archived_at");

    // 2. DOCX overview export
    const docxRes = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/reports/export?kind=overview&format=docx`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(docxRes.statusCode).toBe(200);
    expect(docxRes.headers["content-type"]).toContain("wordprocessingml.document");
    const docxEntries = parseZipEntries(docxRes.rawPayload);
    expect(docxEntries.has("[Content_Types].xml")).toBe(true);
    expect(docxEntries.has("word/document.xml")).toBe(true);
    const docXml = docxEntries.get("word/document.xml")!.toString("utf8");
    expect(docXml).toContain("School Overview Report");
    expect(docXml).toContain("<w:tbl>");
  });

  it("runs async export jobs via worker into S3 storage with authorization and cross-tenant isolation", async () => {
    const mockStorage = new InMemoryStorageProvider();
    setStorageProviderForTesting(mockStorage);

    // Unauthorized role cannot request finance export (403)
    const denied = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/reports/exports`,
      headers: { authorization: `Bearer ${teacherAToken}`, "x-tenant-id": ids.tenantA },
      payload: { dataset: "finance", format: "xlsx" },
    });
    expect(denied.statusCode).toBe(403);

    // Cross-tenant export denied (403)
    const cross = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/reports/exports`,
      headers: { authorization: `Bearer ${teacherBToken}`, "x-tenant-id": ids.tenantA },
      payload: { dataset: "overview", format: "xlsx" },
    });
    expect(cross.statusCode).toBe(403);

    // Admin creates async XLSX learners export job
    const createRes = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/reports/exports`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { dataset: "learners", format: "xlsx" },
    });
    expect(createRes.statusCode).toBe(202);
    const exportId = createRes.json().export_job.id as string;
    expect(createRes.json().export_job.status).toBe("queued");

    // Download before completion is refused (409)
    const earlyDl = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/reports/exports/${exportId}/download-url`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(earlyDl.statusCode).toBe(409);

    // Worker processes export.generate job
    const handlers = workerHandlers(mpesaProviderFromConfig(ctx.app.appConfig), { storageProvider: mockStorage });
    const outcome = await runCycle(workerPool, { workerName: "test-export-worker", leaseSeconds: 60, handlers });
    expect(outcome).toBe("succeeded");

    // Status is now completed with row_count >= 1
    const statusRes = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/reports/exports/${exportId}`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().export_job.status).toBe("completed");
    expect(statusRes.json().export_job.row_count).toBeGreaterThanOrEqual(1);
    expect(statusRes.json().export_job.storage_object_id).toBeTruthy();

    // Authorized download URL succeeds
    const dlRes = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/reports/exports/${exportId}/download-url`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(dlRes.statusCode).toBe(200);
    expect(dlRes.json().status).toBe("ready");
    expect(dlRes.json().url).toContain("https://mock-s3.local/download/");

    // Stored artifact in mock S3 is a valid XLSX archive
    expect(mockStorage.store.size).toBe(1);
    const storedBuf = [...mockStorage.store.values()][0]!.body;
    const entries = parseZipEntries(storedBuf);
    expect(entries.has("xl/worksheets/sheet1.xml")).toBe(true);
    expect(entries.get("xl/worksheets/sheet1.xml")!.toString("utf8")).toContain("&apos;=CMD|&apos; /C calc&apos;!A0");
  });
});
