import type { FastifyInstance } from "fastify";
import { z } from "zod/v4";
import { uuidString } from "../schemas.js";
import type { AppPool } from "../../db/pool.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import { createLearner, getLearnerById } from "../../modules/directory/learners.js";
import { assertSameTenant } from "../../modules/tenancy/context.js";
import { clientIp } from "../clientIp.js";
import { validationError } from "../errors.js";
import { withTenantRequest } from "../tenantRequest.js";

const CreateLearnerSchema = z.object({
  admission_no: z.string().min(1).max(32),
  full_name: z.string().min(1).max(120),
  gender: z.enum(["male", "female"]),
  boarding: z.boolean().optional(),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

const UuidParam = uuidString;

/**
 * VS-1 School Directory — learner create/read.
 * Tenant id comes from the path and must match the established authz tenant.
 * Client-supplied tenantId / permissions in the body are never authoritative.
 */
export async function registerLearnerRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.post("/v1/tenants/:tenantId/learners", async (request, reply) => {
    const params = request.params as { tenantId: string };
    if (!UuidParam.safeParse(params.tenantId).success) {
      throw validationError("tenantId must be a UUID");
    }
    const parsed = CreateLearnerSchema.safeParse(request.body);
    if (!parsed.success) {
      throw validationError(
        "admission_no, full_name and gender (male|female) are required; optional boarding and date_of_birth (YYYY-MM-DD)",
      );
    }
    const learner = await withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.learner.write", {
        ip: clientIp(request),
        deferAudit: true,
      });
      return createLearner(tx, {
        tenantId: params.tenantId,
        actorUserId: auth.user.id,
        admission_no: parsed.data.admission_no,
        full_name: parsed.data.full_name,
        gender: parsed.data.gender,
        boarding: parsed.data.boarding,
        date_of_birth: parsed.data.date_of_birth ?? null,
        ip: clientIp(request),
      });
    });
    return reply.status(201).send({ learner });
  });

  app.get("/v1/tenants/:tenantId/learners/:learnerId", async (request) => {
    const params = request.params as { tenantId: string; learnerId: string };
    if (!UuidParam.safeParse(params.tenantId).success) {
      throw validationError("tenantId must be a UUID");
    }
    if (!UuidParam.safeParse(params.learnerId).success) {
      throw validationError("learnerId must be a UUID");
    }
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.learner.read", {
        ip: clientIp(request),
        deferAudit: true,
      });
      const learner = await getLearnerById(tx, {
        tenantId: params.tenantId,
        learnerId: params.learnerId,
        actorUserId: auth.user.id,
      });
      return { learner };
    });
  });
}
