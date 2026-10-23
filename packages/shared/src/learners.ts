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
  const { data, error } = await supabase().rpc("archive_learners", { p_ids: ids });
  if (error) throw new Error(error.message);
  return data as number;
}

/** Puts archived learners back. Returns how many changed. */
export async function restoreLearners(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
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
  const { data, error } = await supabase().from("students").delete().in("id", ids).select("id");
  if (error) throw new Error(error.message);
  // Row-level security turns a delete it doesn't allow into "0 rows" instead of an error.
  if ((data ?? []).length < ids.length) throw new Error("Only the school admin can delete learners.");
}

/** Learners who have left, most recently archived first. */
export async function fetchArchivedLearners(tenantId: string): Promise<ArchivedLearner[]> {
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
