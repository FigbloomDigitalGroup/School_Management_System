import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import {
  addRouteStop,
  assignDriver,
  assignLearnerTransport,

  createRoute,
  createVehicle,
  listRoutes,
  listVehicleLocations,
  listVehicles,
  recordVehicleLocation,
  startTrip,
} from "../../modules/transport/transport.js";
import { finishTrip, recordTripStarted } from "../../modules/transport/operations.js";
import { assertUuid, inTenant, pageFrom } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

const VehicleBody = z.strictObject({
  plate_number: z.string().min(1).max(40),
  make_model: z.string().max(120).nullable().optional(),
  capacity: z.number().int().positive().nullable().optional(),
});

const RouteBody = z.strictObject({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
});

const StopBody = z.strictObject({
  name: z.string().min(1).max(120),
  sequence: z.number().int().min(1),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
});

const AssignmentBody = z.strictObject({
  driver_user_id: z.guid(),
  route_id: z.guid().nullable().optional(),
});

const LearnerTransportBody = z.strictObject({
  learner_id: z.guid(),
  route_id: z.guid(),
  stop_id: z.guid().nullable().optional(),
});

const TripStartBody = z.strictObject({
  vehicle_id: z.guid(),
  driver_user_id: z.guid(),
  route_id: z.guid().nullable().optional(),
  direction: z.enum(["to_school", "from_school"]).optional(),
});

const LocationBody = z.strictObject({
  trip_id: z.guid().nullable().optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  speed_kmh: z.number().min(0).max(250).nullable().optional(),
  heading: z.number().min(0).max(360).nullable().optional(),
  recorded_at: z.string().datetime().nullable().optional(),
});

const P = "/v1/tenants/:tenantId";

export async function registerTransportRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.post(`${P}/vehicles`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(VehicleBody, request.body, "plate_number is required");
    const vehicle = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.transport.write", { ip, deferAudit: true });
      return createVehicle(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...body });
    });
    return reply.status(201).send({ vehicle });
  });

  app.get(`${P}/vehicles`, async (request) => {
    const params = request.params as { tenantId: string };
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.transport.read", { ip, deferAudit: true });
      return listVehicles(tx, params.tenantId, page.limit, page.rawCursor);
    });
  });

  app.post(`${P}/transport-routes`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(RouteBody, request.body, "name is required");
    const route = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.transport.write", { ip, deferAudit: true });
      return createRoute(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...body });
    });
    return reply.status(201).send({ route });
  });

  app.get(`${P}/transport-routes`, async (request) => {
    const params = request.params as { tenantId: string };
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.transport.read", { ip, deferAudit: true });
      return listRoutes(tx, params.tenantId, page.limit, page.rawCursor);
    });
  });

  app.post(`${P}/transport-routes/:routeId/stops`, async (request, reply) => {
    const params = request.params as { tenantId: string; routeId: string };
    assertUuid(params.routeId, "routeId");
    const body = parseOrThrow(StopBody, request.body, "name and sequence are required");
    const stop = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.transport.write", { ip, deferAudit: true });
      return addRouteStop(tx, {
        tenantId: params.tenantId,
        routeId: params.routeId,
        actorUserId: auth.user.id,
        ...body,
      });
    });
    return reply.status(201).send({ stop });
  });

  app.post(`${P}/vehicles/:vehicleId/assignments`, async (request, reply) => {
    const params = request.params as { tenantId: string; vehicleId: string };
    assertUuid(params.vehicleId, "vehicleId");
    const body = parseOrThrow(AssignmentBody, request.body, "driver_user_id is required");
    await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.transport.write", { ip, deferAudit: true });
      await assignDriver(tx, {
        tenantId: params.tenantId,
        vehicleId: params.vehicleId,
        driverUserId: body.driver_user_id,
        routeId: body.route_id,
        actorUserId: auth.user.id,
      });
    });
    return reply.status(204).send();
  });

  app.put(`${P}/learner-transport`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(LearnerTransportBody, request.body, "learner_id and route_id are required");
    const assignment = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.transport.write", { ip, deferAudit: true });
      return assignLearnerTransport(tx, {
        tenantId: params.tenantId,
        learnerId: body.learner_id,
        routeId: body.route_id,
        stopId: body.stop_id,
        actorUserId: auth.user.id,
      });
    });
    return reply.status(200).send({ assignment });
  });

  app.post(`${P}/trips`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(TripStartBody, request.body, "vehicle_id and driver_user_id are required");
    const trip = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.transport.write", { ip, deferAudit: true });
      const started = await startTrip(tx, {
        tenantId: params.tenantId,
        vehicleId: body.vehicle_id,
        driverUserId: body.driver_user_id,
        routeId: body.route_id,
        direction: body.direction,
        actorUserId: auth.user.id,
      });
      await recordTripStarted(tx, params.tenantId, started.id, auth.user.id);
      return started;
    });
    return reply.status(201).send({ trip });
  });

  app.post(`${P}/trips/:tripId/complete`, async (request, reply) => {
    const params = request.params as { tenantId: string; tripId: string };
    assertUuid(params.tripId, "tripId");
    await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.transport.write", { ip, deferAudit: true });
      await finishTrip(tx, { tenantId: params.tenantId, tripId: params.tripId, actor: { userId: auth.user.id, mode: "admin" } });
    });
    return reply.status(204).send();
  });

  app.post(`${P}/vehicles/:vehicleId/locations`, async (request, reply) => {
    const params = request.params as { tenantId: string; vehicleId: string };
    assertUuid(params.vehicleId, "vehicleId");
    const body = parseOrThrow(LocationBody, request.body, "lat and lng are required");
    const location = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.transport.write", { ip, deferAudit: true });
      return recordVehicleLocation(tx, {
        tenantId: params.tenantId,
        vehicleId: params.vehicleId,
        tripId: body.trip_id,
        lat: body.lat,
        lng: body.lng,
        speedKmh: body.speed_kmh,
        heading: body.heading,
        recordedAt: body.recorded_at,
        actorUserId: auth.user.id,
      });
    });
    return reply.status(201).send({ location });
  });

  app.get(`${P}/vehicles/:vehicleId/locations`, async (request) => {
    const params = request.params as { tenantId: string; vehicleId: string };
    assertUuid(params.vehicleId, "vehicleId");
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.transport.read", { ip, deferAudit: true });
      return listVehicleLocations(tx, params.tenantId, params.vehicleId, page.limit, page.rawCursor ? String(page.rawCursor) : null);
    });
  });
}
