import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { uuidString } from "../schemas.js";
import type { AppPool } from "../../db/pool.js";
import { recordSecurityEvent } from "../../modules/audit/audit.js";
import { ADMIN_AREAS, isAdminArea, mayHoldAdminAreas } from "../../modules/identity/roles.js";
import {
  loadEffectivePermissions,
  mayAdminister,
  requirePermission,
  resolveActingVia,
} from "../../modules/rbac/authorize.js";
import {
  grantOrgAdminDelegations,
  listOrgAdminDelegationsPage,
  loadDelegatedPermissionCodes,
  revokeOrgAdminDelegations,
  type DelegationListStatus,
} from "../../modules/rbac/delegations.js";
import { clientIp } from "../clientIp.js";
import { forbidden, notFound, validationError } from "../errors.js";
import { pageFromKeysetRows, parseListQuery } from "../pagination.js";
import { withTenantRequest } from "../tenantRequest.js";
import { parseOrThrow } from "../validation.js";
import { parseIdempotencyKey, runIdempotent } from "../../modules/idempotency/idempotency.js";

const SetAreasSchema = z.object({
  userId: uuidString,
  areas: z.array(z.string().max(32)).max(32),
});

const DelegationGrantSchema = z.object({
  delegateUserId: uuidString,
  permissionCodes: z.array(z.string().min(1).max(64)).min(1).max(64),
});

const DelegationRevokeSchema = z.object({
  delegateUserId: uuidString,
  permissionCodes: z.array(z.string().min(1).max(64)).max(64).optional(),
});

function parseDelegationStatus(raw: unknown): DelegationListStatus {
  if (raw === undefined || raw === null || raw === "") return "active";
  if (raw === "active" || raw === "revoked" || raw === "all") return raw;
  throw validationError("status must be active, revoked, or all");
}

export async function registerRbacRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.get("/v1/rbac/permissions", async (request) => {
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      await requirePermission(tx, auth.authz, "rbac.permissions.read", {
        ip: clientIp(request),
        deferAudit: true,
      });
      const query = request.query as Record<string, unknown>;
      const sort = "code";
      const tenantId = auth.authz.tenantId ?? null;
      const { limit, cursor, fingerprint } = parseListQuery(query, {
        sort,
        filter: { tenantId, userId: auth.user.id },
        keySpecs: [{ kind: "permission_code" }],
      });
      // Bounded catalogue: order + keyset in SQL via unnest (no JS string `<`).
      const codes = [...(await loadEffectivePermissions(tx, auth.authz))];
      const params: unknown[] = [codes];
      let keyset = "";
      if (cursor) {
        params.push(cursor.k[0]);
        keyset = `WHERE code > $2`;
      }
      params.push(limit + 1);
      const limitParam = `$${params.length}`;
      const paged = await tx.query<{ code: string }>(
        `SELECT code
         FROM unnest($1::text[]) AS t(code)
         ${keyset}
         ORDER BY code
         LIMIT ${limitParam}`,
        params,
      );
      const page = pageFromKeysetRows(
        paged.rows.map((r) => r.code),
        {
          limit,
          sort,
          fingerprint,
          keysOf: (code) => [code],
        },
      );
      const delegatedPermissions =
        auth.authz.isOrgAdminForTenant && auth.authz.tenantId && !mayAdminister(auth.authz)
          ? [...(await loadDelegatedPermissionCodes(tx, auth.user.id, auth.authz.tenantId))].sort()
          : [];
      return {
        role: auth.authz.role,
        tenantId: auth.authz.tenantId,
        mayAdminister: mayAdminister(auth.authz),
        isOrgAdminForTenant: auth.authz.isOrgAdminForTenant,
        isSuperAdmin: auth.authz.isSuperAdmin,
        delegatedPermissions,
        actingVia: await resolveActingVia(tx, auth.authz),
        items: page.items,
        page: page.page,
      };
    });
  });

  app.get("/v1/rbac/org-delegations", async (request) => {
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      await requirePermission(tx, auth.authz, "rbac.org_delegations.read", {
        ip: clientIp(request),
        deferAudit: true,
      });
      const tenantId = auth.authz.tenantId!;
      const query = request.query as Record<string, unknown>;
      const status = parseDelegationStatus(query.status);
      const sort = "created_at_desc";
      const { limit, cursor, fingerprint } = parseListQuery(query, {
        sort,
        filter: { status, tenantId },
        keySpecs: [{ kind: "timestamptz_micros" }, { kind: "uuid" }],
      });
      const rows = await listOrgAdminDelegationsPage(tx, {
        tenantId,
        status,
        limit: limit + 1,
        after: cursor ? { createdAt: cursor.k[0]!, id: cursor.k[1]! } : null,
      });
      const page = pageFromKeysetRows(rows, {
        limit,
        sort,
        fingerprint,
        keysOf: (row) => [row.createdAt, row.id],
      });
      return { tenantId, items: page.items, page: page.page };
    });
  });

  app.post("/v1/rbac/org-delegations", async (request, reply) => {
    const parsed = parseOrThrow(
      DelegationGrantSchema,
      request.body,
      "delegateUserId and permissionCodes[] are required",
    );
    const key = parseIdempotencyKey(request.headers["idempotency-key"]);
    const out = await withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      await requirePermission(tx, auth.authz, "rbac.org_delegations.manage", {
        ip: clientIp(request),
        deferAudit: true,
      });
      const tenantId = auth.authz.tenantId!;
      return runIdempotent(tx, {
        key,
        config: app.appConfig,
        routeTemplate: "POST /v1/rbac/org-delegations",
        fingerprintInput: { body: parsed },
        status: 200,
        execute: async () => {
          const result = await grantOrgAdminDelegations(tx, {
            actor: auth.authz,
            tenantId,
            delegateUserId: parsed.delegateUserId,
            permissionCodes: parsed.permissionCodes,
            ip: clientIp(request),
          });
          return {
            value: { ok: true, tenantId, delegateUserId: parsed.delegateUserId, granted: result.granted },
            resourceType: "org_delegation",
            resourceId: parsed.delegateUserId,
          };
        },
        // Replay reflects the original request (the fingerprint matched): the codes that were granted.
        replay: async () => ({
          ok: true,
          tenantId,
          delegateUserId: parsed.delegateUserId,
          granted: [...new Set(parsed.permissionCodes)],
        }),
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.delete("/v1/rbac/org-delegations", async (request) => {
    const parsed = parseOrThrow(DelegationRevokeSchema, request.body, "delegateUserId is required");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      await requirePermission(tx, auth.authz, "rbac.org_delegations.manage", {
        ip: clientIp(request),
        deferAudit: true,
      });
      const result = await revokeOrgAdminDelegations(tx, {
        actor: auth.authz,
        tenantId: auth.authz.tenantId!,
        delegateUserId: parsed.delegateUserId,
        permissionCodes: parsed.permissionCodes ?? null,
        ip: clientIp(request),
      });
      return {
        ok: true,
        tenantId: auth.authz.tenantId,
        delegateUserId: parsed.delegateUserId,
        revoked: result.revoked,
      };
    });
  });

  app.put("/v1/rbac/staff-areas", async (request) => {
    const parsed = parseOrThrow(SetAreasSchema, request.body, "userId and areas[] are required");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      await requirePermission(tx, auth.authz, "rbac.staff_areas.manage", {
        ip: clientIp(request),
        deferAudit: true,
      });

      const tenantId = auth.authz.tenantId!;
      if (parsed.userId === auth.user.id) {
        throw forbidden("Cannot change your own admin areas");
      }
      if (!parsed.areas.every(isAdminArea)) throw validationError("Unknown admin area");
      const areas = [...new Set(parsed.areas)].filter(isAdminArea);
      const actingVia = await resolveActingVia(tx, auth.authz);

      // SELECT-only grant on school_memberships cannot take FOR UPDATE.
      // The advisory lock serialises concurrent area edits for this membership.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `staff-areas:${tenantId}:${parsed.userId}`,
      ]);
      const target = await tx.query<{ role: string }>(
        `SELECT role FROM school_memberships
         WHERE user_id = $1 AND tenant_id = $2 AND archived_at IS NULL`,
        [parsed.userId, tenantId],
      );
      if (!target.rows[0]) throw notFound("Membership not found");
      if (!mayHoldAdminAreas(target.rows[0].role)) {
        throw forbidden("Only teacher or staff memberships may hold admin areas");
      }

      const previous = await tx.query<{ area: string }>(
        `SELECT area FROM staff_area_grants WHERE user_id = $1 AND tenant_id = $2 ORDER BY area`,
        [parsed.userId, tenantId],
      );
      await tx.query(`DELETE FROM staff_area_grants WHERE user_id = $1 AND tenant_id = $2`, [
        parsed.userId,
        tenantId,
      ]);
      for (const area of areas) {
        await tx.query(
          `INSERT INTO staff_area_grants (tenant_id, user_id, area, granted_by)
           VALUES ($1, $2, $3, $4)`,
          [tenantId, parsed.userId, area, auth.user.id],
        );
      }
      await recordSecurityEvent(tx, {
        eventType: "rbac.staff_areas.changed",
        actorUserId: auth.user.id,
        tenantId,
        detail: {
          targetUserId: parsed.userId,
          previousAreas: previous.rows.map((r) => r.area),
          areas,
          actingVia,
          actorIsOrgAdmin: auth.authz.isOrgAdminForTenant,
        },
        ip: clientIp(request),
      });

      return {
        ok: true,
        userId: parsed.userId,
        areas: [...ADMIN_AREAS].filter((a) => areas.includes(a)),
      };
    });
  });
}
