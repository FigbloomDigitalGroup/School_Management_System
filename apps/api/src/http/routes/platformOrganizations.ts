import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppPool } from "../../db/pool.js";
import type { IdentityDb } from "../../db/sql.js";
import { withIdentityAccess } from "../../db/identityAccess.js";
import { recordSecurityEvent } from "../../modules/audit/audit.js";
import { buildAuthzContext, requirePermission } from "../../modules/rbac/authorize.js";
import { clientIp } from "../clientIp.js";
import { notFound, validationError } from "../errors.js";
import { requireSessionAuth } from "../middleware/authContext.js";
import { pageFromKeysetRows, parseListQuery } from "../pagination.js";
import { uuidString } from "../schemas.js";

/**
 * Figbloom staff's organization directory (platform console, slice P3 of apps/api/docs/PLATFORM-CONSOLE.md).
 *
 * Read-only: organizations and their org_admin accounts on the identity path with NO tenant context (`tenantId: null`).
 * Authorization: `platform.organizations.read`, held only by `super_admin`. Permission checks run BEFORE any parameter
 * is validated so unauthorized callers learn nothing from a 400. Listing org admins exposes personal data (name, email)
 * and is audited as `platform.organization.admins_read`.
 */

const ORG_STATUSES = ["pending", "active", "suspended", "rejected"] as const;
const ORG_KINDS = ["government", "county", "constituency", "group_owner"] as const;
const LIST_SORT = "organization_name";
const ADMINS_SORT = "since";

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  kind: string;
  status: string;
  created_at: Date;
  school_count: number;
}

const SELECT_ORG = `SELECT o.id, o.name, o.slug, o.kind, o.status, o.created_at,
         (SELECT count(*)::int FROM tenants t WHERE t.organization_id = o.id) AS school_count
    FROM organizations o`;

function toOrg(r: OrgRow) {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    kind: r.kind,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    schoolCount: r.school_count,
  };
}

async function requireOrgReader(db: IdentityDb, request: FastifyRequest): Promise<string> {
  const { user } = await requireSessionAuth(db, request);
  const authz = await buildAuthzContext(db, { userId: user.id, tenantId: null });
  await requirePermission(db, authz, "platform.organizations.read", { ip: clientIp(request) });
  return user.id;
}

function parseOrgFilters(query: Record<string, unknown>): { status: string | null; kind: string | null } {
  const rawStatus = query.status;
  let status: string | null = null;
  if (rawStatus !== undefined && rawStatus !== "") {
    if (typeof rawStatus !== "string" || !(ORG_STATUSES as readonly string[]).includes(rawStatus)) {
      throw validationError("status is not an organization status", [
        { field: "status", code: "invalid_value", message: "Invalid value" },
      ]);
    }
    status = rawStatus;
  }
  const rawKind = query.kind;
  let kind: string | null = null;
  if (rawKind !== undefined && rawKind !== "") {
    if (typeof rawKind !== "string" || !(ORG_KINDS as readonly string[]).includes(rawKind)) {
      throw validationError("kind is not an organization kind", [
        { field: "kind", code: "invalid_value", message: "Invalid value" },
      ]);
    }
    kind = rawKind;
  }
  return { status, kind };
}

export async function registerPlatformOrganizationRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  const opts = () => ({ acquireTimeoutMs: app.appConfig.poolAcquireTimeoutMs });

  app.get("/v1/platform/organizations", async (request) =>
    withIdentityAccess(
      pool,
      async (db) => {
        await requireOrgReader(db, request);

        const query = request.query as Record<string, unknown>;
        const { status, kind } = parseOrgFilters(query);
        const { limit, cursor, fingerprint } = parseListQuery(query, {
          sort: LIST_SORT,
          filter: { scope: "platform_orgs", status, kind },
          keySpecs: [{ kind: "uuid" }],
        });

        const params: unknown[] = [status, kind];
        let keyset = "";
        if (cursor) {
          const anchorId = cursor.k[0]!;
          const anchor = await db.query(`SELECT 1 FROM organizations WHERE id = $1::uuid`, [anchorId]);
          if (anchor.rowCount !== 1) {
            throw validationError("cursor is no longer valid; start again from the first page");
          }
          params.push(anchorId);
          keyset = `AND (o.name COLLATE "C", o.id) > (
            SELECT oa.name COLLATE "C", oa.id FROM organizations oa WHERE oa.id = $${params.length}::uuid)`;
        }
        params.push(limit + 1);

        const result = await db.query<OrgRow>(
          `${SELECT_ORG}
            WHERE ($1::text IS NULL OR o.status = $1::text)
              AND ($2::text IS NULL OR o.kind = $2::text)
              ${keyset}
            ORDER BY o.name COLLATE "C", o.id
            LIMIT $${params.length}`,
          params,
        );

        return pageFromKeysetRows(result.rows.map(toOrg), {
          limit,
          sort: LIST_SORT,
          fingerprint,
          keysOf: (row) => [row.id],
        });
      },
      opts(),
    ),
  );

  app.get("/v1/platform/organizations/:organizationId", async (request) =>
    withIdentityAccess(
      pool,
      async (db) => {
        await requireOrgReader(db, request);
        const { organizationId } = request.params as { organizationId: string };
        if (!uuidString.safeParse(organizationId).success) throw validationError("organizationId must be a UUID");
        const result = await db.query<OrgRow>(`${SELECT_ORG} WHERE o.id = $1::uuid`, [organizationId]);
        const row = result.rows[0];
        if (!row) throw notFound("Organization not found");
        return toOrg(row);
      },
      opts(),
    ),
  );

  app.get("/v1/platform/organizations/:organizationId/admins", async (request) =>
    withIdentityAccess(
      pool,
      async (db) => {
        const actorUserId = await requireOrgReader(db, request);
        const { organizationId } = request.params as { organizationId: string };
        if (!uuidString.safeParse(organizationId).success) throw validationError("organizationId must be a UUID");

        const exists = await db.query(`SELECT 1 FROM organizations WHERE id = $1::uuid`, [organizationId]);
        if (exists.rowCount !== 1) throw notFound("Organization not found");

        const query = request.query as Record<string, unknown>;
        const { limit, cursor, fingerprint } = parseListQuery(query, {
          sort: ADMINS_SORT,
          filter: { scope: "platform_org_admins", organizationId },
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
            WHERE om.organization_id = $1::uuid AND om.role = 'org_admin'
            ${keyset}
            ORDER BY om.created_at, om.id
            LIMIT $${params.length}`,
          params,
        );

        const page = pageFromKeysetRows(result.rows, {
          limit,
          sort: ADMINS_SORT,
          fingerprint,
          keysOf: (row) => [row.since, row.membership_id],
        });

        await recordSecurityEvent(db, {
          eventType: "platform.organization.admins_read",
          actorUserId,
          tenantId: null,
          detail: { organizationId, count: page.items.length },
          ip: clientIp(request),
        });

        return {
          organizationId,
          items: page.items.map((r) => ({
            userId: r.user_id,
            fullName: r.full_name,
            email: r.email,
            status: r.status,
            since: r.since,
          })),
          page: page.page,
        };
      },
      opts(),
    ),
  );
}
