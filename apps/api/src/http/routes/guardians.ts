import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { requireTenantAuth } from "../middleware/authContext.js";
import { clientIp } from "../clientIp.js";
import { validationError } from "../errors.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import { assertSameTenant } from "../../modules/tenancy/context.js";
import {
  addGuardianLink,
  createGuardian,
  getGuardianById,
  listGuardiansForLearner,
} from "../../modules/directory/guardians.js";

const Relationship = z.enum(["mother", "father", "guardian"]);
const Phone = z
  .string()
  .trim()
  .regex(/^[0-9+()\-\s]{5,32}$/);

const LinkSchema = z
  .object({
    learner_id: z.string().uuid(),
    relationship: Relationship,
    is_primary_payer: z.boolean().optional(),
  })
  .strict();

const CreateGuardianSchema = z
  .object({
    full_name: z.string().trim().min(1).max(120),
    phone: Phone.nullable().optional(),
    alt_phone: Phone.nullable().optional(),
    email: z.string().trim().email().max(254).nullable().optional(),
    learners: z.array(LinkSchema).min(1).max(20),
  })
  .strict();

const UuidParam = z.string().uuid();

function uuidParam(value: string, name: string): void {
  if (!UuidParam.safeParse(value).success) throw validationError(`${name} must be a UUID`);
}

/**
 * VS-2 School Directory — guardian create/read and learner links.
 * Guardians are directory records only: no login, no user binding.
 * Tenant id comes from the path and must match the established authz tenant.
 */
export async function registerGuardianRoutes(app: FastifyInstance, pool: pg.Pool): Promise<void> {
  app.post("/v1/tenants/:tenantId/guardians", async (request, reply) => {
    const auth = await requireTenantAuth(pool, request);
    const params = request.params as { tenantId: string };
    uuidParam(params.tenantId, "tenantId");
    assertSameTenant(auth.authz.tenantId, params.tenantId);
    await requirePermission(pool, auth.authz, "resource.guardian.write", { ip: clientIp(request) });
    // Learner existence must not be probeable via guardian.write alone (F-3).
    await requirePermission(pool, auth.authz, "resource.learner.read", { ip: clientIp(request) });

    const parsed = CreateGuardianSchema.safeParse(request.body);
    if (!parsed.success) {
      throw validationError(
        "full_name and at least one learner (learner_id, relationship mother|father|guardian) are required; optional phone, alt_phone and email",
      );
    }

    const guardian = await createGuardian(pool, {
      tenantId: params.tenantId,
      actorUserId: auth.user.id,
      full_name: parsed.data.full_name,
      phone: parsed.data.phone ?? null,
      alt_phone: parsed.data.alt_phone ?? null,
      email: parsed.data.email ?? null,
      learners: parsed.data.learners,
      ip: clientIp(request),
    });
    return reply.status(201).send({ guardian });
  });

  app.get("/v1/tenants/:tenantId/guardians/:guardianId", async (request) => {
    const auth = await requireTenantAuth(pool, request);
    const params = request.params as { tenantId: string; guardianId: string };
    uuidParam(params.tenantId, "tenantId");
    uuidParam(params.guardianId, "guardianId");
    assertSameTenant(auth.authz.tenantId, params.tenantId);
    await requirePermission(pool, auth.authz, "resource.guardian.read", { ip: clientIp(request) });

    const guardian = await getGuardianById(pool, {
      tenantId: params.tenantId,
      guardianId: params.guardianId,
      actorUserId: auth.user.id,
    });
    return { guardian };
  });

  app.post("/v1/tenants/:tenantId/guardians/:guardianId/links", async (request, reply) => {
    const auth = await requireTenantAuth(pool, request);
    const params = request.params as { tenantId: string; guardianId: string };
    uuidParam(params.tenantId, "tenantId");
    uuidParam(params.guardianId, "guardianId");
    assertSameTenant(auth.authz.tenantId, params.tenantId);
    await requirePermission(pool, auth.authz, "resource.guardian.write", { ip: clientIp(request) });
    await requirePermission(pool, auth.authz, "resource.learner.read", { ip: clientIp(request) });

    const parsed = LinkSchema.safeParse(request.body);
    if (!parsed.success) {
      throw validationError(
        "learner_id and relationship (mother|father|guardian) are required; optional is_primary_payer",
      );
    }
    const link = await addGuardianLink(pool, {
      tenantId: params.tenantId,
      guardianId: params.guardianId,
      actorUserId: auth.user.id,
      link: parsed.data,
      ip: clientIp(request),
    });
    return reply.status(201).send({ link });
  });

  app.get("/v1/tenants/:tenantId/learners/:learnerId/guardians", async (request) => {
    const auth = await requireTenantAuth(pool, request);
    const params = request.params as { tenantId: string; learnerId: string };
    uuidParam(params.tenantId, "tenantId");
    uuidParam(params.learnerId, "learnerId");
    assertSameTenant(auth.authz.tenantId, params.tenantId);
    await requirePermission(pool, auth.authz, "resource.guardian.read", { ip: clientIp(request) });
    await requirePermission(pool, auth.authz, "resource.learner.read", { ip: clientIp(request) });

    const guardians = await listGuardiansForLearner(pool, {
      tenantId: params.tenantId,
      learnerId: params.learnerId,
      actorUserId: auth.user.id,
    });
    return { guardians };
  });
}
