import { supabase } from "./supabase";

/**
 * A learner's health and bio details (student_health, see
 * 20261025050000_learner_address_health.sql): allergies, conditions,
 * medication, blood group, diet, support needs, doctor and emergency contact.
 * Staff, the learner's guardians and the learner can read it; admins and
 * guardians can change it. Teachers see a small "Allergy" / "Medical" chip on
 * their class lists from healthFlags().
 */

export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] as const;
export type BloodGroup = (typeof BLOOD_GROUPS)[number];

/** Offered as one-tap chips; anything else can be typed. */
export const COMMON_ALLERGIES = [
  "Peanuts", "Tree nuts", "Milk", "Eggs", "Wheat / gluten", "Soy", "Fish", "Shellfish",
  "Penicillin", "Sulfa drugs", "Bee stings", "Dust", "Pollen",
];

export const COMMON_CONDITIONS = [
  "Asthma", "Epilepsy", "Diabetes", "Sickle cell", "Eczema", "Heart condition", "ADHD", "Hearing impairment", "Visual impairment",
];

export interface StudentHealth {
  student_id: string;
  tenant_id: string;
  allergies: string[];
  medical_conditions: string[];
  medications: string | null;
  blood_group: BloodGroup | null;
  dietary_needs: string | null;
  special_needs: string | null;
  notes: string | null;
  doctor_name: string | null;
  doctor_phone: string | null;
  emergency_name: string | null;
  emergency_relationship: string | null;
  emergency_phone: string | null;
  updated_at: string;
  updated_by: string | null;
}

/** What a form edits: everything but the keys and stamps. */
export type StudentHealthInput = Omit<StudentHealth, "student_id" | "tenant_id" | "updated_at" | "updated_by">;

export function emptyHealth(): StudentHealthInput {
  return {
    allergies: [], medical_conditions: [], medications: null, blood_group: null, dietary_needs: null,
    special_needs: null, notes: null, doctor_name: null, doctor_phone: null,
    emergency_name: null, emergency_relationship: null, emergency_phone: null,
  };
}

/** Trimmed, blanks dropped, repeats (ignoring case) dropped, first spelling kept. */
export function normaliseList(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const v = raw.trim().replace(/\s+/g, " ");
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

/** "peanuts, eggs; dust" -> ["peanuts", "eggs", "dust"] — for a typed or imported list. */
export function splitList(text: string): string[] {
  return normaliseList(text.split(/[,;\n]/));
}

/** The form's values, tidied for saving: lists normalised, blank text as null. */
export function cleanHealthInput(input: StudentHealthInput): StudentHealthInput {
  const t = (v: string | null) => (v && v.trim() ? v.trim() : null);
  return {
    allergies: normaliseList(input.allergies),
    medical_conditions: normaliseList(input.medical_conditions),
    medications: t(input.medications),
    blood_group: input.blood_group && (BLOOD_GROUPS as readonly string[]).includes(input.blood_group) ? input.blood_group : null,
    dietary_needs: t(input.dietary_needs),
    special_needs: t(input.special_needs),
    notes: t(input.notes),
    doctor_name: t(input.doctor_name),
    doctor_phone: t(input.doctor_phone),
    emergency_name: t(input.emergency_name),
    emergency_relationship: t(input.emergency_relationship),
    emergency_phone: t(input.emergency_phone),
  };
}

/** Nothing filled in: not worth saving a row for. */
export function isHealthEmpty(input: StudentHealthInput): boolean {
  const c = cleanHealthInput(input);
  return c.allergies.length === 0 && c.medical_conditions.length === 0
    && Object.entries(c).every(([k, v]) => k === "allergies" || k === "medical_conditions" || v == null);
}

export interface HealthFlags {
  allergy: boolean;
  /** a condition, medication or support need a teacher should know about */
  medical: boolean;
  /** One line for a chip's tooltip / tap: "Allergies: Peanuts, Eggs · Asthma · Takes: inhaler" */
  summary: string;
}

/** What a teacher's class list shows for a learner; null when there's nothing to flag. */
export function healthFlags(h: Pick<StudentHealth, "allergies" | "medical_conditions" | "medications" | "dietary_needs" | "special_needs"> | null | undefined): HealthFlags | null {
  if (!h) return null;
  const allergy = h.allergies.length > 0;
  const medical = h.medical_conditions.length > 0 || !!h.medications?.trim() || !!h.special_needs?.trim();
  if (!allergy && !medical && !h.dietary_needs?.trim()) return null;
  const parts: string[] = [];
  if (allergy) parts.push(`Allergies: ${h.allergies.join(", ")}`);
  if (h.medical_conditions.length) parts.push(h.medical_conditions.join(", "));
  if (h.medications?.trim()) parts.push(`Takes: ${h.medications.trim()}`);
  if (h.dietary_needs?.trim()) parts.push(`Diet: ${h.dietary_needs.trim()}`);
  if (h.special_needs?.trim()) parts.push(`Needs: ${h.special_needs.trim()}`);
  return { allergy, medical, summary: parts.join(" · ") };
}

// ---------------------------------------------------------------- database

export async function fetchStudentHealth(studentId: string): Promise<StudentHealth | null> {
  const { data, error } = await supabase().from("student_health").select("*").eq("student_id", studentId).maybeSingle<StudentHealth>();
  if (error) throw error;
  return data;
}

/** Several learners' records at once (a class list), by student id. Learners with none are absent. */
export async function fetchHealthForStudents(studentIds: string[]): Promise<Map<string, StudentHealth>> {
  const ids = [...new Set(studentIds)];
  const out = new Map<string, StudentHealth>();
  // chunked: a long id list in one URL runs past what the API gateway accepts
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await supabase().from("student_health").select("*").in("student_id", ids.slice(i, i + 150)).returns<StudentHealth[]>();
    if (error) throw error;
    for (const h of data ?? []) out.set(h.student_id, h);
  }
  return out;
}

/** Create or replace a learner's record. */
export async function saveStudentHealth(tenantId: string, studentId: string, input: StudentHealthInput): Promise<StudentHealth> {
  const { data, error } = await supabase().from("student_health")
    .upsert({ tenant_id: tenantId, student_id: studentId, ...cleanHealthInput(input) }, { onConflict: "student_id" })
    .select("*").single<StudentHealth>();
  if (error) throw error;
  return data;
}

/** The form's starting values from a saved record (or a blank form). */
export function healthToInput(h: StudentHealth | null): StudentHealthInput {
  if (!h) return emptyHealth();
  const out = emptyHealth();
  for (const k of Object.keys(out) as (keyof StudentHealthInput)[]) (out as Record<string, unknown>)[k] = h[k] ?? out[k];
  return out;
}
