import type { Tx } from "../../db/sql.js";
import { conflict, forbidden, notFound, validationError } from "../../http/errors.js";
import type { PageInfo } from "../../http/pagination.js";
import { pageQuery } from "../academics/pagination.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { enqueueNotificationEvent } from "../notifications/service.js";
import { recordVehicleLocation, startTrip, type VehicleLocation } from "./transport.js";

/** A guardian only ever sees a coordinate that is at most this old; anything older is reported as stale. */
export const LIVE_LOCATION_MAX_AGE_SECONDS = 120;
/** A driver cannot submit a fix older than this (stops replay of an old capture). */
export const DRIVER_FIX_MAX_AGE_SECONDS = 600;

export const API_TRIP_EVENT_TYPES = [
  "stop_arrived",
  "learner_boarded",
  "learner_alighted",
  "learner_not_boarded",
  "school_arrived",
  "delayed",
  "incident",
] as const;
export type ApiTripEventType = (typeof API_TRIP_EVENT_TYPES)[number];

const NOTIFYING_EVENTS = new Set([
  "trip_started",
  "learner_boarded",
  "learner_alighted",
  "learner_not_boarded",
  "school_arrived",
  "delayed",
  "trip_cancelled",
]);

export type TripActor = { userId: string; mode: "driver" | "admin" };

interface TripRow {
  id: string;
  tenant_id: string;
  vehicle_id: string;
  route_id: string | null;
  driver_user_id: string;
  direction: "to_school" | "from_school";
  status: "active" | "completed" | "cancelled";
  started_at: string;
  ended_at: string | null;
  cancel_reason: string | null;
}

export interface TripEvent {
  id: string;
  trip_id: string;
  event_type: string;
  learner_id: string | null;
  stop_id: string | null;
  actor_user_id: string | null;
  note: string | null;
  occurred_at: string;
}

const TRIP_COLS = `id, tenant_id, vehicle_id, route_id, driver_user_id, direction, status, started_at, ended_at, cancel_reason`;
const EVENT_COLS = `id, trip_id, event_type, learner_id, stop_id, actor_user_id, note, occurred_at`;

async function lockTrip(tx: Tx, tenantId: string, tripId: string, actor: TripActor): Promise<TripRow> {
  const res = await tx.query<TripRow>(`SELECT ${TRIP_COLS} FROM trips WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [
    tenantId,
    tripId,
  ]);
  const trip = res.rows[0];
  if (!trip) throw notFound("Trip not found");
  // A driver may only operate their own trip. Unrelated drivers get the same answer as a missing trip.
  if (actor.mode === "driver" && trip.driver_user_id !== actor.userId) throw notFound("Trip not found");
  return trip;
}

function mapGuardError(err: unknown): never {
  const e = err as { code?: string; message?: string };
  if (e.code === "23514") throw conflict(e.message ?? "Invalid trip event");
  if (e.code === "23503") throw validationError("Invalid trip event reference");
  throw err;
}

async function fanout(tx: Tx, tenantId: string, eventId: string, actorUserId: string): Promise<number> {
  const res = await tx.query<{ n: number }>(`SELECT public.transport_fanout_notifications($1::uuid) AS n`, [eventId]);
  const count = res.rows[0]?.n ?? 0;
  if (count > 0) {
    // Bridge into the central notification engine (durable outbox + worker push/in-app dispatch)
    const recips = await tx.query<{ recipient_user_id: string; title: string; body: string; kind: string }>(
      `SELECT recipient_user_id, title, body, kind FROM public.transport_event_recipients($1::uuid)`,
      [eventId],
    );
    const byMsg = new Map<string, { title: string; body: string; kind: string; users: string[] }>();
    for (const r of recips.rows) {
      const k = `${r.kind}|${r.title}|${r.body}`;
      const existing = byMsg.get(k);
      if (existing) existing.users.push(r.recipient_user_id);
      else byMsg.set(k, { title: r.title, body: r.body, kind: r.kind, users: [r.recipient_user_id] });
    }
    let idx = 0;
    for (const group of byMsg.values()) {
      idx += 1;
      await enqueueNotificationEvent(tx, {
        tenantId,
        eventType: `transport.${group.kind}`,
        category: "transport",
        idempotencyKey: `transport:${eventId}:${idx}`,
        recipientUserIds: group.users,
        title: group.title,
        body: group.body,
        channels: ["in_app", "push"],
        metadata: { event_id: eventId, kind: group.kind },
        createdBy: actorUserId,
      });
    }
  }
  return count;
}

async function insertEvent(
  tx: Tx,
  input: {
    tenantId: string;
    tripId: string;
    type: string;
    learnerId?: string | null;
    stopId?: string | null;
    note?: string | null;
    actorUserId: string;
  },
): Promise<{ event: TripEvent; replayed: boolean }> {
  let inserted: TripEvent | undefined;
  try {
    const res = await tx.query<TripEvent>(
      `INSERT INTO trip_events (tenant_id, trip_id, event_type, learner_id, stop_id, note, actor_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT DO NOTHING
       RETURNING ${EVENT_COLS}`,
      [input.tenantId, input.tripId, input.type, input.learnerId ?? null, input.stopId ?? null, input.note ?? null, input.actorUserId],
    );
    inserted = res.rows[0];
  } catch (err) {
    mapGuardError(err);
  }
  if (inserted) {
    if (NOTIFYING_EVENTS.has(input.type)) await fanout(tx, input.tenantId, inserted.id, input.actorUserId);
    if (input.type === "incident") {
      await tx.query(
        `INSERT INTO transport_incidents (tenant_id, trip_id, event_id, severity, summary, status, reported_by)
         VALUES ($1, $2, $3, 'medium', $4, 'open', $5)
         ON CONFLICT (event_id) DO NOTHING`,
        [input.tenantId, input.tripId, inserted.id, input.note?.trim() || "Transport incident reported", input.actorUserId],
      );
    }
    return { event: inserted, replayed: false };
  }
  // Duplicate: return the original event unchanged (idempotent replay, no second notification).
  const existing = await tx.query<TripEvent>(
    `SELECT ${EVENT_COLS} FROM trip_events
      WHERE tenant_id = $1 AND trip_id = $2 AND event_type = $3
        AND learner_id IS NOT DISTINCT FROM $4 AND ($5::uuid IS NULL OR stop_id IS NOT DISTINCT FROM $5)
      ORDER BY occurred_at LIMIT 1`,
    [input.tenantId, input.tripId, input.type, input.learnerId ?? null, input.stopId ?? null],
  );
  if (!existing.rows[0]) throw conflict("Trip event could not be recorded");
  return { event: existing.rows[0], replayed: true };
}

/** Driver (or admin on a driver's behalf) starts a trip; the route comes from the vehicle assignment. */
export async function startAssignedTrip(
  tx: Tx,
  input: { tenantId: string; vehicleId: string; driverUserId: string; direction: "to_school" | "from_school"; actorUserId: string; routeId?: string | null },
): Promise<{ id: string; status: string; route_id: string | null }> {
  const assignment = await tx.query<{ route_id: string | null }>(
    `SELECT route_id FROM vehicle_assignments WHERE tenant_id = $1 AND vehicle_id = $2 AND driver_user_id = $3 AND active = true`,
    [input.tenantId, input.vehicleId, input.driverUserId],
  );
  if (!assignment.rows[0]) throw validationError("driver_user_id is not actively assigned to this vehicle");
  const routeId = input.routeId ?? assignment.rows[0].route_id;
  if (!routeId) throw validationError("The vehicle assignment has no route; assign a route before starting a trip");
  const trip = await startTrip(tx, {
    tenantId: input.tenantId,
    vehicleId: input.vehicleId,
    driverUserId: input.driverUserId,
    routeId,
    direction: input.direction,
    actorUserId: input.actorUserId,
  });
  await insertEvent(tx, { tenantId: input.tenantId, tripId: trip.id, type: "trip_started", actorUserId: input.actorUserId });
  return { ...trip, route_id: routeId };
}

export async function recordTripEvent(
  tx: Tx,
  input: {
    tenantId: string;
    tripId: string;
    actor: TripActor;
    type: ApiTripEventType;
    learnerId?: string | null;
    stopId?: string | null;
    note?: string | null;
  },
): Promise<{ event: TripEvent; replayed: boolean }> {
  const learnerTypes = ["learner_boarded", "learner_alighted", "learner_not_boarded"];
  if (learnerTypes.includes(input.type) && !input.learnerId) throw validationError("learner_id is required for this event");
  if (!learnerTypes.includes(input.type) && input.learnerId) throw validationError("learner_id is not valid for this event");
  if (input.type === "stop_arrived" && !input.stopId) throw validationError("stop_id is required for stop_arrived");
  const trip = await lockTrip(tx, input.tenantId, input.tripId, input.actor);
  if (trip.status !== "active") throw conflict("The trip is not active");
  const out = await insertEvent(tx, {
    tenantId: input.tenantId,
    tripId: input.tripId,
    type: input.type,
    learnerId: input.learnerId,
    stopId: input.stopId,
    note: input.note,
    actorUserId: input.actor.userId,
  });
  if (!out.replayed) {
    await recordSecurityEvent(tx, {
      eventType: "transport.trip.event",
      actorUserId: input.actor.userId,
      tenantId: input.tenantId,
      detail: { tripId: input.tripId, eventType: input.type, learnerId: input.learnerId ?? null },
    });
  }
  return out;
}

export async function finishTrip(
  tx: Tx,
  input: { tenantId: string; tripId: string; actor: TripActor; acknowledgeOpenLearners?: boolean },
): Promise<void> {
  const trip = await lockTrip(tx, input.tenantId, input.tripId, input.actor);
  if (trip.status !== "active") throw conflict("The trip is not active");
  if (trip.direction === "from_school") {
    const open = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM trip_events b
        WHERE b.tenant_id = $1 AND b.trip_id = $2 AND b.event_type = 'learner_boarded'
          AND NOT EXISTS (SELECT 1 FROM trip_events a WHERE a.trip_id = b.trip_id AND a.learner_id = b.learner_id AND a.event_type = 'learner_alighted')`,
      [input.tenantId, input.tripId],
    );
    if ((open.rows[0]?.n ?? 0) > 0 && !input.acknowledgeOpenLearners) {
      throw conflict(`${open.rows[0]!.n} boarded learner(s) have no drop-off event; record drop-offs or acknowledge before completing`);
    }
  }
  await tx.query(`UPDATE trips SET status = 'completed', ended_at = now() WHERE tenant_id = $1 AND id = $2`, [input.tenantId, input.tripId]);
  await insertEvent(tx, {
    tenantId: input.tenantId,
    tripId: input.tripId,
    type: "trip_completed",
    note: input.acknowledgeOpenLearners ? "completed with acknowledged open learners" : null,
    actorUserId: input.actor.userId,
  });
  await recordSecurityEvent(tx, {
    eventType: "transport.trip.completed",
    actorUserId: input.actor.userId,
    tenantId: input.tenantId,
    detail: { tripId: input.tripId },
  });
}

export async function cancelTrip(
  tx: Tx,
  input: { tenantId: string; tripId: string; actor: TripActor; reason: string },
): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length < 1 || reason.length > 500) throw validationError("reason must be 1-500 characters");
  const trip = await lockTrip(tx, input.tenantId, input.tripId, input.actor);
  if (trip.status !== "active") throw conflict("The trip is not active");
  await tx.query(
    `UPDATE trips SET status = 'cancelled', ended_at = now(), cancel_reason = $3 WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.tripId, reason],
  );
  await insertEvent(tx, { tenantId: input.tenantId, tripId: input.tripId, type: "trip_cancelled", note: reason, actorUserId: input.actor.userId });
  await recordSecurityEvent(tx, {
    eventType: "transport.trip.cancelled",
    actorUserId: input.actor.userId,
    tenantId: input.tenantId,
    detail: { tripId: input.tripId },
  });
}

/**
 * Driver-bound GPS ingestion: the caller must be the driver of an ACTIVE trip; the vehicle is taken from the
 * trip (never from the request). Out-of-order, replayed and stale fixes are refused; an exact resend is a no-op.
 */
export async function recordDriverLocation(
  tx: Tx,
  input: {
    tenantId: string;
    tripId: string;
    driverUserId: string;
    lat: number;
    lng: number;
    speedKmh?: number | null;
    heading?: number | null;
    recordedAt?: string | null;
  },
): Promise<{ location: VehicleLocation; replayed: boolean }> {
  const trip = await lockTrip(tx, input.tenantId, input.tripId, { userId: input.driverUserId, mode: "driver" });
  if (trip.status !== "active") throw conflict("The trip is not active");
  const recordedAt = input.recordedAt ? new Date(input.recordedAt) : new Date();
  if (Number.isNaN(recordedAt.getTime())) throw validationError("Invalid recorded_at timestamp");
  if (Date.now() - recordedAt.getTime() > DRIVER_FIX_MAX_AGE_SECONDS * 1000) {
    throw validationError(`recorded_at is older than ${DRIVER_FIX_MAX_AGE_SECONDS} seconds; stale fixes are refused`);
  }
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`veh-loc:${trip.vehicle_id}`]);
  const prev = await tx.query<{ lat: number; lng: number; recorded_at: Date }>(
    `SELECT lat, lng, recorded_at FROM vehicle_locations WHERE tenant_id = $1 AND vehicle_id = $2 ORDER BY recorded_at DESC, id DESC LIMIT 1`,
    [input.tenantId, trip.vehicle_id],
  );
  const p = prev.rows[0];
  if (p && recordedAt.getTime() < p.recorded_at.getTime()) {
    throw conflict("Out-of-order location fix refused: a newer fix was already recorded");
  }
  if (p && recordedAt.getTime() === p.recorded_at.getTime()) {
    if (p.lat === input.lat && p.lng === input.lng) {
      const dup = await tx.query(
        `SELECT id, tenant_id, vehicle_id, trip_id, lat, lng, speed_kmh, heading, recorded_at, expires_at
           FROM vehicle_locations WHERE tenant_id = $1 AND vehicle_id = $2 ORDER BY recorded_at DESC, id DESC LIMIT 1`,
        [input.tenantId, trip.vehicle_id],
      );
      const r = dup.rows[0] as VehicleLocation & { recorded_at: Date; expires_at: Date };
      return {
        location: { ...r, recorded_at: new Date(r.recorded_at).toISOString(), expires_at: new Date(r.expires_at).toISOString() },
        replayed: true,
      };
    }
    throw conflict("A different fix with the same timestamp was already recorded");
  }
  const location = await recordVehicleLocation(tx, {
    tenantId: input.tenantId,
    vehicleId: trip.vehicle_id,
    tripId: trip.id,
    lat: input.lat,
    lng: input.lng,
    speedKmh: input.speedKmh,
    heading: input.heading,
    recordedAt: recordedAt.toISOString(),
    actorUserId: input.driverUserId,
  });
  return { location, replayed: false };
}

export interface ManifestEntry {
  learner_id: string;
  full_name: string;
  stop_id: string | null;
  stop_name: string | null;
  status: "waiting" | "boarded" | "dropped_off" | "not_boarded";
}

export async function getTripDetail(tx: Tx, tenantId: string, tripId: string, actor: { userId: string; mode: "driver" | "admin" }) {
  const t = await tx.query<TripRow>(`SELECT ${TRIP_COLS} FROM trips WHERE tenant_id = $1 AND id = $2`, [tenantId, tripId]);
  const trip = t.rows[0];
  if (!trip || (actor.mode === "driver" && trip.driver_user_id !== actor.userId)) throw notFound("Trip not found");
  const manifest = trip.route_id
    ? await tx.query<ManifestEntry>(
        `SELECT lt.learner_id, l.full_name, lt.stop_id, s.name AS stop_name,
                CASE WHEN EXISTS (SELECT 1 FROM trip_events e WHERE e.trip_id = $3 AND e.learner_id = lt.learner_id AND e.event_type = 'learner_alighted') THEN 'dropped_off'
                     WHEN EXISTS (SELECT 1 FROM trip_events e WHERE e.trip_id = $3 AND e.learner_id = lt.learner_id AND e.event_type = 'learner_boarded') THEN 'boarded'
                     WHEN EXISTS (SELECT 1 FROM trip_events e WHERE e.trip_id = $3 AND e.learner_id = lt.learner_id AND e.event_type = 'learner_not_boarded') THEN 'not_boarded'
                     ELSE 'waiting' END AS status
           FROM learner_transport lt
           JOIN learners l ON l.id = lt.learner_id AND l.tenant_id = lt.tenant_id AND l.archived_at IS NULL
           LEFT JOIN route_stops s ON s.id = lt.stop_id AND s.tenant_id = lt.tenant_id
          WHERE lt.tenant_id = $1 AND lt.route_id = $2
          ORDER BY s.sequence NULLS LAST, l.full_name`,
        [tenantId, trip.route_id, tripId],
      )
    : { rows: [] as ManifestEntry[] };
  const events = await tx.query<TripEvent>(
    `SELECT ${EVENT_COLS} FROM trip_events WHERE tenant_id = $1 AND trip_id = $2 ORDER BY occurred_at, id LIMIT 1000`,
    [tenantId, tripId],
  );
  return { trip, manifest: manifest.rows, events: events.rows };
}

export async function listTrips(
  tx: Tx,
  tenantId: string,
  filter: { status?: string | null; driverUserId?: string | null },
  limit: number,
  rawCursor?: unknown,
): Promise<{ trips: TripRow[]; page: PageInfo }> {
  const params: unknown[] = [tenantId, filter.status ?? null, filter.driverUserId ?? null];
  const inner = `SELECT ${TRIP_COLS} FROM trips WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR driver_user_id = $3)`;
  const res = await pageQuery<TripRow>(tx, inner, params, { name: "trips_started_desc", expr: "q.started_at", type: "timestamptz", dir: "desc" }, { limit, rawCursor });
  return { trips: res.rows.map(({ page_key: _pk, ...rest }) => rest as unknown as TripRow), page: res.page };
}

// ---------------------------------------------------------------------------------------------------------
// Guardian-facing reads
// ---------------------------------------------------------------------------------------------------------

export async function myTransport(tx: Tx, tenantId: string) {
  const rows = await tx.query<{
    learner_id: string;
    learner_name: string;
    route_id: string | null;
    route_name: string | null;
    stop_id: string | null;
    stop_name: string | null;
    vehicle_plate: string | null;
    driver_first_name: string | null;
    trip_id: string | null;
    trip_direction: string | null;
    trip_started_at: string | null;
    learner_status: string | null;
    last_event_at: string | null;
    loc_lat: number | null;
    loc_lng: number | null;
    loc_at: string | null;
    loc_age_s: number | null;
  }>(
    `WITH kids AS (SELECT public.transport_my_children() AS learner_id)
     SELECT le.id AS learner_id, le.full_name AS learner_name,
            r.id AS route_id, r.name AS route_name, s.id AS stop_id, s.name AS stop_name,
            v.plate_number AS vehicle_plate,
            split_part(btrim(u.full_name), ' ', 1) AS driver_first_name,
            tr.id AS trip_id, tr.direction AS trip_direction, tr.started_at AS trip_started_at,
            ls.status AS learner_status, ls.at AS last_event_at,
            CASE WHEN ls.status IN ('dropped_off', 'not_boarded') THEN NULL ELSE loc.lat END AS loc_lat,
            CASE WHEN ls.status IN ('dropped_off', 'not_boarded') THEN NULL ELSE loc.lng END AS loc_lng,
            loc.recorded_at AS loc_at,
            extract(epoch FROM (now() - loc.recorded_at))::float8 AS loc_age_s
       FROM kids k
       JOIN learners le ON le.id = k.learner_id AND le.tenant_id = $1
       LEFT JOIN learner_transport lt ON lt.learner_id = le.id AND lt.tenant_id = $1
       LEFT JOIN transport_routes r ON r.id = lt.route_id AND r.tenant_id = $1
       LEFT JOIN route_stops s ON s.id = lt.stop_id AND s.tenant_id = $1
       LEFT JOIN vehicle_assignments va ON va.route_id = r.id AND va.tenant_id = $1 AND va.active
       LEFT JOIN vehicles v ON v.id = va.vehicle_id AND v.tenant_id = $1
       LEFT JOIN users u ON u.id = va.driver_user_id
       LEFT JOIN LATERAL (
         SELECT t.* FROM trips t WHERE t.tenant_id = $1 AND t.route_id = r.id AND t.status = 'active'
          ORDER BY t.started_at DESC LIMIT 1) tr ON true
       LEFT JOIN LATERAL (
         SELECT CASE e.event_type WHEN 'learner_alighted' THEN 'dropped_off' WHEN 'learner_boarded' THEN 'boarded' ELSE 'not_boarded' END AS status,
                e.occurred_at AS at
           FROM trip_events e
          WHERE e.trip_id = tr.id AND e.learner_id = le.id AND e.event_type IN ('learner_boarded', 'learner_alighted', 'learner_not_boarded')
          ORDER BY CASE e.event_type WHEN 'learner_alighted' THEN 3 WHEN 'learner_not_boarded' THEN 2 ELSE 1 END DESC LIMIT 1) ls ON true
       LEFT JOIN LATERAL (
         SELECT vl.lat, vl.lng, vl.recorded_at FROM vehicle_locations vl
          WHERE vl.tenant_id = $1 AND vl.trip_id = tr.id ORDER BY vl.recorded_at DESC, vl.id DESC LIMIT 1) loc ON tr.id IS NOT NULL
      ORDER BY le.full_name`,
    [tenantId],
  );
  return rows.rows.map((r) => {
    const active = r.trip_id !== null;
    const live = active && r.loc_at !== null && r.loc_age_s !== null && r.loc_age_s <= LIVE_LOCATION_MAX_AGE_SECONDS;
    const hidden = r.learner_status === "dropped_off" || r.learner_status === "not_boarded";
    return {
      learner_id: r.learner_id,
      learner_name: r.learner_name,
      assigned: r.route_id !== null,
      route: r.route_id ? { id: r.route_id, name: r.route_name } : null,
      stop: r.stop_id ? { id: r.stop_id, name: r.stop_name } : null,
      vehicle_plate: r.vehicle_plate,
      driver_first_name: r.driver_first_name || null,
      active_trip: active
        ? { id: r.trip_id, direction: r.trip_direction, started_at: r.trip_started_at, learner_status: r.learner_status ?? "waiting", learner_status_at: r.last_event_at }
        : null,
      location: active && !hidden
        ? live
          ? { status: "live", lat: r.loc_lat, lng: r.loc_lng, recorded_at: r.loc_at, age_seconds: Math.round(r.loc_age_s!) }
          : { status: r.loc_at ? "stale" : "unavailable", lat: null, lng: null, recorded_at: r.loc_at, age_seconds: r.loc_age_s === null ? null : Math.round(r.loc_age_s) }
        : null,
    };
  });
}

export async function myTransportNotifications(tx: Tx, tenantId: string, userId: string, limit: number, rawCursor?: unknown) {
  const inner = `SELECT id, trip_id, event_id, learner_id, kind, title, body, delivery_status, in_app_read_at, created_at
                   FROM transport_notifications WHERE tenant_id = $1 AND recipient_user_id = $2`;
  const res = await pageQuery<{ id: string }>(tx, inner, [tenantId, userId], { name: "transport_notifications_desc", expr: "q.created_at", type: "timestamptz", dir: "desc" }, { limit, rawCursor });
  return { notifications: res.rows.map(({ page_key: _pk, ...rest }) => rest), page: res.page };
}

export function assertDriverOrAdminMode(canWrite: boolean, canDrive: boolean): "admin" | "driver" {
  if (canWrite) return "admin";
  if (canDrive) return "driver";
  throw forbidden("Transport access denied");
}

/** Ledger entry (and guardian fan-out) for a trip started through the admin route. */
export async function recordTripStarted(tx: Tx, tenantId: string, tripId: string, actorUserId: string): Promise<void> {
  await insertEvent(tx, { tenantId, tripId, type: "trip_started", actorUserId });
}

export interface TransportIncident {
  id: string;
  tenant_id: string;
  trip_id: string;
  event_id: string;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  status: "open" | "acknowledged" | "escalated" | "resolved";
  reported_by: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  escalated_by: string | null;
  escalated_at: string | null;
  escalation_reason: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
}

const INCIDENT_COLS = `id, tenant_id, trip_id, event_id, severity, summary, status, reported_by,
  acknowledged_by, acknowledged_at, escalated_by, escalated_at, escalation_reason,
  resolved_by, resolved_at, resolution_note, created_at`;

export async function listTripIncidents(tx: Tx, tenantId: string, tripId: string, actor: TripActor): Promise<TransportIncident[]> {
  await lockTrip(tx, tenantId, tripId, actor);
  const res = await tx.query<TransportIncident>(
    `SELECT ${INCIDENT_COLS} FROM transport_incidents WHERE tenant_id = $1 AND trip_id = $2 ORDER BY created_at DESC, id`,
    [tenantId, tripId],
  );
  return res.rows;
}

export async function acknowledgeTransportIncident(
  tx: Tx,
  input: { tenantId: string; tripId: string; incidentId: string; actorUserId: string; severity?: "low" | "medium" | "high" | "critical"; ip?: string | null },
): Promise<TransportIncident> {
  const existing = await tx.query<TransportIncident>(
    `SELECT ${INCIDENT_COLS} FROM transport_incidents WHERE tenant_id = $1 AND trip_id = $2 AND id = $3 FOR UPDATE`,
    [input.tenantId, input.tripId, input.incidentId],
  );
  const inc = existing.rows[0];
  if (!inc) throw notFound("Transport incident not found");
  if (inc.status === "resolved") throw conflict("A resolved incident cannot be re-acknowledged");
  const res = await tx.query<TransportIncident>(
    `UPDATE transport_incidents
        SET status = CASE WHEN status = 'open' THEN 'acknowledged' ELSE status END,
            severity = COALESCE($4, severity),
            acknowledged_by = COALESCE(acknowledged_by, $5),
            acknowledged_at = COALESCE(acknowledged_at, now())
      WHERE tenant_id = $1 AND trip_id = $2 AND id = $3
      RETURNING ${INCIDENT_COLS}`,
    [input.tenantId, input.tripId, input.incidentId, input.severity ?? null, input.actorUserId],
  );
  await recordSecurityEvent(tx, {
    eventType: "transport.incident.acknowledged",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    ip: input.ip,
    detail: { tripId: input.tripId, incidentId: input.incidentId, severityBefore: inc.severity, severityAfter: res.rows[0]!.severity },
  });
  return res.rows[0]!;
}

export async function escalateTransportIncident(
  tx: Tx,
  input: {
    tenantId: string;
    tripId: string;
    incidentId: string;
    actorUserId: string;
    reason: string;
    severity?: "high" | "critical";
    notifyGuardians?: boolean;
    ip?: string | null;
  },
): Promise<{ incident: TransportIncident; guardians_notified: boolean }> {
  const existing = await tx.query<TransportIncident>(
    `SELECT ${INCIDENT_COLS} FROM transport_incidents WHERE tenant_id = $1 AND trip_id = $2 AND id = $3 FOR UPDATE`,
    [input.tenantId, input.tripId, input.incidentId],
  );
  const inc = existing.rows[0];
  if (!inc) throw notFound("Transport incident not found");
  if (inc.status === "resolved") throw conflict("A resolved incident cannot be escalated");
  const res = await tx.query<TransportIncident>(
    `UPDATE transport_incidents
        SET status = 'escalated',
            severity = CASE
              WHEN severity = 'critical' OR $4 = 'critical' THEN 'critical'
              ELSE 'high'
            END,
            escalated_by = COALESCE(escalated_by, $5),
            escalated_at = COALESCE(escalated_at, now()),
            escalation_reason = COALESCE(escalation_reason, $6)
      WHERE tenant_id = $1 AND trip_id = $2 AND id = $3
      RETURNING ${INCIDENT_COLS}`,
    [input.tenantId, input.tripId, input.incidentId, input.severity ?? null, input.actorUserId, input.reason.trim()],
  );
  await recordSecurityEvent(tx, {
    eventType: "transport.incident.escalated",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    ip: input.ip,
    detail: { tripId: input.tripId, incidentId: input.incidentId, notifyGuardians: Boolean(input.notifyGuardians), severityBefore: inc.severity, severityAfter: res.rows[0]!.severity, reason: input.reason.trim() },
  });
  let guardiansNotified = false;
  if (input.notifyGuardians) {
    const gRes = await tx.query<{ user_id: string }>(`SELECT public.transport_trip_guardian_users($1::uuid) AS user_id`, [input.tripId]);
    const recipients = gRes.rows.map((r) => r.user_id).filter(Boolean);
    if (recipients.length > 0) {
      await enqueueNotificationEvent(tx, {
        tenantId: input.tenantId,
        eventType: "transport.incident_escalated",
        category: "transport",
        idempotencyKey: `transport-inc-esc:${input.incidentId}`,
        recipientUserIds: recipients,
        title: "School transport safety update",
        body: "The school transport office has logged an active trip update. Please check the portal or contact the school office.",
        channels: ["in_app", "push"],
        metadata: { trip_id: input.tripId, incident_id: input.incidentId },
        createdBy: input.actorUserId,
      });
      guardiansNotified = true;
    }
  }
  return { incident: res.rows[0]!, guardians_notified: guardiansNotified };
}

export async function resolveTransportIncident(
  tx: Tx,
  input: { tenantId: string; tripId: string; incidentId: string; actorUserId: string; resolutionNote: string; ip?: string | null },
): Promise<TransportIncident> {
  const existing = await tx.query<TransportIncident>(
    `SELECT ${INCIDENT_COLS} FROM transport_incidents WHERE tenant_id = $1 AND trip_id = $2 AND id = $3 FOR UPDATE`,
    [input.tenantId, input.tripId, input.incidentId],
  );
  const inc = existing.rows[0];
  if (!inc) throw notFound("Transport incident not found");
  if (inc.status === "resolved") throw conflict("Transport incident is already resolved");
  const res = await tx.query<TransportIncident>(
    `UPDATE transport_incidents
        SET status = 'resolved',
            resolved_by = $4,
            resolved_at = now(),
            resolution_note = $5
      WHERE tenant_id = $1 AND trip_id = $2 AND id = $3
      RETURNING ${INCIDENT_COLS}`,
    [input.tenantId, input.tripId, input.incidentId, input.actorUserId, input.resolutionNote.trim()],
  );
  await recordSecurityEvent(tx, {
    eventType: "transport.incident.resolved",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    ip: input.ip,
    detail: { tripId: input.tripId, incidentId: input.incidentId },
  });
  return res.rows[0]!;
}

export async function markTransportNotificationRead(
  tx: Tx,
  input: { tenantId: string; userId: string; notificationId: string },
): Promise<{ id: string; in_app_read_at: string }> {
  const res = await tx.query<{ id: string; in_app_read_at: string }>(
    `UPDATE transport_notifications
        SET in_app_read_at = COALESCE(in_app_read_at, now())
      WHERE tenant_id = $1 AND recipient_user_id = $2 AND id = $3
      RETURNING id, in_app_read_at`,
    [input.tenantId, input.userId, input.notificationId],
  );
  if (!res.rows[0]) throw notFound("Transport notification not found");
  return res.rows[0];
}
