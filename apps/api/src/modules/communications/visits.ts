import type { Tx } from "../../db/sql.js";
import { notFound, validationError } from "../../http/errors.js";
import type { PageInfo } from "../../http/pagination.js";
import { pageQuery, type PageInput } from "../academics/pagination.js";
import { recordSecurityEvent } from "../audit/audit.js";

export type VisitStatus = "expected" | "at_reception" | "with_host" | "left";
export type VisitHostKind = "office" | "principal" | "teacher" | "learner";
export type VisitEntryPoint = "gate" | "reception";

export interface GateVisit {
  id: string;
  tenant_id: string;
  visitor_name: string;
  visitor_phone: string | null;
  id_number: string | null;
  vehicle_plate: string | null;
  purpose: string;
  host_kind: VisitHostKind;
  host_user_id: string | null;
  learner_id: string | null;
  host_name: string | null;
  learner_name: string | null;
  entry_point: VisitEntryPoint;
  status: VisitStatus;
  escalated: boolean;
  escalated_at: string | null;
  note: string | null;
  recorded_by: string | null;
  arrived_at: string;
  reception_at: string | null;
  with_host_at: string | null;
  left_at: string | null;
  updated_at: string;
}

const COLS = `id, tenant_id, visitor_name, visitor_phone, id_number, vehicle_plate, purpose, host_kind,
  host_user_id, learner_id, host_name, learner_name, entry_point, status, escalated, escalated_at, note,
  recorded_by, arrived_at, reception_at, with_host_at, left_at, updated_at`;

/**
 * S12-03: Minimize visitor identity PII (visitor_phone, id_number, vehicle_plate, recorded_by)
 * when a host teacher without `resource.visitor.read` views their own hosted visits.
 */
export function projectGateVisitForCaller(visit: GateVisit, canReadAllVisitorPii: boolean): GateVisit {
  if (canReadAllVisitorPii) return visit;
  return {
    ...visit,
    visitor_phone: null,
    id_number: null,
    vehicle_plate: null,
    recorded_by: null,
  };
}

export function nextVisitSteps(status: VisitStatus): VisitStatus[] {
  switch (status) {
    case "expected":
      return ["at_reception", "left"];
    case "at_reception":
      return ["with_host", "left"];
    case "with_host":
      return ["left"];
    case "left":
      return [];
  }
}

export function assertVisitDraft(input: {
  visitor_name: string;
  purpose: string;
  host_kind: VisitHostKind;
  host_user_id?: string | null;
  learner_id?: string | null;
}): void {
  if (!input.visitor_name.trim()) throw validationError("visitor_name is required");
  if (!input.purpose.trim()) throw validationError("purpose is required");
  if (input.host_kind === "teacher" && !input.host_user_id) throw validationError("host_user_id is required for teacher hosts");
  if (input.host_kind === "learner" && !input.learner_id) throw validationError("learner_id is required for learner hosts");
}

export async function createGateVisit(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    visitor_name: string;
    visitor_phone?: string | null;
    id_number?: string | null;
    vehicle_plate?: string | null;
    purpose: string;
    host_kind: VisitHostKind;
    host_user_id?: string | null;
    learner_id?: string | null;
    entry_point?: VisitEntryPoint;
    note?: string | null;
  },
): Promise<GateVisit> {
  assertVisitDraft(input);
  const res = await tx.query<GateVisit>(
    `INSERT INTO gate_visits (
       tenant_id, visitor_name, visitor_phone, id_number, vehicle_plate, purpose,
       host_kind, host_user_id, learner_id, entry_point, note, recorded_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING ${COLS}`,
    [
      input.tenantId,
      input.visitor_name.trim(),
      input.visitor_phone ?? null,
      input.id_number ?? null,
      input.vehicle_plate ?? null,
      input.purpose.trim(),
      input.host_kind,
      input.host_user_id ?? null,
      input.learner_id ?? null,
      input.entry_point ?? "gate",
      input.note ?? null,
      input.actorUserId,
    ],
  );
  const row = res.rows[0]!;
  await recordSecurityEvent(tx, {
    eventType: "communications.visit.created",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { visitId: row.id, hostKind: row.host_kind, status: row.status },
  });
  return row;
}

export async function getGateVisit(tx: Tx, tenantId: string, visitId: string): Promise<GateVisit | null> {
  const res = await tx.query<GateVisit>(`SELECT ${COLS} FROM gate_visits WHERE tenant_id = $1 AND id = $2`, [tenantId, visitId]);
  return res.rows[0] ?? null;
}

export async function listGateVisits(
  tx: Tx,
  input: {
    tenantId: string;
    openOnly?: boolean;
    hostUserId?: string | null;
    limit: number;
    rawCursor?: unknown;
    canReadAllVisitorPii?: boolean;
  },
): Promise<{ visits: GateVisit[]; page: PageInfo }> {
  const page: PageInput = { limit: input.limit, rawCursor: input.rawCursor };
  const canReadAll = input.canReadAllVisitorPii ?? true;
  let inner: string;
  let params: unknown[];
  let sortName: string;
  if (input.openOnly && input.hostUserId) {
    inner = `SELECT ${COLS} FROM gate_visits WHERE tenant_id = $1 AND status <> 'left' AND host_user_id = $2`;
    params = [input.tenantId, input.hostUserId];
    sortName = "gate_visits_open_host_arrived_asc";
  } else if (input.openOnly) {
    inner = `SELECT ${COLS} FROM gate_visits WHERE tenant_id = $1 AND status <> 'left'`;
    params = [input.tenantId];
    sortName = "gate_visits_open_arrived_asc";
  } else if (input.hostUserId) {
    inner = `SELECT ${COLS} FROM gate_visits WHERE tenant_id = $1 AND host_user_id = $2`;
    params = [input.tenantId, input.hostUserId];
    sortName = "gate_visits_host_arrived_asc";
  } else {
    inner = `SELECT ${COLS} FROM gate_visits WHERE tenant_id = $1`;
    params = [input.tenantId];
    sortName = "gate_visits_all_arrived_asc";
  }
  const res = await pageQuery<GateVisit>(
    tx,
    inner,
    params,
    { name: sortName, expr: "q.arrived_at", type: "timestamptz", dir: "asc" },
    page,
  );
  const visits = res.rows.map(({ page_key: _pk, ...rest }) => projectGateVisitForCaller(rest, canReadAll));
  return { visits, page: res.page };
}

export async function advanceGateVisit(
  tx: Tx,
  input: { tenantId: string; visitId: string; actorUserId: string; status: VisitStatus; note?: string | null },
): Promise<GateVisit> {
  const current = await getGateVisit(tx, input.tenantId, input.visitId);
  if (!current) throw notFound("Visit not found");
  if (!nextVisitSteps(current.status).includes(input.status)) {
    throw validationError(`Cannot move visit from ${current.status} to ${input.status}`);
  }
  const res = await tx.query<GateVisit>(
    `UPDATE gate_visits SET status = $3, note = COALESCE($4, note)
      WHERE tenant_id = $1 AND id = $2
      RETURNING ${COLS}`,
    [input.tenantId, input.visitId, input.status, input.note ?? null],
  );
  if (!res.rows[0]) throw notFound("Visit not found");
  await recordSecurityEvent(tx, {
    eventType: "communications.visit.advanced",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { visitId: input.visitId, from: current.status, to: input.status },
  });
  return res.rows[0];
}
