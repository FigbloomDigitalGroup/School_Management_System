import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { hasPermission, requirePermission } from "../../modules/rbac/authorize.js";
import { getHandwritingOcrProvider, normalizeImageBase64 } from "../../modules/reporting/handwritingOcr.js";
import {
  createTeacherReport,
  getTeacherReport,
  listTeacherReports,
  reviewTeacherReport,
  updateTeacherReport,
  type TeacherReportStatus,
  type TeacherReportType,
} from "../../modules/reporting/teacherReports.js";
import { serviceUnavailable, validationError } from "../errors.js";
import { assertUuid, inTenant, optionalUuid, pageFrom } from "../routeKit.js";
import { calendarDateString } from "../schemas.js";
import { parseOrThrow } from "../validation.js";

const REPORT_TYPES = ["daily", "weekly", "incident", "progress", "observation"] as const;
const REPORT_STATUSES = ["draft", "submitted", "reviewed"] as const;

const InterpretHandwritingBody = z.strictObject({
  image_base64: z.string().min(64).max(9_000_000),
  mime_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
  report_type: z.enum(REPORT_TYPES).optional(),
  context_hint: z.string().max(200).optional(),
});

const CreateTeacherReportBody = z.strictObject({
  class_id: z.guid().nullable().optional(),
  learner_id: z.guid().nullable().optional(),
  report_type: z.enum(REPORT_TYPES).default("daily"),
  report_date: calendarDateString.optional(),
  title: z.string().min(1).max(200),
  input_mode: z.enum(["typed", "handwritten_ocr", "hybrid"]).optional(),
  raw_ocr_text: z.string().max(10_000).nullable().optional(),
  body: z.string().min(1).max(10_000),
  ocr_confidence: z.number().min(0).max(1).nullable().optional(),
  ocr_provider: z.string().max(60).nullable().optional(),
  source_image_mime: z.enum(["image/jpeg", "image/png", "image/webp"]).nullable().optional(),
  submit: z.boolean().optional(),
});

const UpdateTeacherReportBody = z
  .strictObject({
    class_id: z.guid().nullable().optional(),
    learner_id: z.guid().nullable().optional(),
    report_type: z.enum(REPORT_TYPES).optional(),
    report_date: calendarDateString.optional(),
    title: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(10_000).optional(),
    submit: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field" });

const ReviewTeacherReportBody = z.strictObject({
  review_note: z.string().max(500).nullable().optional(),
});

const P = "/v1/tenants/:tenantId/teacher-reports";

export async function registerTeacherReportRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  /**
   * Interpret a photographed/uploaded handwritten teacher report using Vision OCR.
   * External AI call runs strictly OUTSIDE any DB transaction; returns editable text for teacher review.
   */
  app.post(`${P}/interpret-handwriting`, { bodyLimit: 10 * 1024 * 1024 }, async (request, reply) => {
    const params = request.params as { tenantId: string };
    await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
    });
    const body = parseOrThrow(InterpretHandwritingBody, request.body, "image_base64 and mime_type are required");
    const normalized = normalizeImageBase64(body.image_base64, body.mime_type);

    const provider = getHandwritingOcrProvider();
    if (!provider.configured) {
      throw serviceUnavailable("Handwriting interpretation is not configured yet (set GEMINI_API_KEY or OPENAI_API_KEY).");
    }

    const result = await provider.interpret({
      imageBase64: normalized.base64,
      mimeType: normalized.mimeType,
      reportType: body.report_type,
      contextHint: body.context_hint,
    });

    if (result.status !== "ok") {
      throw serviceUnavailable("Could not interpret handwriting right now. Please try again or type the report manually.");
    }

    return reply.status(200).send({
      interpretation: {
        transcribed_text: result.transcribed_text,
        suggested_title: result.suggested_title,
        confidence: result.confidence,
        provider: result.provider,
        source_image_mime: normalized.mimeType,
      },
    });
  });

  app.post(P, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const report = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const body = parseOrThrow(CreateTeacherReportBody, request.body, "title and body are required");
      return createTeacherReport(tx, {
        tenantId: params.tenantId,
        authorUserId: auth.user.id,
        ...body,
        ip,
      });
    });
    return reply.status(201).send({ report });
  });

  app.get(P, async (request) => {
    const params = request.params as { tenantId: string };
    const q = request.query as Record<string, unknown>;
    const page = pageFrom(request);
    const reportType =
      typeof q.reportType === "string" && (REPORT_TYPES as readonly string[]).includes(q.reportType)
        ? (q.reportType as TeacherReportType)
        : q.reportType
          ? (() => {
              throw validationError(`reportType must be one of ${REPORT_TYPES.join(", ")}`);
            })()
          : undefined;
    const status =
      typeof q.status === "string" && (REPORT_STATUSES as readonly string[]).includes(q.status)
        ? (q.status as TeacherReportStatus)
        : q.status
          ? (() => {
              throw validationError(`status must be one of ${REPORT_STATUSES.join(", ")}`);
            })()
          : undefined;

    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const isAdmin = await hasPermission(tx, auth.authz, "resource.academics.write");
      const out = await listTeacherReports(tx, {
        tenantId: params.tenantId,
        reportType,
        status,
        classId: optionalUuid(q.classId, "classId"),
        learnerId: optionalUuid(q.learnerId, "learnerId"),
        authorUserId: isAdmin ? optionalUuid(q.authorUserId, "authorUserId") : auth.user.id,
        page,
      });
      return { reports: out.items, page: out.page };
    });
  });

  app.get(`${P}/:reportId`, async (request) => {
    const params = request.params as { tenantId: string; reportId: string };
    assertUuid(params.reportId, "reportId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const report = await getTeacherReport(tx, { tenantId: params.tenantId, reportId: params.reportId });
      return { report };
    });
  });

  app.patch(`${P}/:reportId`, async (request) => {
    const params = request.params as { tenantId: string; reportId: string };
    assertUuid(params.reportId, "reportId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const body = parseOrThrow(UpdateTeacherReportBody, request.body, "at least one field is required");
      const isAdmin = await hasPermission(tx, auth.authz, "resource.academics.write");
      const report = await updateTeacherReport(tx, {
        tenantId: params.tenantId,
        actorUserId: auth.user.id,
        isAdmin,
        reportId: params.reportId,
        ...body,
        ip,
      });
      return { report };
    });
  });

  app.post(`${P}/:reportId/review`, async (request) => {
    const params = request.params as { tenantId: string; reportId: string };
    assertUuid(params.reportId, "reportId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      const body = parseOrThrow(ReviewTeacherReportBody, request.body ?? {}, "Invalid review payload");
      const report = await reviewTeacherReport(tx, {
        tenantId: params.tenantId,
        actorUserId: auth.user.id,
        reportId: params.reportId,
        review_note: body.review_note ?? null,
        ip,
      });
      return { report };
    });
  });
}
