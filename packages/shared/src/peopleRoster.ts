import { fetchAllRows } from "./paging";
import { supabase } from "./supabase";
import type { ClassGroup, Profile, Student, Subject } from "./types";

/**
 * The admin People screen's roster and the edits made from it: learners, staff, their current-term fee balances and the
 * subjects teachers are qualified for. These reads and writes were inline in the web's admin/People screen; they live here
 * so screens ask for people data by name and never query the tables themselves (one place to change when the backend
 * behind them does).
 *
 * Every function throws on a failed query: a read that failed must not look like an empty roster.
 */

/** A learner on the roster. `login_id` comes from their profile, when they have one. */
export type RosterLearner = Pick<Student, "id" | "admission_no" | "full_name" | "class_id" | "boarding" | "gender"> & {
  avatar_url: string | null;
  profile_id: string | null;
  login_id: string | null;
  archived_at?: string | null;
};

/** A staff member on the roster: school admins, teachers, drivers and other staff. */
export type RosterStaff = Pick<Profile, "id" | "full_name" | "role" | "staff_title" | "email" | "phone" | "login_id" | "photo_changed_at" | "handles_visitors"> & {
  avatar_url: string | null;
};

export interface PeopleRoster {
  classes: Pick<ClassGroup, "id" | "name">[];
  students: RosterLearner[];
  staff: RosterStaff[];
  /** Current-term invoice per learner, in cents; a learner with none is missing. */
  feeByStudent: Map<string, { total: number; paid: number }>;
  subjects: Subject[];
  subjectIdsByTeacher: Map<string, string[]>;
}

const STAFF_ROLES = ["school_admin", "teacher", "driver", "staff"] as const;

type InvoiceRow = { student_id: string; total_cents: number; paid_cents: number };

/** Everyone in the school, with what the People screen shows beside them. */
export async function fetchPeopleRoster(tenantId: string): Promise<PeopleRoster> {
  const sb = supabase();
  const { data: term, error: termError } = await sb.from("terms").select("id").eq("tenant_id", tenantId).eq("is_current", true).maybeSingle<{ id: string }>();
  if (termError) throw new Error(termError.message);

  const results = await Promise.all([
    sb.from("classes").select("id,name").eq("tenant_id", tenantId).order("name").returns<Pick<ClassGroup, "id" | "name">[]>(),
    // The API answers at most 1,000 rows and says nothing when it stops, so the learners, their invoices and their logins are read
    // a page at a time (FIG-1416). A stable order (name, then id) keeps the pages from overlapping.
    fetchAllRows<Omit<RosterLearner, "login_id">>((from, to) => sb
      .from("students").select("id,admission_no,full_name,gender,class_id,boarding,avatar_url,profile_id").eq("tenant_id", tenantId).eq("active", true)
      .order("full_name").order("id").range(from, to).returns<Omit<RosterLearner, "login_id">[]>()),
    sb.from("profiles").select("id,full_name,role,staff_title,email,phone,login_id,avatar_url,photo_changed_at,handles_visitors")
      .eq("tenant_id", tenantId).in("role", [...STAFF_ROLES]).order("full_name").returns<RosterStaff[]>(),
    term
      ? fetchAllRows<InvoiceRow>((from, to) => sb
        .from("fee_invoices").select("student_id,total_cents,paid_cents").eq("tenant_id", tenantId).eq("term_id", term.id)
        .order("id").range(from, to).returns<InvoiceRow[]>())
      : Promise.resolve({ data: [] as InvoiceRow[], error: null }),
    sb.from("subjects").select("*").eq("tenant_id", tenantId).order("name").returns<Subject[]>(),
    sb.from("teacher_subjects").select("teacher_id, subject_id").eq("tenant_id", tenantId).returns<{ teacher_id: string; subject_id: string }[]>(),
    fetchAllRows<{ id: string; login_id: string | null }>((from, to) => sb
      .from("profiles").select("id,login_id").eq("tenant_id", tenantId).eq("role", "student")
      .order("id").range(from, to).returns<{ id: string; login_id: string | null }[]>()),
  ]);
  // A failed read must say so, not show up as an empty list: a column the database doesn't have yet (a migration not
  // pushed) otherwise looks like "no staff".
  const failed = results.find((r) => r.error);
  if (failed?.error) throw new Error(failed.error.message);
  const [{ data: classRows }, { data: studentRows }, { data: staffRows }, { data: invoiceRows }, { data: subjectRows }, { data: teacherSubjectRows }, { data: studentProfileRows }] = results;

  const feeByStudent = new Map<string, { total: number; paid: number }>();
  for (const inv of invoiceRows ?? []) feeByStudent.set(inv.student_id, { total: inv.total_cents, paid: inv.paid_cents });

  const loginIdByProfile = new Map<string, string | null>();
  for (const p of studentProfileRows ?? []) loginIdByProfile.set(p.id, p.login_id);

  const subjectIdsByTeacher = new Map<string, string[]>();
  for (const row of teacherSubjectRows ?? []) {
    const ids = subjectIdsByTeacher.get(row.teacher_id) ?? [];
    ids.push(row.subject_id);
    subjectIdsByTeacher.set(row.teacher_id, ids);
  }

  return {
    classes: classRows ?? [],
    students: (studentRows ?? []).map((s) => ({ ...s, login_id: s.profile_id ? loginIdByProfile.get(s.profile_id) ?? null : null })),
    staff: staffRows ?? [],
    feeByStudent,
    subjects: subjectRows ?? [],
    subjectIdsByTeacher,
  };
}

export interface NewLearner {
  tenantId: string;
  admissionNo: string;
  fullName: string;
  gender: "male" | "female";
  classId: string;
  boarding: boolean;
  /** yyyy-mm-dd, or null when not known. */
  dateOfBirth: string | null;
  home: { address: string | null; landmark: string | null; lat: number | null; lng: number | null };
}

/** Admit a learner. Gives the new learner's id. */
export async function addLearner(input: NewLearner): Promise<string> {
  const { data, error } = await supabase().from("students").insert({
    tenant_id: input.tenantId,
    admission_no: input.admissionNo,
    full_name: input.fullName,
    gender: input.gender,
    class_id: input.classId,
    boarding: input.boarding,
    date_of_birth: input.dateOfBirth,
    active: true,
    home_address: input.home.address,
    home_landmark: input.home.landmark,
    home_lat: input.home.lat,
    home_lng: input.home.lng,
  }).select("id").single<{ id: string }>();
  if (error) throw new Error(error.message);
  return data.id;
}

export async function updateLearnerDetails(
  studentId: string,
  change: { fullName: string; admissionNo: string; gender: "male" | "female" | null; classId: string | null; boarding: boolean },
): Promise<void> {
  const { error } = await supabase().from("students").update({
    full_name: change.fullName,
    admission_no: change.admissionNo,
    gender: change.gender,
    class_id: change.classId,
    boarding: change.boarding,
  }).eq("id", studentId);
  if (error) throw new Error(error.message);
}

export async function updateStaffDetails(profileId: string, change: { fullName: string; staffTitle: string | null; phone: string | null }): Promise<void> {
  const { error } = await supabase().from("profiles").update({
    full_name: change.fullName,
    staff_title: change.staffTitle,
    phone: change.phone,
  }).eq("id", profileId);
  if (error) throw new Error(error.message);
}

/**
 * An admin's answer to a photo a staff member changed themselves: keep it (clears the flag) or take it down (removing the
 * photo clears the flag too, guard_profile_self_edit).
 */
export async function reviewStaffPhoto(profileId: string, remove: boolean): Promise<void> {
  const { error } = await supabase().from("profiles")
    .update(remove ? { avatar_url: null } : { photo_changed_at: null }).eq("id", profileId);
  if (error) throw new Error(error.message);
}

/** Mark a teacher qualified, or no longer qualified, to teach a subject. */
export async function setTeacherQualified(input: { tenantId: string; teacherId: string; subjectId: string; qualified: boolean }): Promise<void> {
  const { error } = input.qualified
    ? await supabase().from("teacher_subjects").insert({ tenant_id: input.tenantId, teacher_id: input.teacherId, subject_id: input.subjectId })
    : await supabase().from("teacher_subjects").delete().eq("teacher_id", input.teacherId).eq("subject_id", input.subjectId);
  if (error) throw new Error(error.message);
}
