/**
 * Shared directory contact-field rules (P3-AUDIT-013).
 *
 * VS-2 defined phone/email/name shapes for guardians and checked them against the published
 * OpenAPI patterns. Staff members and the school profile accepted the same kinds of value with a
 * **length check only**, so `phone: "<script>"` or `contact_email: "not an address"` were stored.
 * One school directory should apply one rule to one kind of field, so the guardian rules are the
 * directory rules; `guardians.ts` re-exports them under their original `GUARDIAN_*` names so the
 * published schema and the VS-2 tests keep their existing identifiers.
 *
 * The patterns are written without regex flags so the same string can be published verbatim as an
 * OpenAPI `pattern` (JSON Schema has no flag syntax).
 */

/** 5–32 characters of digits and the usual dialling punctuation; no leading/trailing space. */
export const CONTACT_PHONE_PATTERN = "^[0-9+()\\-][0-9+()\\-\\s]{3,30}[0-9+()\\-]$";

/** A non-empty value with no leading or trailing whitespace. Any script, any accent. */
export const CONTACT_NAME_PATTERN = "^\\S([\\s\\S]*\\S)?$";

/**
 * Same acceptance set as zod 3.25's built-in `.email()` (the case-insensitive flag written out as
 * explicit ranges, so the published pattern needs no flags).
 */
export const CONTACT_EMAIL_PATTERN =
  "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-.]*)[A-Za-z0-9_+\\-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$";

export const CONTACT_NAME_MAX_LENGTH = 120;
export const CONTACT_EMAIL_MAX_LENGTH = 254;
export const CONTACT_PHONE_MIN_LENGTH = 5;
export const CONTACT_PHONE_MAX_LENGTH = 32;

/**
 * School accent token (P3-AUDIT-013).
 *
 * `accent` is a presentation value that existing clients drop into CSS. It was length-checked
 * only, so `red;background:url(...)` was storable and would have been interpreted as further
 * declarations by any client that interpolates it. The shape below is deliberately *conservative*
 * rather than an assertion that the value is a hex colour — the legacy column held free text and
 * this phase does not get to redefine it. It allows a hex colour, a CSS colour keyword and a
 * design-token name, and excludes every character that could terminate or extend a declaration:
 * whitespace, quotes, `;`, `:`, `(`, `)`, `{`, `}`, `/`, `\`, `<`, `>`, `,` and `*`.
 *
 * The two alternatives exist so the TOTAL length can never exceed 32. The first form of this
 * pattern was `^#?[A-Za-z0-9_-]{1,32}$`, which allows 33 characters when the optional `#` is
 * present — one more than the `school_profiles_accent_len` CHECK permits. A 33-character value
 * therefore passed validation and was refused by the database as SQLSTATE 23514 (adversarial
 * audit finding A-01). Application validation is the primary control; `toClientError` now also
 * maps 23514 to HTTP 400 so any remaining CHECK miss cannot surface as a 500.
 * {@link ACCENT_MAX_LENGTH} is the published `maxLength` and the database bound.
 */
export const ACCENT_PATTERN = "^(#[A-Za-z0-9_-]{1,31}|[A-Za-z0-9_-]{1,32})$";

/** Must equal the `school_profiles_accent_len` CHECK upper bound. Asserted in tests. */
export const ACCENT_MAX_LENGTH = 32;

/**
 * Length in Unicode code points, the way JSON Schema `minLength`/`maxLength` and Postgres
 * `char_length` count it. `String.prototype.length` counts UTF-16 units and would count one
 * supplementary character (an emoji, for example) as two.
 */
export function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n += 1;
  return n;
}
