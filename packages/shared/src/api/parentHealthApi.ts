import type { ChildMedical, DoseStatus, MedicationDose, MedicationSchedule, SickBayVisit, VisitOutcome } from "../medical";
import { VISIT_OUTCOMES } from "../medical";
import { apiClient } from "./client";
import { familyTenantId } from "./parentApi";
import type { components } from "./schema";

/**
 * A parent's view of their child's health on apps/api (the API side of `fetchChildMedical` in medical.ts), from
 * `GET .../me/children/{learnerId}/health`.
 *
 * The API's model is not the Supabase app's. A medicine is a medication *authorization* that the school makes and the guardian
 * consents to; the nurse's rounds are *administrations*. So:
 *  - visits, schedules and doses are mapped onto the types the Health page already shows;
 *  - the health profile and the authorizations (with the consent a guardian is asked for) come as `family`, which only the API has;
 *  - there are no sick-bay notices to guardians (finding 15) and no parent-made medicine requests, so `notices` and `requests` are empty
 *    and `parentCapabilities()` hides what would have used them.
 */

type FamilyHealth = components["schemas"]["FamilyHealth"];
export type MedicationAuthorizationView = {
  id: string;
  medication: string;
  dosage: string;
  frequency: string;
  route: string;
  startDate: string;
  endDate: string;
  status: FamilyHealth["medication_authorizations"][number]["status"];
  consent: FamilyHealth["medication_authorizations"][number]["guardian_consent_status"];
  consentAt: string | null;
  rejectionReason: string | null;
};

export interface FamilyHealthView {
  profile: {
    bloodGroup: string | null;
    allergies: string[];
    conditions: string[];
    dietaryNotes: string | null;
    emergencyNotes: string | null;
    updatedAt: string;
  } | null;
  authorizations: MedicationAuthorizationView[];
}

const NAIROBI = "Africa/Nairobi";

/** The school day and time of an instant, on the school's clock (Kenya). */
export function dayAndTime(iso: string): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: NAIROBI, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour") === "24" ? "00" : get("hour")}:${get("minute")}` };
}

const asOutcome = (v: string | null): VisitOutcome | null => ((VISIT_OUTCOMES as readonly string[]).includes(v ?? "") ? (v as VisitOutcome) : null);

export function visitFromFamily(v: FamilyHealth["sick_bay_visits"][number], studentId: string, tenantId: string): SickBayVisit {
  return {
    id: v.id, tenant_id: tenantId, student_id: studentId, time_in: v.time_in, complaint: v.complaint,
    temperature_c: v.temperature_c === null ? null : Number(v.temperature_c), pulse_bpm: v.pulse_bpm, observations: v.observations,
    assessment: v.assessment, treatment: v.treatment, outcome: asOutcome(v.outcome), referred_to: v.referred_to, time_out: v.time_out,
    follow_up: v.follow_up, attendance_mark: null, attendance_marked_at: null, logged_by: null, updated_at: v.time_in, visit_medications: [],
  };
}

const DOSE: Record<string, { status: DoseStatus; label: string }> = {
  administered: { status: "given", label: "Given" },
  delayed: { status: "given", label: "Given late" },
  refused: { status: "refused", label: "Refused" },
  missed: { status: "missed", label: "Missed" },
  held: { status: "missed", label: "Held" },
  exception: { status: "missed", label: "Not given" },
};

export function medicalFromFamily(h: FamilyHealth, studentId: string, tenantId: string): ChildMedical {
  const auths = new Map(h.medication_authorizations.map((a) => [a.id, a]));
  const schedules: MedicationSchedule[] = h.medication_schedules.flatMap((s) => {
    const a = auths.get(s.authorization_id);
    if (!a) return [];
    return [{
      id: s.id, tenant_id: tenantId, student_id: studentId, drug: a.medication_name, dose: a.dosage_instruction, times: s.schedule_times,
      starts_on: a.start_date, ends_on: a.end_date, prescribed_by: "doctor" as const, prescriber: null, notes: a.frequency_instruction,
      stopped_at: a.status === "revoked" || a.status === "expired" ? (a.guardian_consent_at ?? a.created_at) : null, created_at: a.created_at,
    }];
  });
  const scheduleOf = new Map<string, string>();
  for (const s of h.medication_schedules) if (!scheduleOf.has(s.authorization_id)) scheduleOf.set(s.authorization_id, s.id);
  const doses: MedicationDose[] = h.medication_administrations.flatMap((m) => {
    const scheduleId = scheduleOf.get(m.authorization_id);
    if (!scheduleId) return [];
    const when = dayAndTime(m.scheduled_for);
    const outcome = DOSE[m.outcome] ?? { status: "missed" as const, label: m.outcome };
    return [{
      id: m.id, schedule_id: scheduleId, student_id: studentId, due_on: when.day, due_time: when.time, status: outcome.status,
      recorded_at: m.administered_at ?? m.scheduled_for, given_by: null, note: m.exception_reason, label: outcome.label,
    }];
  }).sort((a, b) => `${b.due_on} ${b.due_time}`.localeCompare(`${a.due_on} ${a.due_time}`));
  return {
    visits: h.sick_bay_visits.map((v) => visitFromFamily(v, studentId, tenantId)),
    schedules,
    doses,
    requests: [],
    notices: [],
    family: {
      profile: h.profile ? {
        bloodGroup: h.profile.blood_group, allergies: h.profile.allergies, conditions: h.profile.chronic_conditions,
        dietaryNotes: h.profile.dietary_notes, emergencyNotes: h.profile.emergency_notes, updatedAt: h.profile.updated_at,
      } : null,
      authorizations: h.medication_authorizations.map((a) => ({
        id: a.id, medication: a.medication_name, dosage: a.dosage_instruction, frequency: a.frequency_instruction, route: a.route,
        startDate: a.start_date, endDate: a.end_date, status: a.status, consent: a.guardian_consent_status, consentAt: a.guardian_consent_at,
        rejectionReason: a.rejection_reason,
      })),
    },
  };
}

export async function apiFetchChildMedical(studentId: string): Promise<ChildMedical> {
  const tenantId = familyTenantId();
  const res = await apiClient().get("/v1/tenants/{tenantId}/me/children/{learnerId}/health", { path: { tenantId, learnerId: studentId }, tenantId });
  return medicalFromFamily(res.health, studentId, tenantId);
}

/** A guardian's answer to one medicine the school asked consent for (the existing consent endpoint; a parent may answer for their own child only). */
export async function apiAnswerMedicationConsent(authorizationId: string, decision: "granted" | "declined" | "revoked", note?: string): Promise<void> {
  const tenantId = familyTenantId();
  await apiClient().post("/v1/tenants/{tenantId}/health/medications/authorizations/{authorizationId}/consent", {
    path: { tenantId, authorizationId }, body: note ? { decision, note } : { decision }, tenantId,
  });
}
