import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import {
  createCbeAssessment,
  createLearningArea,
  createLearningOutcome,
  createProvenance,
  createRubricConfig,
  createStrand,
  createSubStrand,
  listCbeAssessments,
  listCbeResults,
  listEvidence,
  listLearningAreas,
  listLearningOutcomes,
  listProvenance,
  listRubricConfigs,
  listStrands,
  listSubStrands,
  recordCbeResult,
  getCbeResultVersion,
  getCbeAssessmentById,
  getEvidenceById,
  getLearningAreaById,
  getLearningOutcomeById,
  getProvenanceById,
  getRubricConfigById,
  getStrandById,
  getSubStrandById,
  registerEvidence,
} from "../../modules/academics/cbe.js";
import { parseIdempotencyKey, runIdempotent } from "../../modules/idempotency/idempotency.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import { assertUuid, inTenant, optionalUuid, pageFrom } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

const ProvenanceBody = z.strictObject({
  source_kind: z.enum(["school_configured", "import_pending"]),
  source_label: z.string().min(1).max(160),
  source_uri: z.string().max(500).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
const AreaBody = z.strictObject({ provenance_id: z.guid(), code: z.string().min(1).max(32), name: z.string().min(1).max(120) });
const StrandBody = z.strictObject({ learning_area_id: z.guid(), code: z.string().min(1).max(32), name: z.string().min(1).max(160) });
const SubBody = z.strictObject({ strand_id: z.guid(), code: z.string().min(1).max(32), name: z.string().min(1).max(160) });
const OutcomeBody = z.strictObject({ sub_strand_id: z.guid(), code: z.string().min(1).max(32), statement: z.string().min(1).max(500) });
const RubricBody = z.strictObject({
  name: z.string().min(1).max(80),
  version: z.number().int().positive().optional(),
  descriptors: z.unknown(),
});
const CbeAssessmentBody = z.strictObject({
  class_id: z.guid(),
  learning_area_id: z.guid(),
  term_id: z.guid(),
  title: z.string().min(1).max(160),
  rubric_config_id: z.guid().nullable().optional(),
});
const ResultBody = z.strictObject({
  learner_id: z.guid(),
  strand_id: z.guid().nullable().optional(),
  learning_outcome_id: z.guid().nullable().optional(),
  level_code: z.string().min(1).max(16),
  points: z.number(),
  /** OD-3: to change an existing result, its current row_version and a reason. */
  row_version: z.number().int().nonnegative().nullable().optional(),
  reason: z.string().min(5).max(500).nullable().optional(),
});
const EvidenceBody = z.strictObject({
  provenance_id: z.guid(),
  title: z.string().min(1).max(160),
  description: z.string().max(4000).nullable().optional(),
  learner_id: z.guid().nullable().optional(),
});

/** Request bodies by OpenAPI operation key; test/openapi.stage910.contract.test.ts compares them with the spec. */
export const CBE_REQUEST_SCHEMAS = {
  "POST /v1/tenants/{tenantId}/curriculum-provenance": ProvenanceBody,
  "POST /v1/tenants/{tenantId}/learning-areas": AreaBody,
  "POST /v1/tenants/{tenantId}/strands": StrandBody,
  "POST /v1/tenants/{tenantId}/sub-strands": SubBody,
  "POST /v1/tenants/{tenantId}/learning-outcomes": OutcomeBody,
  "POST /v1/tenants/{tenantId}/rubric-configs": RubricBody,
  "POST /v1/tenants/{tenantId}/cbe-assessments": CbeAssessmentBody,
  "POST /v1/tenants/{tenantId}/cbe-assessments/{cbeAssessmentId}/results": ResultBody,
  "POST /v1/tenants/{tenantId}/evidence-assets": EvidenceBody,
} as const;

export async function registerAcademicsCbeRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.post("/v1/tenants/:tenantId/curriculum-provenance", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(ProvenanceBody, request.body, "source_kind and source_label are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/curriculum-provenance",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const provenance = await createProvenance(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
          return { value: { provenance }, resourceType: "curriculum_provenance", resourceId: provenance.id };
        },
        replay: async (_t, id) => {
          const provenance = await getProvenanceById(tx, { tenantId: params.tenantId, id });
          return provenance ? { provenance } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/curriculum-provenance", async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const out = await listProvenance(tx, { tenantId: params.tenantId, page: pageFrom(request) });
      return { provenance: out.items, page: out.page };
    });
  });

  app.post("/v1/tenants/:tenantId/learning-areas", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(AreaBody, request.body, "provenance_id, code and name are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/learning-areas",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const learning_area = await createLearningArea(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
          return { value: { learning_area }, resourceType: "learning_area", resourceId: learning_area.id };
        },
        replay: async (_t, id) => {
          const learning_area = await getLearningAreaById(tx, { tenantId: params.tenantId, id });
          return learning_area ? { learning_area } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/learning-areas", async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const out = await listLearningAreas(tx, { tenantId: params.tenantId, page: pageFrom(request) });
      return { learning_areas: out.items, page: out.page };
    });
  });

  app.post("/v1/tenants/:tenantId/strands", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(StrandBody, request.body, "learning_area_id, code and name are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/strands",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const strand = await createStrand(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
          return { value: { strand }, resourceType: "strand", resourceId: strand.id };
        },
        replay: async (_t, id) => {
          const strand = await getStrandById(tx, { tenantId: params.tenantId, id });
          return strand ? { strand } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/strands", async (request) => {
    const params = request.params as { tenantId: string };
    const learningAreaId = optionalUuid((request.query as { learningAreaId?: unknown }).learningAreaId, "learningAreaId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const out = await listStrands(tx, { tenantId: params.tenantId, learningAreaId, page: pageFrom(request) });
      return { strands: out.items, page: out.page };
    });
  });

  app.post("/v1/tenants/:tenantId/sub-strands", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(SubBody, request.body, "strand_id, code and name are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/sub-strands",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const sub_strand = await createSubStrand(tx, { tenantId: params.tenantId, ...parsed });
          return { value: { sub_strand }, resourceType: "sub_strand", resourceId: sub_strand.id };
        },
        replay: async (_t, id) => {
          const sub_strand = await getSubStrandById(tx, { tenantId: params.tenantId, id });
          return sub_strand ? { sub_strand } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/sub-strands", async (request) => {
    const params = request.params as { tenantId: string };
    const strandId = optionalUuid((request.query as { strandId?: unknown }).strandId, "strandId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const out = await listSubStrands(tx, { tenantId: params.tenantId, strandId, page: pageFrom(request) });
      return { sub_strands: out.items, page: out.page };
    });
  });

  app.post("/v1/tenants/:tenantId/learning-outcomes", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(OutcomeBody, request.body, "sub_strand_id, code and statement are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/learning-outcomes",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const learning_outcome = await createLearningOutcome(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
          return { value: { learning_outcome }, resourceType: "learning_outcome", resourceId: learning_outcome.id };
        },
        replay: async (_t, id) => {
          const learning_outcome = await getLearningOutcomeById(tx, { tenantId: params.tenantId, id });
          return learning_outcome ? { learning_outcome } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/learning-outcomes", async (request) => {
    const params = request.params as { tenantId: string };
    const subStrandId = optionalUuid((request.query as { subStrandId?: unknown }).subStrandId, "subStrandId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const out = await listLearningOutcomes(tx, { tenantId: params.tenantId, subStrandId, page: pageFrom(request) });
      return { learning_outcomes: out.items, page: out.page };
    });
  });

  app.post("/v1/tenants/:tenantId/rubric-configs", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(RubricBody, request.body, "name and descriptors are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/rubric-configs",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const rubric_config = await createRubricConfig(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
          return { value: { rubric_config }, resourceType: "rubric_config", resourceId: rubric_config.id };
        },
        replay: async (_t, id) => {
          const rubric_config = await getRubricConfigById(tx, { tenantId: params.tenantId, id });
          return rubric_config ? { rubric_config } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/rubric-configs", async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const out = await listRubricConfigs(tx, { tenantId: params.tenantId, page: pageFrom(request) });
      return { rubric_configs: out.items, page: out.page };
    });
  });

  app.post("/v1/tenants/:tenantId/cbe-assessments", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(CbeAssessmentBody, request.body, "class_id, learning_area_id, term_id and title are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/cbe-assessments",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const cbe_assessment = await createCbeAssessment(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
          return { value: { cbe_assessment }, resourceType: "cbe_assessment", resourceId: cbe_assessment.id };
        },
        replay: async (_t, id) => {
          const cbe_assessment = await getCbeAssessmentById(tx, { tenantId: params.tenantId, id });
          return cbe_assessment ? { cbe_assessment } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/cbe-assessments", async (request) => {
    const params = request.params as { tenantId: string };
    const classId = optionalUuid((request.query as { classId?: unknown }).classId, "classId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const out = await listCbeAssessments(tx, { tenantId: params.tenantId, classId, page: pageFrom(request) });
      return { cbe_assessments: out.items, page: out.page };
    });
  });

  app.post("/v1/tenants/:tenantId/cbe-assessments/:cbeAssessmentId/results", async (request, reply) => {
    const params = request.params as { tenantId: string; cbeAssessmentId: string };
    assertUuid(params.cbeAssessmentId, "cbeAssessmentId");
    const parsed = parseOrThrow(ResultBody, request.body, "learner_id, level_code and points are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/cbe-assessments/:cbeAssessmentId/results",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const done = await recordCbeResult(tx, {
            tenantId: params.tenantId,
            actorUserId: auth.user.id,
            cbeAssessmentId: params.cbeAssessmentId,
            ...parsed,
            ip,
          });
          // OD-3: 201 for a new result, 200 for a revision or an unchanged retry. The reference names the
          // exact version and outcome, so a replay returns the original response even after later revisions.
          return {
            value: { result: done.result, outcome: done.outcome },
            resourceType: `${done.ref.type}:${done.outcome}`,
            resourceId: done.ref.id,
            status: done.outcome === "created" ? 201 : 200,
          };
        },
        replay: async (refType, id) => {
          const [type, outcome] = refType.split(":");
          const result = await getCbeResultVersion(tx, { tenantId: params.tenantId, refType: type ?? "", refId: id });
          return result ? { result, outcome: (outcome ?? "created") as "created" | "revised" | "unchanged" } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/cbe-assessments/:cbeAssessmentId/results", async (request) => {
    const params = request.params as { tenantId: string; cbeAssessmentId: string };
    assertUuid(params.cbeAssessmentId, "cbeAssessmentId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const out = await listCbeResults(tx, { tenantId: params.tenantId, cbeAssessmentId: params.cbeAssessmentId, page: pageFrom(request) });
      return { results: out.items, page: out.page };
    });
  });

  app.post("/v1/tenants/:tenantId/evidence-assets", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(EvidenceBody, request.body, "provenance_id and title are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/evidence-assets",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const evidence = await registerEvidence(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
          return { value: { evidence }, resourceType: "evidence_asset", resourceId: evidence.id };
        },
        replay: async (_t, id) => {
          const evidence = await getEvidenceById(tx, { tenantId: params.tenantId, id });
          return evidence ? { evidence } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/evidence-assets", async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const out = await listEvidence(tx, { tenantId: params.tenantId, page: pageFrom(request) });
      return { evidence: out.items, page: out.page };
    });
  });
}
