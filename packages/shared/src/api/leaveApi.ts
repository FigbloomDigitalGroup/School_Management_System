import type { LeaveRequest, LeaveRequestRow, LeaveStatus } from "../leave";
import { formatShortDate } from "../parentData";
import { apiClient } from "./client";
import { isApiError, userMessage } from "./errors";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import { activeTenantId } from "./peopleApi";
import type { components } from "./schema";

/**
 * Leave requests on apps/api: the API side of leave.ts.
 *
 * Differences from Supabase, handled here rather than in the screens:
 *  - The API names a rejected request "declined"; this maps it to/from the domain's "rejected".
 *  - Dates are named `start_on` / `end_on` on the API and `starts_on` / `ends_on` in the domain model.
 *  - `GET /leave-requests` returns only the caller's own requests without `resource.leave.read`, and every
 *    request in the school with it. `apiFetchMyLeaveRequests` filters by `teacherId` so a teacher who also
 *    holds the Leave admin area still sees only their own requests on their Leave page.
 *  - `POST /leave-requests` requires a reason of at least 3 characters (trimmed).
 *  - `LeaveRequest` carries `staff_user_id` without a name, so `apiFetchAllLeaveRequests` resolves names from
 *    `/staff` (all staff, active or archived) and tolerates 403 when a leave-only reviewer cannot read staff.
 *  - Reviewing does not send an announcement on the server; `apiDecideLeaveRequest` posts and publishes an
 *    in-app `user`-audience announcement and returns `{ notifyError }` if only that step fails.
 */

type ApiLeaveRequest = components["schemas"]["LeaveRequest"];

/** Minimum trimmed length for `reason` accepted by `POST /v1/tenants/{tenantId}/leave-requests`. */
export const API_LEAVE_REASON_MIN = 3;

export function leaveStatusFromApi(status: ApiLeaveRequest["status"]): LeaveStatus {
  return status === "declined" ? "rejected" : status;
}

export function leaveRequestFromApi(r: ApiLeaveRequest): LeaveRequest {
  return {
    id: r.id,
    teacher_id: r.staff_user_id,
    starts_on: r.start_on,
    ends_on: r.end_on,
    reason: r.reason,
    status: leaveStatusFromApi(r.status),
    reviewed_by: r.reviewed_by ?? null,
    reviewed_at: r.reviewed_at ?? null,
    review_note: r.review_note ?? null,
    created_at: r.created_at,
    source: "schools",
  };
}

async function listApiLeaveRequests(tenantId: string): Promise<ApiLeaveRequest[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/leave-requests", {
      path: { tenantId },
      query: { limit: API_PAGE_LIMIT, cursor },
      tenantId,
    });
    return { items: r.leave_requests, page: r.page };
  });
}

async function staffNamesByUserId(tenantId: string): Promise<Map<string, string>> {
  try {
    const staff = await listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/staff", {
        path: { tenantId },
        query: { limit: API_PAGE_LIMIT, cursor },
        tenantId,
      });
      return { items: r.staff, page: r.page };
    });
    const out = new Map<string, string>();
    for (const s of staff) {
      if (s.userId) out.set(s.userId, s.full_name);
    }
    return out;
  } catch (err) {
    if (isApiError(err) && err.code === "forbidden") return new Map();
    throw err;
  }
}

export async function apiFetchMyLeaveRequests(teacherId: string): Promise<LeaveRequest[]> {
  const tenantId = activeTenantId();
  const rows = await listApiLeaveRequests(tenantId);
  return rows
    .filter((r) => r.staff_user_id === teacherId)
    .map(leaveRequestFromApi)
    .sort((a, b) => b.starts_on.localeCompare(a.starts_on) || b.created_at.localeCompare(a.created_at));
}

export async function apiRequestLeave(input: {
  tenantId: string;
  teacherId: string;
  startsOn: string;
  endsOn: string;
  reason: string;
}): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length < API_LEAVE_REASON_MIN) {
    throw new Error(`Give a short reason (at least ${API_LEAVE_REASON_MIN} characters).`);
  }
  await apiClient().post("/v1/tenants/{tenantId}/leave-requests", {
    path: { tenantId: input.tenantId },
    body: {
      start_on: input.startsOn,
      end_on: input.endsOn,
      reason,
    },
    tenantId: input.tenantId,
  });
}

export async function apiCancelLeaveRequest(id: string): Promise<void> {
  const tenantId = activeTenantId();
  await apiClient().post("/v1/tenants/{tenantId}/leave-requests/{leaveId}/cancel", {
    path: { tenantId, leaveId: id },
    tenantId,
  });
}

export async function apiFetchAllLeaveRequests(tenantId: string): Promise<LeaveRequestRow[]> {
  const [rows, names] = await Promise.all([
    listApiLeaveRequests(tenantId),
    staffNamesByUserId(tenantId),
  ]);
  return rows.map((r) => ({
    ...leaveRequestFromApi(r),
    teacherName: names.get(r.staff_user_id) ?? "Unknown teacher",
  }));
}

export async function apiReviewLeaveRequest(
  id: string,
  _reviewerId: string,
  status: "approved" | "rejected",
  note: string,
  tenantId: string = activeTenantId(),
): Promise<void> {
  await apiClient().post("/v1/tenants/{tenantId}/leave-requests/{leaveId}/review", {
    path: { tenantId, leaveId: id },
    body: {
      status: status === "rejected" ? "declined" : "approved",
      review_note: note.trim() || null,
    },
    tenantId,
  });
}

export async function apiDecideLeaveRequest(input: {
  tenantId: string;
  reviewerId: string;
  request: Pick<LeaveRequestRow, "id" | "teacher_id" | "starts_on" | "ends_on">;
  status: "approved" | "rejected";
  note: string;
}): Promise<{ notifyError: string | null }> {
  const { tenantId, reviewerId, request: r, status, note } = input;
  await apiReviewLeaveRequest(r.id, reviewerId, status, note, tenantId);
  const dates = `${formatShortDate(r.starts_on)} to ${formatShortDate(r.ends_on)}`;
  const subject = status === "approved" ? "Your leave request was approved" : "Your leave request was not approved";
  const body = (status === "approved" ? `Your leave from ${dates} has been approved.` : `Your leave from ${dates} was not approved.`)
    + (note.trim() ? ` Note: ${note.trim()}` : "");
  try {
    const created = await apiClient().post("/v1/tenants/{tenantId}/communications/announcements", {
      path: { tenantId },
      body: {
        subject,
        body,
        audience: { kind: "user", user_id: r.teacher_id },
        channels: ["in_app"],
      },
      tenantId,
    });
    await apiClient().post("/v1/tenants/{tenantId}/communications/announcements/{announcementId}/publish", {
      path: { tenantId, announcementId: created.announcement.id },
      tenantId,
    });
    return { notifyError: null };
  } catch (err) {
    return { notifyError: userMessage(err) };
  }
}
