import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import {
  addMarCorrection,
  createMedicationAuthorization,
  createMedicationSchedule,
  getLearnerHealthProfile,
  listLearnerMar,
  recordGuardianConsent,
  recordMedicationAdministration,
  reportMedicationIncident,
  reviewMedicationAuthorization,
  upsertLearnerHealthProfile,
} from "../../modules/health/medication.js";
import { calendarDateString } from "../schemas.js";
import { assertUuid, inTenant } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

const ProfileBody = z.strictObject({
  blood_group: z.enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"]).nullable().optional(),
  allergies: z.array(z.string().min(1).max(120)).max(50).optional(),
  chronic_conditions: z.array(z.string().min(1).max(120)).max(50).optional(),
  dietary_notes: z.string().max(1000).nullable().optional(),
  emergency_notes: z.string().max(1000).nullable().optional(),
});

const CreateAuthBody = z.strictObject({
  learner_id: z.guid(),
  medication_name: z.string().min(1).max(200),
  dosage_instruction: z.string().min(1).max(200),
  frequency_instruction: z.string().min(1).max(200),
  route: z.enum(["oral", "topical", "inhaled", "ophthalmic", "otic", "injection", "other"]).optional(),
  start_date: calendarDateString,
  end_date: calendarDateString,
  supporting_document_id: z.guid().nullable().optional(),
});

const ConsentBody = z.strictObject({
  decision: z.enum(["granted", "declined", "revoked"]),
  note: z.string().max(500).nullable().optional(),
});

const ReviewAuthBody = z.strictObject({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().max(500).nullable().optional(),
});

const CreateScheduleBody = z.strictObject({
  authorization_id: z.guid(),
  schedule_times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).min(1).max(12),
  window_minutes: z.number().int().min(5).max(180).optional(),
});

const RecordMarBody = z.strictObject({
  schedule_id: z.guid(),
  scheduled_for: z.string().datetime(),
  administered_at: z.string().datetime().nullable().optional(),
  outcome: z.enum(["administered", "missed", "delayed", "refused", "held", "exception"]),
  exception_reason: z.string().max(500).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

const CorrectMarBody = z.strictObject({
  corrected_outcome: z.enum(["administered", "missed", "delayed", "refused", "held", "exception"]),
  correction_reason: z.string().min(3).max(500),
});

const ReportIncidentBody = z.strictObject({
  learner_id: z.guid(),
  authorization_id: z.guid().nullable().optional(),
  mar_id: z.guid().nullable().optional(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  summary: z.string().min(3).max(1000),
});

export const MEDICATION_REQUEST_SCHEMAS = {
  "PUT /v1/tenants/{tenantId}/health/learners/{learnerId}/profile": ProfileBody,
  "POST /v1/tenants/{tenantId}/health/medications/authorizations": CreateAuthBody,
  "POST /v1/tenants/{tenantId}/health/medications/authorizations/{authorizationId}/consent": ConsentBody,
  "POST /v1/tenants/{tenantId}/health/medications/authorizations/{authorizationId}/review": ReviewAuthBody,
  "POST /v1/tenants/{tenantId}/health/medications/schedules": CreateScheduleBody,
  "POST /v1/tenants/{tenantId}/health/medications/administrations": RecordMarBody,
  "POST /v1/tenants/{tenantId}/health/medications/administrations/{marId}/corrections": CorrectMarBody,
  "POST /v1/tenants/{tenantId}/health/medications/incidents": ReportIncidentBody,
} as const;

const P = "/v1/tenants/:tenantId/health";

export async function registerMedicationRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.get(`${P}/learners/:learnerId/profile`, async (request) => {
    const params = request.params as { tenantId: string; learnerId: string };
    assertUuid(params.learnerId, "learnerId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.medication.read", { ip, deferAudit: true });
      const profile = await getLearnerHealthProfile(tx, params.tenantId, params.learnerId);
      return { profile };
    });
  });

  app.put(`${P}/learners/:learnerId/profile`, async (request) => {
    const params = request.params as { tenantId: string; learnerId: string };
    assertUuid(params.learnerId, "learnerId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.medication.write", { ip, deferAudit: true });
      const body = parseOrThrow(ProfileBody, request.body, "Invalid health profile payload");
      const profile = await upsertLearnerHealthProfile(tx, {
        tenantId: params.tenantId,
        learnerId: params.learnerId,
        actorUserId: auth.user.id,
        ...body,
        ip,
      });
      return { profile };
    });
  });

  app.post(`${P}/medications/authorizations`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const authorization = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.medication.write", { ip, deferAudit: true });
      const body = parseOrThrow(CreateAuthBody, request.body, "Invalid medication authorization payload");
      return createMedicationAuthorization(tx, {
        tenantId: params.tenantId,
        learnerId: body.learner_id,
        actorUserId: auth.user.id,
        medication_name: body.medication_name,
        dosage_instruction: body.dosage_instruction,
        frequency_instruction: body.frequency_instruction,
        route: body.route,
        start_date: body.start_date,
        end_date: body.end_date,
        supporting_document_id: body.supporting_document_id,
        ip,
      });
    });
    return reply.status(201).send({ authorization });
  });

  app.post(`${P}/medications/authorizations/:authorizationId/consent`, async (request) => {
    const params = request.params as { tenantId: string; authorizationId: string };
    assertUuid(params.authorizationId, "authorizationId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.medication.consent", { ip, deferAudit: true });
      const body = parseOrThrow(ConsentBody, request.body, "decision is required");
      const authorization = await recordGuardianConsent(tx, {
        tenantId: params.tenantId,
        authorizationId: params.authorizationId,
        guardianUserId: auth.user.id,
        decision: body.decision,
        note: body.note,
        ip,
      });
      return { authorization };
    });
  });

  app.post(`${P}/medications/authorizations/:authorizationId/review`, async (request) => {
    const params = request.params as { tenantId: string; authorizationId: string };
    assertUuid(params.authorizationId, "authorizationId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.medication.write", { ip, deferAudit: true });
      const body = parseOrThrow(ReviewAuthBody, request.body, "decision is required");
      const authorization = await reviewMedicationAuthorization(tx, {
        tenantId: params.tenantId,
        authorizationId: params.authorizationId,
        actorUserId: auth.user.id,
        decision: body.decision,
        reason: body.reason,
        ip,
      });
      return { authorization };
    });
  });

  app.post(`${P}/medications/schedules`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const schedule = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.medication.write", { ip, deferAudit: true });
      const body = parseOrThrow(CreateScheduleBody, request.body, "authorization_id and schedule_times are required");
      return createMedicationSchedule(tx, {
        tenantId: params.tenantId,
        authorizationId: body.authorization_id,
        actorUserId: auth.user.id,
        schedule_times: body.schedule_times,
        window_minutes: body.window_minutes,
        ip,
      });
    });
    return reply.status(201).send({ schedule });
  });

  app.post(`${P}/medications/administrations`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.medication.administer", { ip, deferAudit: true });
      const body = parseOrThrow(RecordMarBody, request.body, "schedule_id, scheduled_for and outcome are required");
      return recordMedicationAdministration(tx, {
        tenantId: params.tenantId,
        scheduleId: body.schedule_id,
        actorUserId: auth.user.id,
        scheduled_for: body.scheduled_for,
        administered_at: body.administered_at,
        outcome: body.outcome,
        exception_reason: body.exception_reason,
        notes: body.notes,
        ip,
      });
    });
    return reply.status(out.replayed ? 200 : 201).send({ record: out.record, replayed: out.replayed });
  });

  app.post(`${P}/medications/administrations/:marId/corrections`, async (request, reply) => {
    const params = request.params as { tenantId: string; marId: string };
    assertUuid(params.marId, "marId");
    const correction = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.medication.administer", { ip, deferAudit: true });
      const body = parseOrThrow(CorrectMarBody, request.body, "corrected_outcome and correction_reason are required");
      return addMarCorrection(tx, {
        tenantId: params.tenantId,
        marId: params.marId,
        actorUserId: auth.user.id,
        corrected_outcome: body.corrected_outcome,
        correction_reason: body.correction_reason,
        ip,
      });
    });
    return reply.status(201).send({ correction });
  });

  app.get(`${P}/learners/:learnerId/medications/mar`, async (request) => {
    const params = request.params as { tenantId: string; learnerId: string };
    assertUuid(params.learnerId, "learnerId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.medication.read", { ip, deferAudit: true });
      return listLearnerMar(tx, params.tenantId, params.learnerId);
    });
  });

  app.post(`${P}/medications/incidents`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const incident = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.medication.write", { ip, deferAudit: true });
      const body = parseOrThrow(ReportIncidentBody, request.body, "learner_id, severity and summary are required");
      return reportMedicationIncident(tx, {
        tenantId: params.tenantId,
        learnerId: body.learner_id,
        actorUserId: auth.user.id,
        authorization_id: body.authorization_id,
        mar_id: body.mar_id,
        severity: body.severity,
        summary: body.summary,
        ip,
      });
    });
    return reply.status(201).send({ incident });
  });
}
