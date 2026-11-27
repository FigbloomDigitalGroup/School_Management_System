import type { Tx } from "../../db/sql.js";

/**
 * Family reads of one child's clubs, issued items and health (docs/FAMILY-READS.md). The learner id is already proven to
 * be the caller's child (assertMyChild). No staff user id is returned; patrons are names only.
 */

export interface ChildActivity {
  activity_id: string;
  name: string;
  category: string;
  description: string;
  meeting_schedule: string;
  active: boolean;
  role: string | null;
  joined_on: string;
  patrons: string[];
}

export async function childActivities(tx: Tx, input: { tenantId: string; learnerId: string }): Promise<ChildActivity[]> {
  const res = await tx.query<Omit<ChildActivity, "patrons"> & { patrons: string[] | null }>(
    `SELECT a.id AS activity_id, a.name, a.category, a.description, a.meeting_schedule, a.active, m.role, m.joined_on::text AS joined_on,
            (SELECT array_agg(u.full_name ORDER BY u.full_name)
               FROM activity_patrons p JOIN users u ON u.id = p.teacher_user_id
              WHERE p.tenant_id = a.tenant_id AND p.activity_id = a.id) AS patrons
       FROM activity_members m
       JOIN activities a ON a.tenant_id = m.tenant_id AND a.id = m.activity_id
      WHERE m.tenant_id = $1 AND m.learner_id = $2 AND a.archived_at IS NULL
      ORDER BY a.active DESC, a.name, a.id
      LIMIT 200`,
    [input.tenantId, input.learnerId],
  );
  return res.rows.map((r) => ({ ...r, patrons: r.patrons ?? [] }));
}

export interface ChildItem {
  id: string;
  item: { name: string; category: string; asset_tag: string | null };
  quantity: number;
  issued_at: string;
  due_on: string | null;
  status: string;
  condition_out: string | null;
  returned_condition: string | null;
  closed_at: string | null;
}

/** Items issued to the child (books, uniforms, equipment), open ones first. */
export async function childItems(tx: Tx, input: { tenantId: string; learnerId: string }): Promise<ChildItem[]> {
  const res = await tx.query<{
    id: string;
    name: string;
    category: string;
    asset_tag: string | null;
    quantity: number;
    issued_at: Date;
    due_on: string | null;
    status: string;
    condition_out: string | null;
    returned_condition: string | null;
    closed_at: Date | null;
  }>(
    `SELECT i.id, it.name, it.category, it.asset_tag, i.quantity, i.issued_at, i.due_on::text AS due_on, i.status,
            i.condition_out, i.returned_condition, i.closed_at
       FROM inventory_issues i
       JOIN inventory_items it ON it.tenant_id = i.tenant_id AND it.id = i.item_id
      WHERE i.tenant_id = $1 AND i.learner_id = $2
      ORDER BY (i.closed_at IS NULL) DESC, i.issued_at DESC, i.id
      LIMIT 200`,
    [input.tenantId, input.learnerId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    item: { name: r.name, category: r.category, asset_tag: r.asset_tag },
    quantity: r.quantity,
    issued_at: r.issued_at.toISOString(),
    due_on: r.due_on,
    status: r.status,
    condition_out: r.condition_out,
    returned_condition: r.returned_condition,
    closed_at: r.closed_at ? r.closed_at.toISOString() : null,
  }));
}

export interface ChildHealth {
  profile: {
    blood_group: string | null;
    allergies: string[];
    chronic_conditions: string[];
    dietary_notes: string | null;
    emergency_notes: string | null;
    updated_at: string;
  } | null;
  medication_authorizations: Array<{
    id: string;
    medication_name: string;
    dosage_instruction: string;
    frequency_instruction: string;
    route: string;
    start_date: string;
    end_date: string;
    status: string;
    guardian_consent_status: string;
    guardian_consent_at: string | null;
    rejection_reason: string | null;
    created_at: string;
  }>;
  medication_schedules: Array<{ id: string; authorization_id: string; schedule_times: string[]; window_minutes: number }>;
  medication_administrations: Array<{
    id: string;
    authorization_id: string;
    scheduled_for: string;
    administered_at: string | null;
    outcome: string;
    exception_reason: string | null;
  }>;
  sick_bay_visits: Array<{
    id: string;
    time_in: string;
    time_out: string | null;
    complaint: string;
    temperature_c: string | null;
    pulse_bpm: number | null;
    observations: string | null;
    assessment: string | null;
    treatment: string | null;
    outcome: string | null;
    referred_to: string | null;
    follow_up: string | null;
  }>;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * The child's health profile, medication authorizations (with consent status, so the parent can answer through the
 * existing consent endpoint), active schedules, administrations of the last 60 days and the newest 100 sick-bay visits.
 */
export async function childHealth(tx: Tx, input: { tenantId: string; learnerId: string }): Promise<ChildHealth> {
  const p = [input.tenantId, input.learnerId];
  const profile = await tx.query<{
    blood_group: string | null;
    allergies: string[];
    chronic_conditions: string[];
    dietary_notes: string | null;
    emergency_notes: string | null;
    updated_at: Date;
  }>(
    `SELECT blood_group, allergies, chronic_conditions, dietary_notes, emergency_notes, updated_at
       FROM learner_health_profiles WHERE tenant_id = $1 AND learner_id = $2`,
    p,
  );
  const auths = await tx.query<{
    id: string;
    medication_name: string;
    dosage_instruction: string;
    frequency_instruction: string;
    route: string;
    start_date: string;
    end_date: string;
    status: string;
    guardian_consent_status: string;
    guardian_consent_at: Date | null;
    rejection_reason: string | null;
    created_at: Date;
  }>(
    `SELECT id, medication_name, dosage_instruction, frequency_instruction, route, start_date::text AS start_date,
            end_date::text AS end_date, status, guardian_consent_status, guardian_consent_at, rejection_reason, created_at
       FROM medication_authorizations WHERE tenant_id = $1 AND learner_id = $2
      ORDER BY created_at DESC, id
      LIMIT 200`,
    p,
  );
  const schedules = await tx.query<{ id: string; authorization_id: string; schedule_times: string[]; window_minutes: number }>(
    `SELECT id, authorization_id, schedule_times, window_minutes
       FROM medication_schedules WHERE tenant_id = $1 AND learner_id = $2 AND active = true
      ORDER BY created_at DESC, id
      LIMIT 200`,
    p,
  );
  const mar = await tx.query<{
    id: string;
    authorization_id: string;
    scheduled_for: Date;
    administered_at: Date | null;
    outcome: string;
    exception_reason: string | null;
  }>(
    `SELECT id, authorization_id, scheduled_for, administered_at, outcome, exception_reason
       FROM medication_administration_records
      WHERE tenant_id = $1 AND learner_id = $2 AND scheduled_for >= now() - interval '60 days'
      ORDER BY scheduled_for DESC, id
      LIMIT 500`,
    p,
  );
  const visits = await tx.query<{
    id: string;
    time_in: Date;
    time_out: Date | null;
    complaint: string;
    temperature_c: string | null;
    pulse_bpm: number | null;
    observations: string | null;
    assessment: string | null;
    treatment: string | null;
    outcome: string | null;
    referred_to: string | null;
    follow_up: string | null;
  }>(
    `SELECT id, time_in, time_out, complaint, temperature_c::text AS temperature_c, pulse_bpm, observations, assessment,
            treatment, outcome, referred_to, follow_up
       FROM sick_bay_visits WHERE tenant_id = $1 AND learner_id = $2
      ORDER BY time_in DESC, id
      LIMIT 100`,
    p,
  );
  const prof = profile.rows[0];
  return {
    profile: prof
      ? {
          blood_group: prof.blood_group,
          allergies: prof.allergies,
          chronic_conditions: prof.chronic_conditions,
          dietary_notes: prof.dietary_notes,
          emergency_notes: prof.emergency_notes,
          updated_at: prof.updated_at.toISOString(),
        }
      : null,
    medication_authorizations: auths.rows.map((a) => ({ ...a, guardian_consent_at: iso(a.guardian_consent_at), created_at: a.created_at.toISOString() })),
    medication_schedules: schedules.rows,
    medication_administrations: mar.rows.map((m) => ({ ...m, scheduled_for: m.scheduled_for.toISOString(), administered_at: iso(m.administered_at) })),
    sick_bay_visits: visits.rows.map((v) => ({ ...v, time_in: v.time_in.toISOString(), time_out: iso(v.time_out) })),
  };
}
