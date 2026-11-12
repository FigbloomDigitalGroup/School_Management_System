export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation_error"
  | "rate_limited"
  | "conflict"
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

export function conflict(message: string): AppError {
  return new AppError(409, "conflict", message);
}

export function rateLimited(
  message = "Too many attempts. Try again shortly.",
  retryAfterSeconds?: number,
): AppError {
  return new AppError(429, "rate_limited", message, true, retryAfterSeconds);
}

/** Client-safe body — never include SQL, stack traces, or internal details. */
export function toClientError(err: unknown): { statusCode: number; body: { error: { code: ErrorCode; message: string } } } {
  if (err instanceof AppError) {
    return {
      statusCode: err.statusCode,
      body: { error: { code: err.code, message: err.expose ? err.message : "Request failed" } },
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
