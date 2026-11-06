import { formatShortDate } from "./parentData";
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
  /** 'hr': approved (or cancelled) in Figbloom HR and written by its event (20261105800000); 'schools': the office's */
  source?: "schools" | "hr";
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

export const LEAVE_STATUS_LABEL: Record<LeaveStatus, string> = {
  pending: "Awaiting review", approved: "Approved", rejected: "Rejected", cancelled: "Cancelled",
};

export type LeaveTone = "ok" | "warn" | "muted";
export const LEAVE_STATUS_TONE: Record<LeaveStatus, LeaveTone> = {
  pending: "warn", approved: "ok", rejected: "muted", cancelled: "muted",
};

/** Requests awaiting review, and everything else (reviewed or withdrawn), each in the order given. */
export function splitLeaveRequests<T extends Pick<LeaveRequest, "status">>(requests: readonly T[]): { pending: T[]; decided: T[] } {
  return { pending: requests.filter((r) => r.status === "pending"), decided: requests.filter((r) => r.status !== "pending") };
}

/**
 * Approves or rejects a request and tells the teacher in the app (the same `user`-audience notice a promotion sends), so
 * nobody finds out only by asking. The decision is recorded first; if only the notice fails, the decision stands and
 * `notifyError` says why the teacher was not told.
 */
export async function decideLeaveRequest(input: {
  tenantId: string;
  reviewerId: string;
  request: Pick<LeaveRequestRow, "id" | "teacher_id" | "starts_on" | "ends_on">;
  status: "approved" | "rejected";
  note: string;
}): Promise<{ notifyError: string | null }> {
  const { tenantId, reviewerId, request: r, status, note } = input;
  await reviewLeaveRequest(r.id, reviewerId, status, note);
  const dates = `${formatShortDate(r.starts_on)} to ${formatShortDate(r.ends_on)}`;
  const { error } = await supabase().from("announcements").insert({
    tenant_id: tenantId,
    author_id: reviewerId,
    subject: status === "approved" ? "Your leave request was approved" : "Your leave request was not approved",
    body: (status === "approved" ? `Your leave from ${dates} has been approved.` : `Your leave from ${dates} was not approved.`)
      + (note.trim() ? ` Note: ${note.trim()}` : ""),
    audience: { kind: "user", user_id: r.teacher_id },
    channels: ["in_app"],
    published_at: new Date().toISOString(),
  });
  return { notifyError: error?.message ?? null };
}

export async function reviewLeaveRequest(
  id: string, reviewerId: string, status: "approved" | "rejected", note: string,
): Promise<void> {
  const { error } = await supabase().from("leave_requests").update({
    status, reviewed_by: reviewerId, reviewed_at: new Date().toISOString(), review_note: note.trim() || null,
  }).eq("id", id);
  if (error) throw new Error(error.message);
}
