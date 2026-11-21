import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { recordSecurityEvent } from "../../modules/audit/audit.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import {
  createSickBayVisit,
  getMedicalSettings,
  getSickBayVisit,
  listSickBayBoard,
  putMedicalSettings,
  updateSickBayVisit,
  type VisitOutcome,
} from "../../modules/health/sickBay.js";
import { notFound } from "../errors.js";
import { assertUuid, inTenant, pageFrom } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

const SettingsBody = z.strictObject({
  notify_guardians: z.enum(["all", "serious"]),
});

const CreateBody = z.strictObject({
  learner_id: z.guid(),
  complaint: z.string().min(1).max(300),
  temperature_c: z.number().min(30).max(45).nullable().optional(),
  pulse_bpm: z.number().int().min(20).max(250).nullable().optional(),
  observations: z.string().max(2000).nullable().optional(),
  assessment: z.string().max(2000).nullable().optional(),
  treatment: z.string().max(2000).nullable().optional(),
});

const PatchBody = z.strictObject({
  row_version: z.number().int().min(1).optional(),
  correction_reason: z.string().min(3).max(500).nullable().optional(),
  complaint: z.string().min(1).max(300).optional(),
  temperature_c: z.number().min(30).max(45).nullable().optional(),
  pulse_bpm: z.number().int().min(20).max(250).nullable().optional(),
  observations: z.string().max(2000).nullable().optional(),
  assessment: z.string().max(2000).nullable().optional(),
  treatment: z.string().max(2000).nullable().optional(),
  outcome: z.enum(["class", "rest", "home", "hospital", "admitted"]).nullable().optional(),
  referred_to: z.string().max(200).nullable().optional(),
  time_out: z.string().datetime().nullable().optional(),
  follow_up: z.string().max(2000).nullable().optional(),
});

const P = "/v1/tenants/:tenantId/health";

export async function registerSchoolHealthRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.get(`${P}/medical-settings`, async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.medical.read", { ip, deferAudit: true });
      return { settings: await getMedicalSettings(tx, params.tenantId) };
    });
  });

  app.put(`${P}/medical-settings`, async (request) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(SettingsBody, request.body, "notify_guardians is required");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.medical.write", { ip, deferAudit: true });
      const settings = await putMedicalSettings(tx, {
        tenantId: params.tenantId,
        actorUserId: auth.user.id,
        notify_guardians: body.notify_guardians,
        ip,
      });
      return { settings };
    });
  });

  app.post(`${P}/sick-bay/visits`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(CreateBody, request.body, "learner_id and complaint are required");
    const visit = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.medical.write", { ip, deferAudit: true });
      return createSickBayVisit(tx, {
        tenantId: params.tenantId,
        actorUserId: auth.user.id,
        ...body,
      });
    });
    return reply.status(201).send({ visit });
  });

  app.get(`${P}/sick-bay/board`, async (request) => {
    const params = request.params as { tenantId: string };
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.medical.read", { ip, deferAudit: true });
      const out = await listSickBayBoard(tx, params.tenantId, page.limit, page.rawCursor);
      await recordSecurityEvent(tx, {
        eventType: "health.sick_bay.board_viewed",
        actorUserId: auth.user.id,
        tenantId: params.tenantId,
        ip,
        detail: { count: out.visits.length },
      });
      return out;
    });
  });

  app.get(`${P}/sick-bay/visits/:visitId`, async (request) => {
    const params = request.params as { tenantId: string; visitId: string };
    assertUuid(params.visitId, "visitId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.medical.read", { ip, deferAudit: true });
      const visit = await getSickBayVisit(tx, params.tenantId, params.visitId);
      if (!visit) throw notFound("Sick bay visit not found");
      await recordSecurityEvent(tx, {
        eventType: "health.sick_bay.visit_viewed",
        actorUserId: auth.user.id,
        tenantId: params.tenantId,
        ip,
        detail: { visitId: visit.id, learnerId: visit.learner_id },
      });
      return { visit };
    });
  });

  app.patch(`${P}/sick-bay/visits/:visitId`, async (request) => {
    const params = request.params as { tenantId: string; visitId: string };
    assertUuid(params.visitId, "visitId");
    const body = parseOrThrow(PatchBody, request.body, "at least one field is required");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.medical.write", { ip, deferAudit: true });
      const visit = await updateSickBayVisit(tx, {
        tenantId: params.tenantId,
        visitId: params.visitId,
        actorUserId: auth.user.id,
        ip,
        ...body,
        outcome: body.outcome as VisitOutcome | null | undefined,
      });
      return { visit };
    });
  });
}
