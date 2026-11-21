import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import { applyLearnerCsvImport, previewLearnerCsvImport } from "../../modules/imports/learnersCsv.js";
import { inTenant } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

const PreviewBody = z.strictObject({
  csv: z.string().min(1).max(1_000_000),
});

const ApplyBody = z.strictObject({
  import_id: z.guid(),
});

/**
 * OA-2: Route-level Fastify bodyLimit for the 1,000,000-character CSV preview payload
 * wrapped in a JSON `{ "csv": "..." }` envelope (1.5 MiB), while the global app bodyLimit
 * remains 64 KiB for all other endpoints.
 */
export const IMPORT_PREVIEW_BODY_LIMIT = 1_572_864;

const P = "/v1/tenants/:tenantId/imports/learners";

export async function registerImportRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.post(`${P}/preview`, { bodyLimit: IMPORT_PREVIEW_BODY_LIMIT }, async (request) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(PreviewBody, request.body, "csv is required");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.import.write", { ip, deferAudit: true });
      return {
        preview: await previewLearnerCsvImport(tx, {
          tenantId: params.tenantId,
          actorUserId: auth.user.id,
          csv: body.csv,
          ip,
        }),
      };
    });
  });

  app.post(`${P}/apply`, async (request) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(ApplyBody, request.body, "import_id is required");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.import.write", { ip, deferAudit: true });
      return {
        result: await applyLearnerCsvImport(tx, {
          tenantId: params.tenantId,
          actorUserId: auth.user.id,
          importId: body.import_id,
          ip,
        }),
      };
    });
  });
}
