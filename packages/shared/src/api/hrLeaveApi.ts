import { EdgeError } from "../edge";
import type { HrLeaveAccess } from "../hrLeave";
import { activeTenantId } from "./peopleApi";
import { apiClient } from "./client";
import { isApiError, userMessage } from "./errors";

const TIMEOUT_MS = 25_000;

function asEdgeError(err: unknown): never {
  if (isApiError(err)) throw new EdgeError(userMessage(err), err.status || undefined, err.code === "aborted", err.code);
  throw err;
}

export async function apiFetchHrLeaveAccess(): Promise<HrLeaveAccess> {
  const tenantId = activeTenantId();
  try {
    return await apiClient().get("/v1/tenants/{tenantId}/me/hr/leave/access", { path: { tenantId }, tenantId, timeoutMs: TIMEOUT_MS });
  } catch (err) { return asEdgeError(err); }
}

export async function apiFetchHrLeaveApprovals(): Promise<unknown> {
  const tenantId = activeTenantId();
  try {
    return await apiClient().get("/v1/tenants/{tenantId}/me/hr/leave/approvals", { path: { tenantId }, tenantId, timeoutMs: TIMEOUT_MS });
  } catch (err) { return asEdgeError(err); }
}

export async function apiDecideHrLeaveApproval(applicationId: string, decision: "approve" | "decline", comment: string): Promise<unknown> {
  const tenantId = activeTenantId();
  try {
    return await apiClient().post("/v1/tenants/{tenantId}/me/hr/leave/approvals/{applicationId}/decide", {
      path: { tenantId, applicationId }, tenantId, body: { decision, ...(comment.trim() ? { comment: comment.trim() } : {}) }, timeoutMs: TIMEOUT_MS,
    });
  } catch (err) { return asEdgeError(err); }
}
