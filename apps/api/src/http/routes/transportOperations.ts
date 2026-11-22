import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import type { Tx } from "../../db/sql.js";
import { hasPermission, requirePermission } from "../../modules/rbac/authorize.js";
import {
  acknowledgeTransportIncident,
  API_TRIP_EVENT_TYPES,
  cancelTrip,
  escalateTransportIncident,
  finishTrip,
  getTripDetail,
  listTripIncidents,
  listTrips,
  markTransportNotificationRead,
  myTransport,
  myTransportNotifications,
  recordDriverLocation,
  recordTripEvent,
  resolveTransportIncident,
  startAssignedTrip,
  type TripActor,
} from "../../modules/transport/operations.js";
import { validationError } from "../errors.js";
import type { RequestAuth } from "../middleware/authContext.js";
import { assertUuid, inTenant, pageFrom } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

const DriverTripBody = z.strictObject({
  vehicle_id: z.guid(),
  direction: z.enum(["to_school", "from_school"]),
});

const DriverLocationBody = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  speed_kmh: z.number().min(0).max(250).nullable().optional(),
  heading: z.number().min(0).max(360).nullable().optional(),
  recorded_at: z.string().datetime().nullable().optional(),
});

const TripEventBody = z.strictObject({
  event_type: z.enum(API_TRIP_EVENT_TYPES),
  learner_id: z.guid().nullable().optional(),
  stop_id: z.guid().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

const TripCancelBody = z.strictObject({ reason: z.string().min(1).max(500) });
const TripFinishBody = z.strictObject({ acknowledge_open_learners: z.boolean().optional() });
const IncidentAckBody = z.strictObject({
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
});
const IncidentEscalateBody = z.strictObject({
  reason: z.string().min(3).max(500),
  severity: z.enum(["high", "critical"]).optional(),
  notify_guardians: z.boolean().optional(),
});
const IncidentResolveBody = z.strictObject({
  resolution_note: z.string().min(3).max(1000),
});

export const TRANSPORT_OPERATIONS_REQUEST_SCHEMAS = {
  "POST /v1/tenants/{tenantId}/driver/trips": DriverTripBody,
  "POST /v1/tenants/{tenantId}/trips/{tripId}/driver-location": DriverLocationBody,
  "POST /v1/tenants/{tenantId}/trips/{tripId}/events": TripEventBody,
  "POST /v1/tenants/{tenantId}/trips/{tripId}/cancel": TripCancelBody,
  "POST /v1/tenants/{tenantId}/trips/{tripId}/finish": TripFinishBody,
  "POST /v1/tenants/{tenantId}/trips/{tripId}/incidents/{incidentId}/acknowledge": IncidentAckBody,
  "POST /v1/tenants/{tenantId}/trips/{tripId}/incidents/{incidentId}/escalate": IncidentEscalateBody,
  "POST /v1/tenants/{tenantId}/trips/{tripId}/incidents/{incidentId}/resolve": IncidentResolveBody,
} as const;

const P = "/v1/tenants/:tenantId";

/** Admin (transport.write) acts on any trip; a driver (transport.drive) only on their own. */
async function tripActor(tx: Tx, auth: RequestAuth, ip: string | null): Promise<TripActor> {
  if (await hasPermission(tx, auth.authz, "resource.transport.write")) return { userId: auth.user.id, mode: "admin" };
  await requirePermission(tx, auth.authz, "resource.transport.drive", { ip, deferAudit: true });
  return { userId: auth.user.id, mode: "driver" };
}

export async function registerTransportOperationsRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.get(`${P}/driver/assignments`, async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.transport.drive", { ip, deferAudit: true });
      const a = await tx.query(
        `SELECT va.id, va.vehicle_id, v.plate_number, va.route_id, r.name AS route_name
           FROM vehicle_assignments va
           JOIN vehicles v ON v.id = va.vehicle_id AND v.tenant_id = va.tenant_id
           LEFT JOIN transport_routes r ON r.id = va.route_id AND r.tenant_id = va.tenant_id
          WHERE va.tenant_id = $1 AND va.driver_user_id = $2 AND va.active = true AND v.active = true`,
        [params.tenantId, auth.user.id],
      );
      const t = await tx.query(
        `SELECT id, vehicle_id, route_id, direction, status, started_at FROM trips
          WHERE tenant_id = $1 AND driver_user_id = $2 AND status = 'active'`,
        [params.tenantId, auth.user.id],
      );
      return { assignments: a.rows, active_trips: t.rows };
    });
  });

  app.post(`${P}/driver/trips`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(DriverTripBody, request.body, "vehicle_id and direction are required");
    const trip = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.transport.drive", { ip, deferAudit: true });
      // A driver can only ever start a trip as themselves.
      return startAssignedTrip(tx, {
        tenantId: params.tenantId,
        vehicleId: body.vehicle_id,
        driverUserId: auth.user.id,
        direction: body.direction,
        actorUserId: auth.user.id,
      });
    });
    return reply.status(201).send({ trip });
  });

  app.post(`${P}/trips/:tripId/driver-location`, async (request, reply) => {
    const params = request.params as { tenantId: string; tripId: string };
    assertUuid(params.tripId, "tripId");
    const body = parseOrThrow(DriverLocationBody, request.body, "lat and lng are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.transport.drive", { ip, deferAudit: true });
      return recordDriverLocation(tx, {
        tenantId: params.tenantId,
        tripId: params.tripId,
        driverUserId: auth.user.id,
        lat: body.lat,
        lng: body.lng,
        speedKmh: body.speed_kmh,
        heading: body.heading,
        recordedAt: body.recorded_at,
      });
    });
    return reply.status(out.replayed ? 200 : 201).send({ location: out.location, replayed: out.replayed });
  });

  app.post(`${P}/trips/:tripId/events`, async (request, reply) => {
    const params = request.params as { tenantId: string; tripId: string };
    assertUuid(params.tripId, "tripId");
    const body = parseOrThrow(TripEventBody, request.body, "event_type is required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const actor = await tripActor(tx, auth, ip);
      return recordTripEvent(tx, {
        tenantId: params.tenantId,
        tripId: params.tripId,
        actor,
        type: body.event_type,
        learnerId: body.learner_id,
        stopId: body.stop_id,
        note: body.note,
      });
    });
    return reply.status(out.replayed ? 200 : 201).send({ event: out.event, replayed: out.replayed });
  });

  app.post(`${P}/trips/:tripId/cancel`, async (request, reply) => {
    const params = request.params as { tenantId: string; tripId: string };
    assertUuid(params.tripId, "tripId");
    const body = parseOrThrow(TripCancelBody, request.body, "reason is required");
    await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const actor = await tripActor(tx, auth, ip);
      await cancelTrip(tx, { tenantId: params.tenantId, tripId: params.tripId, actor, reason: body.reason });
    });
    return reply.status(204).send();
  });

  app.post(`${P}/trips/:tripId/finish`, async (request, reply) => {
    const params = request.params as { tenantId: string; tripId: string };
    assertUuid(params.tripId, "tripId");
    const body = parseOrThrow(TripFinishBody, request.body ?? {}, "invalid body");
    await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const actor = await tripActor(tx, auth, ip);
      await finishTrip(tx, {
        tenantId: params.tenantId,
        tripId: params.tripId,
        actor,
        acknowledgeOpenLearners: body.acknowledge_open_learners,
      });
    });
    return reply.status(204).send();
  });

  app.get(`${P}/trips`, async (request) => {
    const params = request.params as { tenantId: string };
    const q = request.query as { status?: string; driver_user_id?: string };
    if (q.status !== undefined && !["active", "completed", "cancelled"].includes(q.status)) {
      throw validationError("status must be active, completed or cancelled");
    }
    if (q.driver_user_id !== undefined) assertUuid(q.driver_user_id, "driver_user_id");
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.transport.read", { ip, deferAudit: true });
      return listTrips(tx, params.tenantId, { status: q.status, driverUserId: q.driver_user_id }, page.limit, page.rawCursor);
    });
  });

  app.get(`${P}/trips/:tripId`, async (request) => {
    const params = request.params as { tenantId: string; tripId: string };
    assertUuid(params.tripId, "tripId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const admin = await hasPermission(tx, auth.authz, "resource.transport.read");
      if (!admin) await requirePermission(tx, auth.authz, "resource.transport.drive", { ip, deferAudit: true });
      return getTripDetail(tx, params.tenantId, params.tripId, { userId: auth.user.id, mode: admin ? "admin" : "driver" });
    });
  });

  app.get(`${P}/me/transport`, async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.transport.family_read", { ip, deferAudit: true });
      return { children: await myTransport(tx, params.tenantId) };
    });
  });

  app.get(`${P}/me/transport/notifications`, async (request) => {
    const params = request.params as { tenantId: string };
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.transport.family_read", { ip, deferAudit: true });
      return myTransportNotifications(tx, params.tenantId, auth.user.id, page.limit, page.rawCursor);
    });
  });

  app.post(`${P}/me/transport/notifications/:notificationId/read`, async (request) => {
    const params = request.params as { tenantId: string; notificationId: string };
    assertUuid(params.notificationId, "notificationId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.transport.family_read", { ip, deferAudit: true });
      const notification = await markTransportNotificationRead(tx, {
        tenantId: params.tenantId,
        userId: auth.user.id,
        notificationId: params.notificationId,
      });
      return { notification };
    });
  });

  app.get(`${P}/trips/:tripId/incidents`, async (request) => {
    const params = request.params as { tenantId: string; tripId: string };
    assertUuid(params.tripId, "tripId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const admin = await hasPermission(tx, auth.authz, "resource.transport.read");
      if (!admin) await requirePermission(tx, auth.authz, "resource.transport.drive", { ip, deferAudit: true });
      const incidents = await listTripIncidents(tx, params.tenantId, params.tripId, {
        userId: auth.user.id,
        mode: admin ? "admin" : "driver",
      });
      return { incidents };
    });
  });

  app.post(`${P}/trips/:tripId/incidents/:incidentId/acknowledge`, async (request) => {
    const params = request.params as { tenantId: string; tripId: string; incidentId: string };
    assertUuid(params.tripId, "tripId");
    assertUuid(params.incidentId, "incidentId");
    const body = parseOrThrow(IncidentAckBody, request.body ?? {}, "Invalid body");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.transport.write", { ip, deferAudit: true });
      const incident = await acknowledgeTransportIncident(tx, {
        tenantId: params.tenantId,
        tripId: params.tripId,
        incidentId: params.incidentId,
        actorUserId: auth.user.id,
        severity: body.severity,
        ip,
      });
      return { incident };
    });
  });

  app.post(`${P}/trips/:tripId/incidents/:incidentId/escalate`, async (request) => {
    const params = request.params as { tenantId: string; tripId: string; incidentId: string };
    assertUuid(params.tripId, "tripId");
    assertUuid(params.incidentId, "incidentId");
    const body = parseOrThrow(IncidentEscalateBody, request.body, "reason is required");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.transport.write", { ip, deferAudit: true });
      return escalateTransportIncident(tx, {
        tenantId: params.tenantId,
        tripId: params.tripId,
        incidentId: params.incidentId,
        actorUserId: auth.user.id,
        reason: body.reason,
        severity: body.severity,
        notifyGuardians: body.notify_guardians,
        ip,
      });
    });
  });

  app.post(`${P}/trips/:tripId/incidents/:incidentId/resolve`, async (request) => {
    const params = request.params as { tenantId: string; tripId: string; incidentId: string };
    assertUuid(params.tripId, "tripId");
    assertUuid(params.incidentId, "incidentId");
    const body = parseOrThrow(IncidentResolveBody, request.body, "resolution_note is required");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.transport.write", { ip, deferAudit: true });
      const incident = await resolveTransportIncident(tx, {
        tenantId: params.tenantId,
        tripId: params.tripId,
        incidentId: params.incidentId,
        actorUserId: auth.user.id,
        resolutionNote: body.resolution_note,
        ip,
      });
      return { incident };
    });
  });
}
