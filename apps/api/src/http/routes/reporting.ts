import type { FastifyInstance } from "fastify";
import { calendarDateString } from "../schemas.js";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import { attendanceDaily, financeSummary, schoolOverview } from "../../modules/reporting/overview.js";
import { inTenant, optionalUuid } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";
import { validationError } from "../errors.js";

const DateQuery = z.strictObject({
  date: calendarDateString,
});

const P = "/v1/tenants/:tenantId/reports";

export async function registerReportingRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.get(`${P}/overview`, async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.report.overview.read", { ip, deferAudit: true });
      return { overview: await schoolOverview(tx, params.tenantId) };
    });
  });

  app.get(`${P}/attendance-daily`, async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.report.attendance.read", { ip, deferAudit: true });
      const query = parseOrThrow(DateQuery, request.query, "date (YYYY-MM-DD) is required");
      return { report: await attendanceDaily(tx, params.tenantId, query.date) };
    });
  });

  app.get(`${P}/finance-summary`, async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      // S14-1: Separate finance summary permission (resource.finance.read) from general resource.report.read.
      await requirePermission(tx, auth.authz, "resource.finance.read", { ip, deferAudit: true });
      const q = request.query as { termId?: string };
      let termId: string | undefined;
      try {
        termId = optionalUuid(q.termId, "termId");
      } catch {
        throw validationError("termId must be a UUID");
      }
      return { summary: await financeSummary(tx, params.tenantId, termId) };
    });
  });
}
