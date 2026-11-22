import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { withIdentityAccess, withIdentityUserScope } from "../../db/identityAccess.js";
import {
  assignUnmatched,
  escalateUnmatched,
  getUnmatched,
  listUnmatched,
  noteUnmatched,
  reopenUnmatched,
  resolveUnmatched,
  retryUnmatched,
} from "../../modules/finance/unmatchedCases.js";
import { assertRecentAuth } from "../../modules/auth/reauth.js";
import { buildAuthzContext, requirePermission } from "../../modules/rbac/authorize.js";
import { requireSessionAuth } from "../middleware/authContext.js";
import { assertUuid } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

/**
 * Platform operator workflow for provider callbacks that matched no payment (migration 074). Super administrators only
 * (enforced again inside every database function). Nothing here credits money, settles or fails a payment, or creates provider
 * evidence; resolution needs a disposition, a reason AND supporting evidence, and every mutation is audited.
 */
const ListQuery = z.strictObject({
  status: z.enum(["open", "resolved"]).optional(),
  owner: z.guid().optional(),
  unassigned: z.enum(["true", "false"]).optional(),
  min_age_minutes: z.coerce.number().int().min(0).max(525_600).optional(),
  severity: z.enum(["high", "normal"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const AssignBody = z.strictObject({ owner_user_id: z.guid().nullable() });
const NoteBody = z.strictObject({ note: z.string().min(3).max(1000) });
const EscalateBody = z.strictObject({ reason: z.string().min(3).max(500) });
const ResolveBody = z.strictObject({
  resolution: z.enum(["provider_confirmed_not_ours", "provider_confirmed_failed", "duplicate_of_settled", "other_evidenced"]),
  reason: z.string().min(10).max(500),
  evidence: z.string().min(10).max(1000),
});
const ReopenBody = z.strictObject({ reason: z.string().min(10).max(500) });

export const UNMATCHED_REQUEST_SCHEMAS = {
  "POST /v1/platform/finance/unmatched-callbacks/{caseId}/assign": AssignBody,
  "POST /v1/platform/finance/unmatched-callbacks/{caseId}/notes": NoteBody,
  "POST /v1/platform/finance/unmatched-callbacks/{caseId}/escalate": EscalateBody,
  "POST /v1/platform/finance/unmatched-callbacks/{caseId}/resolve": ResolveBody,
  "POST /v1/platform/finance/unmatched-callbacks/{caseId}/reopen": ReopenBody,
} as const;

export async function registerUnmatchedCallbackRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  const opts = () => ({ acquireTimeoutMs: app.appConfig.poolAcquireTimeoutMs });
  const asOperator = async <T>(request: Parameters<typeof requireSessionAuth>[1], fn: Parameters<typeof withIdentityUserScope<T>>[2], sensitive = false): Promise<T> => {
    const user = await withIdentityAccess(
      pool,
      async (db) => {
        const { user: u, session } = await requireSessionAuth(db, request);
        const authz = await buildAuthzContext(db, { userId: u.id, tenantId: null });
        await requirePermission(db, authz, "platform.finance.unmatched.manage");
        return Object.assign({}, u, { sessionId: session.id });
      },
      opts(),
    );
    return withIdentityUserScope(
      pool,
      user.id,
      async (db) => {
        if (sensitive) await assertRecentAuth(db, app.appConfig, user.sessionId);
        return fn(db);
      },
      opts(),
    );
  };
  const B = "/v1/platform/finance/unmatched-callbacks";

  app.get(B, async (request) => {
    const q = parseOrThrow(ListQuery, request.query ?? {}, "invalid filter");
    return asOperator(request, async (db) => ({
      cases: await listUnmatched(db, { status: q.status, owner: q.owner, unassigned: q.unassigned === "true", minAgeMinutes: q.min_age_minutes, severity: q.severity, limit: q.limit }),
    }));
  });
  app.get(`${B}/:caseId`, async (request) => {
    const { caseId } = request.params as { caseId: string };
    assertUuid(caseId, "caseId");
    return asOperator(request, (db) => getUnmatched(db, caseId));
  });
  app.post(`${B}/:caseId/assign`, async (request) => {
    const { caseId } = request.params as { caseId: string };
    assertUuid(caseId, "caseId");
    const body = parseOrThrow(AssignBody, request.body, "owner_user_id is required (or null)");
    return asOperator(request, async (db) => {
      await assignUnmatched(db, caseId, body.owner_user_id);
      return { assigned: true };
    });
  });
  app.post(`${B}/:caseId/notes`, async (request) => {
    const { caseId } = request.params as { caseId: string };
    assertUuid(caseId, "caseId");
    const body = parseOrThrow(NoteBody, request.body, "a note is required");
    return asOperator(request, async (db) => {
      await noteUnmatched(db, caseId, body.note);
      return { noted: true };
    });
  });
  app.post(`${B}/:caseId/retry`, async (request) => {
    const { caseId } = request.params as { caseId: string };
    assertUuid(caseId, "caseId");
    return asOperator(request, (db) => retryUnmatched(db, caseId));
  });
  app.post(`${B}/:caseId/escalate`, async (request) => {
    const { caseId } = request.params as { caseId: string };
    assertUuid(caseId, "caseId");
    const body = parseOrThrow(EscalateBody, request.body, "a reason is required");
    return asOperator(request, async (db) => {
      await escalateUnmatched(db, caseId, body.reason);
      return { escalated: true };
    });
  });
  app.post(`${B}/:caseId/resolve`, async (request) => {
    const { caseId } = request.params as { caseId: string };
    assertUuid(caseId, "caseId");
    const body = parseOrThrow(ResolveBody, request.body, "disposition, reason and evidence are required");
    return asOperator(request, async (db) => {
      await resolveUnmatched(db, caseId, body);
      return { resolved: true };
    }, true);
  });
  app.post(`${B}/:caseId/reopen`, async (request) => {
    const { caseId } = request.params as { caseId: string };
    assertUuid(caseId, "caseId");
    const body = parseOrThrow(ReopenBody, request.body, "a reason is required");
    return asOperator(request, async (db) => {
      await reopenUnmatched(db, caseId, body.reason);
      return { reopened: true };
    }, true);
  });
}
