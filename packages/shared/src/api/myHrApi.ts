import { EdgeError } from "../edge";
import type { MyHrRoute, MyHrStatus } from "../myHr";
import { apiClient } from "./client";
import { isApiError, userMessage } from "./errors";
import { activeTenantId } from "./peopleApi";

/**
 * "My HR" on apps/api: the API side of myHr.ts (apps/api/docs/MY-HR.md). The API is a proxy to Figbloom HR for the signed-in
 * person's OWN record: the school and the person are the session's, so nothing here names either. HR's JSON comes back as HR sent
 * it, which is what `readSummary`, `readPayslips` and the other readers in myHr.ts expect, so the screen does not change.
 *
 * The screen reads failures as `EdgeError`s (`code` "not_linked" / "pending_hr" show "Your HR record isn't ready yet"), so the
 * API's errors are turned into those, with the server's sentence as the message. The API is off by default (`status` "off") until
 * the owner switches it on and links schools, so the page shows only for "available".
 */

/** HR goes through the platform token and HR itself, so it gets longer than an ordinary call (the Supabase function had 25 s). */
const TIMEOUT_MS = 25_000;

const STATUSES: readonly MyHrStatus[] = ["not_staff", "off", "not_linked", "not_enabled", "available"];

function asEdgeError(err: unknown): never {
  if (isApiError(err)) throw new EdgeError(userMessage(err), err.status || undefined, err.code === "aborted", err.code);
  throw err;
}

/** The rule for the signed-in person (GET .../me/hr/status); "off" for an answer it does not know, so the page stays hidden. */
export async function apiFetchMyHrStatus(): Promise<MyHrStatus> {
  const tenantId = activeTenantId();
  const res = await apiClient().get("/v1/tenants/{tenantId}/me/hr/status", { path: { tenantId }, tenantId, timeoutMs: TIMEOUT_MS });
  return STATUSES.includes(res.status) ? res.status : "off";
}

/** One section of the signed-in person's own HR record, as HR sent it. Throws an EdgeError with a sentence to show. */
export async function apiFetchMyHr(route: MyHrRoute, params: { from?: string; to?: string } = {}): Promise<unknown> {
  const tenantId = activeTenantId();
  const opts = { path: { tenantId }, tenantId, timeoutMs: TIMEOUT_MS } as const;
  try {
    switch (route) {
      case "summary": return await apiClient().get("/v1/tenants/{tenantId}/me/hr/summary", opts);
      case "payslips": return await apiClient().get("/v1/tenants/{tenantId}/me/hr/payslips", opts);
      case "leave": return await apiClient().get("/v1/tenants/{tenantId}/me/hr/leave", opts);
      case "kpis": return await apiClient().get("/v1/tenants/{tenantId}/me/hr/kpis", opts);
      case "attendance": {
        const query: { from?: string; to?: string } = {};
        if (params.from) query.from = params.from;
        if (params.to) query.to = params.to;
        return await apiClient().get("/v1/tenants/{tenantId}/me/hr/attendance", { ...opts, query });
      }
    }
  } catch (err) {
    return asEdgeError(err);
  }
}

/** One payslip in full, as HR sent it (the page lays it out and the browser prints it). */
export async function apiFetchPayslip(payslipId: string): Promise<unknown> {
  const tenantId = activeTenantId();
  try {
    return await apiClient().get("/v1/tenants/{tenantId}/me/hr/payslips/{payslipId}", { path: { tenantId, payslipId }, tenantId, timeoutMs: TIMEOUT_MS });
  } catch (err) {
    return asEdgeError(err);
  }
}
