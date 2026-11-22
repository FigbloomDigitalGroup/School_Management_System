import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { recordSecurityEvent } from "../../modules/audit/audit.js";
import { hasPermission, requirePermission } from "../../modules/rbac/authorize.js";
import {
  advanceGateVisit,
  createGateVisit,
  getGateVisit,
  listGateVisits,
  projectGateVisitForCaller,
  type VisitEntryPoint,
  type VisitHostKind,
  type VisitStatus,
} from "../../modules/communications/visits.js";
import { notFound } from "../errors.js";
import { assertUuid, inTenant, pageFrom } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

const CreateBody = z.strictObject({
  visitor_name: z.string().min(1).max(120),
  visitor_phone: z.string().max(30).nullable().optional(),
  id_number: z.string().max(40).nullable().optional(),
  vehicle_plate: z.string().max(20).nullable().optional(),
  purpose: z.string().min(1).max(300),
  host_kind: z.enum(["office", "principal", "teacher", "learner"]),
  host_user_id: z.guid().nullable().optional(),
  learner_id: z.guid().nullable().optional(),
  entry_point: z.enum(["gate", "reception"]).default("gate"),
  note: z.string().max(500).nullable().optional(),
});

const AdvanceBody = z.strictObject({
  status: z.enum(["expected", "at_reception", "with_host", "left"]),
  note: z.string().max(500).nullable().optional(),
});

const P = "/v1/tenants/:tenantId/gate-visits";

export async function registerVisitRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.post(P, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(CreateBody, request.body, "visitor_name, purpose and host_kind are required");
    const visit = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.visitor.write", { ip, deferAudit: true });
      return createGateVisit(tx, {
        tenantId: params.tenantId,
        actorUserId: auth.user.id,
        visitor_name: body.visitor_name,
        visitor_phone: body.visitor_phone,
        id_number: body.id_number,
        vehicle_plate: body.vehicle_plate,
        purpose: body.purpose,
        host_kind: body.host_kind as VisitHostKind,
        host_user_id: body.host_user_id,
        learner_id: body.learner_id,
        entry_point: body.entry_point as VisitEntryPoint,
        note: body.note,
      });
    });
    return reply.status(201).send({ visit });
  });

  app.get(P, async (request) => {
    const params = request.params as { tenantId: string };
    const q = request.query as { open?: string; mine?: string };
    const page = pageFrom(request);
    const openOnly = q.open === "true" || q.open === "1";
    const mineOnly = q.mine === "true" || q.mine === "1";
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const canReadAll = await hasPermission(tx, auth.authz, "resource.visitor.read");
      // Desk/admin: full log (unless mine=1). Everyone else: only visits hosted by them, with visitor PII minimized (S12-03).
      const out = await listGateVisits(tx, {
        tenantId: params.tenantId,
        openOnly,
        hostUserId: canReadAll && !mineOnly ? null : auth.user.id,
        limit: page.limit,
        rawCursor: page.rawCursor,
        canReadAllVisitorPii: canReadAll,
      });
      await recordSecurityEvent(tx, {
        eventType: "communications.visit.list_viewed",
        actorUserId: auth.user.id,
        tenantId: params.tenantId,
        ip,
        detail: { count: out.visits.length, openOnly, mineOnly, fullPii: canReadAll },
      });
      return out;
    });
  });

  app.get(`${P}/:visitId`, async (request) => {
    const params = request.params as { tenantId: string; visitId: string };
    assertUuid(params.visitId, "visitId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const visit = await getGateVisit(tx, params.tenantId, params.visitId);
      if (!visit) throw notFound("Visit not found");
      const canReadAll = await hasPermission(tx, auth.authz, "resource.visitor.read");
      if (!canReadAll && visit.host_user_id !== auth.user.id) {
        await requirePermission(tx, auth.authz, "resource.visitor.read", { ip, deferAudit: true });
      }
      await recordSecurityEvent(tx, {
        eventType: "communications.visit.viewed",
        actorUserId: auth.user.id,
        tenantId: params.tenantId,
        ip,
        detail: { visitId: visit.id, fullPii: canReadAll },
      });
      return { visit: projectGateVisitForCaller(visit, canReadAll) };
    });
  });

  app.post(`${P}/:visitId/advance`, async (request) => {
    const params = request.params as { tenantId: string; visitId: string };
    assertUuid(params.visitId, "visitId");
    const body = parseOrThrow(AdvanceBody, request.body, "status is required");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.visitor.write", { ip, deferAudit: true });
      const visit = await advanceGateVisit(tx, {
        tenantId: params.tenantId,
        visitId: params.visitId,
        actorUserId: auth.user.id,
        status: body.status as VisitStatus,
        note: body.note,
      });
      return { visit };
    });
  });
}
