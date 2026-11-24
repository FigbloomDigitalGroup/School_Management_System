import { NotOnApiError, type MedicalAccess } from "../capabilities";
import type {
  DoseStatus,
  LearnerHit,
  MedicalRecord,
  MedicationDose,
  NotifyPolicy,
  SickBayVisit,
  SickBayVisitDraft,
  VisitLearnerRef,
  VisitOutcome,
} from "../medical";
import {
  BLOOD_GROUPS,
  cleanHealthInput,
  type BloodGroup,
  type StudentHealth,
  type StudentHealthInput,
} from "../studentHealth";
import { apiClient } from "./client";
import { isApiError } from "./errors";
import { classNamesFor, fetchLearnersById, tolerantRead } from "./learnerNamesApi";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import { activeTenantId } from "./peopleApi";
import type { components } from "./schema";
import { permissionCodes } from "./sessionApi";

/**
 * Sick bay and learner health on apps/api: the API side of medical.ts and studentHealth.ts.
 *
 * Differences from Supabase, handled here rather than in the screens:
 *  - `GET /health/sick-bay/board` returns open visits (`time_out IS NULL`) only; there is no date-range visit list
 *    (`visitHistory: false`, `reports: false`). A visit that has left the sick bay is final.
 *  - `POST /health/sick-bay/visits` takes the learner, the complaint and what was seen and given, and stamps `time_in` itself.
 *    When the nurse also sets an outcome, referral, time out or follow-up on a new visit, `apiLogVisit` follows up with a PATCH.
 *  - `PATCH /health/sick-bay/visits/{visitId}` checks `row_version`; the version each visit was read at is kept here.
 *  - A visit carries a learner id only. Names and classes are looked up for the few visits on the board, which needs the People
 *    area (`resource.learner.read`); without it the board says the name is not shown. `fetchMedicalAccess` tells the screen why.
 *  - `GET/PUT /health/learners/{learnerId}/profile` holds a blood group, allergies, conditions, diet notes and emergency notes,
 *    and needs `resource.medication.read`/`write`, which only school administrators hold (not the Medical area).
 *  - The medication workflow is different (an authorization the family consents to, a schedule, then a record of each dose) and
 *    has no list endpoints, so the round, the requests and the reports are hidden. `GET /health/learners/{id}/medications/mar`
 *    gives one learner's dose records, shown in the learner's medical record.
 */

type ApiSickBayVisit = components["schemas"]["SickBayVisit"];

/** `GET /health/learners/{id}/profile` and `PUT` answer `{ profile }` but the contract leaves the body open, so it is typed here. */
interface ApiHealthProfile {
  tenant_id: string;
  learner_id: string;
  blood_group: string | null;
  allergies: string[];
  chronic_conditions: string[];
  dietary_notes: string | null;
  emergency_notes: string | null;
  updated_at: string;
}

interface ApiMarRecord {
  id: string;
  schedule_id: string;
  learner_id: string;
  scheduled_for: string;
  administered_at?: string | null;
  outcome: string;
  administered_by?: string | null;
  exception_reason?: string | null;
  notes?: string | null;
  created_at?: string;
}

interface ApiMarCorrection {
  mar_id: string;
  corrected_outcome: string;
  created_at: string;
}

/** The learner shown for a visit whose learner the person may not read. */
export const HIDDEN_LEARNER: VisitLearnerRef = { full_name: "Name not shown", admission_no: "", classes: null };

const visitRowVersions = new Map<string, number>();

export function resetMedicalApiCache(): void {
  visitRowVersions.clear();
}

export function sickBayVisitFromApi(v: ApiSickBayVisit, learner?: VisitLearnerRef | null): SickBayVisit {
  visitRowVersions.set(v.id, v.row_version);
  return {
    id: v.id,
    tenant_id: v.tenant_id,
    student_id: v.learner_id,
    time_in: v.time_in,
    complaint: v.complaint,
    temperature_c: v.temperature_c != null ? Number(v.temperature_c) : null,
    pulse_bpm: v.pulse_bpm ?? null,
    observations: v.observations ?? null,
    assessment: v.assessment ?? null,
    treatment: v.treatment ?? null,
    outcome: (v.outcome as VisitOutcome | null | undefined) ?? null,
    referred_to: v.referred_to ?? null,
    time_out: v.time_out ?? null,
    follow_up: v.follow_up ?? null,
    attendance_mark: v.attendance_mark ?? null,
    attendance_marked_at: v.attendance_marked_at ?? null,
    logged_by: v.logged_by ?? null,
    updated_at: v.updated_at,
    students: learner ?? null,
    visit_medications: [],
  };
}

export function studentHealthFromApi(p: ApiHealthProfile): StudentHealth {
  const blood = p.blood_group && (BLOOD_GROUPS as readonly string[]).includes(p.blood_group) ? (p.blood_group as BloodGroup) : null;
  const text = (v: string | null | undefined) => (v && v.trim() ? v : null);
  return {
    student_id: p.learner_id,
    tenant_id: p.tenant_id,
    allergies: Array.isArray(p.allergies) ? p.allergies : [],
    medical_conditions: Array.isArray(p.chronic_conditions) ? p.chronic_conditions : [],
    medications: null,
    blood_group: blood,
    dietary_needs: text(p.dietary_notes),
    special_needs: null,
    notes: text(p.emergency_notes),
    doctor_name: null,
    doctor_phone: null,
    emergency_name: null,
    emergency_relationship: null,
    emergency_phone: null,
    updated_at: p.updated_at,
    updated_by: null,
  };
}

// ---------------------------------------------------------------- what the person may read

/** What the signed-in person may read on the sick bay screen, from their permissions (see MedicalAccess). */
export async function apiFetchMedicalAccess(tenantId?: string): Promise<MedicalAccess> {
  const tid = tenantId ?? activeTenantId();
  let codes: string[];
  try {
    codes = await permissionCodes(tid);
  } catch (err) {
    if (isApiError(err) && err.code === "forbidden") return { learners: false, healthRecords: false };
    throw err;
  }
  return { learners: codes.includes("resource.learner.read"), healthRecords: codes.includes("resource.medication.read") };
}

// ---------------------------------------------------------------- visits

async function listOpenVisits(tenantId: string): Promise<ApiSickBayVisit[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/health/sick-bay/board", {
      path: { tenantId },
      query: { limit: API_PAGE_LIMIT, cursor },
      tenantId,
    });
    return { items: r.visits, page: r.page };
  });
}

/** Names and classes for the learners on the board: one read each, so a few visits cost a few calls. Unreadable ones are left out. */
async function learnerRefs(tenantId: string, learnerIds: readonly string[]): Promise<Map<string, VisitLearnerRef>> {
  const out = new Map<string, VisitLearnerRef>();
  if (learnerIds.length === 0) return out;
  const learners = await fetchLearnersById(tenantId, learnerIds);
  const classes = learners.size
    ? await tolerantRead(() => classNamesFor(tenantId, [...learners.keys()]), new Map<string, string>())
    : new Map<string, string>();
  for (const [id, l] of learners) {
    const className = classes.get(id);
    out.set(id, { full_name: l.full_name, admission_no: l.admission_no, classes: className ? { name: className } : null });
  }
  return out;
}

/** Learners by name or admission number, for the nurse's "who is it" box (the API's own search, eight at most). */
export async function apiFindMedicalLearners(tenantId: string, query: string): Promise<LearnerHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const r = await apiClient().get("/v1/tenants/{tenantId}/learners", {
    path: { tenantId },
    query: { q, active: true, sort: "name", limit: 8 },
    tenantId,
  });
  const classes = await tolerantRead(() => classNamesFor(tenantId, r.learners.map((l) => l.id)), new Map<string, string>());
  return r.learners.map((l) => ({
    id: l.id,
    full_name: l.full_name,
    admission_no: l.admission_no,
    class_name: classes.get(l.id) ?? null,
  }));
}

/** Everyone still in the sick bay, whatever day they came in. */
export async function apiFetchOpenVisits(tenantId: string): Promise<SickBayVisit[]> {
  const visits = await listOpenVisits(tenantId);
  const refs = await learnerRefs(tenantId, visits.map((v) => v.learner_id));
  return visits.map((v) => sickBayVisitFromApi(v, refs.get(v.learner_id) ?? HIDDEN_LEARNER));
}

/** The visit was logged but its outcome could not be saved: the nurse must not log it again. */
function partialVisitError(err: unknown): Error {
  const why = err instanceof Error && err.message ? err.message.replace(/\.$/, "") : "the server refused it";
  return new Error(`The visit was logged, but where the learner went could not be saved (${why}). Close this window and open the visit from "In the sick bay now" to finish it. Do not log it again.`);
}

export async function apiLogVisit(tenantId: string, draft: SickBayVisitDraft): Promise<SickBayVisit> {
  if (!draft.student_id) throw new Error("Pick the learner.");
  const created = await apiClient().post("/v1/tenants/{tenantId}/health/sick-bay/visits", {
    path: { tenantId },
    body: {
      learner_id: draft.student_id,
      complaint: draft.complaint.trim(),
      temperature_c: draft.temperature_c,
      pulse_bpm: draft.pulse_bpm,
      observations: draft.observations.trim() || null,
      assessment: draft.assessment.trim() || null,
      treatment: draft.treatment.trim() || null,
    },
    tenantId,
  });
  let visit = created.visit;
  const hasPatchFields = draft.outcome != null || Boolean(draft.referred_to.trim()) || draft.time_out != null || Boolean(draft.follow_up.trim());
  if (hasPatchFields) {
    // The server stamps the time in, and a time out may not be earlier than it (a database rule): a slow clock here must not break that.
    const timeOut = draft.time_out && draft.time_out < visit.time_in ? visit.time_in : draft.time_out;
    try {
      const patched = await apiClient().patch("/v1/tenants/{tenantId}/health/sick-bay/visits/{visitId}", {
        path: { tenantId, visitId: visit.id },
        body: {
          row_version: visit.row_version,
          outcome: draft.outcome,
          referred_to: draft.referred_to.trim() || null,
          time_out: timeOut,
          follow_up: draft.follow_up.trim() || null,
        },
        tenantId,
      });
      visit = patched.visit;
    } catch (err) {
      throw partialVisitError(err);
    }
  }
  return sickBayVisitFromApi(visit);
}

export async function apiUpdateVisit(id: string, draft: SickBayVisitDraft): Promise<SickBayVisit> {
  const tenantId = activeTenantId();
  const rowVersion = visitRowVersions.get(id);
  const res = await apiClient().patch("/v1/tenants/{tenantId}/health/sick-bay/visits/{visitId}", {
    path: { tenantId, visitId: id },
    body: {
      ...(rowVersion !== undefined ? { row_version: rowVersion } : {}),
      complaint: draft.complaint.trim(),
      temperature_c: draft.temperature_c,
      pulse_bpm: draft.pulse_bpm,
      observations: draft.observations.trim() || null,
      assessment: draft.assessment.trim() || null,
      treatment: draft.treatment.trim() || null,
      outcome: draft.outcome,
      referred_to: draft.referred_to.trim() || null,
      time_out: draft.time_out,
      follow_up: draft.follow_up.trim() || null,
    },
    tenantId,
  });
  return sickBayVisitFromApi(res.visit);
}

// ---------------------------------------------------------------- a learner's health record

export async function apiFetchStudentHealth(studentId: string): Promise<StudentHealth | null> {
  const tenantId = activeTenantId();
  // A refusal is "nothing to show": the screen says why (see MedicalAccess), so it never reads as "no allergies".
  const res = await tolerantRead(
    () => apiClient().get("/v1/tenants/{tenantId}/health/learners/{learnerId}/profile", { path: { tenantId, learnerId: studentId }, tenantId }),
    null,
    ["forbidden", "not_found"],
  );
  const profile = (res as { profile?: ApiHealthProfile | null } | null)?.profile ?? null;
  return profile ? studentHealthFromApi(profile) : null;
}

/** What the API's health record cannot hold, by field, as the screens call them. */
const NOT_STORED: ReadonlyArray<readonly [keyof StudentHealthInput, string]> = [
  ["medications", "medicines taken"], ["special_needs", "support needs"], ["doctor_name", "family doctor"], ["doctor_phone", "family doctor"],
  ["emergency_name", "emergency contact"], ["emergency_relationship", "emergency contact"], ["emergency_phone", "emergency contact"],
];

/**
 * Saves a learner's health record. The API keeps a blood group, allergies, conditions, diet notes and emergency notes. A form that
 * fills in anything else is refused whole, so nothing is dropped without a word. The API keeps the old value when a text field or
 * the blood group is sent as null, so a cleared field is sent as "" (and a cleared blood group as "unknown").
 */
export async function apiSaveStudentHealth(tenantId: string, studentId: string, input: StudentHealthInput): Promise<StudentHealth> {
  const cleaned = cleanHealthInput(input);
  const unsaved = [...new Set(NOT_STORED.filter(([k]) => cleaned[k] != null).map(([, label]) => label))];
  if (unsaved.length > 0) throw new NotOnApiError(`Saving the learner's ${unsaved.join(", ")}`);
  const res = await apiClient().put("/v1/tenants/{tenantId}/health/learners/{learnerId}/profile", {
    path: { tenantId, learnerId: studentId },
    body: {
      blood_group: cleaned.blood_group ?? "unknown",
      allergies: cleaned.allergies,
      chronic_conditions: cleaned.medical_conditions,
      dietary_notes: cleaned.dietary_needs ?? "",
      emergency_notes: cleaned.notes ?? "",
    },
    tenantId,
  });
  const profile = (res as { profile?: ApiHealthProfile }).profile;
  if (!profile) throw new Error("The health record was not returned.");
  return studentHealthFromApi(profile);
}

// ---------------------------------------------------------------- one learner's record

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

function marRecordToDose(r: ApiMarRecord, outcome: string): MedicationDose {
  const at = new Date(r.scheduled_for);
  const status: DoseStatus = outcome === "administered" || outcome === "delayed" ? "given" : outcome === "refused" ? "refused" : "missed";
  return {
    id: r.id,
    schedule_id: r.schedule_id,
    student_id: r.learner_id,
    due_on: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    due_time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
    status,
    recorded_at: r.administered_at ?? r.created_at ?? r.scheduled_for,
    given_by: r.administered_by ?? null,
    note: r.notes ?? r.exception_reason ?? null,
  };
}

/**
 * One learner's record for the nurse: their health record, their open visits, and the dose records of the last 60 days (a
 * correction replaces the outcome it corrects). Schedules and family requests have no read endpoint. A refusal of the health
 * record or the dose records leaves that part empty; the screen says why.
 */
export async function apiOpenMedicalRecord(studentId: string, now: Date = new Date()): Promise<MedicalRecord> {
  const tenantId = activeTenantId();
  const [health, open, mar] = await Promise.all([
    apiFetchStudentHealth(studentId),
    listOpenVisits(tenantId),
    tolerantRead(
      () => apiClient().get("/v1/tenants/{tenantId}/health/learners/{learnerId}/medications/mar", { path: { tenantId, learnerId: studentId }, tenantId }),
      null,
      ["forbidden", "not_found"],
    ),
  ]);
  const body = mar as { records?: ApiMarRecord[]; corrections?: ApiMarCorrection[] } | null;
  const latest = new Map<string, string>();
  for (const c of [...(body?.corrections ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at))) latest.set(c.mar_id, c.corrected_outcome);
  const since = now.getTime() - 60 * DAY_MS;
  const doses: MedicationDose[] = [];
  let otherDoses = 0;
  for (const r of body?.records ?? []) {
    if (new Date(r.scheduled_for).getTime() < since) continue;
    const outcome = latest.get(r.id) ?? r.outcome;
    if (outcome === "held" || outcome === "exception") otherDoses += 1;
    else doses.push(marRecordToDose(r, outcome));
  }
  return {
    health,
    visits: open.filter((v) => v.learner_id === studentId).map((v) => sickBayVisitFromApi(v)),
    schedules: [],
    doses,
    requests: [],
    otherDoses,
  };
}

// ---------------------------------------------------------------- telling families

export async function apiFetchNotifyPolicy(tenantId: string): Promise<NotifyPolicy> {
  const res = await apiClient().get("/v1/tenants/{tenantId}/health/medical-settings", { path: { tenantId }, tenantId });
  return res.settings.notify_guardians;
}

export async function apiSaveNotifyPolicy(tenantId: string, policy: NotifyPolicy): Promise<void> {
  await apiClient().put("/v1/tenants/{tenantId}/health/medical-settings", { path: { tenantId }, body: { notify_guardians: policy }, tenantId });
}
