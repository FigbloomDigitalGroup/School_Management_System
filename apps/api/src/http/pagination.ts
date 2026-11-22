import { createHash } from "node:crypto";
import { validationError } from "./errors.js";

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;
export const CURSOR_VERSION = 2 as const;

export interface PageInfo {
  limit: number;
  next_cursor: string | null;
}

export interface ListPage<T> {
  items: T[];
  page: PageInfo;
}

/**
 * Cursor v2: every sort key is a string exactly as PostgreSQL returned it
 * (timestamps via to_char / ::text, never a JS Date). Bound to sort + filter
 * fingerprint (includes tenant/org scope).
 */
export interface CursorPayload {
  v: typeof CURSOR_VERSION;
  /** Last sort-key values from the previous page (order matches the SQL ORDER BY). */
  k: string[];
  /** Fingerprint of filter + sort + tenant/org scope. */
  f: string;
  /** Allowlisted sort name. */
  s: string;
}

/** Per-endpoint key shape. Validated before any SQL bind so cast failures never become HTTP 500. */
export type CursorKeySpec =
  | { kind: "uuid" }
  | { kind: "timestamptz_micros" }
  | { kind: "text"; maxLen: number }
  | { kind: "permission_code" };

const LIMIT_PATTERN = /^\d+$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMPTZ_MICROS_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;
const PERMISSION_CODE_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;
const CURSOR_FIELDS = new Set(["v", "k", "f", "s"]);

/**
 * Parse page size. Decimal integers only (`/^\d+$/`); rejects `0x10`, `1e2`,
 * floats, and values above 200 (OpenAPI maximum).
 */
export function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_PAGE_LIMIT;
  const text = typeof raw === "number" ? String(raw) : String(raw);
  if (!LIMIT_PATTERN.test(text)) {
    throw validationError("limit must be an integer between 1 and 200", [
      { field: "limit", code: "invalid_format", message: "Invalid format" },
    ]);
  }
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) {
    throw validationError("limit must be an integer between 1 and 200", [
      { field: "limit", code: "too_small", message: "Value is too small" },
    ]);
  }
  if (n > MAX_PAGE_LIMIT) {
    throw validationError("limit must be an integer between 1 and 200", [
      { field: "limit", code: "too_big", message: "Value is too large" },
    ]);
  }
  return n;
}

/** Stable fingerprint of filter+sort (+ scope) so a cursor cannot be reused across queries/tenants. */
export function pageFingerprint(sort: string, filter: Record<string, unknown>): string {
  const payload = JSON.stringify({ sort, filter });
  return createHash("sha256").update(payload).digest("base64url");
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function rejectCursor(message = "cursor is invalid"): never {
  throw validationError(message);
}

function assertNoNul(value: string): void {
  if (value.includes("\0")) rejectCursor();
}

export function validateCursorKey(value: string, spec: CursorKeySpec): void {
  assertNoNul(value);
  switch (spec.kind) {
    case "uuid": {
      if (!UUID_PATTERN.test(value) || value.length !== 36) rejectCursor();
      return;
    }
    case "timestamptz_micros": {
      const m = TIMESTAMPTZ_MICROS_PATTERN.exec(value);
      if (!m) rejectCursor();
      const year = Number(m![1]);
      const month = Number(m![2]);
      const day = Number(m![3]);
      const hour = Number(m![4]);
      const minute = Number(m![5]);
      const second = Number(m![6]);
      if (
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > 31 ||
        hour > 23 ||
        minute > 59 ||
        second > 59
      ) {
        rejectCursor();
      }
      const dt = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
      if (
        dt.getUTCFullYear() !== year ||
        dt.getUTCMonth() !== month - 1 ||
        dt.getUTCDate() !== day
      ) {
        rejectCursor();
      }
      return;
    }
    case "text": {
      if (value.length === 0 || value.length > spec.maxLen) rejectCursor();
      return;
    }
    case "permission_code": {
      if (!PERMISSION_CODE_PATTERN.test(value)) rejectCursor();
      return;
    }
    default: {
      const _exhaustive: never = spec;
      void _exhaustive;
      rejectCursor();
    }
  }
}

function assertStringKeys(
  keys: unknown[],
  specs: readonly CursorKeySpec[],
): string[] {
  if (keys.length !== specs.length) rejectCursor();
  const out: string[] = [];
  for (let i = 0; i < specs.length; i++) {
    const key = keys[i];
    if (typeof key !== "string") rejectCursor();
    validateCursorKey(key, specs[i]!);
    out.push(key);
  }
  return out;
}

export function decodeCursor(
  raw: unknown,
  expected: {
    sort: string;
    fingerprint: string;
    keySpecs: readonly CursorKeySpec[];
  },
): CursorPayload | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || raw.length < 8 || raw.length > 2048) {
    rejectCursor();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    rejectCursor();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    rejectCursor();
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!CURSOR_FIELDS.has(key)) rejectCursor();
  }
  if (obj.v !== CURSOR_VERSION) rejectCursor();
  if (!Array.isArray(obj.k) || typeof obj.f !== "string" || typeof obj.s !== "string") {
    rejectCursor();
  }
  assertNoNul(obj.f);
  assertNoNul(obj.s);
  if (obj.f.length === 0 || obj.f.length > 128 || obj.s.length === 0 || obj.s.length > 64) {
    rejectCursor();
  }
  const keys = assertStringKeys(obj.k, expected.keySpecs);
  if (obj.s !== expected.sort || obj.f !== expected.fingerprint) {
    throw validationError("cursor does not match this query");
  }
  return { v: CURSOR_VERSION, k: keys, f: obj.f, s: obj.s };
}

/**
 * Build the response page from a SQL result that already applied keyset + LIMIT n+1.
 * Does not load or slice a larger in-memory catalogue beyond the fetched window.
 */
export function pageFromKeysetRows<T>(
  rows: T[],
  opts: {
    limit: number;
    sort: string;
    fingerprint: string;
    keysOf: (row: T) => string[];
  },
): ListPage<T> {
  const hasMore = rows.length > opts.limit;
  const items = hasMore ? rows.slice(0, opts.limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    page: {
      limit: opts.limit,
      next_cursor:
        hasMore && last
          ? encodeCursor({
              v: CURSOR_VERSION,
              k: opts.keysOf(last),
              f: opts.fingerprint,
              s: opts.sort,
            })
          : null,
    },
  };
}

/**
 * Parse list query: limit + cursor against an allowlisted sort and filter fingerprint.
 * Unsupported `?sort` values are rejected (422-class validation_error), never ignored.
 */
export function parseListQuery(
  query: Record<string, unknown>,
  opts: {
    sort: string;
    filter: Record<string, unknown>;
    allowSort?: readonly string[];
    keySpecs: readonly CursorKeySpec[];
  },
): { limit: number; cursor: CursorPayload | null; sort: string; fingerprint: string } {
  const sortRaw =
    query.sort === undefined || query.sort === null || query.sort === ""
      ? opts.sort
      : String(query.sort);
  const allow = opts.allowSort ?? [opts.sort];
  if (!allow.includes(sortRaw)) {
    throw validationError("sort is not allowed", [
      { field: "sort", code: "invalid_value", message: "Invalid value" },
    ]);
  }
  const fingerprint = pageFingerprint(sortRaw, opts.filter);
  return {
    limit: parseLimit(query.limit),
    cursor: decodeCursor(query.cursor, {
      sort: sortRaw,
      fingerprint,
      keySpecs: opts.keySpecs,
    }),
    sort: sortRaw,
    fingerprint,
  };
}

/** PostgreSQL timestamptz → UTC text with microseconds (cursor-safe). */
export const PG_TIMESTAMPTZ_MICROS_UTC = `to_char(%COL% AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export function pgTimestamptzMicrosExpr(columnSql: string): string {
  return PG_TIMESTAMPTZ_MICROS_UTC.replace("%COL%", columnSql);
}
