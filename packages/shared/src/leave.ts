import { supabase } from "./supabase";

export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface LeaveRequest {
  id: string;
  teacher_id: string;
  starts_on: string;
  ends_on: string;
  reason: string | null;
  status: LeaveStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
}

export interface LeaveRequestRow extends LeaveRequest {
  teacherName: string;
}

/** A teacher's own leave history, most recent first. */
export async function fetchMyLeaveRequests(teacherId: string): Promise<LeaveRequest[]> {
  const { data, error } = await supabase()
    .from("leave_requests").select("*").eq("teacher_id", teacherId).order("starts_on", { ascending: false })
    .returns<LeaveRequest[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function requestLeave(input: {
  tenantId: string; teacherId: string; startsOn: string; endsOn: string; reason: string;
}): Promise<void> {
  const { error } = await supabase().from("leave_requests").insert({
    tenant_id: input.tenantId,
    teacher_id: input.teacherId,
    starts_on: input.startsOn,
    ends_on: input.endsOn,
    reason: input.reason.trim() || null,
  });
  if (error) throw new Error(error.message);
}

/** Withdraws a request that's still pending — RLS also enforces this isn't allowed once reviewed. */
export async function cancelLeaveRequest(id: string): Promise<void> {
  const { error } = await supabase().from("leave_requests").update({ status: "cancelled" }).eq("id", id);
  if (error) throw new Error(error.message);
}

/** Every leave request in the school — what the principal's review screen is built from. */
export async function fetchAllLeaveRequests(tenantId: string): Promise<LeaveRequestRow[]> {
  const { data, error } = await supabase()
    .from("leave_requests")
    .select("*, profiles!leave_requests_teacher_id_fkey(full_name)")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .returns<(LeaveRequest & { profiles: { full_name: string } | null })[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({ ...r, teacherName: r.profiles?.full_name ?? "Unknown teacher" }));
}

export async function reviewLeaveRequest(
  id: string, reviewerId: string, status: "approved" | "rejected", note: string,
): Promise<void> {
  const { error } = await supabase().from("leave_requests").update({
    status, reviewed_by: reviewerId, reviewed_at: new Date().toISOString(), review_note: note.trim() || null,
  }).eq("id", id);
  if (error) throw new Error(error.message);
}
