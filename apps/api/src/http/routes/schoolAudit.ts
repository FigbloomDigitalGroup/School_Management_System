import type { FastifyInstance } from "fastify";
import type { AppPool } from "../../db/pool.js";
import {
  SCHOOL_AUDIT_READ,
  parseAuditCategory,
  parseAuditSearch,
  parseAuditSince,
  readSchoolAuditRows,
  toSchoolAuditEvent,
} from "../../modules/audit/schoolAudit.js";
import { parsePage } from "../../modules/academics/pagination.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import { decodeCursor, pageFingerprint, pageFromKeysetRows } from "../pagination.js";
import { inTenant } from "../routeKit.js";

/**
 * The school's audit log (docs/SCHOOL-AUDIT.md): the business events of this school, newest first, for a full administrator and
 * for whoever holds the Audit area (`resource.audit.read`). The database function `school_audit_events` (migration 106) decides
 * which rows exist for the caller; this route authorises the request, parses the filters and pages the result.
 */
const SORT = "occurred_at_desc";

export async function registerSchoolAuditRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.get("/v1/tenants/:tenantId/audit-events", async (request) => {
    const params = request.params as { tenantId: string };
    const query = request.query as Record<string, unknown>;
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, SCHOOL_AUDIT_READ, { ip, deferAudit: true });
      const page = parsePage(query); // limit, and a refused `sort`
      const category = parseAuditCategory(query.category);
      const since = parseAuditSince(query.since);
      const search = parseAuditSearch(query.search);
      // The cursor is bound to the school and to every filter, so it cannot be replayed under another one.
      const fingerprint = pageFingerprint(SORT, { tenantId: params.tenantId, category: category ?? null, since: since ?? null, search: search ?? null });
      const cursor = decodeCursor(page.rawCursor, { sort: SORT, fingerprint, keySpecs: [{ kind: "timestamptz_micros" }, { kind: "uuid" }] });
      const rows = await readSchoolAuditRows(tx, {
        category,
        since,
        search,
        cursor: cursor ? { beforeAt: cursor.k[0]!, beforeId: cursor.k[1]! } : null,
        limit: page.limit + 1,
      });
      const out = pageFromKeysetRows(rows, { limit: page.limit, sort: SORT, fingerprint, keysOf: (r) => [r.occurred_at_text, r.id] });
      return { events: out.items.map(toSchoolAuditEvent), page: out.page };
    });
  });
}
