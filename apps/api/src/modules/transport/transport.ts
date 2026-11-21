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
