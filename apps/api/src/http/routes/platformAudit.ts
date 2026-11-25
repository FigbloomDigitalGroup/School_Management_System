import type { FastifyInstance } from "fastify";
import type { AppPool } from "../../db/pool.js";
import { withIdentityAccess, withIdentityUserScope } from "../../db/identityAccess.js";
import { recordSecurityEvent } from "../../modules/audit/audit.js";
import { buildAuthzContext, requirePermission } from "../../modules/rbac/authorize.js";
import { clientIp } from "../clientIp.js";
import { validationError } from "../errors.js";
import { requireSessionAuth } from "../middleware/authContext.js";
import { pageFromKeysetRows, parseListQuery } from "../pagination.js";
import { uuidString } from "../schemas.js";

/**
 * Platform-wide audit trail read (slice P5 of apps/api/docs/PLATFORM-CONSOLE.md).
 *
 * Reads `security_audit_events` through `public.platform_audit_events(...)` (migration 113): never returns `ip` or
 * `detail`, keyset-paginated newest first on `(occurred_at, id)`. Super administrators only (`platform.audit.read`),
 * ignoring `X-Tenant-Id`. Reading the platform audit log is itself audited (`platform.audit.read`).
 */

const SORT = "occurred_at_desc";
const EVENT_PREFIX_RE = /^[a-z0-9._-]{1,80}$/;

interface PlatformAuditRow {
  id: string;
  occurred_at_text: string;
  event_type: string;
  tenant_id: string | null;
  tenant_name: string | null;
  actor_user_id: string | null;
  actor_name: string | null;
}

function parseFilters(query: Record<string, unknown>): {
  schoolId: string | null;
  eventPrefix: string | null;
  since: string | null;
} {
  let schoolId: string | null = null;
  if (query.schoolId !== undefined && query.schoolId !== "") {
    if (typeof query.schoolId !== "string" || !uuidString.safeParse(query.schoolId).success) {
      throw validationError("schoolId must be a UUID", [
        { field: "schoolId", code: "invalid_format", message: "Invalid format" },
      ]);
    }
    schoolId = query.schoolId.toLowerCase();
  }

  let eventPrefix: string | null = null;
  if (query.eventPrefix !== undefined && query.eventPrefix !== "") {
    if (typeof query.eventPrefix !== "string" || !EVENT_PREFIX_RE.test(query.eventPrefix)) {
      throw validationError("eventPrefix must be a lowercase event prefix", [
        { field: "eventPrefix", code: "invalid_format", message: "Invalid format" },
      ]);
    }
    eventPrefix = query.eventPrefix;
  }

  let since: string | null = null;
  if (query.since !== undefined && query.since !== "") {
    if (typeof query.since !== "string" || !Number.isFinite(Date.parse(query.since))) {
      throw validationError("since must be an ISO-8601 timestamp", [
        { field: "since", code: "invalid_format", message: "Invalid format" },
      ]);
    }
    since = new Date(query.since).toISOString();
  }

  return { schoolId, eventPrefix, since };
}

export async function registerPlatformAuditRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  const opts = () => ({ acquireTimeoutMs: app.appConfig.poolAcquireTimeoutMs });

  app.get("/v1/platform/audit-events", async (request) => {
    const ip = clientIp(request);
    const actorUserId = await withIdentityAccess(
      pool,
      async (db) => {
        const { user } = await requireSessionAuth(db, request);
        const authz = await buildAuthzContext(db, { userId: user.id, tenantId: null });
        await requirePermission(db, authz, "platform.audit.read", { ip });
        return user.id;
      },
      opts(),
    );

    const query = request.query as Record<string, unknown>;
    const { schoolId, eventPrefix, since } = parseFilters(query);
    const { limit, cursor, fingerprint } = parseListQuery(query, {
      sort: SORT,
      filter: { scope: "platform_audit", schoolId, eventPrefix, since },
      keySpecs: [{ kind: "timestamptz_micros" }, { kind: "uuid" }],
    });

    const rows = await withIdentityUserScope(
      pool,
      actorUserId,
      async (db) => {
        const res = await db.query<PlatformAuditRow>(
          `SELECT * FROM public.platform_audit_events($1::uuid, $2::text, $3::timestamptz, $4::timestamptz, $5::uuid, $6::integer)`,
          [schoolId, eventPrefix, since, cursor ? cursor.k[0]! : null, cursor ? cursor.k[1]! : null, limit + 1],
        );
        return res.rows;
      },
      opts(),
    );

    const paged = pageFromKeysetRows(rows, {
      limit,
      sort: SORT,
      fingerprint,
      keysOf: (r) => [r.occurred_at_text, r.id],
    });

    await withIdentityAccess(
      pool,
      async (db) => {
        await recordSecurityEvent(db, {
          eventType: "platform.audit.read",
          actorUserId,
          tenantId: schoolId,
          detail: { schoolId, eventPrefix, count: paged.items.length },
          ip,
        });
      },
      opts(),
    );

    return {
      items: paged.items.map((r) => ({
        id: r.id,
        occurredAt: r.occurred_at_text,
        eventType: r.event_type,
        schoolId: r.tenant_id,
        schoolName: r.tenant_name,
        actorUserId: r.actor_user_id,
        actorName: r.actor_name,
      })),
      page: paged.page,
    };
  });
}
