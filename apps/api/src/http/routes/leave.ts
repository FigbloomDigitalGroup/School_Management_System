import type { FastifyInstance } from "fastify";
import { calendarDateString } from "../schemas.js";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { hasPermission, requirePermission } from "../../modules/rbac/authorize.js";
import {
  cancelLeaveRequest,
  listLeaveRequests,
  reviewLeaveRequest,
  submitLeaveRequest,
} from "../../modules/hr/leave.js";
import { assertUuid, inTenant, pageFrom } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

const SubmitBody = z.strictObject({
  start_on: calendarDateString,
  end_on: calendarDateString,
  reason: z.string().min(3).max(1000),
});

const ReviewBody = z.strictObject({
  status: z.enum(["approved", "declined"]),
  review_note: z.string().max(1000).nullable().optional(),
});

const P = "/v1/tenants/:tenantId/leave-requests";

export async function registerLeaveRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.post(P, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(SubmitBody, request.body, "start_on, end_on and reason are required");
    const leave_request = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth }) =>
      // S13-05: Only authenticated school staff members (not parent/student) may submit leave.
      submitLeaveRequest(tx, {
        tenantId: params.tenantId,
        staffUserId: auth.user.id,
        callerMembershipRole: auth.authz.membership?.role ?? null,
        isSuperAdmin: auth.authz.isSuperAdmin,
        startOn: body.start_on,
        endOn: body.end_on,
        reason: body.reason,
      }),
    );
    return reply.status(201).send({ leave_request });
  });

  app.get(P, async (request) => {
    const params = request.params as { tenantId: string };
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const canReadAll = await hasPermission(tx, auth.authz, "resource.leave.read");
      if (!canReadAll) {
        return listLeaveRequests(tx, {
          tenantId: params.tenantId,
          staffUserId: auth.user.id,
          limit: page.limit,
          rawCursor: page.rawCursor,
        });
      }
      await requirePermission(tx, auth.authz, "resource.leave.read", { ip, deferAudit: true });
      return listLeaveRequests(tx, {
        tenantId: params.tenantId,
        limit: page.limit,
        rawCursor: page.rawCursor,
      });
    });
  });

  app.post(`${P}/:leaveId/review`, async (request) => {
    const params = request.params as { tenantId: string; leaveId: string };
    assertUuid(params.leaveId, "leaveId");
    const body = parseOrThrow(ReviewBody, request.body, "status is required");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.leave.write", { ip, deferAudit: true });
      const leave_request = await reviewLeaveRequest(tx, {
        tenantId: params.tenantId,
        leaveId: params.leaveId,
        reviewerUserId: auth.user.id,
        status: body.status,
        reviewNote: body.review_note,
      });
      return { leave_request };
    });
  });

  app.post(`${P}/:leaveId/cancel`, async (request) => {
    const params = request.params as { tenantId: string; leaveId: string };
    assertUuid(params.leaveId, "leaveId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth }) => {
      const canWriteLeave = await hasPermission(tx, auth.authz, "resource.leave.write");
      const leave_request = await cancelLeaveRequest(tx, {
        tenantId: params.tenantId,
        leaveId: params.leaveId,
        actorUserId: auth.user.id,
        canWriteLeave,
      });
      return { leave_request };
    });
  });
}
