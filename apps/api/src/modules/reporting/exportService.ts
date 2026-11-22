import type { Tx } from "../../db/sql.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import type { PageInfo } from "../../http/pagination.js";
import { pageQuery } from "../academics/pagination.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { getStorageProvider, type StorageProvider } from "../storage/storageProvider.js";
import { PermanentJobError, RetryableJobError, type JobContext } from "../../worker/runtime.js";
import { toCsv } from "./exportFormat.js";
import { buildDocx, buildXlsx, type XlsxCellValue } from "./ooxml.js";
import { academicsSummary, attendanceDaily, financeSummary, schoolOverview } from "./overview.js";

export type ExportDataset = "overview" | "attendance" | "finance" | "academics" | "learners";
export type ExportFormat = "xlsx" | "docx" | "csv" | "json";

export interface ExportJobRow {
  id: string;
  tenant_id: string;
  requested_by: string | null;
  dataset: ExportDataset;
  format: ExportFormat;
  filters: Record<string, unknown>;
  status: "queued" | "processing" | "completed" | "failed" | "expired";
  storage_object_id: string | null;
  file_name: string | null;
  content_type: string | null;
  byte_size: number | null;
  row_count: number | null;
  error_code: string | null;
  expires_at: string | null;
  created_at: string;
  completed_at: string | null;
}

export const EXPORT_DATASET_PERMISSION: Record<ExportDataset, string> = {
  overview: "resource.report.overview.read",
  attendance: "resource.report.attendance.read",
  finance: "resource.finance.read",
  academics: "resource.academics.read",
  learners: "resource.learner.read",
};

export const EXPORT_CONTENT_TYPES: Record<ExportFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  csv: "text/csv",
  json: "application/json",
};

const COLS = `id, tenant_id, requested_by, dataset, format, filters, status, storage_object_id,
  file_name, content_type, byte_size, row_count, error_code, expires_at, created_at, completed_at`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Safe tabular extraction with explicit column allowlists (never exposes internal columns). */
export async function extractDatasetTable(
  tx: Tx,
  tenantId: string,
  dataset: ExportDataset,
  filters: Record<string, unknown>,
): Promise<{ title: string; headers: string[]; rows: XlsxCellValue[][] }> {
  if (dataset === "overview") {
    const data = await schoolOverview(tx, tenantId);
    const rows: XlsxCellValue[][] = Object.entries(data as unknown as Record<string, unknown>).map(([k, v]) => [
      k,
      typeof v === "number" || typeof v === "boolean" || typeof v === "string" ? v : JSON.stringify(v),
    ]);
    return { title: "School Overview Report", headers: ["Metric", "Value"], rows };
  }
  if (dataset === "attendance") {
    const date = typeof filters.date === "string" && DATE_RE.test(filters.date) ? filters.date : null;
    if (!date) throw validationError("filters.date (YYYY-MM-DD) is required for attendance export");
    const data = await attendanceDaily(tx, tenantId, date);
    const rows: XlsxCellValue[][] = Object.entries(data as unknown as Record<string, unknown>).map(([k, v]) => [
      k,
      typeof v === "number" || typeof v === "boolean" || typeof v === "string" ? v : JSON.stringify(v),
    ]);
    return { title: `Daily Attendance Report (${date})`, headers: ["Metric", "Value"], rows };
  }
  if (dataset === "finance") {
    const termId = typeof filters.termId === "string" && UUID_RE.test(filters.termId) ? filters.termId : undefined;
    const data = await financeSummary(tx, tenantId, termId);
    const rows: XlsxCellValue[][] = Object.entries(data as unknown as Record<string, unknown>).map(([k, v]) => [
      k,
      typeof v === "number" || typeof v === "boolean" || typeof v === "string" ? v : JSON.stringify(v),
    ]);
    return { title: "Finance Summary Report", headers: ["Metric", "Value"], rows };
  }
  if (dataset === "academics") {
    const termId = typeof filters.termId === "string" && UUID_RE.test(filters.termId) ? filters.termId : undefined;
    const data = await academicsSummary(tx, tenantId, termId);
    const rows: XlsxCellValue[][] = Object.entries(data as unknown as Record<string, unknown>).map(([k, v]) => [
      k,
      typeof v === "number" || typeof v === "boolean" || typeof v === "string" ? v : JSON.stringify(v),
    ]);
    return { title: "Academics Summary Report", headers: ["Metric", "Value"], rows };
  }
  // learners: explicit safe columns only (capped at 10,000 rows for bounded memory)
  const res = await tx.query<{
    admission_no: string;
    full_name: string;
    gender: string | null;
    date_of_birth: string | null;
    boarding: boolean | null;
    active: boolean;
  }>(
    `SELECT admission_no, full_name, gender, date_of_birth::text, boarding, active
       FROM learners
      WHERE tenant_id = $1 AND archived_at IS NULL
      ORDER BY admission_no ASC, id ASC
      LIMIT 10000`,
    [tenantId],
  );
  return {
    title: "Learners Register Export",
    headers: ["Admission No", "Full Name", "Gender", "Date of Birth", "Boarding", "Active"],
    rows: res.rows.map((r) => [r.admission_no, r.full_name, r.gender ?? "", r.date_of_birth ?? "", Boolean(r.boarding), r.active]),
  };
}

export function renderExportArtifact(
  dataset: ExportDataset,
  format: ExportFormat,
  table: { title: string; headers: string[]; rows: XlsxCellValue[][] },
): { buffer: Buffer; contentType: string; fileName: string } {
  const fileName = `figbloom-${dataset}.${format}`;
  const contentType = EXPORT_CONTENT_TYPES[format];
  if (format === "xlsx") {
    return {
      buffer: buildXlsx({ sheetName: dataset, title: table.title, headers: table.headers, rows: table.rows }),
      contentType,
      fileName,
    };
  }
  if (format === "docx") {
    return {
      buffer: buildDocx({
        title: table.title,
        subtitle: `Dataset: ${dataset}`,
        metadata: [
          ["Dataset", dataset],
          ["Row Count", String(table.rows.length)],
        ],
        sections: [
          {
            heading: "Report Data",
            table: {
              headers: table.headers,
              rows: table.rows.map((row) => row.map((v) => (v === null || v === undefined ? "" : String(v)))),
            },
          },
        ],
      }),
      contentType,
      fileName,
    };
  }
  if (format === "csv") {
    return {
      buffer: Buffer.from(toCsv(table.headers, table.rows), "utf8"),
      contentType,
      fileName,
    };
  }
  return {
    buffer: Buffer.from(JSON.stringify({ title: table.title, headers: table.headers, rows: table.rows }, null, 2), "utf8"),
    contentType,
    fileName,
  };
}

export async function createExportJob(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    dataset: ExportDataset;
    format: ExportFormat;
    filters: Record<string, unknown>;
    ip?: string | null;
  },
): Promise<ExportJobRow> {
  if (input.dataset === "attendance") {
    if (typeof input.filters.date !== "string" || !DATE_RE.test(input.filters.date)) {
      throw validationError("filters.date (YYYY-MM-DD) is required for attendance export");
    }
  }
  const res = await tx.query<ExportJobRow>(
    `INSERT INTO export_jobs (tenant_id, requested_by, dataset, format, filters, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'queued')
     RETURNING ${COLS}`,
    [input.tenantId, input.actorUserId, input.dataset, input.format, JSON.stringify(input.filters)],
  );
  const job = res.rows[0]!;
  await tx.query(
    `INSERT INTO jobs (tenant_id, job_type, payload, idempotency_key, enqueued_by_user_id)
     VALUES ($1, 'export.generate', $2::jsonb, $3, $4)`,
    [input.tenantId, JSON.stringify({ exportJobId: job.id }), `export:${job.id}`, input.actorUserId],
  );
  await recordSecurityEvent(tx, {
    eventType: "reporting.export.requested",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    ip: input.ip,
    detail: { exportJobId: job.id, dataset: input.dataset, format: input.format },
  });
  return job;
}

export async function listExportJobs(
  tx: Tx,
  tenantId: string,
  limit: number,
  rawCursor: unknown,
  /** Datasets the caller may read; jobs for any other dataset are not listed (metadata would leak). */
  allowedDatasets: readonly ExportDataset[],
): Promise<{ exports: ExportJobRow[]; page: PageInfo }> {
  const res = await pageQuery<ExportJobRow>(
    tx,
    `SELECT ${COLS} FROM export_jobs WHERE tenant_id = $1 AND dataset = ANY($2::text[])`,
    [tenantId, [...allowedDatasets]],
    { name: "created_at", expr: "q.created_at", type: "timestamptz", dir: "desc" },
    { limit, rawCursor },
  );
  return { exports: res.rows, page: res.page };
}

export async function getExportJobById(tx: Tx, tenantId: string, exportId: string): Promise<ExportJobRow> {
  const res = await tx.query<ExportJobRow>(
    `SELECT ${COLS} FROM export_jobs WHERE tenant_id = $1 AND id = $2`,
    [tenantId, exportId],
  );
  if (!res.rows[0]) throw notFound("Export job not found");
  return res.rows[0];
}

/** Worker handler for `export.generate`: builds XLSX/DOCX/CSV/JSON and stores it in S3 storage_objects. */
export async function processExportJob(ctx: JobContext, overrideStorage?: StorageProvider): Promise<void> {
  const exportJobId = ctx.payload.exportJobId;
  if (typeof exportJobId !== "string" || !UUID_RE.test(exportJobId)) {
    throw new PermanentJobError("invalid_payload");
  }
  const storage = overrideStorage ?? getStorageProvider();

  // 1. Load export job and extract dataset under tenant RLS
  const prepared = await ctx.inTenant(async (tx) => {
    const res = await tx.query<ExportJobRow>(
      `SELECT ${COLS} FROM export_jobs WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, exportJobId],
    );
    const job = res.rows[0];
    if (!job) throw new PermanentJobError("export_job_not_found");
    if (job.status === "completed") return { alreadyDone: true as const };

    await tx.query(`UPDATE export_jobs SET status = 'processing' WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      exportJobId,
    ]);

    const table = await extractDatasetTable(tx, ctx.tenantId, job.dataset, job.filters ?? {});
    const artifact = renderExportArtifact(job.dataset, job.format, table);

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const objRes = await tx.query<{ id: string; object_key: string }>(
      `INSERT INTO storage_objects (
         tenant_id, owner_resource_type, owner_resource_id, uploaded_by, object_key,
         original_filename, content_type, byte_size, storage_provider, status, expires_at
       ) VALUES ($1, 'export_artifact', $2, $3, 'server_generated', $4, $5, $6, $7, 'pending_upload', $8)
       RETURNING id, object_key`,
      [
        ctx.tenantId,
        job.id,
        job.requested_by,
        artifact.fileName,
        artifact.contentType,
        artifact.buffer.byteLength,
        storage.providerName,
        expiresAt.toISOString(),
      ],
    );
    return {
      alreadyDone: false as const,
      job,
      artifact,
      rowCount: table.rows.length,
      storageObjectId: objRes.rows[0]!.id,
      objectKey: objRes.rows[0]!.object_key,
      expiresAt,
    };
  });

  if (prepared.alreadyDone) return;

  // 2. Upload artifact bytes to S3 OUTSIDE the DB transaction
  const put = await storage.putObject({
    tenantId: ctx.tenantId,
    objectKey: prepared.objectKey,
    contentType: prepared.artifact.contentType,
    body: prepared.artifact.buffer,
  });

  if (put.status === "not_configured") {
    await ctx.fenced(async (tx) => {
      await tx.query(`UPDATE storage_objects SET status = 'failed' WHERE tenant_id = $1 AND id = $2`, [
        ctx.tenantId,
        prepared.storageObjectId,
      ]);
      await tx.query(
        `UPDATE export_jobs SET status = 'failed', error_code = 'storage_provider_not_configured', completed_at = now() WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, exportJobId],
      );
    });
    throw new PermanentJobError("storage_provider_not_configured");
  }

  if (put.status === "error") {
    await ctx.fenced(async (tx) => {
      await tx.query(`UPDATE storage_objects SET status = 'failed' WHERE tenant_id = $1 AND id = $2`, [
        ctx.tenantId,
        prepared.storageObjectId,
      ]);
      await tx.query(`UPDATE export_jobs SET status = 'failed', error_code = $3 WHERE tenant_id = $1 AND id = $2`, [
        ctx.tenantId,
        exportJobId,
        put.code,
      ]);
    });
    throw new RetryableJobError(put.code);
  }

  // 3. Finalize storage_objects and export_jobs atomically under lease fence
  await ctx.fenced(async (tx) => {
    await tx.query(
      `UPDATE storage_objects SET status = 'available', byte_size = $3, checksum_sha256 = $4 WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, prepared.storageObjectId, put.byteSize, put.checksumSha256],
    );
    await tx.query(
      `UPDATE export_jobs
          SET status = 'completed',
              storage_object_id = $3,
              file_name = $4,
              content_type = $5,
              byte_size = $6,
              row_count = $7,
              error_code = NULL,
              expires_at = $8,
              completed_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [
        ctx.tenantId,
        exportJobId,
        prepared.storageObjectId,
        prepared.artifact.fileName,
        prepared.artifact.contentType,
        put.byteSize,
        prepared.rowCount,
        prepared.expiresAt.toISOString(),
      ],
    );
  });
}

export async function authorizeExportDownload(
  tx: Tx,
  input: { tenantId: string; exportId: string; actorUserId: string; ip?: string | null },
): Promise<{ objectKey: string; fileName: string; contentType: string }> {
  const job = await getExportJobById(tx, input.tenantId, input.exportId);
  if (job.status !== "completed" || !job.storage_object_id) {
    throw conflict(`Export job is not ready for download (status: ${job.status})`);
  }
  const objRes = await tx.query<{ object_key: string; original_filename: string; content_type: string; status: string }>(
    `SELECT object_key, original_filename, content_type, status FROM storage_objects WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, job.storage_object_id],
  );
  const obj = objRes.rows[0];
  if (!obj || obj.status !== "available") {
    throw conflict("Export artifact is no longer available");
  }
  await recordSecurityEvent(tx, {
    eventType: "reporting.export.downloaded",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    ip: input.ip,
    detail: { exportJobId: job.id, dataset: job.dataset, format: job.format },
  });
  return { objectKey: obj.object_key, fileName: obj.original_filename, contentType: obj.content_type };
}
