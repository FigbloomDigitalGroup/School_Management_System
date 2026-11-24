import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppPool } from "../../db/pool.js";
import { withIdentityAccess, withIdentityUserScope } from "../../db/identityAccess.js";
import type { IdentityDb } from "../../db/sql.js";
import { recordSecurityEvent } from "../../modules/audit/audit.js";
import { buildAuthzContext, requirePermission } from "../../modules/rbac/authorize.js";
import { describeError, logError } from "../../log.js";
import { clientIp } from "../clientIp.js";
import { requireSessionAuth } from "../middleware/authContext.js";
import { pageFromKeysetRows, parseListQuery } from "../pagination.js";
import { assertUuid } from "../routeKit.js";
import { forbidden, validationError } from "../errors.js";

/** One answer for another organisation, an unknown id and a non-active organisation, so existence is not revealed. */
const NOT_ORG_ADMIN = "Not an administrator of this organization";

/**
 * The caller must be an org_admin of this organisation, and the organisation must be active (the same rule as
 * GET /v1/org/schools). Otherwise 403, and the refusal is audited on this autocommit connection.
 */
async function assertOrgAdminOfActiveOrg(
  db: IdentityDb,
  request: FastifyRequest,
  input: { userId: string; organizationId: string; permission: string },
): Promise<void> {
  const r = await db.query(
    `SELECT 1
       FROM organization_memberships om
       JOIN organizations o ON o.id = om.organization_id
      WHERE om.user_id = $1 AND om.organization_id = $2 AND om.role = 'org_admin' AND o.status = 'active'`,
    [input.userId, input.organizationId],
  );
  if (r.rowCount === 1) return;
  try {
    await recordSecurityEvent(db, {
      eventType: "rbac.permission.denied",
      actorUserId: input.userId,
      tenantId: null,
      detail: { permission: input.permission, organizationId: input.organizationId, reason: "not_org_admin_of_active_org" },
      ip: clientIp(request),
    });
  } catch (auditErr) {
    logError("denial_audit_write_failed", { outcome: "inline", ...describeError(auditErr) });
  }
  throw forbidden(NOT_ORG_ADMIN);
}

/**
 * Organization-level aggregate endpoints (R2-05).
 * Separated from school-scoped tenant.read / learner record access.
 * Identity path only: no tenant context.
 *
 * Ordering uses COLLATE "C" on both ORDER BY and the keyset predicate so
 * PostgreSQL and the cursor agree regardless of database locale (FIG-1621 / IR-01).
 *
 * The cursor carries only the last school's id. Organisation and school names have no
 * length limit in the schema, so embedding them could exceed the cursor bound; instead the
 * keyset boundary is read from that row inside the same SQL statement. Ordering and the
 * comparison stay in PostgreSQL, nothing is truncated, and an id outside the caller's own
 * authorised set is rejected exactly like an id that no longer exists.
 */
export async function registerOrgRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.get("/v1/org/schools", async (request) => {
    return withIdentityAccess(
      pool,
      async (db) => {
        const { user } = await requireSessionAuth(db, request);
        const authz = await buildAuthzContext(db, { userId: user.id, tenantId: null });
        await requirePermission(db, authz, "org.tenants.read", { ip: clientIp(request) });

        const query = request.query as Record<string, unknown>;
        const sort = "org_name_school_name";
        // Bind cursor to the organisation-admin principal (foreign-tenant reuse → validation_error).
        const { limit, cursor, fingerprint } = parseListQuery(query, {
          sort,
          filter: { scopeUserId: user.id },
          keySpecs: [{ kind: "uuid" }],
        });

        const params: unknown[] = [user.id];
        let keyset = "";
        if (cursor) {
          const anchorId = cursor.k[0]!;
          const anchor = await db.query(
            `SELECT 1
               FROM tenants t
               JOIN organizations o ON o.id = t.organization_id
               JOIN organization_memberships om
                 ON om.organization_id = o.id AND om.user_id = $1 AND om.role = 'org_admin'
              WHERE o.status = 'active' AND t.id = $2::uuid`,
            [user.id, anchorId],
          );
          if (anchor.rowCount !== 1) {
            throw validationError("cursor is no longer valid; start again from the first page");
          }
          params.push(anchorId);
          keyset = `AND (o.name COLLATE "C", t.name COLLATE "C", t.id) > (
            SELECT oa.name COLLATE "C", ta.name COLLATE "C", ta.id
              FROM tenants ta JOIN organizations oa ON oa.id = ta.organization_id
             WHERE ta.id = $${params.length}::uuid)`;
        }
        params.push(limit + 1);
        const limitParam = `$${params.length}`;

        const result = await db.query<{
          id: string;
          name: string;
          slug: string;
          status: string;
          organization_id: string;
          organization_name: string;
          organization_slug: string;
        }>(
          `SELECT t.id, t.name, t.slug, t.status,
                  o.id AS organization_id, o.name AS organization_name, o.slug AS organization_slug
           FROM tenants t
           JOIN organizations o ON o.id = t.organization_id
           JOIN organization_memberships om
             ON om.organization_id = o.id
            AND om.user_id = $1
            AND om.role = 'org_admin'
           WHERE o.status = 'active'
           ${keyset}
           ORDER BY o.name COLLATE "C", t.name COLLATE "C", t.id
           LIMIT ${limitParam}`,
          params,
        );

        const rows = result.rows.map((r) => ({
          id: r.id,
          name: r.name,
          slug: r.slug,
          status: r.status,
          organizationId: r.organization_id,
          organizationName: r.organization_name,
          organizationSlug: r.organization_slug,
        }));

        return pageFromKeysetRows(rows, {
          limit,
          sort,
          fingerprint,
          keysOf: (row) => [row.id],
        });
      },
      { acquireTimeoutMs: app.appConfig.poolAcquireTimeoutMs },
    );
  });

  /**
   * The caller's own organisations, every status (S11, docs/ORG-CONSOLE.md), so a picker can say "Suspended" instead
   * of hiding one. Only the caller's own memberships are read. Same paging rule as /v1/org/schools: the cursor carries
   * the last organisation's id and the boundary is read in SQL.
   */
  app.get("/v1/org/organizations", async (request) => {
    return withIdentityAccess(
      pool,
      async (db) => {
        const { user } = await requireSessionAuth(db, request);
        const authz = await buildAuthzContext(db, { userId: user.id, tenantId: null });
        await requirePermission(db, authz, "org.tenants.read", { ip: clientIp(request) });

        const query = request.query as Record<string, unknown>;
        const sort = "name";
        const { limit, cursor, fingerprint } = parseListQuery(query, {
          sort,
          filter: { scopeUserId: user.id, list: "organizations" },
          keySpecs: [{ kind: "uuid" }],
        });
        const params: unknown[] = [user.id];
        let keyset = "";
        if (cursor) {
          const anchorId = cursor.k[0]!;
          const anchor = await db.query(
            `SELECT 1 FROM organization_memberships
              WHERE user_id = $1 AND organization_id = $2::uuid AND role = 'org_admin'`,
            [user.id, anchorId],
          );
          if (anchor.rowCount !== 1) {
            throw validationError("cursor is no longer valid; start again from the first page");
          }
          params.push(anchorId);
          keyset = `AND (o.name COLLATE "C", o.id) > (
            SELECT oa.name COLLATE "C", oa.id FROM organizations oa WHERE oa.id = $${params.length}::uuid)`;
        }
        params.push(limit + 1);
        const result = await db.query<{ id: string; name: string; slug: string; kind: string; status: string }>(
          `SELECT o.id, o.name, o.slug, o.kind, o.status
             FROM organizations o
             JOIN organization_memberships om
               ON om.organization_id = o.id AND om.user_id = $1 AND om.role = 'org_admin'
            WHERE true ${keyset}
            ORDER BY o.name COLLATE "C", o.id
            LIMIT $${params.length}`,
          params,
        );
        return pageFromKeysetRows(result.rows, { limit, sort, fingerprint, keysOf: (row) => [row.id] });
      },
      { acquireTimeoutMs: app.appConfig.poolAcquireTimeoutMs },
    );
  });

  /**
   * The org admins of ONE organisation the caller administers (S11). Name, the e-mail they sign in with, account status,
   * since when. No other contact field. Keyset on the membership's (created_at, id).
   */
  app.get("/v1/org/organizations/:organizationId/admins", async (request) => {
    const { organizationId } = request.params as { organizationId: string };
    assertUuid(organizationId, "organizationId");
    return withIdentityAccess(
      pool,
      async (db) => {
        const { user } = await requireSessionAuth(db, request);
        const authz = await buildAuthzContext(db, { userId: user.id, tenantId: null });
        await requirePermission(db, authz, "org.admins.read", { ip: clientIp(request) });
        await assertOrgAdminOfActiveOrg(db, request, { userId: user.id, organizationId, permission: "org.admins.read" });

        const query = request.query as Record<string, unknown>;
        const sort = "since";
        const { limit, cursor, fingerprint } = parseListQuery(query, {
          sort,
          filter: { scopeUserId: user.id, organizationId, list: "admins" },
          keySpecs: [{ kind: "timestamptz_micros" }, { kind: "uuid" }],
        });
        const params: unknown[] = [organizationId];
        let keyset = "";
        if (cursor) {
          params.push(cursor.k[0]!, cursor.k[1]!);
          keyset = `AND (om.created_at, om.id) > ($2::timestamptz, $3::uuid)`;
        }
        params.push(limit + 1);
        const result = await db.query<{
          membership_id: string;
          since: string;
          user_id: string;
          full_name: string;
          email: string | null;
          status: string;
        }>(
          `SELECT om.id AS membership_id,
                  to_char(om.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS since,
                  u.id AS user_id, u.full_name, u.email, u.status
             FROM organization_memberships om
             JOIN users u ON u.id = om.user_id
            WHERE om.organization_id = $1 AND om.role = 'org_admin'
            ${keyset}
            ORDER BY om.created_at, om.id
            LIMIT $${params.length}`,
          params,
        );
        const page = pageFromKeysetRows(result.rows, {
          limit,
          sort,
          fingerprint,
          keysOf: (row) => [row.since, row.membership_id],
        });
        return {
          organizationId,
          items: page.items.map((r) => ({
            userId: r.user_id,
            fullName: r.full_name,
            email: r.email,
            status: r.status,
            since: r.since,
            isYou: r.user_id === user.id,
          })),
          page: page.page,
        };
      },
      { acquireTimeoutMs: app.appConfig.poolAcquireTimeoutMs },
    );
  });

  /**
   * The caller's OWN audit events about ONE organisation they administer (S11): what they did in its schools, and the
   * delegation events that name it. Read through the definer org_my_audit_events (migration 105), which takes the actor
   * from the session's app.user_id and re-checks the organisation; security_audit_events has no SELECT grant.
   */
  app.get("/v1/org/organizations/:organizationId/audit-events", async (request) => {
    const { organizationId } = request.params as { organizationId: string };
    assertUuid(organizationId, "organizationId");
    const query = request.query as Record<string, unknown>;
    const checked = await withIdentityAccess(
      pool,
      async (db) => {
        const { user } = await requireSessionAuth(db, request);
        const authz = await buildAuthzContext(db, { userId: user.id, tenantId: null });
        await requirePermission(db, authz, "org.audit.read", { ip: clientIp(request) });
        await assertOrgAdminOfActiveOrg(db, request, { userId: user.id, organizationId, permission: "org.audit.read" });
        const parsed = parseListQuery(query, {
          sort: "occurred_at_desc",
          filter: { scopeUserId: user.id, organizationId, list: "audit" },
          keySpecs: [{ kind: "timestamptz_micros" }, { kind: "uuid" }],
        });
        return { userId: user.id, ...parsed };
      },
      { acquireTimeoutMs: app.appConfig.poolAcquireTimeoutMs },
    );
    const { userId, sort, limit, cursor, fingerprint } = checked;
    const rows = await withIdentityUserScope(
      pool,
      userId,
      async (db) =>
        (
          await db.query<{
            id: string;
            occurred_at_text: string;
            event_type: string;
            tenant_id: string | null;
            tenant_name: string | null;
            detail: Record<string, unknown>;
          }>(
            `SELECT id, occurred_at_text, event_type, tenant_id, tenant_name, detail
               FROM public.org_my_audit_events($1::uuid, $2::timestamptz, $3::uuid, $4::integer)`,
            [organizationId, cursor ? cursor.k[0]! : null, cursor ? cursor.k[1]! : null, limit + 1],
          )
        ).rows,
      { acquireTimeoutMs: app.appConfig.poolAcquireTimeoutMs },
    );
    const page = pageFromKeysetRows(rows, {
      limit,
      sort,
      fingerprint,
      keysOf: (row) => [row.occurred_at_text, row.id],
    });
    return {
      organizationId,
      items: page.items.map((r) => ({
        id: r.id,
        occurredAt: r.occurred_at_text,
        eventType: r.event_type,
        schoolId: r.tenant_id,
        schoolName: r.tenant_name,
        detail: r.detail,
      })),
      page: page.page,
    };
  });
}
