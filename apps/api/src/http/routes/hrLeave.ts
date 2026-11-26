import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { describeError, logError } from "../../log.js";
import { recordSecurityEvent } from "../../modules/audit/audit.js";
import {
  assertHrLeaveRateLimit,
  authorizeHrLeaveApprover,
  HR_LEAVE_DECISIONS,
  HrLeaveGateway,
  MAX_COMMENT,
  planDecide,
  resolveHrLeaveAccess,
} from "../../modules/hr/hrLeave.js";
import { inTenant } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

/**
 * Leave run by Figbloom HR, the approver's side (docs/HR-HANDOFF.md, slice L1): the API's port of hr_leave_access() and of the
 * Supabase `my-hr` routes `approvals` and `approval_decide`, under the prefix My HR uses. The school and the person come from
 * the verified session (the path's school must be the session's school); nothing in a body or header can name another.
 *
 * As My HR: (1) the rule, the switch and the rate limit in a short transaction committed before any network call; (2) HR, with
 * no database connection held; (3) for a decision, a second short transaction that writes the audit row (`hr.leave.decided`:
 * the application id and the decision, never the comment). Off unless HR_LEAVE_ENABLED and the platform settings are set.
 */
const P = "/v1/tenants/:tenantId/me/hr/leave";

/** approve / decline, and the comment (up to 1,000 characters; a decline needs one, HR says so). */
const DecideBody = z.strictObject({
  decision: z.enum(HR_LEAVE_DECISIONS),
  comment: z.string().max(MAX_COMMENT).nullable().optional(),
});

export const HR_LEAVE_REQUEST_SCHEMAS = {
  "POST /v1/tenants/{tenantId}/me/hr/leave/approvals/{applicationId}/decide": DecideBody,
} as const;

export async function registerHrLeaveRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  const hr = new HrLeaveGateway(app.appConfig);
  const tenantOf = (request: FastifyRequest) => (request.params as { tenantId: string }).tenantId;

  // hr_leave_access(): which leave the caller's school uses, and whether the caller gets "Leave to approve". Any member may ask.
  app.get(`${P}/access`, async (request) =>
    inTenant(app, pool, request, tenantOf(request), ({ tx, auth }) => resolveHrLeaveAccess(tx, { on: hr.on, auth })),
  );

  // my-hr {route: "approvals"}: the applications HR says wait on the caller's HR user.
  app.get(`${P}/approvals`, async (request) => {
    const who = await inTenant(app, pool, request, tenantOf(request), async ({ tx, auth, ip }) => {
      const caller = await authorizeHrLeaveApprover(tx, { on: hr.on, auth, ip });
      await assertHrLeaveRateLimit(tx, { userId: caller.person, tenantId: caller.school });
      return caller;
    });
    return hr.approvals(who, request.abortSignal);
  });

  // my-hr {route: "approval_decide"}: approve or decline one application, in HR, as the caller's HR user.
  app.post(`${P}/approvals/:applicationId/decide`, async (request) => {
    const step = await inTenant(app, pool, request, tenantOf(request), async ({ tx, auth, ip }) => {
      const caller = await authorizeHrLeaveApprover(tx, { on: hr.on, auth, ip });
      const body = parseOrThrow(DecideBody, request.body, "Approve or decline (decision), with a comment of up to 1,000 characters.");
      const plan = planDecide((request.params as { applicationId: string }).applicationId, body);
      await assertHrLeaveRateLimit(tx, { userId: caller.person, tenantId: caller.school });
      return { caller, plan };
    });
    const answer = await hr.decide(step.plan, step.caller, request.abortSignal);
    // HR has recorded the decision: it is audited here as well (Supabase did not). If the audit write fails the decision
    // still stands in HR, so the answer is given and the failure logged (never the comment, never anything HR sent).
    try {
      await inTenant(app, pool, request, tenantOf(request), async ({ tx, auth, ip }) =>
        recordSecurityEvent(tx, {
          eventType: "hr.leave.decided",
          actorUserId: auth.user.id,
          tenantId: step.caller.school,
          detail: { applicationId: step.plan.applicationId, decision: step.plan.decision },
          ip,
        }),
      );
    } catch (err) {
      logError("hr_leave_audit_failed", { tenant_id: step.caller.school, reason: "decide", ...describeError(err) });
    }
    return answer;
  });
}
