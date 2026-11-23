import type { FastifyInstance } from "fastify";
import { calendarDateString } from "../schemas.js";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { hasPermission, requirePermission } from "../../modules/rbac/authorize.js";
import { academicsSummary, attendanceDaily, financeSummary, schoolOverview } from "../../modules/reporting/overview.js";
import { toCsv } from "../../modules/reporting/exportFormat.js";
import {
  authorizeExportDownload,
  createExportJob,
  EXPORT_DATASET_PERMISSION,
  extractDatasetTable,
  getExportJobById,
  listExportJobs,
  renderExportArtifact,
  type ExportDataset,
  type ExportFormat,
} from "../../modules/reporting/exportService.js";
import { getStorageProvider } from "../../modules/storage/storageProvider.js";
import { assertUuid, inTenant, optionalUuid, pageFrom } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";
import { validationError } from "../errors.js";

const DateQuery = z.strictObject({
  date: calendarDateString,
});

const CreateExportBody = z.strictObject({
  dataset: z.enum(["overview", "attendance", "finance", "academics", "learners"]),
  format: z.enum(["xlsx", "docx", "csv", "json"]),
  filters: z.record(z.string(), z.unknown()).optional(),
});

export const REPORTING_EXPORT_REQUEST_SCHEMAS = {
  "POST /v1/tenants/{tenantId}/reports/exports": CreateExportBody,
} as const;

const P = "/v1/tenants/:tenantId/reports";

export async function registerReportingRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.get(`${P}/overview`, async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.report.overview.read", { ip, deferAudit: true });
      return { overview: await schoolOverview(tx, params.tenantId) };
    });
  });

  app.get(`${P}/attendance-daily`, async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.report.attendance.read", { ip, deferAudit: true });
      const query = parseOrThrow(DateQuery, request.query, "date (YYYY-MM-DD) is required");
      return { report: await attendanceDaily(tx, params.tenantId, query.date) };
    });
  });

  app.get(`${P}/finance-summary`, async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      // S14-1: Separate finance summary permission (resource.finance.read) from general resource.report.read.
      await requirePermission(tx, auth.authz, "resource.finance.read", { ip, deferAudit: true });
      const q = request.query as { termId?: string };
      let termId: string | undefined;
      try {
        termId = optionalUuid(q.termId, "termId");
      } catch {
        throw validationError("termId must be a UUID");
      }
      return { summary: await financeSummary(tx, params.tenantId, termId) };
    });
  });

  app.get(`${P}/academics-summary`, async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      // Academic counts: academics.read (not overview/attendance report perms). Counts only — no invented KPIs.
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const q = request.query as { termId?: string };
      let termId: string | undefined;
      try {
        termId = optionalUuid(q.termId, "termId");
      } catch {
        throw validationError("termId must be a UUID");
      }
      return { summary: await academicsSummary(tx, params.tenantId, termId) };
    });
  });

  app.get(`${P}/export`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const q = request.query as { kind?: string; format?: string; date?: string; termId?: string };
    const kind = String(q.kind ?? "overview");
    const format = String(q.format ?? "json").toLowerCase();
    if (kind !== "overview" && kind !== "attendance" && kind !== "finance" && kind !== "academics" && kind !== "learners") {
      throw validationError("kind must be overview, attendance, finance, academics or learners");
    }
    if (format !== "json" && format !== "csv" && format !== "xlsx" && format !== "docx") {
      throw validationError("format must be json, csv, xlsx or docx");
    }
    const perm = EXPORT_DATASET_PERMISSION[kind as ExportDataset];

    if (format === "xlsx" || format === "docx" || kind === "learners") {
      const filters: Record<string, unknown> = {};
      if (q.date) filters.date = q.date;
      if (q.termId) filters.termId = optionalUuid(q.termId, "termId");
      const table = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
        await requirePermission(tx, auth.authz, perm, { ip, deferAudit: true });
        return extractDatasetTable(tx, params.tenantId, kind as ExportDataset, filters);
      });
      const artifact = renderExportArtifact(kind as ExportDataset, format as ExportFormat, table);
      return reply
        .header("content-type", artifact.contentType)
        .header("content-disposition", `attachment; filename="${artifact.fileName}"`)
        .send(artifact.buffer);
    }

    const data = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, perm, { ip, deferAudit: true });
      if (kind === "overview") return schoolOverview(tx, params.tenantId);
      if (kind === "attendance") {
        const parsed = parseOrThrow(DateQuery, { date: q.date }, "date (YYYY-MM-DD) is required");
        return attendanceDaily(tx, params.tenantId, parsed.date);
      }
      const termId = optionalUuid(q.termId, "termId");
      if (kind === "finance") return financeSummary(tx, params.tenantId, termId);
      return academicsSummary(tx, params.tenantId, termId);
    });

    if (format === "csv") {
      const entries = Object.entries(data as unknown as Record<string, unknown>).map(([k, v]) => [
        k,
        typeof v === "object" && v !== null ? JSON.stringify(v) : v,
      ]);
      const csv = toCsv(["metric", "value"], entries);
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="report-${kind}.csv"`)
        .send(csv);
    }
    return { kind, data };
  });

  app.post(`${P}/exports`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const job = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const body = parseOrThrow(CreateExportBody, request.body, "dataset and format are required");
      const perm = EXPORT_DATASET_PERMISSION[body.dataset];
      await requirePermission(tx, auth.authz, perm, { ip, deferAudit: true });
      return createExportJob(tx, {
        tenantId: params.tenantId,
        actorUserId: auth.user.id,
        dataset: body.dataset,
        format: body.format,
        filters: body.filters ?? {},
        ip,
      });
    });
    return reply.status(202).send({ export_job: job });
  });

  app.get(`${P}/exports`, async (request) => {
    const params = request.params as { tenantId: string };
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.report.overview.read", { ip, deferAudit: true });
      const allowed: ExportDataset[] = [];
      for (const [dataset, perm] of Object.entries(EXPORT_DATASET_PERMISSION) as [ExportDataset, string][]) {
        if (await hasPermission(tx, auth.authz, perm)) allowed.push(dataset);
      }
      return listExportJobs(tx, params.tenantId, page.limit, page.rawCursor, allowed);
    });
  });

  app.get(`${P}/exports/:exportId`, async (request) => {
    const params = request.params as { tenantId: string; exportId: string };
    assertUuid(params.exportId, "exportId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.report.overview.read", { ip, deferAudit: true });
      const job = await getExportJobById(tx, params.tenantId, params.exportId);
      await requirePermission(tx, auth.authz, EXPORT_DATASET_PERMISSION[job.dataset], { ip, deferAudit: true });
      return { export_job: job };
    });
  });

  app.post(`${P}/exports/:exportId/download-url`, async (request, reply) => {
    const params = request.params as { tenantId: string; exportId: string };
    assertUuid(params.exportId, "exportId");
    const target = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.report.overview.read", { ip, deferAudit: true });
      const job = await getExportJobById(tx, params.tenantId, params.exportId);
      await requirePermission(tx, auth.authz, EXPORT_DATASET_PERMISSION[job.dataset], { ip, deferAudit: true });
      return authorizeExportDownload(tx, {
        tenantId: params.tenantId,
        exportId: params.exportId,
        actorUserId: auth.user.id,
        ip,
      });
    });
    const out = await getStorageProvider().createPresignedDownload({
      tenantId: params.tenantId,
      objectKey: target.objectKey,
      downloadFilename: target.fileName,
    });
    if (out.status === "not_configured") return reply.status(503).send(out);
    return reply.status(200).send(out);
  });
}
