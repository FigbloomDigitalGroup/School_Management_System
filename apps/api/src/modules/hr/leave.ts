import type { Tx } from "../../db/sql.js";
import { conflict, forbidden, notFound, validationError } from "../../http/errors.js";
import type { PageInfo } from "../../http/pagination.js";
import { pageQuery, type PageInput } from "../academics/pagination.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { assertValidCalendarDate } from "../inventory/inventory.js";

export interface LeaveRequest {
  id: string;
  tenant_id: string;
  staff_user_id: string;
  start_on: string;
  end_on: string;
  reason: string;
  status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
}

const COLS = `id, tenant_id, staff_user_id, start_on::text AS start_on, end_on::text AS end_on, reason, status, reviewed_by, reviewed_at, review_note, created_at`;
const STAFF_LEAVE_ROLES = new Set(["school_admin", "teacher", "staff", "driver"]);

export async function submitLeaveRequest(
  tx: Tx,
  input: {
    tenantId: string;
    staffUserId: string;
    callerMembershipRole?: string | null;
    isSuperAdmin?: boolean;
    startOn: string;
    endOn: string;
    reason: string;
  },
): Promise<LeaveRequest> {
  // S13-05: Only staff roles (school_admin, teacher, staff, driver) may submit staff leave requests.
  if (!input.isSuperAdmin) {
    if (!input.callerMembershipRole || !STAFF_LEAVE_ROLES.has(input.callerMembershipRole)) {
      throw forbidden("Only school staff members may submit leave requests");
    }
  }
  assertValidCalendarDate(input.startOn, "start_on");
  assertValidCalendarDate(input.endOn, "end_on");
  if (input.endOn < input.startOn) throw validationError("end_on must be on or after start_on");
  const trimmedReason = input.reason.trim();
  if (trimmedReason.length < 3) throw validationError("reason must be at least 3 characters");

  try {
    const res = await tx.query<LeaveRequest>(
      `INSERT INTO leave_requests (tenant_id, staff_user_id, start_on, end_on, reason)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING ${COLS}`,
      [input.tenantId, input.staffUserId, input.startOn, input.endOn, trimmedReason],
    );
    await recordSecurityEvent(tx, {
      eventType: "hr.leave.submitted",
      actorUserId: input.staffUserId,
      tenantId: input.tenantId,
      detail: { leaveId: res.rows[0]!.id },
    });
    return res.rows[0]!;
  } catch (err) {
    const code = (err as { code?: string }).code;
    const msg = (err as { message?: string }).message ?? "";
    if (code === "23514" && /overlap/i.test(msg)) {
      throw conflict("Leave dates overlap an existing request");
    }
    if (code === "23P01") {
      throw conflict("Leave dates overlap an existing request");
    }
    throw err;
  }
}

export async function listLeaveRequests(
  tx: Tx,
  input: { tenantId: string; staffUserId?: string | null; limit: number; rawCursor?: unknown },
): Promise<{ leave_requests: LeaveRequest[]; page: PageInfo }> {
  const page: PageInput = { limit: input.limit, rawCursor: input.rawCursor };
  const inner = input.staffUserId
    ? `SELECT ${COLS} FROM leave_requests WHERE tenant_id = $1 AND staff_user_id = $2`
    : `SELECT ${COLS} FROM leave_requests WHERE tenant_id = $1`;
  const params = input.staffUserId ? [input.tenantId, input.staffUserId] : [input.tenantId];
  const res = await pageQuery<LeaveRequest>(
    tx,
    inner,
    params,
    {
      name: input.staffUserId ? "leave_requests_own_created_desc" : "leave_requests_all_created_desc",
      expr: "q.created_at",
      type: "timestamptz",
      dir: "desc",
    },
    page,
  );
  const leave_requests = res.rows.map(({ page_key: _pk, ...rest }) => rest);
  return { leave_requests, page: res.page };
}

export async function reviewLeaveRequest(
  tx: Tx,
  input: {
    tenantId: string;
    leaveId: string;
    reviewerUserId: string;
    status: "approved" | "declined";
    reviewNote?: string | null;
  },
): Promise<LeaveRequest> {
  try {
    const res = await tx.query<LeaveRequest>(
      `UPDATE leave_requests
          SET status = $3, reviewed_by = $4, review_note = $5, reviewed_at = now()
        WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
        RETURNING ${COLS}`,
      [input.tenantId, input.leaveId, input.status, input.reviewerUserId, input.reviewNote ?? null],
    );
    if (!res.rows[0]) throw notFound("Pending leave request not found");
    await recordSecurityEvent(tx, {
      eventType: "hr.leave.reviewed",
      actorUserId: input.reviewerUserId,
      tenantId: input.tenantId,
      detail: { leaveId: input.leaveId, status: input.status },
    });
    return res.rows[0];
  } catch (err) {
    const code = (err as { code?: string }).code;
    const msg = (err as { message?: string }).message ?? "";
    if (code === "23514" && /overlap/i.test(msg)) {
      throw conflict("Leave dates overlap an existing request");
    }
    if (code === "23514" && /own leave/i.test(msg)) {
      throw forbidden("A staff member cannot review their own leave");
    }
    throw err;
  }
}

export async function cancelLeaveRequest(
  tx: Tx,
  input: {
    tenantId: string;
    leaveId: string;
    actorUserId: string;
    canWriteLeave: boolean;
  },
): Promise<LeaveRequest> {
  const existing = await tx.query<LeaveRequest>(
    `SELECT ${COLS} FROM leave_requests WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.leaveId],
  );
  const row = existing.rows[0];
  if (!row) throw notFound("Leave request not found");
  if (row.staff_user_id !== input.actorUserId && !input.canWriteLeave) {
    throw forbidden("You may only cancel your own pending leave request");
  }
  if (row.status !== "pending") {
    throw conflict("Only pending leave requests can be cancelled");
  }
  const res = await tx.query<LeaveRequest>(
    `UPDATE leave_requests
        SET status = 'cancelled', updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
      RETURNING ${COLS}`,
    [input.tenantId, input.leaveId],
  );
  const updated = res.rows[0]!;
  await recordSecurityEvent(tx, {
    eventType: "hr.leave.cancelled",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { leaveId: input.leaveId, staffUserId: updated.staff_user_id },
  });
  return updated;
}
