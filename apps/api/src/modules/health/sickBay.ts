import type { Tx } from "../../db/sql.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import type { PageInfo } from "../../http/pagination.js";
import { pageQuery, type PageInput } from "../academics/pagination.js";
import { recordSecurityEvent } from "../audit/audit.js";

export type VisitOutcome = "class" | "rest" | "home" | "hospital" | "admitted";

export interface MedicalSettings {
  notify_guardians: "all" | "serious";
  /** S12-05: Guardian account-linking (OD-F1) is deferred; setting is persisted but guardian notices are not yet emitted. */
  guardian_notices_available: boolean;
}

export interface SickBayVisit {
  id: string;
  tenant_id: string;
  learner_id: string;
  time_in: string;
  complaint: string;
  temperature_c: string | null;
  pulse_bpm: number | null;
  observations: string | null;
  assessment: string | null;
  treatment: string | null;
  outcome: VisitOutcome | null;
  referred_to: string | null;
  time_out: string | null;
  follow_up: string | null;
  attendance_mark: "excused" | "absent" | null;
  attendance_marked_at: string | null;
  logged_by: string | null;
  row_version: number;
  correction_reason: string | null;
  updated_at: string;
}

const COLS = `id, tenant_id, learner_id, time_in, complaint, temperature_c, pulse_bpm, observations,
  assessment, treatment, outcome, referred_to, time_out, follow_up, attendance_mark, attendance_marked_at,
  logged_by, row_version, correction_reason, updated_at`;

export async function getMedicalSettings(tx: Tx, tenantId: string): Promise<MedicalSettings> {
  const res = await tx.query<{ notify_guardians: "all" | "serious" }>(
    `SELECT notify_guardians FROM medical_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  return {
    notify_guardians: res.rows[0]?.notify_guardians ?? "serious",
    guardian_notices_available: false,
  };
}

export async function putMedicalSettings(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; notify_guardians: "all" | "serious"; ip?: string | null },
): Promise<MedicalSettings> {
  const res = await tx.query<{ notify_guardians: "all" | "serious" }>(
    `INSERT INTO medical_settings (tenant_id, notify_guardians, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (tenant_id) DO UPDATE SET notify_guardians = EXCLUDED.notify_guardians, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING notify_guardians`,
    [input.tenantId, input.notify_guardians, input.actorUserId],
  );
  await recordSecurityEvent(tx, {
    eventType: "health.medical_settings.updated",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    ip: input.ip,
    detail: { notify_guardians: res.rows[0]!.notify_guardians, guardian_notices_available: false },
  });
  return {
    notify_guardians: res.rows[0]!.notify_guardians,
    guardian_notices_available: false,
  };
}

export async function createSickBayVisit(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    learner_id: string;
    complaint: string;
    temperature_c?: number | null;
    pulse_bpm?: number | null;
    observations?: string | null;
    assessment?: string | null;
    treatment?: string | null;
  },
): Promise<SickBayVisit> {
  if (!input.complaint.trim()) throw validationError("complaint is required");
  const learner = await tx.query(`SELECT 1 FROM learners WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL`, [
    input.tenantId,
    input.learner_id,
  ]);
  if (!learner.rows[0]) throw validationError("learner_id must be an active learner in this school");
  const res = await tx.query<SickBayVisit>(
    `INSERT INTO sick_bay_visits (
       tenant_id, learner_id, complaint, temperature_c, pulse_bpm, observations, assessment, treatment, logged_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING ${COLS}`,
    [
      input.tenantId,
      input.learner_id,
      input.complaint.trim(),
      input.temperature_c ?? null,
      input.pulse_bpm ?? null,
      input.observations ?? null,
      input.assessment ?? null,
      input.treatment ?? null,
      input.actorUserId,
    ],
  );
  const row = res.rows[0]!;
  await recordSecurityEvent(tx, {
    eventType: "health.sick_bay.visit_created",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { visitId: row.id, learnerId: row.learner_id, rowVersion: row.row_version },
  });
  return row;
}

export async function getSickBayVisit(tx: Tx, tenantId: string, visitId: string): Promise<SickBayVisit | null> {
  const res = await tx.query<SickBayVisit>(`SELECT ${COLS} FROM sick_bay_visits WHERE tenant_id = $1 AND id = $2`, [
    tenantId,
    visitId,
  ]);
  return res.rows[0] ?? null;
}

export async function listSickBayBoard(
  tx: Tx,
  tenantId: string,
  limit: number,
  rawCursor?: unknown,
): Promise<{ visits: SickBayVisit[]; page: PageInfo }> {
  const page: PageInput = { limit, rawCursor };
  const inner = `SELECT ${COLS} FROM sick_bay_visits WHERE tenant_id = $1 AND time_out IS NULL`;
  const res = await pageQuery<SickBayVisit>(
    tx,
    inner,
    [tenantId],
    { name: "sick_bay_board_time_in_asc", expr: "q.time_in", type: "timestamptz", dir: "asc" },
    page,
  );
  const visits = res.rows.map(({ page_key: _pk, ...rest }) => rest);
  return { visits, page: res.page };
}

export async function updateSickBayVisit(
  tx: Tx,
  input: {
    tenantId: string;
    visitId: string;
    actorUserId: string;
    ip?: string | null;
    row_version?: number;
    correction_reason?: string | null;
    complaint?: string;
    temperature_c?: number | null;
    pulse_bpm?: number | null;
    observations?: string | null;
    assessment?: string | null;
    treatment?: string | null;
    outcome?: VisitOutcome | null;
    referred_to?: string | null;
    time_out?: string | null;
    follow_up?: string | null;
  },
): Promise<SickBayVisit> {
  const locked = await tx.query<SickBayVisit>(
    `SELECT ${COLS} FROM sick_bay_visits WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.visitId],
  );
  const current = locked.rows[0];
  if (!current) throw notFound("Sick bay visit not found");

  if (input.row_version !== undefined && input.row_version !== current.row_version) {
    throw conflict("Sick bay visit was modified by another request (row_version mismatch)");
  }

  const wasDischarged = current.time_out !== null;
  if (wasDischarged) {
    if (input.time_out === null) {
      throw conflict("A discharged sick bay visit cannot be reopened");
    }
    if (!input.correction_reason || input.correction_reason.trim().length < 3) {
      throw conflict("A discharged sick bay visit is final; correction_reason is required to amend");
    }
  }

  const nextComplaint = input.complaint !== undefined ? input.complaint.trim() : current.complaint;
  if (!nextComplaint) throw validationError("complaint is required");
  const nextTemp = input.temperature_c !== undefined ? input.temperature_c : current.temperature_c;
  const nextPulse = input.pulse_bpm !== undefined ? input.pulse_bpm : current.pulse_bpm;
  const nextObservations = input.observations !== undefined ? input.observations : current.observations;
  const nextAssessment = input.assessment !== undefined ? input.assessment : current.assessment;
  const nextTreatment = input.treatment !== undefined ? input.treatment : current.treatment;
  const nextOutcome = input.outcome !== undefined ? input.outcome : current.outcome;
  const nextReferredTo = input.referred_to !== undefined ? input.referred_to : current.referred_to;
  const nextTimeOut = input.time_out !== undefined ? input.time_out : current.time_out;
  const nextFollowUp = input.follow_up !== undefined ? input.follow_up : current.follow_up;
  const nextCorrectionReason =
    input.correction_reason !== undefined ? input.correction_reason?.trim() ?? null : current.correction_reason;

  if (nextOutcome === "hospital" && !nextReferredTo?.trim()) {
    throw validationError("referred_to is required for hospital outcome");
  }

  const changedFields: string[] = [];
  if (input.complaint !== undefined && nextComplaint !== current.complaint) changedFields.push("complaint");
  if (input.temperature_c !== undefined && String(nextTemp ?? "") !== String(current.temperature_c ?? "")) {
    changedFields.push("temperature_c");
  }
  if (input.pulse_bpm !== undefined && nextPulse !== current.pulse_bpm) changedFields.push("pulse_bpm");
  if (input.observations !== undefined && nextObservations !== current.observations) changedFields.push("observations");
  if (input.assessment !== undefined && nextAssessment !== current.assessment) changedFields.push("assessment");
  if (input.treatment !== undefined && nextTreatment !== current.treatment) changedFields.push("treatment");
  if (input.outcome !== undefined && nextOutcome !== current.outcome) changedFields.push("outcome");
  if (input.referred_to !== undefined && nextReferredTo !== current.referred_to) changedFields.push("referred_to");
  if (input.time_out !== undefined && nextTimeOut !== current.time_out) changedFields.push("time_out");
  if (input.follow_up !== undefined && nextFollowUp !== current.follow_up) changedFields.push("follow_up");

  const res = await tx.query<SickBayVisit>(
    `UPDATE sick_bay_visits SET
       complaint = $3,
       temperature_c = $4,
       pulse_bpm = $5,
       observations = $6,
       assessment = $7,
       treatment = $8,
       outcome = $9,
       referred_to = $10,
       time_out = $11::timestamptz,
       follow_up = $12,
       correction_reason = $13
     WHERE tenant_id = $1 AND id = $2 AND row_version = $14
     RETURNING ${COLS}`,
    [
      input.tenantId,
      input.visitId,
      nextComplaint,
      nextTemp,
      nextPulse,
      nextObservations,
      nextAssessment,
      nextTreatment,
      nextOutcome,
      nextReferredTo,
      nextTimeOut,
      nextFollowUp,
      nextCorrectionReason,
      current.row_version,
    ],
  );
  const row = res.rows[0];
  if (!row) throw conflict("Sick bay visit was modified by another request");
  // N-4: the database consumes the reason into sick_bay_visit_corrections and clears the column so it can never go
  // stale; this response and the audit event carry the reason that was supplied in THIS statement.
  row.correction_reason = nextCorrectionReason;

  await recordSecurityEvent(tx, {
    eventType: wasDischarged ? "health.sick_bay.visit_corrected" : "health.sick_bay.visit_updated",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    ip: input.ip,
    detail: {
      visitId: input.visitId,
      outcome: row.outcome,
      rowVersion: row.row_version,
      changedFields,
      discharged: row.time_out !== null,
      correctionReason: row.correction_reason,
    },
  });
  return row;
}

