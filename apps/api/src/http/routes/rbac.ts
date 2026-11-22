import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { uuidString } from "../schemas.js";
import type { AppPool } from "../../db/pool.js";
import { attachDenialAudit } from "../../db/errors.js";
import { recordSecurityEvent } from "../../modules/audit/audit.js";
import { ADMIN_AREAS, isAdminArea, mayHoldAdminAreas } from "../../modules/identity/roles.js";
import {
  loadEffectivePermissions,
  mayAdminister,
  requirePermission,
  resolveActingVia,
} from "../../modules/rbac/authorize.js";
import {
  activeDelegationCodes,
  assertRecipientEligible,
  assertSchoolAcceptsGrants,
  isDelegablePermission,
  grantOrgAdminDelegations,
  listOrgAdminDelegationsPage,
  loadActiveDelegations,
  loadDelegatedPermissionCodes,
  revokeOrgAdminDelegations,
  type DelegationListStatus,
} from "../../modules/rbac/delegations.js";
import {
  GUARDIAN_ACCESS_CODES,
  grantGuardianAccess,
  listGuardianAccess,
  revokeGuardianAccess,
} from "../../modules/rbac/guardianAccess.js";
import { clientIp } from "../clientIp.js";
import { forbidden, notFound, validationError } from "../errors.js";
import { pageFromKeysetRows, parseListQuery } from "../pagination.js";
import { assertRecentAuth } from "../../modules/auth/reauth.js";
import { withDelegationRequest, withTenantRequest } from "../tenantRequest.js";
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
  // Omit the field to revoke every delegation of the person. An empty array is refused rather
  // than read as "everything", so a client that sends an empty selection cannot wipe grants.
  permissionCodes: z.array(z.string().min(1).max(64)).min(1).max(64).optional(),
});

const GuardianAccessCodeSchema = z.enum(GUARDIAN_ACCESS_CODES);
const GuardianAccessGrantSchema = z.strictObject({
  userId: uuidString,
  permissionCodes: z.array(GuardianAccessCodeSchema).min(1).max(2),
});
const GuardianAccessRevokeSchema = z.strictObject({
  userId: uuidString,
  permissionCodes: z.array(GuardianAccessCodeSchema).min(1).max(2).optional(),
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
    const out = await withDelegationRequest(pool, app.appConfig, request, "grant", async ({ tx, actor, auth }) => {
      await assertRecentAuth(tx, app.appConfig, auth.session.id);
      const tenantId = actor.tenantId;
      // Current-state checks run BEFORE the idempotency lookup, so a stored success is never
      // replayed into a suspended school (the actor's authority was just re-resolved above).
      await assertSchoolAcceptsGrants(tx, actor, { delegateUserId: parsed.delegateUserId, ip: clientIp(request) });
      return runIdempotent(tx, {
        key,
        config: app.appConfig,
        routeTemplate: "POST /v1/rbac/org-delegations",
        fingerprintInput: { body: parsed },
        status: 200,
        execute: async () => {
          const result = await grantOrgAdminDelegations(tx, {
            actor,
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
        // A replay must still be true: if any granted code has since been revoked, the original
        // success no longer describes reality, so answer 409 (null) instead of a stale 200.
        replay: async () => {
          // The recipient must still be an active org admin of this organization.
          try {
            await assertRecipientEligible(tx, parsed.delegateUserId, tenantId);
          } catch {
            return null;
          }
          const active = await activeDelegationCodes(tx, tenantId, parsed.delegateUserId);
          const codes = [...new Set(parsed.permissionCodes)];
          // Every code must still be delegable AND active: a stored pre-policy success for a code that
          // is no longer delegable must not replay as "granted".
          if (!codes.every((c) => isDelegablePermission(c) && active.has(c))) return null;
          return { ok: true, tenantId, delegateUserId: parsed.delegateUserId, granted: codes };
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.delete("/v1/rbac/org-delegations", async (request) => {
    const parsed = parseOrThrow(DelegationRevokeSchema, request.body, "delegateUserId is required");
    return withDelegationRequest(pool, app.appConfig, request, "revoke", async ({ tx, actor, auth }) => {
      await assertRecentAuth(tx, app.appConfig, auth.session.id);
      const result = await revokeOrgAdminDelegations(tx, {
        actor,
        delegateUserId: parsed.delegateUserId,
        permissionCodes: parsed.permissionCodes ?? null,
        ip: clientIp(request),
      });
      return {
        ok: true,
        tenantId: actor.tenantId,
        delegateUserId: parsed.delegateUserId,
        revoked: result.revoked,
      };
    });
  });

  // FIG-1614 Option D: explicit per-person guardian read/write grants (school administrators only).
  app.get("/v1/rbac/guardian-access", async (request) => {
    const userId = (request.query as Record<string, unknown>).userId;
    if (typeof userId !== "string" || !uuidString.safeParse(userId).success) {
      throw validationError("userId query parameter must be a UUID");
    }
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      await requirePermission(tx, auth.authz, "rbac.guardian_access.manage", {
        ip: clientIp(request),
        deferAudit: true,
      });
      const tenantId = auth.authz.tenantId!;
      return { tenantId, userId, items: await listGuardianAccess(tx, { tenantId, userId }) };
    });
  });

  app.post("/v1/rbac/guardian-access", async (request) => {
    const parsed = parseOrThrow(GuardianAccessGrantSchema, request.body, "userId and permissionCodes[] are required");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      await requirePermission(tx, auth.authz, "rbac.guardian_access.manage", {
        ip: clientIp(request),
        deferAudit: true,
      });
      await assertRecentAuth(tx, app.appConfig, auth.session.id);
      const tenantId = auth.authz.tenantId!;
      const result = await grantGuardianAccess(tx, {
        actorUserId: auth.user.id,
        tenantId,
        userId: parsed.userId,
        permissionCodes: parsed.permissionCodes,
        ip: clientIp(request),
      });
      return { ok: true, tenantId, userId: parsed.userId, granted: result.granted };
    });
  });

  app.delete("/v1/rbac/guardian-access", async (request) => {
    const parsed = parseOrThrow(GuardianAccessRevokeSchema, request.body, "userId is required");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      await requirePermission(tx, auth.authz, "rbac.guardian_access.manage", {
        ip: clientIp(request),
        deferAudit: true,
      });
      await assertRecentAuth(tx, app.appConfig, auth.session.id);
      const tenantId = auth.authz.tenantId!;
      const result = await revokeGuardianAccess(tx, {
        actorUserId: auth.user.id,
        tenantId,
        userId: parsed.userId,
        permissionCodes: parsed.permissionCodes ?? null,
        ip: clientIp(request),
      });
      return { ok: true, tenantId, userId: parsed.userId, revoked: result.revoked };
    });
  });

  app.put("/v1/rbac/staff-areas", async (request) => {
    const parsed = parseOrThrow(SetAreasSchema, request.body, "userId and areas[] are required");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      await requirePermission(tx, auth.authz, "rbac.staff_areas.manage", {
        ip: clientIp(request),
        deferAudit: true,
      });

      await assertRecentAuth(tx, app.appConfig, auth.session.id);
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
      // An administrator may not assign more authority than they are permitted to administer.
      // School administrators and platform super administrators administer every area. An
      // organization administrator acting through a delegation administers exactly the `area.*`
      // codes delegated to them; they may neither assign nor remove any other area, so holding
      // rbac.staff_areas.manage alone cannot mint area authority (and `people`, which is no longer
      // delegable, cannot be created through this door).
      let finalAreas: string[] = areas;
      let delegatedScope: string[] | null = null;
      let activeDelegations: Array<{ id: string; permission_code: string }> = [];
      if (!mayAdminister(auth.authz)) {
        activeDelegations = await loadActiveDelegations(tx, auth.user.id, tenantId);
        const scope = new Set<string>(
          activeDelegations.filter((d) => d.permission_code.startsWith("area.")).map((d) => d.permission_code.slice("area.".length)),
        );
        delegatedScope = ADMIN_AREAS.filter((a) => scope.has(a));
        const beyond = areas.filter((a) => !scope.has(a));
        if (beyond.length > 0) {
          const err = forbidden("Cannot assign admin areas beyond your own delegated authority");
          attachDenialAudit(err, {
            eventType: "rbac.staff_areas.denied",
            actorUserId: auth.user.id,
            tenantId,
            detail: {
              reason: "area_beyond_authority",
              targetUserId: parsed.userId,
              requestedBeyondAuthority: beyond,
              delegatedAreas: delegatedScope,
              actingVia,
            },
            ip: clientIp(request),
          });
          throw err;
        }
        // Areas outside the actor's authority that the person already holds stay as they are.
        finalAreas = [...new Set([...previous.rows.map((r) => r.area).filter((a) => !scope.has(a)), ...areas])];
      }
      // Apply only the DIFFERENCE. An area the person already holds keeps its row, and with it who
      // assigned it and when (granted_by, granted_at): an assignment made under a delegation becomes
      // a school-level assignment and stays attributable to its maker, whoever edits the person's
      // areas later. (Deleting and re-inserting everything would re-stamp every retained area.)
      const held = new Set(previous.rows.map((r) => r.area));
      const wanted = new Set(finalAreas);
      const removedAreas = [...held].filter((a) => !wanted.has(a));
      const addedAreas = finalAreas.filter((a) => !held.has(a));
      if (removedAreas.length > 0) {
        await tx.query(`DELETE FROM staff_area_grants WHERE user_id = $1 AND tenant_id = $2 AND area = ANY($3::text[])`, [
          parsed.userId,
          tenantId,
          removedAreas,
        ]);
      }
      for (const area of addedAreas) {
        await tx.query(
          `INSERT INTO staff_area_grants (tenant_id, user_id, area, granted_by)
           VALUES ($1, $2, $3, $4)`,
          [tenantId, parsed.userId, area, auth.user.id],
        );
      }
      // The delegations that authorized this change: the management permission and the area codes touched.
      const touched = new Set<string>([...addedAreas, ...removedAreas].map((a) => `area.${a}`));
      const authorizingDelegationIds = activeDelegations
        .filter((d) => d.permission_code === "rbac.staff_areas.manage" || touched.has(d.permission_code))
        .map((d) => d.id);
      await recordSecurityEvent(tx, {
        eventType: "rbac.staff_areas.changed",
        actorUserId: auth.user.id,
        tenantId,
        detail: {
          targetUserId: parsed.userId,
          previousAreas: previous.rows.map((r) => r.area),
          areas: finalAreas,
          addedAreas,
          removedAreas,
          actingVia,
          actorIsOrgAdmin: auth.authz.isOrgAdminForTenant,
          ...(delegatedScope ? { delegatedAreas: delegatedScope, authorizingDelegationIds } : {}),
        },
        ip: clientIp(request),
      });

      return {
        ok: true,
        userId: parsed.userId,
        areas: [...ADMIN_AREAS].filter((a) => finalAreas.includes(a)),
      };
    });
  });
}
