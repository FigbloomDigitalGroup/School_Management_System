import type { Tx } from "../../db/sql.js";
import { conflict, forbidden, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { pageQuery, type Page, type PageInput } from "../academics/pagination.js";

export type TeacherReportType = "daily" | "weekly" | "incident" | "progress" | "observation";
export type TeacherReportInputMode = "typed" | "handwritten_ocr" | "hybrid";
export type TeacherReportStatus = "draft" | "submitted" | "reviewed";

export interface PublicTeacherReport {
  id: string;
  tenantId: string;
  author_user_id: string;
  class_id: string | null;
  learner_id: string | null;
  report_type: TeacherReportType;
  report_date: string;
  title: string;
  input_mode: TeacherReportInputMode;
  raw_ocr_text: string | null;
  body: string;
  ocr_confidence: number | null;
  ocr_provider: string | null;
  source_image_mime: string | null;
  status: TeacherReportStatus;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
}

type Row = {
  id: string;
  tenant_id: string;
  author_user_id: string;
  class_id: string | null;
  learner_id: string | null;
  report_type: TeacherReportType;
  report_date: string;
  title: string;
  input_mode: TeacherReportInputMode;
  raw_ocr_text: string | null;
  body: string;
  ocr_confidence: string | null;
  ocr_provider: string | null;
  source_image_mime: string | null;
  status: TeacherReportStatus;
  submitted_at: Date | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  created_at: Date;
  updated_at: Date;
};

const COLS = `id, tenant_id, author_user_id, class_id, learner_id, report_type, report_date::text AS report_date,
  title, input_mode, raw_ocr_text, body, ocr_confidence, ocr_provider, source_image_mime,
  status, submitted_at, reviewed_by, reviewed_at, review_note, created_at, updated_at`;

function mapRow(r: Row): PublicTeacherReport {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    author_user_id: r.author_user_id,
    class_id: r.class_id,
    learner_id: r.learner_id,
    report_type: r.report_type,
    report_date: r.report_date,
    title: r.title,
    input_mode: r.input_mode,
    raw_ocr_text: r.raw_ocr_text,
    body: r.body,
    ocr_confidence: r.ocr_confidence === null ? null : Number(r.ocr_confidence),
    ocr_provider: r.ocr_provider,
    source_image_mime: r.source_image_mime,
    status: r.status,
    submitted_at: r.submitted_at ? r.submitted_at.toISOString() : null,
    reviewed_by: r.reviewed_by,
    reviewed_at: r.reviewed_at ? r.reviewed_at.toISOString() : null,
    review_note: r.review_note,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

export async function createTeacherReport(
  tx: Tx,
  input: {
    tenantId: string;
    authorUserId: string;
    class_id?: string | null;
    learner_id?: string | null;
    report_type: TeacherReportType;
    report_date?: string;
    title: string;
    input_mode?: TeacherReportInputMode;
    raw_ocr_text?: string | null;
    body: string;
    ocr_confidence?: number | null;
    ocr_provider?: string | null;
    source_image_mime?: string | null;
    submit?: boolean;
    ip?: string | null;
  },
): Promise<PublicTeacherReport> {
  const title = input.title.trim();
  const body = input.body.trim();
  if (title.length < 1 || title.length > 200) throw validationError("title must be 1–200 characters");
  if (body.length < 1 || body.length > 10_000) throw validationError("body must be 1–10000 characters");

  const rawOcr = input.raw_ocr_text?.trim() || null;
  let mode: TeacherReportInputMode = input.input_mode ?? (rawOcr ? "handwritten_ocr" : "typed");
  if (rawOcr && mode === "handwritten_ocr" && body !== rawOcr) {
    mode = "hybrid";
  }
  const status: TeacherReportStatus = input.submit ? "submitted" : "draft";

  const res = await tx.query<Row>(
    `INSERT INTO teacher_reports
       (tenant_id, author_user_id, class_id, learner_id, report_type, report_date, title, input_mode,
        raw_ocr_text, body, ocr_confidence, ocr_provider, source_image_mime, status, submitted_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING ${COLS}`,
    [
      input.tenantId,
      input.authorUserId,
      input.class_id ?? null,
      input.learner_id ?? null,
      input.report_type,
      input.report_date ?? null,
      title,
      mode,
      rawOcr,
      body,
      input.ocr_confidence ?? null,
      input.ocr_provider ?? null,
      input.source_image_mime ?? null,
      status,
      input.submit ? new Date() : null,
    ],
  );
  const report = mapRow(res.rows[0]!);
  await recordSecurityEvent(tx, {
    eventType: "reporting.teacher_report.created",
    actorUserId: input.authorUserId,
    tenantId: input.tenantId,
    detail: { reportId: report.id, reportType: report.report_type, inputMode: report.input_mode, status: report.status },
    ip: input.ip,
  });
  return report;
}

export async function getTeacherReport(tx: Tx, input: { tenantId: string; reportId: string }): Promise<PublicTeacherReport> {
  const res = await tx.query<Row>(`SELECT ${COLS} FROM teacher_reports WHERE tenant_id = $1 AND id = $2`, [
    input.tenantId,
    input.reportId,
  ]);
  if (!res.rows[0]) throw notFound("Teacher report not found");
  return mapRow(res.rows[0]);
}

export async function listTeacherReports(
  tx: Tx,
  input: {
    tenantId: string;
    reportType?: TeacherReportType;
    status?: TeacherReportStatus;
    classId?: string;
    learnerId?: string;
    authorUserId?: string;
    page: PageInput;
  },
): Promise<Page<PublicTeacherReport>> {
  const params: unknown[] = [input.tenantId];
  const where = ["tenant_id = $1"];
  if (input.reportType) {
    params.push(input.reportType);
    where.push(`report_type = $${params.length}`);
  }
  if (input.status) {
    params.push(input.status);
    where.push(`status = $${params.length}`);
  }
  if (input.classId) {
    params.push(input.classId);
    where.push(`class_id = $${params.length}`);
  }
  if (input.learnerId) {
    params.push(input.learnerId);
    where.push(`learner_id = $${params.length}`);
  }
  if (input.authorUserId) {
    params.push(input.authorUserId);
    where.push(`author_user_id = $${params.length}`);
  }
  const out = await pageQuery<Row>(
    tx,
    `SELECT ${COLS} FROM teacher_reports WHERE ${where.join(" AND ")}`,
    params,
    { name: "teacher_reports", expr: "q.created_at", type: "timestamptz", dir: "desc" },
    input.page,
  );
  return { items: out.rows.map(mapRow), page: out.page };
}

export async function updateTeacherReport(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    isAdmin: boolean;
    reportId: string;
    class_id?: string | null;
    learner_id?: string | null;
    report_type?: TeacherReportType;
    report_date?: string;
    title?: string;
    body?: string;
    submit?: boolean;
    ip?: string | null;
  },
): Promise<PublicTeacherReport> {
  const curRes = await tx.query<Row>(`SELECT ${COLS} FROM teacher_reports WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [
    input.tenantId,
    input.reportId,
  ]);
  const cur = curRes.rows[0];
  if (!cur) throw notFound("Teacher report not found");
  if (cur.author_user_id !== input.actorUserId && !input.isAdmin) {
    throw forbidden("You can only edit your own teacher reports");
  }
  if (cur.status === "reviewed") {
    throw conflict("Reviewed reports cannot be edited");
  }

  const nextTitle = input.title !== undefined ? input.title.trim() : cur.title;
  const nextBody = input.body !== undefined ? input.body.trim() : cur.body;
  if (nextTitle.length < 1 || nextTitle.length > 200) throw validationError("title must be 1–200 characters");
  if (nextBody.length < 1 || nextBody.length > 10_000) throw validationError("body must be 1–10000 characters");

  let nextMode: TeacherReportInputMode = cur.input_mode;
  if (cur.raw_ocr_text && nextBody !== cur.raw_ocr_text) {
    nextMode = "hybrid";
  }
  const nextStatus: TeacherReportStatus = input.submit ? "submitted" : cur.status;
  const nextSubmittedAt = input.submit && !cur.submitted_at ? new Date() : cur.submitted_at;

  const updated = await tx.query<Row>(
    `UPDATE teacher_reports
        SET class_id = $3,
            learner_id = $4,
            report_type = $5,
            report_date = $6::date,
            title = $7,
            body = $8,
            input_mode = $9,
            status = $10,
            submitted_at = $11,
            updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING ${COLS}`,
    [
      input.tenantId,
      input.reportId,
      input.class_id !== undefined ? input.class_id : cur.class_id,
      input.learner_id !== undefined ? input.learner_id : cur.learner_id,
      input.report_type ?? cur.report_type,
      input.report_date ?? cur.report_date,
      nextTitle,
      nextBody,
      nextMode,
      nextStatus,
      nextSubmittedAt,
    ],
  );
  const report = mapRow(updated.rows[0]!);
  await recordSecurityEvent(tx, {
    eventType: "reporting.teacher_report.updated",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { reportId: report.id, status: report.status, inputMode: report.input_mode },
    ip: input.ip,
  });
  return report;
}

export async function reviewTeacherReport(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; reportId: string; review_note?: string | null; ip?: string | null },
): Promise<PublicTeacherReport> {
  const curRes = await tx.query<Row>(`SELECT ${COLS} FROM teacher_reports WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [
    input.tenantId,
    input.reportId,
  ]);
  const cur = curRes.rows[0];
  if (!cur) throw notFound("Teacher report not found");
  if (cur.status !== "submitted") throw conflict("Only submitted reports can be reviewed");

  const updated = await tx.query<Row>(
    `UPDATE teacher_reports
        SET status = 'reviewed', reviewed_by = $3, reviewed_at = now(), review_note = $4, updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING ${COLS}`,
    [input.tenantId, input.reportId, input.actorUserId, input.review_note?.trim() || null],
  );
  const report = mapRow(updated.rows[0]!);
  await recordSecurityEvent(tx, {
    eventType: "reporting.teacher_report.reviewed",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { reportId: report.id },
    ip: input.ip,
  });
  return report;
}
