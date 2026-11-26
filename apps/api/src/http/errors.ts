import { isConnectionFailure } from "../db/clientHealth.js";

export type ErrorCode =
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
  // My HR (docs/MY-HR.md): the same codes the Supabase `my-hr` function answers with.
  | "my_hr_off"
  | "school_not_linked"
  | "not_linked"
  | "pending_hr"
  | "hr_off"
  | "hr_forbidden"
  | "hr_not_connected"
  | "hr_unavailable"
  | "hr_bad_answer"
  // The "HR & Payroll" hand-off (docs/HR-HANDOFF.md, H1): the same codes the Supabase `open-hr` function answers with.
  | "handoff_off"
  | "already_connected"
  | "target_not_enabled"
  | "target_not_linked"
  | "target_no_handoff_url"
  // Leave run by Figbloom HR (docs/HR-HANDOFF.md, L1): the same codes the Supabase `my-hr` function answers with.
  | "hr_leave_off"
  | "approver_not_linked"
  | "approver_no_access"
  | "not_your_approval"
  | "already_decided"
  | "not_cancellable"
  | "leave_rules"
  | "document_too_large";

/** Additive field-level validation detail (OI-4 / FIG-1621). Never carries submitted values. */
export type ErrorDetail = {
  field: string;
  code: string;
  message: string;
};

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly expose: boolean;
  /** Seconds for the Retry-After header (429 only). */
  readonly retryAfterSeconds?: number;
  readonly details?: ErrorDetail[];

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    expose = true,
    retryAfterSeconds?: number,
    details?: ErrorDetail[],
  ) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.expose = expose;
    this.details = details;
  }
}

export function unauthorized(message = "Authentication required"): AppError {
  return new AppError(401, "unauthorized", message);
}

export function forbidden(message = "Access denied"): AppError {
  return new AppError(403, "forbidden", message);
}

export function notFound(message = "Not found"): AppError {
  return new AppError(404, "not_found", message);
}

export function validationError(message: string, details?: ErrorDetail[]): AppError {
  return new AppError(400, "validation_error", message, true, undefined, details);
}

/** The same Idempotency-Key was sent with a different request (FIG-1623). */
export function idempotencyKeyReused(): AppError {
  return new AppError(
    422,
    "idempotency_key_reused",
    "This Idempotency-Key was already used for a different request",
  );
}

export function conflict(message: string): AppError {
  return new AppError(409, "conflict", message);
}

export function rateLimited(
  message = "Too many attempts. Try again shortly.",
  retryAfterSeconds?: number,
): AppError {
  return new AppError(429, "rate_limited", message, true, retryAfterSeconds);
}

export function serviceUnavailable(
  message = "Service temporarily unavailable",
  retryAfterSeconds = 1,
): AppError {
  return new AppError(503, "service_unavailable", message, true, retryAfterSeconds);
}

/** Transient database failures. The client sees a stable 503, never the driver text. */
const TRANSIENT_SQLSTATE = new Set([
  "55P03", // lock_not_available
  "57014", // query_canceled (statement_timeout)
  "25P03", // idle_in_transaction_session_timeout
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "08000",
  "08001",
  "08003",
  "08006",
  "53300", // too_many_connections
  "57P01",
  "57P03",
]);

/**
 * The database is unreachable or too slow at the connection level (refused, reset, closed, client-side
 * read timeout). Not an application bug: a stable 503 with Retry-After, never a 500 or driver text.
 */
function isDatabaseUnavailable(err: unknown): boolean {
  return isConnectionFailure(err);
}

/** Client-safe body — never include SQL, stack traces, or internal details. */
export function toClientError(err: unknown): {
  statusCode: number;
  body: {
    error: {
      code: ErrorCode;
      message: string;
      details?: ErrorDetail[];
    };
  };
  retryAfterSeconds?: number;
} {
  if (err instanceof AppError) {
    return {
      statusCode: err.statusCode,
      body: {
        error: {
          code: err.code,
          message: err.expose ? err.message : "Request failed",
          ...(err.details && err.details.length > 0 ? { details: err.details } : {}),
        },
      },
      retryAfterSeconds: err.retryAfterSeconds,
    };
  }
  const sqlstate = (err as { code?: unknown } | null)?.code;
  if (typeof sqlstate === "string" && TRANSIENT_SQLSTATE.has(sqlstate)) {
    return {
      statusCode: 503,
      body: { error: { code: "service_unavailable", message: "Service temporarily unavailable" } },
      retryAfterSeconds: 1,
    };
  }
  // Defence in depth for cursor / bind casts: class 22 data exceptions map to the
  // established client validation response. Message stays generic; SQL never leaks.
  if (
    typeof sqlstate === "string" &&
    (sqlstate === "22P02" ||
      sqlstate === "22007" ||
      sqlstate === "22008" ||
      sqlstate === "22021" ||
      (sqlstate.length === 5 && sqlstate.startsWith("22")))
  ) {
    return {
      statusCode: 400,
      body: { error: { code: "validation_error", message: "Invalid request" } },
    };
  }
  // Check violations (23514) are the same defect class as A-01: a value that slipped past
  // application validation must not surface as 500/internal_error. Unique (23505) and FK
  // (23503) stay call-site mapped — they are not generically "invalid request".
  if (typeof sqlstate === "string" && sqlstate === "23514") {
    return {
      statusCode: 400,
      body: { error: { code: "validation_error", message: "Invalid request" } },
    };
  }
  // Database-raised conditions that are the CLIENT's doing (a duplicate, a missing or still-referenced row, a refused state
  // transition, a policy denial, a "not found" raised by one of our definer functions). Routes that know better map them
  // themselves; this is the safety net so such a case is never an opaque 500. Messages stay generic: no constraint, table or
  // column name ever reaches the client.
  if (typeof sqlstate === "string") {
    if (sqlstate === "23505" || sqlstate === "23503" || sqlstate === "23P01" || sqlstate === "55000") {
      return { statusCode: 409, body: { error: { code: "conflict", message: "The request conflicts with existing data" } } };
    }
    if (sqlstate === "42501") {
      return { statusCode: 403, body: { error: { code: "forbidden", message: "Access denied" } } };
    }
    if (sqlstate === "P0002") {
      return { statusCode: 404, body: { error: { code: "not_found", message: "Not found" } } };
    }
  }
  if (isDatabaseUnavailable(err)) {
    return {
      statusCode: 503,
      body: { error: { code: "service_unavailable", message: "Service temporarily unavailable" } },
      retryAfterSeconds: 1,
    };
  }
  // Fastify's own client errors (malformed JSON, wrong content type, body too
  // large) carry a 4xx statusCode. Map them to the standard shape; anything else
  // is an opaque 500 so SQL / stack detail never reaches the client.
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    const code: ErrorCode = status === 429 ? "rate_limited" : "validation_error";
    return { statusCode: status, body: { error: { code, message: "Invalid request" } } };
  }
  return {
    statusCode: 500,
    body: { error: { code: "internal_error", message: "Internal server error" } },
  };
}
