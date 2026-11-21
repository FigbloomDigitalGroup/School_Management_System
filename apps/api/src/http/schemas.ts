import { z } from "zod";

/**
 * One authoritative definition of the identifier and e-mail shapes the API
 * accepts on the wire (Stage Z, FIG-1615).
 *
 * Identifiers are accepted exactly as PostgreSQL's `uuid` type and
 * `authContext.ts`'s lenient UUID pattern accept them: any 8-4-4-4-12 hex form,
 * regardless of version or variant bits. Zod 4's `.uuid()` is RFC 9562-strict
 * and would reject ids that the API accepts today (for example
 * `11111111-1111-1111-1111-111111111111`), so `z.guid()` is used deliberately.
 * Changing this to a stricter check is an API-contract change that needs an
 * explicit decision.
 */
export const uuidString = z.guid();

/**
 * A real calendar date in YYYY-MM-DD form. The shape regex alone accepts 2026-02-31, which PostgreSQL then rejects with a
 * data exception; some routes mapped that to 400 and others did not. Impossible dates are rejected here, never normalised
 * into a different date (JavaScript's Date would silently roll 2026-02-31 over to March 3rd).
 */
const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function isRealCalendarDate(value: string): boolean {
  const m = DATE_SHAPE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  return d <= days;
}
/** Zod schema for a date-only wire value. The JSON-schema form stays the plain pattern (OpenAPI parity). */
export const calendarDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isRealCalendarDate, { message: "must be a real calendar date" });

/** Sign-in e-mail: same acceptance set as the previous `.email()` (pinned by test/validation.corpus.test.ts). */
export const loginEmailString = z.email().max(254);
