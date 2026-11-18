import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { uuidString } from "../schemas.js";
import type { AppPool } from "../../db/pool.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import {
  archiveStaffMember,
  createStaffMember,
  getStaffMemberById,
  listStaffMembersPage,
  restoreStaffMember,
  updateStaffMember,
} from "../../modules/directory/staffMembers.js";
import {
  CONTACT_EMAIL_MAX_LENGTH,
  CONTACT_EMAIL_PATTERN,
  CONTACT_PHONE_PATTERN,
} from "../../modules/directory/contact.js";
import { parseSearchTerm } from "../../modules/directory/search.js";
import { assertSameTenant } from "../../modules/tenancy/context.js";
import { clientIp } from "../clientIp.js";
import { AppError, forbidden, validationError } from "../errors.js";
import { parseIdempotencyKey, runIdempotent } from "../../modules/idempotency/idempotency.js";
import { withTenantRequest } from "../tenantRequest.js";
import { parseOrThrow } from "../validation.js";
import { pageFromKeysetRows, parseListQuery } from "../pagination.js";

const UuidParam = uuidString;
const Classification = z.enum(["school_admin", "teacher", "driver", "staff"]);

// P3-AUDIT-013: the same shapes the guardian directory publishes and enforces, so a staff phone
// number and a guardian phone number mean the same thing. Previously length-only.
const StaffPhone = z.string().regex(new RegExp(CONTACT_PHONE_PATTERN));
const StaffEmail = z
  .string()
  .max(CONTACT_EMAIL_MAX_LENGTH)
  .regex(new RegExp(CONTACT_EMAIL_PATTERN));

const CreateSchema = z.strictObject({
  full_name: z.string().min(1).max(120),
  staff_title: z.string().min(1).max(120).nullable().optional(),
  classification: Classification.optional(),
  phone: StaffPhone.nullable().optional(),
  email: StaffEmail.nullable().optional(),
  userId: uuidString.nullable().optional(),
});

const PatchSchema = z
  .strictObject({
    full_name: z.string().min(1).max(120).optional(),
    staff_title: z.string().min(1).max(120).nullable().optional(),
    classification: Classification.optional(),
    phone: StaffPhone.nullable().optional(),
    email: StaffEmail.nullable().optional(),
    userId: uuidString.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required" });

function rejectClientSuppliedPermissions(body: unknown): void {
  if (body && typeof body === "object" && "permissions" in body) {
    throw forbidden("Client-supplied permissions are not accepted");
  }
}

export async function registerStaffRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.post("/v1/tenants/:tenantId/staff", async (request, reply) => {
    const params = request.params as { tenantId: string };
    if (!UuidParam.safeParse(params.tenantId).success) throw validationError("tenantId must be a UUID");
    rejectClientSuppliedPermissions(request.body);
    const parsed = parseOrThrow(CreateSchema, request.body, "full_name is required");
    const key = parseIdempotencyKey(request.headers["idempotency-key"]);
    const out = await withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.staff.write", {
        ip: clientIp(request),
        deferAudit: true,
      });
      return runIdempotent(tx, {
        key,
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/staff",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const staff = await createStaffMember(tx, {
            tenantId: params.tenantId,
            actorUserId: auth.user.id,
            ...parsed,
            ip: clientIp(request),
          });
          return { value: { staff }, resourceType: "staff", resourceId: staff.id };
        },
        replay: async (_type, id) => {
          try {
            return { staff: await getStaffMemberById(tx, { tenantId: params.tenantId, staffId: id }) };
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

  app.get("/v1/tenants/:tenantId/staff", async (request) => {
    const params = request.params as { tenantId: string };
    if (!UuidParam.safeParse(params.tenantId).success) throw validationError("tenantId must be a UUID");
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
      filter: { resource: "staff", tenantId: params.tenantId, active, q },
      keySpecs: [{ kind: "text", maxLen: 120 }, { kind: "uuid" }],
    });
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.staff.read", {
        ip: clientIp(request),
        deferAudit: true,
      });
      const rows = await listStaffMembersPage(tx, {
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
        staff: page.items.map(({ _sort_name: _, ...member }) => member),
        page: page.page,
      };
    });
  });

  app.get("/v1/tenants/:tenantId/staff/:staffId", async (request) => {
    const params = request.params as { tenantId: string; staffId: string };
    if (!UuidParam.safeParse(params.tenantId).success) throw validationError("tenantId must be a UUID");
    if (!UuidParam.safeParse(params.staffId).success) throw validationError("staffId must be a UUID");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.staff.read", {
        ip: clientIp(request),
        deferAudit: true,
      });
      return { staff: await getStaffMemberById(tx, { tenantId: params.tenantId, staffId: params.staffId }) };
    });
  });

  app.patch("/v1/tenants/:tenantId/staff/:staffId", async (request) => {
    const params = request.params as { tenantId: string; staffId: string };
    if (!UuidParam.safeParse(params.tenantId).success) throw validationError("tenantId must be a UUID");
    if (!UuidParam.safeParse(params.staffId).success) throw validationError("staffId must be a UUID");
    rejectClientSuppliedPermissions(request.body);
    const parsed = parseOrThrow(PatchSchema, request.body, "At least one staff field is required");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.staff.write", {
        ip: clientIp(request),
        deferAudit: true,
      });
      return {
        staff: await updateStaffMember(tx, {
          tenantId: params.tenantId,
          staffId: params.staffId,
          actorUserId: auth.user.id,
          ...parsed,
          ip: clientIp(request),
        }),
      };
    });
  });

  app.post("/v1/tenants/:tenantId/staff/:staffId/archive", async (request) => {
    const params = request.params as { tenantId: string; staffId: string };
    if (!UuidParam.safeParse(params.tenantId).success) throw validationError("tenantId must be a UUID");
    if (!UuidParam.safeParse(params.staffId).success) throw validationError("staffId must be a UUID");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.staff.write", {
        ip: clientIp(request),
        deferAudit: true,
      });
      return {
        staff: await archiveStaffMember(tx, {
          tenantId: params.tenantId,
          staffId: params.staffId,
          actorUserId: auth.user.id,
          ip: clientIp(request),
        }),
      };
    });
  });

  app.post("/v1/tenants/:tenantId/staff/:staffId/restore", async (request) => {
    const params = request.params as { tenantId: string; staffId: string };
    if (!UuidParam.safeParse(params.tenantId).success) throw validationError("tenantId must be a UUID");
    if (!UuidParam.safeParse(params.staffId).success) throw validationError("staffId must be a UUID");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.staff.write", {
        ip: clientIp(request),
        deferAudit: true,
      });
      return {
        staff: await restoreStaffMember(tx, {
          tenantId: params.tenantId,
          staffId: params.staffId,
          actorUserId: auth.user.id,
          ip: clientIp(request),
        }),
      };
    });
  });
}
