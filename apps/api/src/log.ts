/**
 * One structured logger (FIG-1620). JSON lines on stdout.
 *
 * Safety by construction, not by convention:
 *  - `msg` is a fixed, caller-supplied constant (never interpolated data);
 *  - only the ALLOWED fields below are ever written; any other key is dropped, so a
 *    future caller cannot start logging a body, header, token, name or e-mail by accident;
 *  - values are coerced to short scalars (strings are length-capped, no objects).
 *
 * Never logged (and not representable): Authorization, cookies, tokens, passwords, hashes,
 * request or response bodies, query-string values, IP addresses, personal data (names,
 * e-mails, phones, admission numbers, dates of birth), idempotency payloads, connection
 * strings, raw driver or exception messages. Identifiers (request, tenant and user ids)
 * and operational facts (route template, status, duration, error code and class, SQLSTATE)
 * are the allowlist.
 */
export const ALLOWED_LOG_FIELDS = [
  "request_id",
  "method",
  "route",
  "status",
  "duration_ms",
  "tenant_id",
  "user_id",
  "error_code",
  "error_class",
  "sqlstate",
  "outcome",
  "reason",
  // Stage 11 worker observability: identifiers and counters only (never payloads or provider data).
  "job_id",
  "job_type",
  "attempt",
] as const;

export type LogField = (typeof ALLOWED_LOG_FIELDS)[number];
export type LogFields = Partial<Record<LogField, string | number | boolean | null>>;
export type LogLevel = "info" | "warn" | "error";

const ALLOWED = new Set<string>(ALLOWED_LOG_FIELDS);
const MAX_STRING = 200;

type Sink = (line: string) => void;
let sink: Sink = (line) => process.stdout.write(line + "\n");

/** Replace the output (tests capture it). Returns a function that restores the previous sink. */
export function setLogSink(next: Sink): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

export function log(level: LogLevel, msg: string, fields: LogFields = {}): void {
  const entry: Record<string, string | number | boolean | null> = {
    level,
    time: new Date().toISOString(),
    msg,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED.has(key) || value === undefined) continue;
    entry[key] = typeof value === "string" ? value.slice(0, MAX_STRING) : value;
  }
  try {
    sink(JSON.stringify(entry));
  } catch {
    /* logging must never break a request */
  }
}

export const logInfo = (msg: string, fields?: LogFields) => log("info", msg, fields);
export const logWarn = (msg: string, fields?: LogFields) => log("warn", msg, fields);
export const logError = (msg: string, fields?: LogFields) => log("error", msg, fields);

/** error_class + sqlstate for an unknown thrown value, without its message. */
export function describeError(err: unknown): LogFields {
  const out: LogFields = {};
  if (err instanceof Error) out.error_class = err.name;
  else out.error_class = typeof err;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) out.sqlstate = code;
  return out;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

/** Accept an inbound X-Request-Id only when it is a short safe token; otherwise the caller generates one. */
export function acceptableRequestId(value: unknown): string | undefined {
  return typeof value === "string" && REQUEST_ID_RE.test(value) ? value : undefined;
}
