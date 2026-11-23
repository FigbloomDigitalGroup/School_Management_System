import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import { addMember, addPatron, createActivity, listActivities, listMembers } from "../../modules/activities/activities.js";
import { assertUuid, inTenant, pageFrom } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

const CreateBody = z.strictObject({
  name: z.string().min(1).max(120),
  category: z.enum(["sport", "club", "arts", "other"]),
  description: z.string().max(2000).optional(),
  meeting_schedule: z.string().max(300).optional(),
});

const PatronBody = z.strictObject({ teacher_user_id: z.guid() });
const MemberBody = z.strictObject({
  learner_id: z.guid(),
  role: z.string().min(1).max(60).nullable().optional(),
});

const P = "/v1/tenants/:tenantId/activities";

export async function registerActivitiesRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.post(P, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(CreateBody, request.body, "name and category are required");
    const activity = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.activity.write", { ip, deferAudit: true });
      return createActivity(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...body });
    });
    return reply.status(201).send({ activity });
  });

  app.get(P, async (request) => {
    const params = request.params as { tenantId: string };
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.activity.read", { ip, deferAudit: true });
      return listActivities(tx, params.tenantId, page.limit, page.rawCursor);
    });
  });

  app.post(`${P}/:activityId/patrons`, async (request, reply) => {
    const params = request.params as { tenantId: string; activityId: string };
    assertUuid(params.activityId, "activityId");
    const body = parseOrThrow(PatronBody, request.body, "teacher_user_id is required");
    await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.activity.write", { ip, deferAudit: true });
      await addPatron(tx, {
        tenantId: params.tenantId,
        activityId: params.activityId,
        teacherUserId: body.teacher_user_id,
        actorUserId: auth.user.id,
      });
    });
    return reply.status(204).send();
  });

  app.post(`${P}/:activityId/members`, async (request, reply) => {
    const params = request.params as { tenantId: string; activityId: string };
    assertUuid(params.activityId, "activityId");
    const body = parseOrThrow(MemberBody, request.body, "learner_id is required");
    await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.activity.write", { ip, deferAudit: true });
      await addMember(tx, {
        tenantId: params.tenantId,
        activityId: params.activityId,
        learnerId: body.learner_id,
        role: body.role,
        actorUserId: auth.user.id,
      });
    });
    return reply.status(204).send();
  });

  app.get(`${P}/:activityId/members`, async (request) => {
    const params = request.params as { tenantId: string; activityId: string };
    assertUuid(params.activityId, "activityId");
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.activity.read", { ip, deferAudit: true });
      return listMembers(tx, {
        tenantId: params.tenantId,
        activityId: params.activityId,
        limit: page.limit,
        rawCursor: page.rawCursor,
      });
    });
  });
}
