import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { uuidString, calendarDateString } from "../schemas.js";
import type { AppPool } from "../../db/pool.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import {
  archiveLearner,
  createLearner,
  getLearnerById,
  listLearnersPage,
  restoreLearner,
  updateLearner,
} from "../../modules/directory/learners.js";
import { parseSearchTerm } from "../../modules/directory/search.js";
import { assertSameTenant } from "../../modules/tenancy/context.js";
import { clientIp } from "../clientIp.js";
import { AppError, forbidden, validationError } from "../errors.js";
import { parseIdempotencyKey, runIdempotent } from "../../modules/idempotency/idempotency.js";
import { withTenantRequest } from "../tenantRequest.js";
import { parseOrThrow } from "../validation.js";
import { pageFromKeysetRows, parseListQuery } from "../pagination.js";

const CreateLearnerSchema = z.object({
  admission_no: z.string().min(1).max(32),
  full_name: z.string().min(1).max(120),
  gender: z.enum(["male", "female"]),
  boarding: z.boolean().optional(),
  date_of_birth: calendarDateString.nullable().optional(),
});

const PatchLearnerSchema = z
  .strictObject({
    admission_no: z.string().min(1).max(32).optional(),
    full_name: z.string().min(1).max(120).optional(),
    gender: z.enum(["male", "female"]).optional(),
    boarding: z.boolean().optional(),
    date_of_birth: calendarDateString.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required" });

const UuidParam = uuidString;

function rejectClientSuppliedPermissions(body: unknown): void {
  if (body && typeof body === "object" && "permissions" in body) {
    throw forbidden("Client-supplied permissions are not accepted");
  }
}

/**
 * School Directory — learner create/read/list/update/archive/restore.
 * Tenant id comes from the path and must match the established authz tenant.
 */
export async function registerLearnerRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.post("/v1/tenants/:tenantId/learners", async (request, reply) => {
    const params = request.params as { tenantId: string };
    if (!UuidParam.safeParse(params.tenantId).success) {
      throw validationError("tenantId must be a UUID");
    }
    const parsed = parseOrThrow(
      CreateLearnerSchema,
      request.body,
      "admission_no, full_name and gender (male|female) are required; optional boarding and date_of_birth (YYYY-MM-DD)",
    );
    const key = parseIdempotencyKey(request.headers["idempotency-key"]);
    const out = await withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.learner.write", {
        ip: clientIp(request),
        deferAudit: true,
      });
      return runIdempotent(tx, {
        key,
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/learners",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const learner = await createLearner(tx, {
            tenantId: params.tenantId,
            actorUserId: auth.user.id,
            admission_no: parsed.admission_no,
            full_name: parsed.full_name,
            gender: parsed.gender,
            boarding: parsed.boarding,
            date_of_birth: parsed.date_of_birth ?? null,
            ip: clientIp(request),
          });
          return { value: { learner }, resourceType: "learner", resourceId: learner.id };
        },
        replay: async (_type, id) => {
          try {
            return { learner: await getLearnerById(tx, { tenantId: params.tenantId, learnerId: id, actorUserId: auth.user.id }) };
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

  app.get("/v1/tenants/:tenantId/learners", async (request) => {
    const params = request.params as { tenantId: string };
    if (!UuidParam.safeParse(params.tenantId).success) {
      throw validationError("tenantId must be a UUID");
    }
    const query = request.query as Record<string, unknown>;
    let active: boolean | null = null;
    if (query.active === "true") active = true;
    else if (query.active === "false") active = false;
    else if (query.active !== undefined && query.active !== null && query.active !== "") {
      throw validationError("active must be true or false");
    }
    // P3-AUDIT-013: bounded, control-character-free. Returns null for an empty/blank q so the
    // page fingerprint of a no-search listing is unchanged.
    const q = parseSearchTerm(query.q);
    const sortRaw =
      query.sort === undefined || query.sort === null || query.sort === ""
        ? "name"
        : String(query.sort);
    if (sortRaw !== "name" && sortRaw !== "created") {
      throw validationError("sort is not allowed", [
        { field: "sort", code: "invalid_value", message: "Invalid value" },
      ]);
    }
    const list = parseListQuery(query, {
      sort: sortRaw,
      allowSort: ["name", "created"] as const,
      // Audit A-07: `resource` makes the cursor fingerprint endpoint-specific. Without it
      // learners, guardians and staff all fingerprint as sort=name + {tenantId, active, q},
      // so a cursor minted on one was silently accepted by the others.
      filter: { resource: "learners", tenantId: params.tenantId, active, q },
      keySpecs:
        sortRaw === "created"
          ? ([{ kind: "timestamptz_micros" }, { kind: "uuid" }] as const)
          : ([{ kind: "text", maxLen: 120 }, { kind: "uuid" }] as const),
    });
    const sort = list.sort as "name" | "created";
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.learner.read", {
        ip: clientIp(request),
        deferAudit: true,
      });
      const rows = await listLearnersPage(tx, {
        tenantId: params.tenantId,
        limit: list.limit,
        cursorKeys: list.cursor?.k ?? null,
        sort,
        active,
        q,
      });
      const page = pageFromKeysetRows(rows, {
        limit: list.limit,
        sort: list.sort,
        fingerprint: list.fingerprint,
        keysOf: (row) =>
          sort === "name"
            ? [row._sort_name ?? row.full_name.toLowerCase(), row.id]
            : [row._sort_created ?? row.created_at, row.id],
      });
      return {
        learners: page.items.map(({ _sort_name: _n, _sort_created: _c, ...learner }) => learner),
        page: page.page,
      };
    });
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

  app.patch("/v1/tenants/:tenantId/learners/:learnerId", async (request) => {
    const params = request.params as { tenantId: string; learnerId: string };
    if (!UuidParam.safeParse(params.tenantId).success) throw validationError("tenantId must be a UUID");
    if (!UuidParam.safeParse(params.learnerId).success) throw validationError("learnerId must be a UUID");
    rejectClientSuppliedPermissions(request.body);
    const parsed = parseOrThrow(PatchLearnerSchema, request.body, "At least one learner field is required");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.learner.write", {
        ip: clientIp(request),
        deferAudit: true,
      });
      const learner = await updateLearner(tx, {
        tenantId: params.tenantId,
        learnerId: params.learnerId,
        actorUserId: auth.user.id,
        ...parsed,
        ip: clientIp(request),
      });
      return { learner };
    });
  });

  app.post("/v1/tenants/:tenantId/learners/:learnerId/archive", async (request) => {
    const params = request.params as { tenantId: string; learnerId: string };
    if (!UuidParam.safeParse(params.tenantId).success) throw validationError("tenantId must be a UUID");
    if (!UuidParam.safeParse(params.learnerId).success) throw validationError("learnerId must be a UUID");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.learner.write", {
        ip: clientIp(request),
        deferAudit: true,
      });
      const learner = await archiveLearner(tx, {
        tenantId: params.tenantId,
        learnerId: params.learnerId,
        actorUserId: auth.user.id,
        ip: clientIp(request),
      });
      return { learner };
    });
  });

  app.post("/v1/tenants/:tenantId/learners/:learnerId/restore", async (request) => {
    const params = request.params as { tenantId: string; learnerId: string };
    if (!UuidParam.safeParse(params.tenantId).success) throw validationError("tenantId must be a UUID");
    if (!UuidParam.safeParse(params.learnerId).success) throw validationError("learnerId must be a UUID");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.learner.write", {
        ip: clientIp(request),
        deferAudit: true,
      });
      const learner = await restoreLearner(tx, {
        tenantId: params.tenantId,
        learnerId: params.learnerId,
        actorUserId: auth.user.id,
        ip: clientIp(request),
      });
      return { learner };
    });
  });
}
