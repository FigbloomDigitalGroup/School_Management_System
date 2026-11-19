import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import {
  correctMark,
  createAssessment,
  createGradingScheme,
  createHomework,
  findAssessmentInScope,
  getAssessmentById,
  getGradingSchemeById,
  getHomeworkById,
  getLearningMaterialById,
  getMarkById,
  getMarkCorrectionById,
  getReportCardById,
  listAssessments,
  listGradingSchemes,
  listHomework,
  listLearningMaterials,
  listMarkCorrections,
  listMarks,
  publishAssessment,
  publishReportCard,
  registerLearningMaterial,
  upsertMark,
  type PublicAssessment,
} from "../../modules/academics/assessments.js";
import { teacherClassIds, userMayAssessClassSubject } from "../../modules/academics/structure.js";
import { parseIdempotencyKey, runIdempotent } from "../../modules/idempotency/idempotency.js";
import { hasPermission, requirePermission } from "../../modules/rbac/authorize.js";
import type { Tx } from "../../db/sql.js";
import type { RequestAuth } from "../middleware/authContext.js";
import { AppError, notFound, validationError } from "../errors.js";
import { assertUuid, classReadScope, inTenant, optionalUuid, pageFrom } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const AssessmentBody = z.strictObject({
  class_id: z.guid(),
  subject_id: z.guid(),
  term_id: z.guid(),
  title: z.string().min(1).max(160),
  kind: z.enum(["exam", "homework", "cbe", "other"]),
  max_score: z.number().positive().max(10000),
  components: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(80),
        max_score: z.number().positive().max(10000),
        weight: z.number().nonnegative().nullable().optional(),
        sort_order: z.number().int().optional(),
      }),
    )
    .optional(),
});
const MarkBody = z.strictObject({
  learner_id: z.guid(),
  score: z.number(),
  grade: z.string().max(16).nullable().optional(),
  row_version: z.number().int().nonnegative().nullable().optional(),
});
const CorrectionBody = z.strictObject({
  learner_id: z.guid(),
  score: z.number(),
  grade: z.string().max(16).nullable().optional(),
  reason: z.string().min(5).max(500),
  row_version: z.number().int().nonnegative(),
});
const HomeworkBody = z.strictObject({
  class_id: z.guid(),
  subject_id: z.guid(),
  term_id: z.guid(),
  title: z.string().min(1).max(160),
  due_on: DateString,
  body: z.string().min(1).max(8000),
});
const MaterialBody = z.strictObject({
  title: z.string().min(1).max(160),
  description: z.string().max(4000).nullable().optional(),
  class_id: z.guid().nullable().optional(),
  subject_id: z.guid().nullable().optional(),
});
const SchemeBody = z.strictObject({
  name: z.string().min(1).max(80),
  version: z.number().int().positive().optional(),
  rules: z.unknown(),
});
const ReportBody = z.strictObject({ term_id: z.guid(), class_id: z.guid() });

/** Request bodies by OpenAPI operation key; test/openapi.stage910.contract.test.ts compares them with the spec. */
export const ASSESSMENT_REQUEST_SCHEMAS = {
  "POST /v1/tenants/{tenantId}/assessments": AssessmentBody,
  "POST /v1/tenants/{tenantId}/assessments/{assessmentId}/marks": MarkBody,
  "POST /v1/tenants/{tenantId}/assessments/{assessmentId}/mark-corrections": CorrectionBody,
  "POST /v1/tenants/{tenantId}/homework-items": HomeworkBody,
  "POST /v1/tenants/{tenantId}/learning-materials": MaterialBody,
  "POST /v1/tenants/{tenantId}/grading-schemes": SchemeBody,
  "POST /v1/tenants/{tenantId}/report-cards": ReportBody,
} as const;

function expectedRowVersion(request: FastifyRequest, bodyVersion: number | null | undefined): number | null {
  const header = request.headers["if-match"];
  let fromHeader: number | null = null;
  if (header !== undefined) {
    const raw = String(Array.isArray(header) ? header[0] : header).replace(/^W\//, "").replaceAll('"', "");
    if (!/^\d+$/.test(raw)) throw validationError("If-Match must be a row version");
    fromHeader = Number(raw);
  }
  const fromBody = bodyVersion === undefined ? null : bodyVersion;
  if (fromHeader !== null && fromBody !== null && fromHeader !== fromBody) {
    throw validationError("If-Match and row_version disagree");
  }
  return fromHeader ?? fromBody;
}

/**
 * OD-2 + A9-9: resolve an assessment for a reader. Academics readers see any assessment (404 only when it
 * does not exist). A teacher sees only assessments of classes they teach; an assessment of another class
 * answers exactly like a missing one (404), so ids outside the teacher's scope reveal nothing. A user who
 * teaches nothing gets 403 before any lookup.
 */
async function assessmentForReader(tx: Tx, auth: RequestAuth, ip: string | null, tenantId: string, assessmentId: string) {
  const scope = await classReadScope(tx, auth, ip, "resource.academics.read");
  const assessment = await findAssessmentInScope(tx, { tenantId, assessmentId, scopeClassIds: scope });
  if (!assessment) throw notFound("Assessment not found");
  return assessment;
}

/**
 * A9-9: authorise a mark write before revealing whether the assessment exists. Academics writers: any
 * assessment. Otherwise the caller must teach some class (else 403, no lookup); an assessment outside
 * those classes answers 404 like a missing one; inside them, the caller must teach its subject (403).
 */
async function assessmentForMarkWrite(
  tx: Tx,
  auth: RequestAuth,
  ip: string | null,
  tenantId: string,
  assessmentId: string,
): Promise<PublicAssessment> {
  if (await hasPermission(tx, auth.authz, "resource.academics.write")) {
    return getAssessmentById(tx, { tenantId, assessmentId });
  }
  const classes = await teacherClassIds(tx, { tenantId, userId: auth.user.id });
  if (classes.length === 0) {
    await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
  }
  const assessment = await findAssessmentInScope(tx, { tenantId, assessmentId, scopeClassIds: classes });
  if (!assessment) throw notFound("Assessment not found");
  const assessor = await userMayAssessClassSubject(tx, {
    tenantId,
    userId: auth.user.id,
    classId: assessment.class_id,
    subjectId: assessment.subject_id,
  });
  if (!assessor) await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
  return assessment;
}

export async function registerAcademicsAssessmentRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.post("/v1/tenants/:tenantId/assessments", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(AssessmentBody, request.body, "class_id, subject_id, term_id, title, kind and max_score are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/assessments",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const assessment = await createAssessment(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
          return { value: { assessment }, resourceType: "assessment", resourceId: assessment.id };
        },
        replay: async (_t, id) => {
          try {
            return { assessment: await getAssessmentById(tx, { tenantId: params.tenantId, assessmentId: id }) };
          } catch (err) {
            if (err instanceof AppError && err.statusCode === 404) return null;
            throw err;
          }
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/assessments", async (request) => {
    const params = request.params as { tenantId: string };
    const query = request.query as Record<string, unknown>;
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const scope = await classReadScope(tx, auth, ip, "resource.academics.read");
      const out = await listAssessments(tx, {
        tenantId: params.tenantId,
        classId: optionalUuid(query.classId, "classId"),
        termId: optionalUuid(query.termId, "termId"),
        scopeClassIds: scope,
        page,
      });
      return { assessments: out.items, page: out.page };
    });
  });

  app.post("/v1/tenants/:tenantId/assessments/:assessmentId/publish", async (request, reply) => {
    const params = request.params as { tenantId: string; assessmentId: string };
    assertUuid(params.assessmentId, "assessmentId");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/assessments/:assessmentId/publish",
        fingerprintInput: { params },
        status: 200,
        execute: async () => {
          const assessment = await publishAssessment(tx, {
            tenantId: params.tenantId,
            assessmentId: params.assessmentId,
            actorUserId: auth.user.id,
            ip,
          });
          return { value: { assessment }, resourceType: "assessment", resourceId: assessment.id };
        },
        replay: async () => ({ assessment: await getAssessmentById(tx, { tenantId: params.tenantId, assessmentId: params.assessmentId }) }),
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.post("/v1/tenants/:tenantId/assessments/:assessmentId/marks", async (request, reply) => {
    const params = request.params as { tenantId: string; assessmentId: string };
    assertUuid(params.assessmentId, "assessmentId");
    const parsed = parseOrThrow(MarkBody, request.body, "learner_id and score are required");
    const rowVersion = expectedRowVersion(request, parsed.row_version);
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await assessmentForMarkWrite(tx, auth, ip, params.tenantId, params.assessmentId);
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/assessments/:assessmentId/marks",
        fingerprintInput: { params, body: parsed, rowVersion },
        status: rowVersion && rowVersion > 0 ? 200 : 201,
        execute: async () => {
          const mark = await upsertMark(tx, {
            tenantId: params.tenantId,
            actorUserId: auth.user.id,
            assessmentId: params.assessmentId,
            learner_id: parsed.learner_id,
            score: parsed.score,
            grade: parsed.grade,
            rowVersion,
            ip,
          });
          return { value: { mark }, resourceType: "mark_entry", resourceId: mark.id };
        },
        // A9-6: direct lookup by id.
        replay: async (_t, id) => {
          const mark = await getMarkById(tx, { tenantId: params.tenantId, markId: id });
          return mark ? { mark } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/assessments/:assessmentId/marks", async (request) => {
    const params = request.params as { tenantId: string; assessmentId: string };
    assertUuid(params.assessmentId, "assessmentId");
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await assessmentForReader(tx, auth, ip, params.tenantId, params.assessmentId);
      const out = await listMarks(tx, { tenantId: params.tenantId, assessmentId: params.assessmentId, page });
      return { marks: out.items, page: out.page };
    });
  });

  // OD-1: correct a mark on a published assessment. Academics writers only (class assessors cannot).
  app.post("/v1/tenants/:tenantId/assessments/:assessmentId/mark-corrections", async (request, reply) => {
    const params = request.params as { tenantId: string; assessmentId: string };
    assertUuid(params.assessmentId, "assessmentId");
    const parsed = parseOrThrow(CorrectionBody, request.body, "learner_id, score, reason and row_version are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/assessments/:assessmentId/mark-corrections",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const done = await correctMark(tx, {
            tenantId: params.tenantId,
            actorUserId: auth.user.id,
            assessmentId: params.assessmentId,
            learner_id: parsed.learner_id,
            score: parsed.score,
            grade: parsed.grade,
            reason: parsed.reason,
            rowVersion: parsed.row_version,
            ip,
          });
          return { value: done, resourceType: "mark_correction", resourceId: done.correction.id };
        },
        replay: async (_t, id) => getMarkCorrectionById(tx, { tenantId: params.tenantId, correctionId: id }),
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/assessments/:assessmentId/mark-corrections", async (request) => {
    const params = request.params as { tenantId: string; assessmentId: string };
    assertUuid(params.assessmentId, "assessmentId");
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await assessmentForReader(tx, auth, ip, params.tenantId, params.assessmentId);
      const out = await listMarkCorrections(tx, { tenantId: params.tenantId, assessmentId: params.assessmentId, page });
      return { corrections: out.items, page: out.page };
    });
  });

  app.post("/v1/tenants/:tenantId/homework-items", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(HomeworkBody, request.body, "class_id, subject_id, term_id, title, due_on and body are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/homework-items",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const homework = await createHomework(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
          return { value: { homework }, resourceType: "homework_item", resourceId: homework.id };
        },
        replay: async (_t, id) => {
          const homework = await getHomeworkById(tx, { tenantId: params.tenantId, homeworkId: id });
          return homework ? { homework } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/homework-items", async (request) => {
    const params = request.params as { tenantId: string };
    const classId = optionalUuid((request.query as { classId?: unknown }).classId, "classId");
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const out = await listHomework(tx, { tenantId: params.tenantId, classId, page });
      return { homework: out.items, page: out.page };
    });
  });

  app.post("/v1/tenants/:tenantId/learning-materials", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(MaterialBody, request.body, "title is required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/learning-materials",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const material = await registerLearningMaterial(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
          return { value: { material }, resourceType: "learning_material", resourceId: material.id };
        },
        replay: async (_t, id) => {
          const material = await getLearningMaterialById(tx, { tenantId: params.tenantId, materialId: id });
          return material ? { material } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/learning-materials", async (request) => {
    const params = request.params as { tenantId: string };
    const classId = optionalUuid((request.query as { classId?: unknown }).classId, "classId");
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const out = await listLearningMaterials(tx, { tenantId: params.tenantId, classId, page });
      return { materials: out.items, page: out.page };
    });
  });

  app.post("/v1/tenants/:tenantId/grading-schemes", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(SchemeBody, request.body, "name and rules are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/grading-schemes",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const scheme = await createGradingScheme(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
          return { value: { scheme }, resourceType: "grading_scheme", resourceId: scheme.id };
        },
        replay: async (_t, id) => {
          const scheme = await getGradingSchemeById(tx, { tenantId: params.tenantId, schemeId: id });
          return scheme ? { scheme } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/grading-schemes", async (request) => {
    const params = request.params as { tenantId: string };
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const out = await listGradingSchemes(tx, { tenantId: params.tenantId, page });
      return { schemes: out.items, page: out.page };
    });
  });

  app.post("/v1/tenants/:tenantId/report-cards", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(ReportBody, request.body, "term_id and class_id are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/report-cards",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const report_card = await publishReportCard(tx, {
            tenantId: params.tenantId,
            termId: parsed.term_id,
            classId: parsed.class_id,
            actorUserId: auth.user.id,
            ip,
          });
          return { value: { report_card }, resourceType: "report_card", resourceId: report_card.id };
        },
        replay: async (_t, id) => {
          try {
            return { report_card: await getReportCardById(tx, { tenantId: params.tenantId, reportCardId: id }) };
          } catch (err) {
            if (err instanceof AppError && err.statusCode === 404) return null;
            throw err;
          }
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });
}
