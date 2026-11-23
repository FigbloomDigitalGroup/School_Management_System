import { apiArchiveLearners, apiFetchArchivedLearners, apiRestoreLearners } from "./api/peopleApi";
import { onApi } from "./backend";
import { NotOnApiError } from "./capabilities";
import { setHealthConsent } from "./healthConsent";
import { supabase } from "./supabase";
import { fetchAllPages } from "./paging";

/**
 * A learner who has left is archived, not deleted: students.active goes false
 * (rosters, attendance, billing and dashboards already honour that) and nothing
 * they own is removed. Only a learner with no records at all (added by mistake,
 * or a bad import) can be deleted outright; the database refuses the rest.
 */

export interface ArchivedLearner {
  id: string;
  admission_no: string;
  full_name: string;
  class_id: string | null;
  boarding: boolean;
  gender: string | null;
  avatar_url: string | null;
  profile_id: string | null;
  archived_at: string | null;
}

/** "1 learner", "3 learners". */
export const learnerCount = (n: number): string => `${n.toLocaleString()} learner${n === 1 ? "" : "s"}`;

/** Takes the learners off class lists, attendance and billing, keeping every record. Returns how many changed. */
export async function archiveLearners(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  if (onApi()) return apiArchiveLearners(ids);
  const { data, error } = await supabase().rpc("archive_learners", { p_ids: ids });
  if (error) throw new Error(error.message);
  return data as number;
}

/** Puts archived learners back. Returns how many changed. */
export async function restoreLearners(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  if (onApi()) return apiRestoreLearners(ids);
  const { data, error } = await supabase().rpc("restore_learners", { p_ids: ids });
  if (error) throw new Error(error.message);
  return data as number;
}

/**
 * Removes learners for good. The database refuses any learner who has
 * attendance, marks, fee records or other history, and says which, so the
 * message is shown as it is. Everything or nothing: one refusal removes none.
 */
export async function deleteLearners(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  if (onApi()) throw new NotOnApiError("Deleting a learner");
  const { data, error } = await supabase().from("students").delete().in("id", ids).select("id");
  if (error) throw new Error(error.message);
  // Row-level security turns a delete it doesn't allow into "0 rows" instead of an error.
  if ((data ?? []).length < ids.length) throw new Error("Only the school admin can delete learners.");
}

/** Learners who have left, most recently archived first. */
export async function fetchArchivedLearners(tenantId: string): Promise<ArchivedLearner[]> {
  if (onApi()) return apiFetchArchivedLearners(tenantId);
  const rows = await fetchAllPages<ArchivedLearner>((from, to) =>
    supabase()
      .from("students")
      .select("id, admission_no, full_name, class_id, boarding, gender, avatar_url, profile_id, archived_at")
      .eq("tenant_id", tenantId)
      .eq("active", false)
      .order("archived_at", { ascending: false, nullsFirst: false })
      .order("id")
      .range(from, to)
      .returns<ArchivedLearner[]>(),
  );
  return rows;
}

export interface LearnerHomeDetails {
  home_address: string | null;
  home_landmark: string | null;
  home_lat: number | null;
  home_lng: number | null;
}

/** A learner's saved home address, landmark, and map coordinates. */
export async function fetchLearnerHome(studentId: string): Promise<LearnerHomeDetails | null> {
  const { data, error } = await supabase()
    .from("students")
    .select("home_address, home_landmark, home_lat, home_lng")
    .eq("id", studentId)
    .maybeSingle<LearnerHomeDetails>();
  if (error) throw new Error(error.message);
  return data ?? null;
}

export interface ActiveLearnerOption {
  id: string;
  full_name: string;
  admission_no: string;
}

/** Active learners at a school (id, name, admission number) for pickers and chat oversight filters. */
export async function fetchActiveLearnerOptions(tenantId: string): Promise<ActiveLearnerOption[]> {
  const { data, error } = await supabase()
    .from("students")
    .select("id, full_name, admission_no")
    .eq("tenant_id", tenantId)
    .eq("active", true)
    .order("full_name")
    .limit(5000);
  if (error) throw new Error(error.message);
  return (data ?? []) as ActiveLearnerOption[];
}

export interface BulkStudentImportRow {
  admission_no: string;
  full_name: string;
  gender: "male" | "female" | null;
  class_id: string;
  boarding: boolean;
  date_of_birth: string | null;
  home_address: string | null;
  home_landmark: string | null;
  home_lat: number | null;
  home_lng: number | null;
  allergies: string[];
  medical_conditions: string[];
  health_consent: { signedBy: string; formDate: string } | null;
}

/**
 * Inserts a batch of imported learners into `students` and, for rows with allergies or conditions,
 * records their signed health consent forms and upserts `student_health`. Still on Supabase (the API
 * path uses `apiImportLearners` in `api/peopleApi.ts`).
 */
export async function bulkInsertStudentsWithHealth(tenantId: string, rows: BulkStudentImportRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const { data: created, error } = await supabase().from("students").insert(
    rows.map((r) => ({
      tenant_id: tenantId,
      admission_no: r.admission_no,
      full_name: r.full_name,
      gender: r.gender,
      class_id: r.class_id,
      boarding: r.boarding,
      date_of_birth: r.date_of_birth,
      active: true,
      home_address: r.home_address,
      home_landmark: r.home_landmark,
      home_lat: r.home_lat,
      home_lng: r.home_lng,
    })),
  ).select("id, admission_no").returns<{ id: string; admission_no: string }[]>();
  if (error) throw error;

  const idByAdmission = new Map((created ?? []).map((c) => [c.admission_no, c.id]));
  const health = rows
    .filter((r) => r.health_consent && (r.allergies.length || r.medical_conditions.length))
    .map((r) => ({
      consent: r.health_consent!,
      row: { tenant_id: tenantId, student_id: idByAdmission.get(r.admission_no), allergies: r.allergies, medical_conditions: r.medical_conditions },
    }))
    .filter((h): h is typeof h & { row: { student_id: string } } => !!h.row.student_id);

  if (health.length) {
    try {
      for (let i = 0; i < health.length; i += 8) {
        await Promise.all(health.slice(i, i + 8).map((h) => setHealthConsent(h.row.student_id, true, h.consent)));
      }
    } catch (err) {
      throw new Error(`The learners were imported, but their health consent forms didn't save: ${err instanceof Error ? err.message : String(err)}`);
    }
    const { error: healthErr } = await supabase().from("student_health").upsert(health.map((h) => h.row), { onConflict: "student_id" });
    if (healthErr) throw new Error(`The learners were imported, but their allergies and conditions didn't save: ${healthErr.message}`);
  }
  return rows.length;
}

/** A profile's full name and role, e.g. for "last updated by" stamps. */
export async function fetchProfileDisplayName(profileId: string): Promise<{ full_name: string; role: string } | null> {
  const { data, error } = await supabase()
    .from("profiles")
    .select("full_name, role")
    .eq("id", profileId)
    .maybeSingle<{ full_name: string; role: string }>();
  if (error) throw new Error(error.message);
  return data ?? null;
}

export interface LearnerHomeAndTransport {
  home: LearnerHomeDetails & { boarding: boolean };
  transport: { route_id: string; stop_id: string | null } | null;
}

/** A learner's saved home details (with boarding flag) and current bus assignment, for Manage learner. */
export async function fetchLearnerHomeAndTransport(studentId: string): Promise<LearnerHomeAndTransport> {
  const [{ data: home, error: sErr }, { data: transport, error: tErr }] = await Promise.all([
    supabase()
      .from("students")
      .select("home_address, home_landmark, home_lat, home_lng, boarding")
      .eq("id", studentId)
      .single<LearnerHomeDetails & { boarding: boolean }>(),
    supabase()
      .from("student_transport")
      .select("route_id, stop_id")
      .eq("student_id", studentId)
      .maybeSingle<{ route_id: string; stop_id: string | null }>(),
  ]);
  if (sErr) throw sErr;
  if (tErr) throw tErr;
  return { home, transport };
}
