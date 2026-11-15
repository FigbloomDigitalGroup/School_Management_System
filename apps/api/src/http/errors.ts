import { isConnectionFailure } from "../db/clientHealth.js";

export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation_error"
  | "rate_limited"
  | "conflict"
  | "idempotency_key_reused"
  | "service_unavailable"
  | "internal_error";

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly expose: boolean;
  /** Seconds for the Retry-After header (429 only). */
  readonly retryAfterSeconds?: number;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    expose = true,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.expose = expose;
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

export function validationError(message: string): AppError {
  return new AppError(400, "validation_error", message);
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
  body: { error: { code: ErrorCode; message: string } };
  retryAfterSeconds?: number;
} {
  if (err instanceof AppError) {
    return {
      statusCode: err.statusCode,
      body: { error: { code: err.code, message: err.expose ? err.message : "Request failed" } },
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
