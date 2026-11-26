/**
 * What goes wrong on a call to the API, in one type. The API answers every failure as
 * `{ "error": { "code", "message", "request_id", "details?" } }` (apps/api/docs/API-CONVENTIONS.md); this turns that and
 * the failures with no answer at all (offline, timed out) into an ApiError the screens can read.
 */

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "reauth_required"
  | "mfa_required"
  | "not_found"
  | "validation_error"
  | "rate_limited"
  | "conflict"
  | "idempotency_key_reused"
  | "service_unavailable"
  | "internal_error"
  // My HR (apps/api/docs/MY-HR.md): the answers of the HR proxy.
  | "my_hr_off"
  | "school_not_linked"
  | "not_linked"
  | "pending_hr"
  | "hr_off"
  | "hr_forbidden"
  | "hr_not_connected"
  | "hr_unavailable"
  | "hr_bad_answer"
  // The "HR & Payroll" hand-off (apps/api/docs/HR-HANDOFF.md, section 9): the switch is off, HR is already there, and the platform's refusals.
  | "handoff_off"
  | "already_connected"
  | "target_not_enabled"
  | "target_not_linked"
  | "target_no_handoff_url"
  // HR leave approvals (apps/api/docs/HR-HANDOFF.md, section 10).
  | "hr_leave_off"
  | "approver_not_linked"
  | "approver_no_access"
  | "not_your_approval"
  | "already_decided"
  | "not_cancellable"
  | "leave_rules"
  | "document_too_large"
  // Not from the server: the request never got an answer.
  | "network_error"
  | "timeout"
  | "aborted";

const SERVER_CODES: readonly ApiErrorCode[] = [
  "unauthorized", "forbidden", "reauth_required", "mfa_required", "not_found", "validation_error", "rate_limited",
  "conflict", "idempotency_key_reused", "service_unavailable", "internal_error",
  "my_hr_off", "school_not_linked", "not_linked", "pending_hr", "hr_off", "hr_forbidden", "hr_not_connected", "hr_unavailable", "hr_bad_answer",
  "handoff_off", "already_connected", "target_not_enabled", "target_not_linked", "target_no_handoff_url",
  "hr_leave_off", "approver_not_linked", "approver_no_access", "not_your_approval", "already_decided", "not_cancellable", "leave_rules", "document_too_large",
];

export interface ApiFieldError {
  field: string;
  code: string;
  message: string;
}

export class ApiError extends Error {
  /** The HTTP status; 0 when no answer came back. */
  readonly status: number;
  readonly code: ApiErrorCode;
  /** The server's correlation id (also the X-Request-Id header). Quote it when reporting a problem. */
  readonly requestId: string | null;
  readonly details: ApiFieldError[];
  /** Seconds the server asked to wait (429 and 503), when it said. */
  readonly retryAfterSeconds: number | null;

  constructor(init: {
    status: number;
    code: ApiErrorCode;
    message: string;
    requestId?: string | null;
    details?: ApiFieldError[];
    retryAfterSeconds?: number | null;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId ?? null;
    this.details = init.details ?? [];
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseDetails(v: unknown): ApiFieldError[] {
  if (!Array.isArray(v)) return [];
  const out: ApiFieldError[] = [];
  for (const d of v) {
    if (isRecord(d) && typeof d.field === "string" && typeof d.message === "string") {
      out.push({ field: d.field, code: typeof d.code === "string" ? d.code : "invalid", message: d.message });
    }
  }
  return out;
}

/** The code a status means when the body gave none (a proxy's own page, say). */
function codeForStatus(status: number): ApiErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422) return "idempotency_key_reused";
  if (status === 429) return "rate_limited";
  if (status === 503) return "service_unavailable";
  if (status >= 400 && status < 500) return "validation_error";
  return "internal_error";
}

/**
 * Builds the error for a non-2xx answer. `body` is the parsed JSON, or undefined when the body was not JSON.
 * The server's message is kept as it is (the API writes them for people); the id comes from the body, else the header.
 */
export function apiErrorFromResponse(status: number, body: unknown, headers: { get(name: string): string | null }): ApiError {
  const inner = isRecord(body) && isRecord(body.error) ? body.error : null;
  const rawCode = inner && typeof inner.code === "string" ? inner.code : null;
  const code = rawCode && (SERVER_CODES as readonly string[]).includes(rawCode) ? (rawCode as ApiErrorCode) : codeForStatus(status);
  const message = inner && typeof inner.message === "string" && inner.message ? inner.message : `The server answered ${status}.`;
  const requestId =
    (inner && typeof inner.request_id === "string" ? inner.request_id : null) ?? headers.get("x-request-id");
  const retryHeader = headers.get("retry-after");
  const retry = retryHeader && /^\d+$/.test(retryHeader.trim()) ? Number(retryHeader.trim()) : null;
  return new ApiError({ status, code, message, requestId, details: inner ? parseDetails(inner.details) : [], retryAfterSeconds: retry });
}

/** Whether to try again later is the caller's call; this says whether the server itself thinks it could work. */
export function isRetryableApiError(err: unknown): boolean {
  return isApiError(err) && (err.code === "service_unavailable" || err.code === "network_error" || err.code === "timeout");
}

/**
 * The sentence to show a person. A validation, conflict or not-found message comes from the server and is written for
 * people, so it is used as it is. The rest are ours, with the request id on server faults so a report can be traced.
 */
export function userMessage(err: unknown): string {
  if (!isApiError(err)) return err instanceof Error && err.message ? err.message : "Something went wrong.";
  switch (err.code) {
    case "network_error": return "Can't reach the server. Check your connection and try again.";
    case "timeout": return "The server took too long to answer. Try again.";
    case "aborted": return "Cancelled.";
    case "unauthorized": return "Your session has ended. Sign in again.";
    case "forbidden": return err.message && err.message !== `The server answered ${err.status}.` ? err.message : "You don't have permission to do that.";
    case "reauth_required": return "Confirm your password to continue.";
    case "mfa_required": return "Two-step verification is needed to continue.";
    case "rate_limited":
      return err.retryAfterSeconds
        ? `Too many attempts. Try again in ${err.retryAfterSeconds} second${err.retryAfterSeconds === 1 ? "" : "s"}.`
        : "Too many attempts. Wait a moment and try again.";
    case "service_unavailable": return "The service is busy. Try again in a moment.";
    case "internal_error": return `Something went wrong on our side.${err.requestId ? ` (reference ${err.requestId})` : ""}`;
    default: return err.message;
  }
}

/** Server-side validation details as `{ field: message }`, for putting each message under its input. The first per field wins. */
export function fieldErrors(err: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isApiError(err)) return out;
  for (const d of err.details) if (!(d.field in out)) out[d.field] = d.message;
  return out;
}
