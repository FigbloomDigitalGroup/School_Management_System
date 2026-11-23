import { validationError } from "../../http/errors.js";

/**
 * Directory search-term handling (P3-AUDIT-013).
 *
 * Two separate defects are closed here:
 *
 *  1. **Unescaped `LIKE` wildcards.** `%` and `_` in a user-supplied `q` were passed straight into
 *     `LIKE`, so `q=%` matched every row and `q=_` matched every single-character value. A search
 *     box is not a pattern language: callers search for literal text, so the wildcards are escaped
 *     and only the surrounding `%` are ours.
 *  2. **Unbounded `q`.** The term was length-checked nowhere, so an arbitrarily long string reached
 *     the planner on every list endpoint. The bound is the longest searchable value in the
 *     directory (`full_name`, 120), because a longer term cannot match anything.
 *
 * Personal names are NOT normalised: no case folding beyond the `lower()` both sides already use,
 * no Unicode normalisation, no accent stripping, no punctuation removal. The term is compared
 * exactly as the caller typed it, so "Wanjirũ" and "O'Brien" search for themselves.
 */
export const MAX_SEARCH_TERM_LENGTH = 120;

/** Code points, as JSON Schema `maxLength` and Postgres `char_length` count them. */
function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n += 1;
  return n;
}

// Control characters never occur in a real name or admission number and would otherwise
// travel into logs and audit details.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Validate `?q`. Returns `null` when the caller sent nothing searchable, so an empty or
 * whitespace-only `q` behaves exactly like no `q` at all (and keeps the same page fingerprint
 * as before this change for those callers).
 */
export function parseSearchTerm(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw validationError("q must be a string", [
      { field: "q", code: "invalid_type", message: "Invalid type" },
    ]);
  }
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (codePointLength(trimmed) > MAX_SEARCH_TERM_LENGTH) {
    throw validationError(`q must be at most ${MAX_SEARCH_TERM_LENGTH} characters`, [
      { field: "q", code: "too_big", message: "Value is too large" },
    ]);
  }
  if (CONTROL_CHARS.test(trimmed)) {
    throw validationError("q must not contain control characters", [
      { field: "q", code: "invalid_format", message: "Invalid format" },
    ]);
  }
  return trimmed;
}

/**
 * Build the bound parameter for a case-insensitive "contains" search.
 *
 * The escape character is backslash, declared explicitly in the SQL with `ESCAPE '\'`
 * ({@link LIKE_ESCAPE_CLAUSE}) rather than relying on the server default. The backslash itself is
 * escaped first, otherwise a trailing `\` in the term would escape our closing `%`.
 *
 * The term is lower-cased with the same `toLowerCase()` the column side approximates via SQL
 * `lower()`; both sides are lower-cased, so the comparison is case-insensitive without touching
 * the stored value.
 */
export function likeContains(term: string): string {
  const escaped = term.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${escaped}%`;
}

/** Appended to every `LIKE` that binds a {@link likeContains} parameter. */
export const LIKE_ESCAPE_CLAUSE = `ESCAPE '\\'`;
