import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { uuidString } from "../schemas.js";
import type { AppPool } from "../../db/pool.js";
import { clientIp } from "../clientIp.js";
import { forbidden, validationError } from "../errors.js";
import { hasPermission, requirePermission } from "../../modules/rbac/authorize.js";
import { assertSameTenant } from "../../modules/tenancy/context.js";
import { pageFromKeysetRows, parseListQuery } from "../pagination.js";
import { withTenantRequest } from "../tenantRequest.js";
import { parseOrThrow } from "../validation.js";
import { parseIdempotencyKey, runIdempotent } from "../../modules/idempotency/idempotency.js";
import {
  addGuardianLink,
  archiveGuardian,
  archiveGuardianLink,
  createGuardian,
  codePointLength,
  getGuardianById,
  GUARDIAN_EMAIL_MAX_LENGTH,
  GUARDIAN_EMAIL_PATTERN,
  GUARDIAN_NAME_MAX_LENGTH,
  GUARDIAN_NAME_PATTERN,
  GUARDIAN_PHONE_PATTERN,
  listGuardiansForLearnerPage,
  listGuardiansPage,
  getCreatedGuardianView,
  getGuardianLinkById,
  restoreGuardian,
  updateGuardian,
} from "../../modules/directory/guardians.js";
import { parseSearchTerm } from "../../modules/directory/search.js";

const Relationship = z.enum(["mother", "father", "guardian"]);
// F-5: the same patterns as the OpenAPI schema. Values are NOT trimmed before checking,
// so a padded value is refused here exactly where the published pattern refuses it.
const Phone = z.string().regex(new RegExp(GUARDIAN_PHONE_PATTERN));

const LinkSchema = z.strictObject({
  learner_id: uuidString,
  relationship: Relationship,
  is_primary_payer: z.boolean().optional(),
});

const CreateGuardianSchema = z.strictObject({
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
});

const UuidParam = uuidString;

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
    const parsed = parseOrThrow(
      CreateGuardianSchema,
      request.body,
      "full_name and at least one learner (learner_id, relationship mother|father|guardian) are required; optional phone, alt_phone and email",
    );
    const key = parseIdempotencyKey(request.headers["idempotency-key"]);
    const out = await withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
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
      return runIdempotent(tx, {
        key,
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/guardians",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const guardian = await createGuardian(tx, {
            tenantId: params.tenantId,
            actorUserId: auth.user.id,
            full_name: parsed.full_name,
            phone: parsed.phone ?? null,
            alt_phone: parsed.alt_phone ?? null,
            email: parsed.email ?? null,
            learners: parsed.learners,
            ip: clientIp(request),
          });
          return { value: { guardian }, resourceType: "guardian", resourceId: guardian.id };
        },
        replay: async (_type, id) => {
          const guardian = await getCreatedGuardianView(tx, { tenantId: params.tenantId, guardianId: id });
          return guardian ? { guardian } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/guardians", async (request) => {
    const params = request.params as { tenantId: string };
    uuidParam(params.tenantId, "tenantId");
    const query = request.query as Record<string, unknown>;
    let active: boolean | null = null;
    if (query.active === "true") active = true;
    else if (query.active === "false") active = false;
    else if (query.active !== undefined && query.active !== null && query.active !== "") {
      throw validationError("active must be true or false");
    }
    const q = parseSearchTerm(query.q);
    const list = parseListQuery(query, {
      sort: "name",
      filter: { resource: "guardians", tenantId: params.tenantId, active, q },
      keySpecs: [{ kind: "text", maxLen: 120 }, { kind: "uuid" }],
    });
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.guardian.read", {
        ip: clientIp(request),
        deferAudit: true,
      });
      const rows = await listGuardiansPage(tx, {
        tenantId: params.tenantId,
        limit: list.limit,
        cursorKeys: list.cursor?.k ?? null,
        active,
        q,
      });
      const page = pageFromKeysetRows(rows, {
        limit: list.limit,
        sort: list.sort,
        fingerprint: list.fingerprint,
        keysOf: (row) => [row._sort_name, row.id],
      });
      return {
        guardians: page.items.map(({ _sort_name: _, ...g }) => g),
        page: page.page,
      };
    });
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

  app.patch("/v1/tenants/:tenantId/guardians/:guardianId", async (request) => {
    const params = request.params as { tenantId: string; guardianId: string };
    uuidParam(params.tenantId, "tenantId");
    uuidParam(params.guardianId, "guardianId");
    rejectClientSuppliedPermissions(request.body);
    const Phone = z.string().regex(new RegExp(GUARDIAN_PHONE_PATTERN));
    const PatchSchema = z
      .strictObject({
        full_name: z
          .string()
          .min(1)
          .regex(new RegExp(GUARDIAN_NAME_PATTERN))
          .refine((v) => codePointLength(v) <= GUARDIAN_NAME_MAX_LENGTH)
          .optional(),
        phone: Phone.nullable().optional(),
        alt_phone: Phone.nullable().optional(),
        email: z
          .string()
          .max(GUARDIAN_EMAIL_MAX_LENGTH)
          .regex(new RegExp(GUARDIAN_EMAIL_PATTERN))
          .nullable()
          .optional(),
      })
      .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required" });
    const parsed = parseOrThrow(PatchSchema, request.body, "At least one guardian field is required");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.guardian.write", {
        ip: clientIp(request),
        deferAudit: true,
      });
      const updated = await updateGuardian(tx, {
        tenantId: params.tenantId,
        guardianId: params.guardianId,
        actorUserId: auth.user.id,
        ...parsed,
        ip: clientIp(request),
      });
      // P3-AUDIT-001: read and write are separable. A caller holding only guardian.write must not
      // receive contact details back from a write.
      const canRead = await hasPermission(tx, auth.authz, "resource.guardian.read");
      return {
        guardian: canRead ? updated : { id: updated.id, tenantId: updated.tenantId },
      };
    });
  });

  app.post("/v1/tenants/:tenantId/guardians/:guardianId/archive", async (request) => {
    const params = request.params as { tenantId: string; guardianId: string };
    uuidParam(params.tenantId, "tenantId");
    uuidParam(params.guardianId, "guardianId");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.guardian.write", {
        ip: clientIp(request),
        deferAudit: true,
      });
      const archived = await archiveGuardian(tx, {
        tenantId: params.tenantId,
        guardianId: params.guardianId,
        actorUserId: auth.user.id,
        ip: clientIp(request),
      });
      // P3-AUDIT-001: same rule as PATCH — no contact details to a write-only caller.
      const canRead = await hasPermission(tx, auth.authz, "resource.guardian.read");
      return {
        guardian: canRead ? archived : { id: archived.id, tenantId: archived.tenantId },
      };
    });
  });

  /**
   * Restore an archived guardian (Stage 8 lifecycle completion).
   *
   * Learners and staff have always had this; guardians did not, so archiving one was irreversible
   * through the API even though `guardians.active` / `archived_at` were built for it (migration
   * 019). Needs the same permission as archiving, so no new authority is created.
   *
   * `resource.learner.read` is also required because restoring re-establishes relationships to
   * named learners: the same rule that applies when a link is created (F-3) applies when one
   * comes back.
   */
  app.post("/v1/tenants/:tenantId/guardians/:guardianId/restore", async (request) => {
    const params = request.params as { tenantId: string; guardianId: string };
    uuidParam(params.tenantId, "tenantId");
    uuidParam(params.guardianId, "guardianId");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.guardian.write", {
        ip: clientIp(request),
        deferAudit: true,
      });
      await requirePermission(tx, auth.authz, "resource.learner.read", {
        ip: clientIp(request),
        deferAudit: true,
      });
      const restored = await restoreGuardian(tx, {
        tenantId: params.tenantId,
        guardianId: params.guardianId,
        actorUserId: auth.user.id,
        ip: clientIp(request),
      });
      // P3-AUDIT-001: same rule as PATCH and archive — no contact details to a write-only caller.
      const canRead = await hasPermission(tx, auth.authz, "resource.guardian.read");
      return {
        guardian: canRead ? restored : { id: restored.id, tenantId: restored.tenantId },
      };
    });
  });

  app.post("/v1/tenants/:tenantId/guardians/:guardianId/links", async (request, reply) => {
    const params = request.params as { tenantId: string; guardianId: string };
    uuidParam(params.tenantId, "tenantId");
    uuidParam(params.guardianId, "guardianId");
    rejectClientSuppliedPermissions(request.body);
    const parsed = parseOrThrow(
      LinkSchema,
      request.body,
      "learner_id and relationship (mother|father|guardian) are required; optional is_primary_payer",
    );
    const key = parseIdempotencyKey(request.headers["idempotency-key"]);
    const out = await withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.guardian.write", {
        ip: clientIp(request),
        deferAudit: true,
      });
      await requirePermission(tx, auth.authz, "resource.learner.read", {
        ip: clientIp(request),
        deferAudit: true,
      });
      return runIdempotent(tx, {
        key,
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/guardians/:guardianId/links",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const link = await addGuardianLink(tx, {
            tenantId: params.tenantId,
            guardianId: params.guardianId,
            actorUserId: auth.user.id,
            link: parsed,
            ip: clientIp(request),
          });
          return { value: { link }, resourceType: "guardian_link", resourceId: link.id };
        },
        replay: async (_type, id) => {
          const link = await getGuardianLinkById(tx, { tenantId: params.tenantId, linkId: id });
          return link ? { link } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
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

      const query = request.query as Record<string, unknown>;
      const sort = "link_created_at";
      const { limit, cursor, fingerprint } = parseListQuery(query, {
        sort,
        filter: { resource: "learner-guardians", tenantId: params.tenantId, learnerId: params.learnerId },
        keySpecs: [{ kind: "timestamptz_micros" }, { kind: "uuid" }],
      });
      const guardians = await listGuardiansForLearnerPage(tx, {
        tenantId: params.tenantId,
        learnerId: params.learnerId,
        actorUserId: auth.user.id,
        limit: limit + 1,
        after: cursor ? { createdAt: cursor.k[0]!, linkId: cursor.k[1]! } : null,
      });
      return pageFromKeysetRows(guardians, {
        limit,
        sort,
        fingerprint,
        keysOf: (g) => [g.created_at, g.linkId],
      });
    });
  });

  app.post("/v1/tenants/:tenantId/guardians/:guardianId/links/:linkId/archive", async (request) => {
    const params = request.params as { tenantId: string; guardianId: string; linkId: string };
    uuidParam(params.tenantId, "tenantId");
    uuidParam(params.guardianId, "guardianId");
    uuidParam(params.linkId, "linkId");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.guardian.write", {
        ip: clientIp(request),
        deferAudit: true,
      });
      await requirePermission(tx, auth.authz, "resource.learner.read", {
        ip: clientIp(request),
        deferAudit: true,
      });
      return {
        link: await archiveGuardianLink(tx, {
          tenantId: params.tenantId,
          guardianId: params.guardianId,
          linkId: params.linkId,
          actorUserId: auth.user.id,
          ip: clientIp(request),
        }),
      };
    });
  });
}
