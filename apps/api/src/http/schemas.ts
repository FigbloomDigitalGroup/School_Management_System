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

/** Sign-in e-mail: same acceptance set as the previous `.email()` (pinned by test/validation.corpus.test.ts). */
export const loginEmailString = z.email().max(254);
