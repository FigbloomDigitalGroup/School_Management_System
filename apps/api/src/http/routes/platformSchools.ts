import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppPool } from "../../db/pool.js";
import type { IdentityDb } from "../../db/sql.js";
import { withIdentityAccess, withIdentityUserScope } from "../../db/identityAccess.js";
import { recordSecurityEvent } from "../../modules/audit/audit.js";
import { buildAuthzContext, requirePermission } from "../../modules/rbac/authorize.js";
import { clientIp } from "../clientIp.js";
import { requireSessionAuth } from "../middleware/authContext.js";
import { pageFromKeysetRows, parseListQuery } from "../pagination.js";
import { notFound, validationError } from "../errors.js";
import { uuidString } from "../schemas.js";

/**
 * Figbloom staff's school directory (platform console, slice P1 of apps/api/docs/PLATFORM-CONSOLE.md).
 *
 * Read-only, directory fields only: the `tenants` row and its organisation. Nothing from inside a school (no learners,
 * staff, profile, money or audit), so no school data crosses schools here. Both tables are identity tables (no RLS,
 * SELECT-only for figbloom_app), read on the identity path with NO tenant context.
 *
 * Authorization: `platform.tenants.read`, which only super_admin holds. The caller's school (session or X-Tenant-Id) is
 * ignored on purpose: buildAuthzContext gets `tenantId: null`, so a school user cannot reach this list by sending a
 * header, and a super admin gets the same answer wherever they are signed in. Authentication and the permission check run
 * BEFORE any query parameter is read, so a caller without the permission learns nothing from a 400.
 *
 * Paging: keyset on `(name COLLATE "C", id)`. The cursor carries only the last school's id (names have no length limit),
 * and the boundary is read from that row in the same statement, as GET /v1/org/schools does.
 *
 * "Request Figbloom HR" (docs/HR-HANDOFF.md, H1; migration 117): each school carries when it asked Figbloom for HR and the
 * id of the account that asked (`hrRequestedAt`, `hrRequestedBy`; null when it never asked), so Figbloom staff see the
 * requests, as the Supabase console does. An id only: no name or e-mail, so the list stays free of personal data.
 */

const TENANT_STATUSES = ["active", "trial", "onboarding", "overdue", "suspended", "setup_stalled"] as const;
const SORT = "school_name";

interface SchoolRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  timezone: string;
  created_at: Date;
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  organization_kind: string;
  organization_status: string;
  hr_requested_at: Date | null;
  hr_requested_by: string | null;
}

const SELECT_SCHOOL = `SELECT t.id, t.name, t.slug, t.status, t.timezone, t.created_at, t.hr_requested_at, t.hr_requested_by,
         o.id AS organization_id, o.name AS organization_name, o.slug AS organization_slug,
         o.kind AS organization_kind, o.status AS organization_status
    FROM tenants t
    JOIN organizations o ON o.id = t.organization_id`;

function toSchool(r: SchoolRow) {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    status: r.status,
    timezone: r.timezone,
    createdAt: r.created_at.toISOString(),
    organization: {
      id: r.organization_id,
      name: r.organization_name,
      slug: r.organization_slug,
      kind: r.organization_kind,
      status: r.organization_status,
    },
    hrRequestedAt: r.hr_requested_at ? r.hr_requested_at.toISOString() : null,
    hrRequestedBy: r.hr_requested_by,
  };
}

/** Session, then the platform permission (denials are audited inline on the identity path). */
async function requirePlatformReader(db: IdentityDb, request: FastifyRequest, permission = "platform.tenants.read"): Promise<string> {
  const { user } = await requireSessionAuth(db, request);
  const authz = await buildAuthzContext(db, { userId: user.id, tenantId: null });
  await requirePermission(db, authz, permission, { ip: clientIp(request) });
  return user.id;
}

function parseFilters(query: Record<string, unknown>): { status: string | null; organizationId: string | null } {
  const rawStatus = query.status;
  let status: string | null = null;
  if (rawStatus !== undefined && rawStatus !== "") {
    if (typeof rawStatus !== "string" || !(TENANT_STATUSES as readonly string[]).includes(rawStatus)) {
      throw validationError("status is not a school status", [
        { field: "status", code: "invalid_value", message: "Invalid value" },
      ]);
    }
    status = rawStatus;
  }
  const rawOrg = query.organizationId;
  let organizationId: string | null = null;
  if (rawOrg !== undefined && rawOrg !== "") {
    if (typeof rawOrg !== "string" || !uuidString.safeParse(rawOrg).success) {
      throw validationError("organizationId must be a UUID", [
        { field: "organizationId", code: "invalid_format", message: "Invalid format" },
      ]);
    }
    organizationId = rawOrg.toLowerCase();
  }
  return { status, organizationId };
}

export async function registerPlatformSchoolRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  const opts = () => ({ acquireTimeoutMs: app.appConfig.poolAcquireTimeoutMs });

  app.get("/v1/platform/schools", async (request) =>
    withIdentityAccess(
      pool,
      async (db) => {
        await requirePlatformReader(db, request);

        const query = request.query as Record<string, unknown>;
        const { status, organizationId } = parseFilters(query);
        const { limit, cursor, fingerprint } = parseListQuery(query, {
          sort: SORT,
          filter: { scope: "platform", status, organizationId },
          keySpecs: [{ kind: "uuid" }],
        });

        const params: unknown[] = [status, organizationId];
        let keyset = "";
        if (cursor) {
          const anchorId = cursor.k[0]!;
          const anchor = await db.query(`SELECT 1 FROM tenants WHERE id = $1::uuid`, [anchorId]);
          if (anchor.rowCount !== 1) {
            throw validationError("cursor is no longer valid; start again from the first page");
          }
          params.push(anchorId);
          keyset = `AND (t.name COLLATE "C", t.id) > (
            SELECT ta.name COLLATE "C", ta.id FROM tenants ta WHERE ta.id = $${params.length}::uuid)`;
        }
        params.push(limit + 1);

        const result = await db.query<SchoolRow>(
          `${SELECT_SCHOOL}
            WHERE ($1::text IS NULL OR t.status = $1::text)
              AND ($2::uuid IS NULL OR t.organization_id = $2::uuid)
              ${keyset}
            ORDER BY t.name COLLATE "C", t.id
            LIMIT $${params.length}`,
          params,
        );

        return pageFromKeysetRows(result.rows.map(toSchool), {
          limit,
          sort: SORT,
          fingerprint,
          keysOf: (row) => [row.id],
        });
      },
      opts(),
    ),
  );

  app.get("/v1/platform/schools/:schoolId", async (request) =>
    withIdentityAccess(
      pool,
      async (db) => {
        await requirePlatformReader(db, request);
        const { schoolId } = request.params as { schoolId: string };
        if (!uuidString.safeParse(schoolId).success) throw validationError("schoolId must be a UUID");
        const result = await db.query<SchoolRow>(`${SELECT_SCHOOL} WHERE t.id = $1::uuid`, [schoolId]);
        const row = result.rows[0];
        if (!row) throw notFound("School not found");
        return toSchool(row);
      },
      opts(),
    ),
  );

  /**
   * Active school administrators for one school (slice P3). Personal data (name, email), so the read is audited.
   */
  app.get("/v1/platform/schools/:schoolId/admins", async (request) => {
    const ip = clientIp(request);
    const { schoolId } = request.params as { schoolId: string };
    const sort = "since";

    // Who may read, the school and the paging, checked before anything is read.
    const { actorUserId, limit, cursor, fingerprint } = await withIdentityAccess(
      pool,
      async (db) => {
        const actor = await requirePlatformReader(db, request, "platform.tenants.admins.read");
        if (!uuidString.safeParse(schoolId).success) throw validationError("schoolId must be a UUID");

        const exists = await db.query(`SELECT 1 FROM tenants WHERE id = $1::uuid`, [schoolId]);
        if (exists.rowCount !== 1) throw notFound("School not found");

        const paging = parseListQuery(request.query as Record<string, unknown>, {
          sort,
          filter: { scope: "platform_school_admins", schoolId },
          keySpecs: [{ kind: "timestamptz_micros" }, { kind: "uuid" }],
        });
        return { actorUserId: actor, ...paging };
      },
      opts(),
    );

    // school_memberships is tenant-scoped (forced RLS) and this request carries no school, so a direct read sees no
    // rows. The rows come from platform_school_admins() (migration 114), which re-checks the super administrator from
    // the acting user that withIdentityUserScope sets.
    const rows = await withIdentityUserScope(
      pool,
      actorUserId,
      async (db) => {
        const res = await db.query<{
          membership_id: string;
          since: string;
          user_id: string;
          full_name: string;
          email: string | null;
          status: string;
        }>(
          `SELECT a.membership_id,
                  to_char(a.since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS since,
                  a.user_id, a.full_name, a.email, a.status
             FROM public.platform_school_admins($1::uuid, $2::timestamptz, $3::uuid, $4::integer) a
            ORDER BY a.since, a.membership_id`,
          [schoolId, cursor ? cursor.k[0]! : null, cursor ? cursor.k[1]! : null, limit + 1],
        );
        return res.rows;
      },
      opts(),
    );

    const page = pageFromKeysetRows(rows, {
      limit,
      sort,
      fingerprint,
      keysOf: (row) => [row.since, row.membership_id],
    });

    await withIdentityAccess(
      pool,
      async (db) => {
        await recordSecurityEvent(db, {
          eventType: "platform.school.admins_read",
          actorUserId,
          tenantId: schoolId,
          detail: { schoolId, count: page.items.length },
          ip,
        });
      },
      opts(),
    );

    return {
      schoolId,
      items: page.items.map((r) => ({
        userId: r.user_id,
        fullName: r.full_name,
        email: r.email,
        status: r.status,
        since: r.since,
      })),
      page: page.page,
    };
  });
}
