import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { clientIp } from "../clientIp.js";
import { forbidden, validationError } from "../errors.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import { assertSameTenant } from "../../modules/tenancy/context.js";
import { withTenantRequest } from "../tenantRequest.js";
import {
  addGuardianLink,
  createGuardian,
  codePointLength,
  getGuardianById,
  GUARDIAN_EMAIL_MAX_LENGTH,
  GUARDIAN_EMAIL_PATTERN,
  GUARDIAN_NAME_MAX_LENGTH,
  GUARDIAN_NAME_PATTERN,
  GUARDIAN_PHONE_PATTERN,
  listGuardiansForLearner,
} from "../../modules/directory/guardians.js";

const Relationship = z.enum(["mother", "father", "guardian"]);
// F-5: the same patterns as the OpenAPI schema. Values are NOT trimmed before checking,
// so a padded value is refused here exactly where the published pattern refuses it.
const Phone = z.string().regex(new RegExp(GUARDIAN_PHONE_PATTERN));

const LinkSchema = z
  .object({
    learner_id: z.string().uuid(),
    relationship: Relationship,
    is_primary_payer: z.boolean().optional(),
  })
  .strict();

const CreateGuardianSchema = z
  .object({
    // Length in Unicode code points (what OpenAPI maxLength means), not UTF-16 units.
    full_name: z
      .string()
      .min(1)
      .regex(new RegExp(GUARDIAN_NAME_PATTERN))
      .refine((v) => codePointLength(v) <= GUARDIAN_NAME_MAX_LENGTH),
    phone: Phone.nullable().optional(),
    alt_phone: Phone.nullable().optional(),
    // The published pattern is the whole rule (no separate .email()), so schema and backend agree.
    email: z
      .string()
      .max(GUARDIAN_EMAIL_MAX_LENGTH)
      .regex(new RegExp(GUARDIAN_EMAIL_PATTERN))
      .nullable()
      .optional(),
    learners: z.array(LinkSchema).min(1).max(20),
  })
  .strict();

const UuidParam = z.string().uuid();

function uuidParam(value: string, name: string): void {
  if (!UuidParam.safeParse(value).success) throw validationError(`${name} must be a UUID`);
}

/** Strict body schemas reject unknown keys before the tenant transaction runs. */
function rejectClientSuppliedPermissions(body: unknown): void {
  if (body && typeof body === "object" && "permissions" in body) {
    throw forbidden("Client-supplied permissions are not accepted");
  }
}

/**
 * VS-2 School Directory — guardian create/read and learner links.
 * Guardians are directory records only: no login, no user binding.
 * Tenant id comes from the path and must match the established authz tenant.
 */
export async function registerGuardianRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.post("/v1/tenants/:tenantId/guardians", async (request, reply) => {
    const params = request.params as { tenantId: string };
    uuidParam(params.tenantId, "tenantId");
    rejectClientSuppliedPermissions(request.body);
    const parsed = CreateGuardianSchema.safeParse(request.body);
    if (!parsed.success) {
      throw validationError(
        "full_name and at least one learner (learner_id, relationship mother|father|guardian) are required; optional phone, alt_phone and email",
      );
    }
    const guardian = await withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.guardian.write", {
        ip: clientIp(request),
        deferAudit: true,
      });
      // Learner existence must not be probeable via guardian.write alone (F-3).
      await requirePermission(tx, auth.authz, "resource.learner.read", {
        ip: clientIp(request),
        deferAudit: true,
      });

      return createGuardian(tx, {
        tenantId: params.tenantId,
        actorUserId: auth.user.id,
        full_name: parsed.data.full_name,
        phone: parsed.data.phone ?? null,
        alt_phone: parsed.data.alt_phone ?? null,
        email: parsed.data.email ?? null,
        learners: parsed.data.learners,
        ip: clientIp(request),
      });
    });
    return reply.status(201).send({ guardian });
  });

  app.get("/v1/tenants/:tenantId/guardians/:guardianId", async (request) => {
    const params = request.params as { tenantId: string; guardianId: string };
    uuidParam(params.tenantId, "tenantId");
    uuidParam(params.guardianId, "guardianId");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
    assertSameTenant(auth.authz.tenantId, params.tenantId);
    await requirePermission(tx, auth.authz, "resource.guardian.read", {
      ip: clientIp(request),
      deferAudit: true,
    });

    const guardian = await getGuardianById(tx, {
      tenantId: params.tenantId,
      guardianId: params.guardianId,
      actorUserId: auth.user.id,
    });
    return { guardian };
    });
  });

  app.post("/v1/tenants/:tenantId/guardians/:guardianId/links", async (request, reply) => {
    const params = request.params as { tenantId: string; guardianId: string };
    uuidParam(params.tenantId, "tenantId");
    uuidParam(params.guardianId, "guardianId");
    rejectClientSuppliedPermissions(request.body);
    const parsed = LinkSchema.safeParse(request.body);
    if (!parsed.success) {
      throw validationError(
        "learner_id and relationship (mother|father|guardian) are required; optional is_primary_payer",
      );
    }
    const link = await withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.guardian.write", {
        ip: clientIp(request),
        deferAudit: true,
      });
      await requirePermission(tx, auth.authz, "resource.learner.read", {
        ip: clientIp(request),
        deferAudit: true,
      });
      return addGuardianLink(tx, {
        tenantId: params.tenantId,
        guardianId: params.guardianId,
        actorUserId: auth.user.id,
        link: parsed.data,
        ip: clientIp(request),
      });
    });
    return reply.status(201).send({ link });
  });

  app.get("/v1/tenants/:tenantId/learners/:learnerId/guardians", async (request) => {
    const params = request.params as { tenantId: string; learnerId: string };
    uuidParam(params.tenantId, "tenantId");
    uuidParam(params.learnerId, "learnerId");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
    assertSameTenant(auth.authz.tenantId, params.tenantId);
    await requirePermission(tx, auth.authz, "resource.guardian.read", {
      ip: clientIp(request),
      deferAudit: true,
    });
    await requirePermission(tx, auth.authz, "resource.learner.read", {
      ip: clientIp(request),
      deferAudit: true,
    });

    const guardians = await listGuardiansForLearner(tx, {
      tenantId: params.tenantId,
      learnerId: params.learnerId,
      actorUserId: auth.user.id,
    });
    return { guardians };
    });
  });
}
