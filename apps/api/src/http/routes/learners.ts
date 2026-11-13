import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { requireTenantAuth } from "../middleware/authContext.js";
import { clientIp } from "../clientIp.js";
import { validationError } from "../errors.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import { assertSameTenant } from "../../modules/tenancy/context.js";
import { createLearner, getLearnerById } from "../../modules/directory/learners.js";

const CreateLearnerSchema = z.object({
  admission_no: z.string().min(1).max(32),
  full_name: z.string().min(1).max(120),
  gender: z.enum(["male", "female"]),
  boarding: z.boolean().optional(),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

const UuidParam = z.string().uuid();

/**
 * VS-1 School Directory — learner create/read.
 * Tenant id comes from the path and must match the established authz tenant.
 * Client-supplied tenantId / permissions in the body are never authoritative.
 */
export async function registerLearnerRoutes(app: FastifyInstance, pool: pg.Pool): Promise<void> {
  app.post("/v1/tenants/:tenantId/learners", async (request, reply) => {
    const auth = await requireTenantAuth(pool, request);
    const params = request.params as { tenantId: string };
    if (!UuidParam.safeParse(params.tenantId).success) {
      throw validationError("tenantId must be a UUID");
    }
    assertSameTenant(auth.authz.tenantId, params.tenantId);
    await requirePermission(pool, auth.authz, "resource.learner.write", {
      ip: clientIp(request),
    });

    const parsed = CreateLearnerSchema.safeParse(request.body);
    if (!parsed.success) {
      throw validationError(
        "admission_no, full_name and gender (male|female) are required; optional boarding and date_of_birth (YYYY-MM-DD)",
      );
    }

    const learner = await createLearner(pool, {
      tenantId: params.tenantId,
      actorUserId: auth.user.id,
      admission_no: parsed.data.admission_no,
      full_name: parsed.data.full_name,
      gender: parsed.data.gender,
      boarding: parsed.data.boarding,
      date_of_birth: parsed.data.date_of_birth ?? null,
      ip: clientIp(request),
    });

    return reply.status(201).send({ learner });
  });

  app.get("/v1/tenants/:tenantId/learners/:learnerId", async (request) => {
    const auth = await requireTenantAuth(pool, request);
    const params = request.params as { tenantId: string; learnerId: string };
    if (!UuidParam.safeParse(params.tenantId).success) {
      throw validationError("tenantId must be a UUID");
    }
    if (!UuidParam.safeParse(params.learnerId).success) {
      throw validationError("learnerId must be a UUID");
    }
    assertSameTenant(auth.authz.tenantId, params.tenantId);
    await requirePermission(pool, auth.authz, "resource.learner.read", {
      ip: clientIp(request),
    });

    const learner = await getLearnerById(pool, {
      tenantId: params.tenantId,
      learnerId: params.learnerId,
      actorUserId: auth.user.id,
    });
    return { learner };
  });
}
