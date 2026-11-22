import type { Tx } from "../../db/sql.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import type { PageInfo } from "../../http/pagination.js";
import { pageQuery, type PageInput } from "../academics/pagination.js";
import { recordSecurityEvent } from "../audit/audit.js";

export interface Vehicle {
  id: string;
  tenant_id: string;
  plate_number: string;
  make_model: string | null;
  capacity: number | null;
  active: boolean;
  created_at: string;
}

export interface TransportRoute {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  active: boolean;
  created_at: string;
}

export interface RouteStop {
  id: string;
  tenant_id: string;
  route_id: string;
  name: string;
  sequence: number;
  lat: number | null;
  lng: number | null;
}

export interface LearnerTransport {
  id: string;
  tenant_id: string;
  learner_id: string;
  route_id: string;
  stop_id: string | null;
}

const VEHICLE_COLS = `id, tenant_id, plate_number, make_model, capacity, active, created_at`;
const ROUTE_COLS = `id, tenant_id, name, description, active, created_at`;
const STOP_COLS = `id, tenant_id, route_id, name, sequence, lat, lng`;
const LT_COLS = `id, tenant_id, learner_id, route_id, stop_id`;

export async function createVehicle(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    plate_number: string;
    make_model?: string | null;
    capacity?: number | null;
  },
): Promise<Vehicle> {
  try {
    const res = await tx.query<Vehicle>(
      `INSERT INTO vehicles (tenant_id, plate_number, make_model, capacity, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING ${VEHICLE_COLS}`,
      [input.tenantId, input.plate_number.trim(), input.make_model ?? null, input.capacity ?? null, input.actorUserId],
    );
    await recordSecurityEvent(tx, {
      eventType: "transport.vehicle.created",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { vehicleId: res.rows[0]!.id },
    });
    return res.rows[0]!;
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "23505") throw conflict("A vehicle with this plate already exists");
    throw err;
  }
}

export async function listVehicles(
  tx: Tx,
  tenantId: string,
  limit: number,
  rawCursor?: unknown,
): Promise<{ vehicles: Vehicle[]; page: PageInfo }> {
  const page: PageInput = { limit, rawCursor };
  const inner = `SELECT ${VEHICLE_COLS} FROM vehicles WHERE tenant_id = $1 AND active = true`;
  const res = await pageQuery<Vehicle>(
    tx,
    inner,
    [tenantId],
    { name: "vehicles_active_plate_asc", expr: "q.plate_number", type: "text", dir: "asc" },
    page,
  );
  const vehicles = res.rows.map(({ page_key: _pk, ...rest }) => rest);
  return { vehicles, page: res.page };
}

export async function createRoute(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; name: string; description?: string },
): Promise<TransportRoute> {
  try {
    const res = await tx.query<TransportRoute>(
      `INSERT INTO transport_routes (tenant_id, name, description, created_by)
       VALUES ($1,$2,$3,$4) RETURNING ${ROUTE_COLS}`,
      [input.tenantId, input.name.trim(), input.description ?? "", input.actorUserId],
    );
    await recordSecurityEvent(tx, {
      eventType: "transport.route.created",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { routeId: res.rows[0]!.id },
    });
    return res.rows[0]!;
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "23505") throw conflict("A route with this name already exists");
    throw err;
  }
}

export async function listRoutes(
  tx: Tx,
  tenantId: string,
  limit: number,
  rawCursor?: unknown,
): Promise<{ routes: TransportRoute[]; page: PageInfo }> {
  const page: PageInput = { limit, rawCursor };
  const inner = `SELECT ${ROUTE_COLS} FROM transport_routes WHERE tenant_id = $1 AND active = true`;
  const res = await pageQuery<TransportRoute>(
    tx,
    inner,
    [tenantId],
    { name: "transport_routes_active_name_asc", expr: "q.name", type: "text", dir: "asc" },
    page,
  );
  const routes = res.rows.map(({ page_key: _pk, ...rest }) => rest);
  return { routes, page: res.page };
}

export async function addRouteStop(
  tx: Tx,
  input: {
    tenantId: string;
    routeId: string;
    name: string;
    sequence: number;
    lat?: number | null;
    lng?: number | null;
    actorUserId: string;
  },
): Promise<RouteStop> {
  if ((input.lat === null || input.lat === undefined) !== (input.lng === null || input.lng === undefined)) {
    throw validationError("lat and lng must both be provided or both be null");
  }
  const route = await tx.query(`SELECT 1 FROM transport_routes WHERE tenant_id = $1 AND id = $2 AND active = true`, [
    input.tenantId,
    input.routeId,
  ]);
  if (!route.rows[0]) throw notFound("Route not found");
  try {
    const res = await tx.query<RouteStop>(
      `INSERT INTO route_stops (tenant_id, route_id, name, sequence, lat, lng)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${STOP_COLS}`,
      [input.tenantId, input.routeId, input.name.trim(), input.sequence, input.lat ?? null, input.lng ?? null],
    );
    await recordSecurityEvent(tx, {
      eventType: "transport.stop.added",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { routeId: input.routeId, stopId: res.rows[0]!.id },
    });
    return res.rows[0]!;
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "23505") throw conflict("Stop sequence already used on this route");
    throw err;
  }
}

export async function assignDriver(
  tx: Tx,
  input: {
    tenantId: string;
    vehicleId: string;
    driverUserId: string;
    routeId?: string | null;
    actorUserId: string;
  },
): Promise<void> {
  const membership = await tx.query(
    `SELECT 1 FROM school_memberships WHERE tenant_id = $1 AND user_id = $2 AND archived_at IS NULL AND role = 'driver'`,
    [input.tenantId, input.driverUserId],
  );
  if (!membership.rows[0]) throw validationError("driver_user_id must be an active driver membership");
  // S13-08: Lock vehicle row FOR UPDATE so concurrent driver swaps serialize cleanly.
  const vehicle = await tx.query(`SELECT 1 FROM vehicles WHERE tenant_id = $1 AND id = $2 AND active = true FOR UPDATE`, [
    input.tenantId,
    input.vehicleId,
  ]);
  if (!vehicle.rows[0]) throw notFound("Vehicle not found");
  if (input.routeId) {
    const route = await tx.query(`SELECT 1 FROM transport_routes WHERE tenant_id = $1 AND id = $2 AND active = true`, [
      input.tenantId,
      input.routeId,
    ]);
    if (!route.rows[0]) throw notFound("Route not found");
  }
  try {
    await tx.query(
      `UPDATE vehicle_assignments SET active = false WHERE tenant_id = $1 AND vehicle_id = $2 AND active = true`,
      [input.tenantId, input.vehicleId],
    );
    await tx.query(
      `INSERT INTO vehicle_assignments (tenant_id, vehicle_id, driver_user_id, route_id, active)
       VALUES ($1,$2,$3,$4,true)`,
      [input.tenantId, input.vehicleId, input.driverUserId, input.routeId ?? null],
    );
    await recordSecurityEvent(tx, {
      eventType: "transport.assignment.created",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { vehicleId: input.vehicleId, driverUserId: input.driverUserId },
    });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "23505") throw conflict("Vehicle already has an active driver assignment");
    throw err;
  }
}

export async function assignLearnerTransport(
  tx: Tx,
  input: {
    tenantId: string;
    learnerId: string;
    routeId: string;
    stopId?: string | null;
    actorUserId: string;
  },
): Promise<LearnerTransport> {
  const learner = await tx.query(`SELECT 1 FROM learners WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL`, [
    input.tenantId,
    input.learnerId,
  ]);
  if (!learner.rows[0]) throw validationError("learner_id must be an active learner");
  const route = await tx.query(`SELECT 1 FROM transport_routes WHERE tenant_id = $1 AND id = $2 AND active = true FOR UPDATE`, [
    input.tenantId,
    input.routeId,
  ]);
  if (!route.rows[0]) throw notFound("Route not found");
  if (input.stopId) {
    const stop = await tx.query(
      `SELECT 1 FROM route_stops WHERE tenant_id = $1 AND id = $2 AND route_id = $3`,
      [input.tenantId, input.stopId, input.routeId],
    );
    if (!stop.rows[0]) throw validationError("stop_id must belong to the selected route");
  }

  // S13-09: Enforce vehicle capacity if an active vehicle with a capacity limit is assigned to this route.
  const capRes = await tx.query<{ capacity: number | null }>(
    `SELECT min(v.capacity)::int AS capacity
       FROM vehicle_assignments va
       JOIN vehicles v ON v.id = va.vehicle_id AND v.tenant_id = va.tenant_id
      WHERE va.tenant_id = $1 AND va.route_id = $2 AND va.active = true AND v.active = true AND v.capacity IS NOT NULL`,
    [input.tenantId, input.routeId],
  );
  const maxCapacity = capRes.rows[0]?.capacity ?? null;
  if (maxCapacity !== null) {
    const assignedCount = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM learner_transport
        WHERE tenant_id = $1 AND route_id = $2 AND learner_id <> $3`,
      [input.tenantId, input.routeId, input.learnerId],
    );
    if ((assignedCount.rows[0]?.n ?? 0) + 1 > maxCapacity) {
      throw conflict("Assigned vehicle capacity for this route has been reached");
    }
  }

  const res = await tx.query<LearnerTransport>(
    `INSERT INTO learner_transport (tenant_id, learner_id, route_id, stop_id)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (learner_id) DO UPDATE SET route_id = EXCLUDED.route_id, stop_id = EXCLUDED.stop_id
     RETURNING ${LT_COLS}`,
    [input.tenantId, input.learnerId, input.routeId, input.stopId ?? null],
  );
  await recordSecurityEvent(tx, {
    eventType: "transport.learner.assigned",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { learnerId: input.learnerId, routeId: input.routeId },
  });
  return res.rows[0]!;
}

export async function startTrip(
  tx: Tx,
  input: {
    tenantId: string;
    vehicleId: string;
    driverUserId: string;
    routeId?: string | null;
    direction?: "to_school" | "from_school";
    actorUserId: string;
  },
): Promise<{ id: string; status: string }> {
  const vehicle = await tx.query(`SELECT 1 FROM vehicles WHERE tenant_id = $1 AND id = $2 AND active = true`, [
    input.tenantId,
    input.vehicleId,
  ]);
  if (!vehicle.rows[0]) throw notFound("Vehicle not found");

  // S13-03 & S13-04: Validate driver has active driver membership in tenantId.
  const driverMembership = await tx.query(
    `SELECT 1 FROM school_memberships
      WHERE tenant_id = $1 AND user_id = $2 AND archived_at IS NULL AND role = 'driver'`,
    [input.tenantId, input.driverUserId],
  );
  if (!driverMembership.rows[0]) {
    throw validationError("driver_user_id must be an active driver in this school");
  }

  // S13-03: Validate driver has an active vehicle_assignment for this vehicle (and matching route if assigned).
  const assignment = await tx.query<{ route_id: string | null }>(
    `SELECT route_id FROM vehicle_assignments
      WHERE tenant_id = $1 AND vehicle_id = $2 AND driver_user_id = $3 AND active = true`,
    [input.tenantId, input.vehicleId, input.driverUserId],
  );
  if (!assignment.rows[0]) {
    throw validationError("driver_user_id is not actively assigned to this vehicle");
  }

  if (input.routeId) {
    const route = await tx.query(
      `SELECT 1 FROM transport_routes WHERE tenant_id = $1 AND id = $2 AND active = true`,
      [input.tenantId, input.routeId],
    );
    if (!route.rows[0]) throw notFound("Route not found");
  }

  try {
    const res = await tx.query<{ id: string; status: string }>(
      `INSERT INTO trips (tenant_id, vehicle_id, route_id, driver_user_id, direction, status)
       VALUES ($1,$2,$3,$4,$5,'active') RETURNING id, status`,
      [
        input.tenantId,
        input.vehicleId,
        input.routeId ?? null,
        input.driverUserId,
        input.direction ?? "to_school",
      ],
    );
    await recordSecurityEvent(tx, {
      eventType: "transport.trip.started",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { tripId: res.rows[0]!.id, vehicleId: input.vehicleId, driverUserId: input.driverUserId },
    });
    return res.rows[0]!;
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === "23505") {
      if (e.constraint === "trips_one_active_per_driver") {
        throw conflict("Driver already has an active trip");
      }
      throw conflict("Vehicle already has an active trip");
    }
    if (e.code === "23503") throw validationError("Invalid trip reference");
    throw err;
  }
}

export async function completeTrip(
  tx: Tx,
  input: { tenantId: string; tripId: string; actorUserId: string },
): Promise<void> {
  const res = await tx.query(
    `UPDATE trips SET status = 'completed', ended_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
    [input.tenantId, input.tripId],
  );
  if (res.rowCount === 0) throw notFound("Active trip not found");
  await recordSecurityEvent(tx, {
    eventType: "transport.trip.completed",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { tripId: input.tripId },
  });
}

export interface VehicleLocation {
  id: string;
  tenant_id: string;
  vehicle_id: string;
  trip_id: string | null;
  lat: number;
  lng: number;
  speed_kmh: number | null;
  heading: number | null;
  recorded_at: string;
  expires_at: string;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function recordVehicleLocation(
  tx: Tx,
  input: {
    tenantId: string;
    vehicleId: string;
    tripId?: string | null;
    lat: number;
    lng: number;
    speedKmh?: number | null;
    heading?: number | null;
    recordedAt?: string | null;
    actorUserId: string;
  },
): Promise<VehicleLocation> {
  if (!Number.isFinite(input.lat) || input.lat < -90 || input.lat > 90) {
    throw validationError("lat must be between -90 and 90");
  }
  if (!Number.isFinite(input.lng) || input.lng < -180 || input.lng > 180) {
    throw validationError("lng must be between -180 and 180");
  }
  if (input.speedKmh !== undefined && input.speedKmh !== null && (input.speedKmh < 0 || input.speedKmh > 250)) {
    throw validationError("speed_kmh must be between 0 and 250");
  }
  if (input.heading !== undefined && input.heading !== null && (input.heading < 0 || input.heading > 360)) {
    throw validationError("heading must be between 0 and 360");
  }
  const vehicle = await tx.query(`SELECT 1 FROM vehicles WHERE tenant_id = $1 AND id = $2 AND active = true`, [
    input.tenantId,
    input.vehicleId,
  ]);
  if (!vehicle.rows[0]) throw notFound("Vehicle not found");

  if (input.tripId) {
    const trip = await tx.query(
      `SELECT 1 FROM trips WHERE tenant_id = $1 AND id = $2 AND vehicle_id = $3 AND status = 'active'`,
      [input.tenantId, input.tripId, input.vehicleId],
    );
    if (!trip.rows[0]) throw validationError("trip_id must be an active trip for this vehicle");
  }

  const recordedAt = input.recordedAt ? new Date(input.recordedAt) : new Date();
  if (Number.isNaN(recordedAt.getTime())) throw validationError("Invalid recorded_at timestamp");
  if (recordedAt.getTime() > Date.now() + 5 * 60_000) {
    throw validationError("recorded_at cannot be more than 5 minutes in the future");
  }

  const prev = await tx.query<{ lat: number; lng: number; recorded_at: Date }>(
    `SELECT lat, lng, recorded_at FROM vehicle_locations
      WHERE tenant_id = $1 AND vehicle_id = $2
      ORDER BY recorded_at DESC, id DESC LIMIT 1`,
    [input.tenantId, input.vehicleId],
  );
  if (prev.rows[0]) {
    const dtHours = Math.abs(recordedAt.getTime() - prev.rows[0].recorded_at.getTime()) / 3_600_000;
    const distKm = haversineKm(prev.rows[0].lat, prev.rows[0].lng, input.lat, input.lng);
    if (dtHours > 0 && distKm / dtHours > 220) {
      throw validationError("Implausible GPS coordinate jump (exceeds 220 km/h)");
    }
    if (dtHours === 0 && distKm > 1) {
      throw validationError("Implausible GPS coordinate jump at identical timestamp");
    }
  }

  const res = await tx.query<{
    id: string;
    tenant_id: string;
    vehicle_id: string;
    trip_id: string | null;
    lat: number;
    lng: number;
    speed_kmh: number | null;
    heading: number | null;
    recorded_at: Date;
    expires_at: Date;
  }>(
    `INSERT INTO vehicle_locations
       (tenant_id, vehicle_id, trip_id, recorded_by, lat, lng, speed_kmh, heading, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, tenant_id, vehicle_id, trip_id, lat, lng, speed_kmh, heading, recorded_at, expires_at`,
    [
      input.tenantId,
      input.vehicleId,
      input.tripId ?? null,
      input.actorUserId,
      input.lat,
      input.lng,
      input.speedKmh ?? null,
      input.heading ?? null,
      recordedAt.toISOString(),
    ],
  );
  const row = res.rows[0]!;
  return {
    ...row,
    recorded_at: row.recorded_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
  };
}

export async function listVehicleLocations(
  tx: Tx,
  tenantId: string,
  vehicleId: string,
  limit: number,
  rawCursor: string | null,
) {
  const vehicle = await tx.query(`SELECT 1 FROM vehicles WHERE tenant_id = $1 AND id = $2`, [tenantId, vehicleId]);
  if (!vehicle.rows[0]) throw notFound("Vehicle not found");
  const out = await pageQuery<{
    id: string;
    tenant_id: string;
    vehicle_id: string;
    trip_id: string | null;
    lat: number;
    lng: number;
    speed_kmh: number | null;
    heading: number | null;
    recorded_at: Date;
    expires_at: Date;
  }>(
    tx,
    `SELECT id, tenant_id, vehicle_id, trip_id, lat, lng, speed_kmh, heading, recorded_at, expires_at
       FROM vehicle_locations
      WHERE tenant_id = $1 AND vehicle_id = $2`,
    [tenantId, vehicleId],
    { name: "vehicle_locations", expr: "q.recorded_at", type: "timestamptz", dir: "desc" },
    { limit, rawCursor },
  );
  return {
    locations: out.rows.map((r) => ({
      ...r,
      recorded_at: r.recorded_at.toISOString(),
      expires_at: r.expires_at.toISOString(),
    })),
    page: out.page,
  };
}
