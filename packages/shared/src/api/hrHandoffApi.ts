import { EdgeError } from "../edge";
import { apiClient } from "./client";
import { isApiError, userMessage } from "./errors";
import type { components } from "./schema";

/**
 * "HR & Payroll" on apps/api: the API side of hrHandoff.ts (apps/api/docs/HR-HANDOFF.md, section 9; docs/web-on-api/hr-handoff.md).
 * The three calls are the three actions of the Supabase function `open-hr` ("status", "request", "open"), and they answer with
 * the same fields, so the readers in hrHandoff.ts (`readHrStatus`) and the screens do not change.
 *
 * The school and the person are the session's: nothing here names a person. The school's id is in the path and in X-Tenant-Id
 * because the launch tab (a page of its own, opened from the console) is not inside a school's route, so it has no "active school"
 * of its own to rely on. The POSTs are sent with no body (the API reads none, and a JSON content type with an empty body is a 400).
 *
 * The API is OFF unless it is configured for the hand-off: the status then says `enabled: false` and the POSTs answer 403
 * `handoff_off`. A person who may not have HR & Payroll gets 403 on all three.
 *
 * The screens read failures as `EdgeError`s (`code`, `status`), so the API's errors are turned into those with the server's
 * sentence as the message. The one-time sign-in link holds a code: it is returned to the caller and never put in an error,
 * a message or a log line here.
 */

/** The platform answers within its own limits and the API cuts at 30 s; this is the ordinary call's limit, so a slow platform reads as one. */
const TIMEOUT_MS = 25_000;

export type ApiHrStatusAnswer = components["schemas"]["HrHandoffStatus"];

function asEdgeError(err: unknown): never {
  if (isApiError(err)) throw new EdgeError(userMessage(err), err.status || undefined, err.code === "aborted", err.code);
  throw err;
}

/** Whether HR is there for the school (GET .../me/hr/handoff-status). A 403 is thrown as an EdgeError with status 403: hidden. */
export async function apiFetchHrHandoffStatus(tenantId: string): Promise<ApiHrStatusAnswer> {
  try {
    return await apiClient().get("/v1/tenants/{tenantId}/me/hr/handoff-status", { path: { tenantId }, tenantId, timeoutMs: TIMEOUT_MS });
  } catch (err) {
    return asEdgeError(err);
  }
}

/** The school asks Figbloom for HR (POST .../me/hr/handoff-request): the first request's time. 409 `already_connected` when HR is on. */
export async function apiRequestHrHandoff(tenantId: string): Promise<{ requested_at: string }> {
  try {
    return await apiClient().post("/v1/tenants/{tenantId}/me/hr/handoff-request", { path: { tenantId }, tenantId, timeoutMs: TIMEOUT_MS });
  } catch (err) {
    return asEdgeError(err);
  }
}

/**
 * A one-time sign-in link into HR for the signed-in person (POST .../me/hr/handoff). The link works once and for about a minute.
 * Nothing here reads, stores or words it: it goes back to the caller, who opens it at once.
 */
export async function apiOpenHrHandoff(tenantId: string): Promise<{ url: string; expires_at: string | null }> {
  try {
    const out = await apiClient().post("/v1/tenants/{tenantId}/me/hr/handoff", { path: { tenantId }, tenantId, timeoutMs: TIMEOUT_MS });
    if (typeof out?.url !== "string" || !out.url) throw new EdgeError("Figbloom HR didn't answer properly. Try again in a minute.", 502, false, "hr_bad_answer");
    return { url: out.url, expires_at: typeof out.expires_at === "string" ? out.expires_at : null };
  } catch (err) {
    return asEdgeError(err);
  }
}
