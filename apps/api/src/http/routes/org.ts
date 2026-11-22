import type { FastifyInstance } from "fastify";
import type { AppPool } from "../../db/pool.js";
import { withIdentityAccess } from "../../db/identityAccess.js";
import { buildAuthzContext, requirePermission } from "../../modules/rbac/authorize.js";
import { clientIp } from "../clientIp.js";
import { requireSessionAuth } from "../middleware/authContext.js";
import { pageFromKeysetRows, parseListQuery } from "../pagination.js";
import { validationError } from "../errors.js";

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
}
