import type { Tx } from "../../db/sql.js";
import { conflict, forbidden, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { enqueueNotificationEvent } from "../notifications/service.js";

export type MarOutcome = "administered" | "missed" | "delayed" | "refused" | "held" | "exception";

export interface LearnerHealthProfile {
  id: string;
  tenant_id: string;
  learner_id: string;
  blood_group: string | null;
  allergies: string[];
  chronic_conditions: string[];
  dietary_notes: string | null;
  emergency_notes: string | null;
  row_version: number;
  updated_at: string;
}

export interface MedicationAuthorization {
  id: string;
  tenant_id: string;
  learner_id: string;
  medication_name: string;
  dosage_instruction: string;
  frequency_instruction: string;
  route: string;
  start_date: string;
  end_date: string;
  status: string;
  guardian_consent_status: string;
  guardian_consent_by: string | null;
  guardian_consent_at: string | null;
  guardian_consent_note: string | null;
  supporting_document_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  created_at: string;
}

export interface MedicationSchedule {
  id: string;
  tenant_id: string;
  authorization_id: string;
  learner_id: string;
  schedule_times: string[];
  window_minutes: number;
  active: boolean;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  created_at: string;
}

export interface MarRecord {
  id: string;
  tenant_id: string;
  schedule_id: string;
  authorization_id: string;
  learner_id: string;
  scheduled_for: string;
  administered_at: string | null;
  administered_by: string | null;
  outcome: MarOutcome;
  exception_reason: string | null;
  notes: string | null;
  created_at: string;
}

export interface MarCorrection {
  id: string;
  mar_id: string;
  corrected_outcome: MarOutcome;
  correction_reason: string;
  corrected_by: string;
  created_at: string;
}

export interface MedicationIncident {
  id: string;
  tenant_id: string;
  learner_id: string;
  authorization_id: string | null;
  mar_id: string | null;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  reported_by: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  resolution_note: string | null;
  resolved_at: string | null;
  created_at: string;
}

async function notifyLearnerGuardians(
  tx: Tx,
  input: {
    tenantId: string;
    learnerId: string;
    eventType: string;
    idempotencyKey: string;
    title: string;
    body: string;
    actorUserId: string;
  },
): Promise<void> {
  const res = await tx.query<{ user_id: string }>(
    `SELECT public.medication_learner_guardian_users($1::uuid) AS user_id`,
    [input.learnerId],
  );
  const recipients = res.rows.map((r) => r.user_id).filter(Boolean);
  if (recipients.length === 0) return;
  // Privacy-safe generic wording only: never expose medication names or clinical details in push/notification bodies.
  await enqueueNotificationEvent(tx, {
    tenantId: input.tenantId,
    eventType: input.eventType,
    category: "medication",
    idempotencyKey: input.idempotencyKey,
    recipientUserIds: recipients,
    title: input.title,
    body: input.body,
    channels: ["in_app", "push"],
    metadata: { learner_id: input.learnerId },
    createdBy: input.actorUserId,
  });
}

async function assertActiveLearner(tx: Tx, tenantId: string, learnerId: string): Promise<void> {
  const res = await tx.query(`SELECT 1 FROM learners WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL`, [
    tenantId,
    learnerId,
  ]);
  if (!res.rows[0]) throw notFound("Active learner not found");
}

export async function upsertLearnerHealthProfile(
  tx: Tx,
  input: {
    tenantId: string;
    learnerId: string;
    actorUserId: string;
    blood_group?: string | null;
    allergies?: string[];
    chronic_conditions?: string[];
    dietary_notes?: string | null;
    emergency_notes?: string | null;
    ip?: string | null;
  },
): Promise<LearnerHealthProfile> {
  await assertActiveLearner(tx, input.tenantId, input.learnerId);
  const res = await tx.query<LearnerHealthProfile>(
    `INSERT INTO learner_health_profiles (
       tenant_id, learner_id, blood_group, allergies, chronic_conditions, dietary_notes, emergency_notes, updated_by
     ) VALUES ($1, $2, $3, $4::text[], $5::text[], $6, $7, $8)
     ON CONFLICT (tenant_id, learner_id) DO UPDATE SET
       blood_group = COALESCE($3, learner_health_profiles.blood_group),
       allergies = COALESCE($4::text[], learner_health_profiles.allergies),
       chronic_conditions = COALESCE($5::text[], learner_health_profiles.chronic_conditions),
       dietary_notes = COALESCE($6, learner_health_profiles.dietary_notes),
       emergency_notes = COALESCE($7, learner_health_profiles.emergency_notes),
       updated_by = $8,
       row_version = learner_health_profiles.row_version + 1,
       updated_at = now()
     RETURNING id, tenant_id, learner_id, blood_group, allergies, chronic_conditions, dietary_notes, emergency_notes, row_version, updated_at`,
    [
      input.tenantId,
      input.learnerId,
      input.blood_group ?? null,
      input.allergies ?? [],
      input.chronic_conditions ?? [],
      input.dietary_notes ?? null,
      input.emergency_notes ?? null,
      input.actorUserId,
    ],
  );
  await recordSecurityEvent(tx, {
    eventType: "health.profile.upserted",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    ip: input.ip,
    detail: { learnerId: input.learnerId, rowVersion: res.rows[0]!.row_version },
  });
  return res.rows[0]!;
}

export async function getLearnerHealthProfile(tx: Tx, tenantId: string, learnerId: string): Promise<LearnerHealthProfile | null> {
  const res = await tx.query<LearnerHealthProfile>(
    `SELECT id, tenant_id, learner_id, blood_group, allergies, chronic_conditions, dietary_notes, emergency_notes, row_version, updated_at
       FROM learner_health_profiles WHERE tenant_id = $1 AND learner_id = $2`,
    [tenantId, learnerId],
  );
  return res.rows[0] ?? null;
}

export async function createMedicationAuthorization(
  tx: Tx,
  input: {
    tenantId: string;
    learnerId: string;
    actorUserId: string;
    medication_name: string;
    dosage_instruction: string;
    frequency_instruction: string;
    route?: string;
    start_date: string;
    end_date: string;
    supporting_document_id?: string | null;
    ip?: string | null;
  },
): Promise<MedicationAuthorization> {
  await assertActiveLearner(tx, input.tenantId, input.learnerId);
  if (input.end_date < input.start_date) throw validationError("end_date must be on or after start_date");
  if (input.supporting_document_id) {
    const doc = await tx.query(`SELECT status FROM storage_objects WHERE tenant_id = $1 AND id = $2`, [
      input.tenantId,
      input.supporting_document_id,
    ]);
    if (!doc.rows[0] || doc.rows[0].status === "deleted") {
      throw validationError("supporting_document_id must reference a valid storage object in this school");
    }
  }
  const res = await tx.query<MedicationAuthorization>(
    `INSERT INTO medication_authorizations (
       tenant_id, learner_id, medication_name, dosage_instruction, frequency_instruction,
       route, start_date, end_date, status, guardian_consent_status, supporting_document_id, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date, 'pending_consent', 'pending', $9, $10)
     RETURNING id, tenant_id, learner_id, medication_name, dosage_instruction, frequency_instruction, route,
               start_date::text, end_date::text, status, guardian_consent_status, guardian_consent_by,
               guardian_consent_at, guardian_consent_note, supporting_document_id, approved_by, approved_at,
               rejection_reason, created_at`,
    [
      input.tenantId,
      input.learnerId,
      input.medication_name.trim(),
      input.dosage_instruction.trim(),
      input.frequency_instruction.trim(),
      input.route ?? "oral",
      input.start_date,
      input.end_date,
      input.supporting_document_id ?? null,
      input.actorUserId,
    ],
  );
  const row = res.rows[0]!;
  await recordSecurityEvent(tx, {
    eventType: "health.medication_authorization.submitted",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    ip: input.ip,
    detail: { authorizationId: row.id, learnerId: row.learner_id },
  });
  await notifyLearnerGuardians(tx, {
    tenantId: input.tenantId,
    learnerId: input.learnerId,
    eventType: "medication.authorization_submitted",
    idempotencyKey: `med-auth-sub:${row.id}`,
    title: "School health authorization pending consent",
    body: "A medication authorization request requires your review in the FigBloom portal.",
    actorUserId: input.actorUserId,
  });
  return row;
}

export async function recordGuardianConsent(
  tx: Tx,
  input: {
    tenantId: string;
    authorizationId: string;
    guardianUserId: string;
    decision: "granted" | "declined" | "revoked";
    note?: string | null;
    ip?: string | null;
  },
): Promise<MedicationAuthorization> {
  const existing = await tx.query<{ id: string; learner_id: string; status: string }>(
    `SELECT id, learner_id, status FROM medication_authorizations WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.authorizationId],
  );
  const authRow = existing.rows[0];
  if (!authRow) throw notFound("Medication authorization not found");

  // Verify the caller is genuinely linked as a guardian of this learner (via transport_my_children / guardian_links)
  const linked = await tx.query<{ learner_id: string }>(`SELECT public.transport_my_children() AS learner_id`);
  const myChildren = new Set(linked.rows.map((r) => r.learner_id));
  if (!myChildren.has(authRow.learner_id)) {
    throw forbidden("You are not a linked guardian for this learner");
  }

  const nextStatus = input.decision === "declined" ? "rejected" : input.decision === "revoked" ? "revoked" : authRow.status;
  const res = await tx.query<MedicationAuthorization>(
    `UPDATE medication_authorizations
        SET guardian_consent_status = $3,
            guardian_consent_by = $4,
            guardian_consent_at = now(),
            guardian_consent_note = $5,
            status = $6
      WHERE tenant_id = $1 AND id = $2
      RETURNING id, tenant_id, learner_id, medication_name, dosage_instruction, frequency_instruction, route,
                start_date::text, end_date::text, status, guardian_consent_status, guardian_consent_by,
                guardian_consent_at, guardian_consent_note, supporting_document_id, approved_by, approved_at,
                rejection_reason, created_at`,
    [input.tenantId, input.authorizationId, input.decision, input.guardianUserId, input.note ?? null, nextStatus],
  );
  await recordSecurityEvent(tx, {
    eventType: "health.medication_authorization.consent_recorded",
    actorUserId: input.guardianUserId,
    tenantId: input.tenantId,
    ip: input.ip,
    detail: { authorizationId: input.authorizationId, decision: input.decision },
  });
  return res.rows[0]!;
}

export async function reviewMedicationAuthorization(
  tx: Tx,
  input: {
    tenantId: string;
    authorizationId: string;
    actorUserId: string;
    decision: "approved" | "rejected";
    reason?: string | null;
    ip?: string | null;
  },
): Promise<MedicationAuthorization> {
  const existing = await tx.query<{ id: string; learner_id: string; guardian_consent_status: string; status: string }>(
    `SELECT id, learner_id, guardian_consent_status, status FROM medication_authorizations WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.authorizationId],
  );
  const authRow = existing.rows[0];
  if (!authRow) throw notFound("Medication authorization not found");
  if (authRow.status !== "pending_consent") {
    throw conflict(`Only an authorization awaiting review can be reviewed (current status: ${authRow.status})`);
  }
  if (input.decision === "approved" && authRow.guardian_consent_status !== "granted") {
    throw conflict("Guardian consent must be explicitly granted before school approval");
  }
  if (input.decision === "rejected" && (!input.reason || input.reason.trim().length < 3)) {
    throw validationError("A rejection reason (at least 3 characters) is required");
  }

  const res = await tx.query<MedicationAuthorization>(
    `UPDATE medication_authorizations
        SET status = $3,
            approved_by = CASE WHEN $3 = 'approved' THEN $4 ELSE approved_by END,
            approved_at = CASE WHEN $3 = 'approved' THEN now() ELSE approved_at END,
            rejection_reason = CASE WHEN $3 = 'rejected' THEN $5 ELSE rejection_reason END
      WHERE tenant_id = $1 AND id = $2
      RETURNING id, tenant_id, learner_id, medication_name, dosage_instruction, frequency_instruction, route,
                start_date::text, end_date::text, status, guardian_consent_status, guardian_consent_by,
                guardian_consent_at, guardian_consent_note, supporting_document_id, approved_by, approved_at,
                rejection_reason, created_at`,
    [input.tenantId, input.authorizationId, input.decision, input.actorUserId, input.reason?.trim() ?? null],
  );
  const row = res.rows[0]!;
  await recordSecurityEvent(tx, {
    eventType: `health.medication_authorization.${input.decision}`,
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    ip: input.ip,
    detail: { authorizationId: row.id, learnerId: row.learner_id },
  });
  await notifyLearnerGuardians(tx, {
    tenantId: input.tenantId,
    learnerId: row.learner_id,
    eventType: `medication.authorization_${input.decision}`,
    idempotencyKey: `med-auth-rev:${row.id}:${input.decision}`,
    title: input.decision === "approved" ? "Medication authorization approved" : "Medication authorization rejected",
    body: "The status of your child's school health authorization has been updated.",
    actorUserId: input.actorUserId,
  });
  return row;
}

export async function createMedicationSchedule(
  tx: Tx,
  input: {
    tenantId: string;
    authorizationId: string;
    actorUserId: string;
    schedule_times: string[];
    window_minutes?: number;
    ip?: string | null;
  },
): Promise<MedicationSchedule> {
  const authRes = await tx.query<{ id: string; learner_id: string; status: string; guardian_consent_status: string }>(
    `SELECT id, learner_id, status, guardian_consent_status FROM medication_authorizations WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.authorizationId],
  );
  const authRow = authRes.rows[0];
  if (!authRow) throw notFound("Medication authorization not found");
  if (authRow.status !== "approved" || authRow.guardian_consent_status !== "granted") {
    throw conflict("A schedule requires an approved authorization with explicit guardian consent");
  }
  const res = await tx.query<MedicationSchedule>(
    `INSERT INTO medication_schedules (
       tenant_id, authorization_id, learner_id, schedule_times, window_minutes, active, created_by
     ) VALUES ($1, $2, $3, $4::text[], $5, true, $6)
     RETURNING id, tenant_id, authorization_id, learner_id, schedule_times, window_minutes, active, cancelled_at, cancelled_reason, created_at`,
    [input.tenantId, input.authorizationId, authRow.learner_id, input.schedule_times, input.window_minutes ?? 30, input.actorUserId],
  );
  await recordSecurityEvent(tx, {
    eventType: "health.medication_schedule.created",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    ip: input.ip,
    detail: { scheduleId: res.rows[0]!.id, authorizationId: input.authorizationId, learnerId: authRow.learner_id },
  });
  return res.rows[0]!;
}

export async function recordMedicationAdministration(
  tx: Tx,
  input: {
    tenantId: string;
    scheduleId: string;
    actorUserId: string;
    scheduled_for: string;
    administered_at?: string | null;
    outcome: MarOutcome;
    exception_reason?: string | null;
    notes?: string | null;
    ip?: string | null;
  },
): Promise<{ record: MarRecord; replayed: boolean }> {
  const schedRes = await tx.query<{ id: string; authorization_id: string; learner_id: string; active: boolean }>(
    `SELECT id, authorization_id, learner_id, active FROM medication_schedules WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.scheduleId],
  );
  const sched = schedRes.rows[0];
  if (!sched) throw notFound("Medication schedule not found");
  if (!sched.active) throw conflict("Medication schedule is no longer active");
  // Replays of an already-recorded slot stay idempotent; a NEW record is validated by the database guard
  // (slot must be a schedule time, inside the authorization dates, authorization approved with consent granted).
  if (input.outcome !== "administered" && (!input.exception_reason || input.exception_reason.trim().length < 3)) {
    throw validationError("exception_reason (at least 3 characters) is required for non-administered outcomes");
  }

  const ins = await tx.query<MarRecord>(
    `INSERT INTO medication_administration_records (
       tenant_id, schedule_id, authorization_id, learner_id, scheduled_for,
       administered_at, administered_by, outcome, exception_reason, notes
     ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9, $10)
     ON CONFLICT (schedule_id, scheduled_for) DO NOTHING
     RETURNING id, tenant_id, schedule_id, authorization_id, learner_id, scheduled_for,
               administered_at, administered_by, outcome, exception_reason, notes, created_at`,
    [
      input.tenantId,
      sched.id,
      sched.authorization_id,
      sched.learner_id,
      input.scheduled_for,
      input.outcome === "administered" || input.outcome === "delayed" ? input.administered_at ?? new Date().toISOString() : null,
      input.actorUserId,
      input.outcome,
      input.exception_reason?.trim() ?? null,
      input.notes ?? null,
    ],
  );

  if (!ins.rows[0]) {
    const existing = await tx.query<MarRecord>(
      `SELECT id, tenant_id, schedule_id, authorization_id, learner_id, scheduled_for,
              administered_at, administered_by, outcome, exception_reason, notes, created_at
         FROM medication_administration_records
        WHERE tenant_id = $1 AND schedule_id = $2 AND scheduled_for = $3::timestamptz`,
      [input.tenantId, sched.id, input.scheduled_for],
    );
    return { record: existing.rows[0]!, replayed: true };
  }

  const record = ins.rows[0]!;
  await recordSecurityEvent(tx, {
    eventType: "health.mar.recorded",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    ip: input.ip,
    detail: { marId: record.id, scheduleId: sched.id, learnerId: sched.learner_id, outcome: record.outcome },
  });

  if (record.outcome === "missed" || record.outcome === "exception" || record.outcome === "refused") {
    await notifyLearnerGuardians(tx, {
      tenantId: input.tenantId,
      learnerId: sched.learner_id,
      eventType: `medication.mar_${record.outcome}`,
      idempotencyKey: `med-mar-exc:${record.id}`,
      title: "School health schedule update",
      body: "A scheduled health administration exception was recorded. Please check with the school nurse or portal.",
      actorUserId: input.actorUserId,
    });
  }

  return { record, replayed: false };
}

export async function addMarCorrection(
  tx: Tx,
  input: {
    tenantId: string;
    marId: string;
    actorUserId: string;
    corrected_outcome: MarOutcome;
    correction_reason: string;
    ip?: string | null;
  },
): Promise<MarCorrection> {
  const existing = await tx.query(`SELECT id, learner_id FROM medication_administration_records WHERE tenant_id = $1 AND id = $2`, [
    input.tenantId,
    input.marId,
  ]);
  if (!existing.rows[0]) throw notFound("Medication administration record not found");
  const res = await tx.query<MarCorrection>(
    `INSERT INTO medication_administration_corrections (tenant_id, mar_id, corrected_outcome, correction_reason, corrected_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, mar_id, corrected_outcome, correction_reason, corrected_by, created_at`,
    [input.tenantId, input.marId, input.corrected_outcome, input.correction_reason.trim(), input.actorUserId],
  );
  await recordSecurityEvent(tx, {
    eventType: "health.mar.corrected",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    ip: input.ip,
    detail: { marId: input.marId, correctionId: res.rows[0]!.id, correctedOutcome: input.corrected_outcome },
  });
  return res.rows[0]!;
}

export async function listLearnerMar(
  tx: Tx,
  tenantId: string,
  learnerId: string,
): Promise<{ records: MarRecord[]; corrections: MarCorrection[] }> {
  const recs = await tx.query<MarRecord>(
    `SELECT id, tenant_id, schedule_id, authorization_id, learner_id, scheduled_for,
            administered_at, administered_by, outcome, exception_reason, notes, created_at
       FROM medication_administration_records
      WHERE tenant_id = $1 AND learner_id = $2
      ORDER BY scheduled_for DESC, id DESC
      LIMIT 200`,
    [tenantId, learnerId],
  );
  const marIds = recs.rows.map((r) => r.id);
  const corrs =
    marIds.length > 0
      ? await tx.query<MarCorrection>(
          `SELECT id, mar_id, corrected_outcome, correction_reason, corrected_by, created_at
             FROM medication_administration_corrections
            WHERE tenant_id = $1 AND mar_id = ANY($2::uuid[])
            ORDER BY created_at ASC`,
          [tenantId, marIds],
        )
      : { rows: [] as MarCorrection[] };
  return { records: recs.rows, corrections: corrs.rows };
}

export async function reportMedicationIncident(
  tx: Tx,
  input: {
    tenantId: string;
    learnerId: string;
    actorUserId: string;
    authorization_id?: string | null;
    mar_id?: string | null;
    severity: "low" | "medium" | "high" | "critical";
    summary: string;
    ip?: string | null;
  },
): Promise<MedicationIncident> {
  await assertActiveLearner(tx, input.tenantId, input.learnerId);
  const res = await tx.query<MedicationIncident>(
    `INSERT INTO medication_incidents (tenant_id, learner_id, authorization_id, mar_id, severity, summary, reported_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, tenant_id, learner_id, authorization_id, mar_id, severity, summary, reported_by,
               acknowledged_by, acknowledged_at, resolution_note, resolved_at, created_at`,
    [input.tenantId, input.learnerId, input.authorization_id ?? null, input.mar_id ?? null, input.severity, input.summary.trim(), input.actorUserId],
  );
  const inc = res.rows[0]!;
  await recordSecurityEvent(tx, {
    eventType: "health.medication_incident.reported",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    ip: input.ip,
    detail: { incidentId: inc.id, learnerId: inc.learner_id, severity: inc.severity },
  });
  await notifyLearnerGuardians(tx, {
    tenantId: input.tenantId,
    learnerId: input.learnerId,
    eventType: "medication.incident_reported",
    idempotencyKey: `med-inc:${inc.id}`,
    title: "School health incident notice",
    body: "A health incident has been logged for your child. Please contact the school health office for details.",
    actorUserId: input.actorUserId,
  });
  return inc;
}
