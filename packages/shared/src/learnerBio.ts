import { supabase } from "./supabase";

/**
 * A learner's bio data (20261027040000_parent_bio_data.sql): the identity
 * details a school registers them by, and everyday details a family keeps
 * up to date. Guardians and admins save both through set_child_bio(); a
 * guardian's identity changes wait for the office as a student_bio_requests
 * row, an admin's apply at once. Health and home have their own editors
 * (studentHealth.ts, set_child_home).
 */

/** Changing these from home needs the office's approval: they go on report cards, exam registration and NEMIS. */
export const BIO_IDENTITY_FIELDS = ["full_name", "date_of_birth", "gender", "birth_cert_no", "upi_no"] as const;
/** A guardian's change to these applies straight away. */
export const BIO_EVERYDAY_FIELDS = ["nationality", "religion", "previous_school"] as const;

export type BioIdentityField = (typeof BIO_IDENTITY_FIELDS)[number];
export type BioEverydayField = (typeof BIO_EVERYDAY_FIELDS)[number];
export type BioField = BioIdentityField | BioEverydayField;

export const BIO_FIELD_LABELS: Record<BioField, string> = {
  full_name: "Full name",
  date_of_birth: "Date of birth",
  gender: "Gender",
  birth_cert_no: "Birth certificate number",
  upi_no: "NEMIS UPI number",
  nationality: "Nationality",
  religion: "Religion",
  previous_school: "Previous school",
};

export interface LearnerBio {
  full_name: string;
  date_of_birth: string | null;
  gender: "male" | "female" | null;
  birth_cert_no: string | null;
  upi_no: string | null;
  nationality: string | null;
  religion: string | null;
  previous_school: string | null;
  bio_updated_at: string | null;
  bio_updated_by: string | null;
}

/** What a form edits. */
export type LearnerBioInput = Omit<LearnerBio, "bio_updated_at" | "bio_updated_by">;

export interface BioRequest {
  id: string;
  tenant_id: string;
  student_id: string;
  requested_by: string | null;
  changes: Partial<Record<BioIdentityField, string | null>>;
  previous: Partial<Record<BioIdentityField, string | null>>;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
  created_at: string;
}

/** Tidied the way set_child_bio() stores it, so a form can tell what actually changed. */
export function cleanBioValue(field: BioField, value: string | null | undefined): string | null {
  const v = (value ?? "").trim().replace(/\s+/g, " ");
  if (!v) return null;
  if (field === "birth_cert_no" || field === "upi_no") return v.replace(/\s/g, "").toUpperCase();
  return v;
}

/** The fields whose cleaned value differs from what's saved, cleaned. */
export function bioChanges(saved: LearnerBioInput, edited: LearnerBioInput): Partial<LearnerBioInput> {
  const out: Record<string, string | null> = {};
  for (const f of [...BIO_IDENTITY_FIELDS, ...BIO_EVERYDAY_FIELDS] as BioField[]) {
    const next = cleanBioValue(f, edited[f]);
    if (next !== cleanBioValue(f, saved[f])) out[f] = next;
  }
  return out as Partial<LearnerBioInput>;
}

/** Changes split the way a guardian's save will go: applied now, or sent to the office. */
export function splitBioChanges(changes: Partial<LearnerBioInput>): { now: BioField[]; approval: BioField[] } {
  const keys = Object.keys(changes) as BioField[];
  return {
    now: keys.filter((k) => (BIO_EVERYDAY_FIELDS as readonly string[]).includes(k)),
    approval: keys.filter((k) => (BIO_IDENTITY_FIELDS as readonly string[]).includes(k)),
  };
}

/** Problems the database would refuse, in words, or null. */
export function bioProblem(input: LearnerBioInput, today: Date = new Date()): string | null {
  if (!cleanBioValue("full_name", input.full_name)) return "The learner needs a name.";
  if (input.date_of_birth) {
    const d = new Date(`${input.date_of_birth}T00:00:00`);
    if (Number.isNaN(d.getTime())) return "That date of birth is not a date.";
    const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (d > t || d.getFullYear() < 1900) return "That date of birth is not possible.";
  }
  if ((cleanBioValue("birth_cert_no", input.birth_cert_no) ?? "").length > 30) return "The birth certificate number is too long.";
  if ((cleanBioValue("upi_no", input.upi_no) ?? "").length > 20) return "The UPI number is too long.";
  return null;
}

/** A stored value as a person reads it: "12 Mar 2014", "Female", "Not set". */
export function bioValueLabel(field: BioField, value: string | null | undefined): string {
  if (!value) return "Not set";
  if (field === "gender") return value === "female" ? "Female" : value === "male" ? "Male" : value;
  if (field === "date_of_birth") {
    const d = new Date(`${value}T00:00:00`);
    return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }
  return value;
}

/** "Date of birth, Birth certificate number" for a list of fields. */
export const bioFieldList = (fields: string[]): string =>
  fields.map((f) => BIO_FIELD_LABELS[f as BioField] ?? f).join(", ");

export function bioToInput(b: LearnerBio): LearnerBioInput {
  return {
    full_name: b.full_name, date_of_birth: b.date_of_birth, gender: b.gender, birth_cert_no: b.birth_cert_no,
    upi_no: b.upi_no, nationality: b.nationality, religion: b.religion, previous_school: b.previous_school,
  };
}

// ---------------------------------------------------------------- database

const BIO_COLUMNS = "full_name, date_of_birth, gender, birth_cert_no, upi_no, nationality, religion, previous_school, bio_updated_at, bio_updated_by";

export async function fetchLearnerBio(studentId: string): Promise<LearnerBio> {
  const { data, error } = await supabase().from("students").select(BIO_COLUMNS).eq("id", studentId).single<LearnerBio>();
  if (error) throw new Error(error.message);
  return data;
}

/** Save the changed fields. Returns which were applied and which went to the office. */
export async function saveLearnerBio(studentId: string, changes: Partial<LearnerBioInput>): Promise<{ saved: string[]; pending: string[] }> {
  const { data, error } = await supabase().rpc("set_child_bio", { p_student_id: studentId, p_bio: changes });
  if (error) throw new Error(error.message);
  return data as { saved: string[]; pending: string[] };
}

/** The learner's open request, if any. */
export async function fetchPendingBioRequest(studentId: string): Promise<BioRequest | null> {
  const { data, error } = await supabase().from("student_bio_requests").select("*")
    .eq("student_id", studentId).eq("status", "pending").maybeSingle<BioRequest>();
  if (error) throw new Error(error.message);
  return data;
}

export interface PendingBioRequest extends BioRequest {
  student_name: string;
  requester_name: string | null;
}

/** Every open request at a school, oldest first, with who it's for and who asked. */
export async function fetchPendingBioRequests(tenantId: string): Promise<PendingBioRequest[]> {
  const sb = supabase();
  const { data, error } = await sb.from("student_bio_requests").select("*")
    .eq("tenant_id", tenantId).eq("status", "pending").order("created_at").returns<BioRequest[]>();
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  if (rows.length === 0) return [];
  const studentIds = [...new Set(rows.map((r) => r.student_id))];
  const profileIds = [...new Set(rows.map((r) => r.requested_by).filter((x): x is string => !!x))];
  const [students, profiles] = await Promise.all([
    sb.from("students").select("id, full_name").in("id", studentIds).returns<{ id: string; full_name: string }[]>(),
    profileIds.length
      ? sb.from("profiles").select("id, full_name").in("id", profileIds).returns<{ id: string; full_name: string }[]>()
      : Promise.resolve({ data: [] as { id: string; full_name: string }[], error: null }),
  ]);
  if (students.error) throw new Error(students.error.message);
  if (profiles.error) throw new Error(profiles.error.message);
  const studentName = new Map((students.data ?? []).map((s) => [s.id, s.full_name]));
  const profileName = new Map((profiles.data ?? []).map((p) => [p.id, p.full_name]));
  return rows.map((r) => ({
    ...r,
    student_name: studentName.get(r.student_id) ?? "A learner",
    requester_name: r.requested_by ? profileName.get(r.requested_by) ?? null : null,
  }));
}

/** The office approves or rejects; the guardian who asked can withdraw (approve false). */
export async function decideBioRequest(requestId: string, approve: boolean, note?: string): Promise<void> {
  const { error } = await supabase().rpc("decide_bio_request", { p_request_id: requestId, p_approve: approve, p_note: note ?? null });
  if (error) throw new Error(error.message);
}

export interface LearnerGuardianContact {
  profile_id: string;
  relationship: "mother" | "father" | "guardian";
  full_name: string;
  phone: string | null;
  alt_phone: string | null;
  /** Their contact email, if any: where "Send sign-in details again" goes. */
  email: string | null;
}

/** The learner's guardians and how to reach them, for the office. */
export async function fetchLearnerGuardians(studentId: string): Promise<LearnerGuardianContact[]> {
  const { data, error } = await supabase().from("guardians")
    .select("profile_id, relationship, profiles(full_name, phone, alt_phone, email)").eq("student_id", studentId)
    .returns<{ profile_id: string; relationship: LearnerGuardianContact["relationship"]; profiles: { full_name: string; phone: string | null; alt_phone: string | null; email: string | null } | null }[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map((g) => ({
    profile_id: g.profile_id,
    relationship: g.relationship,
    full_name: g.profiles?.full_name ?? "Guardian",
    phone: g.profiles?.phone ?? null,
    alt_phone: g.profiles?.alt_phone ?? null,
    email: g.profiles?.email ?? null,
  }));
}
