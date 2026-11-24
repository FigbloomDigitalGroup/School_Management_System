import type { Tx } from "../../db/sql.js";
import { forbidden } from "../../http/errors.js";
import { isMyChild } from "../family/children.js";
import type { AuthzContext } from "../rbac/authorize.js";

/**
 * Payer authorization seam (Stage 11; family link since A1, docs/FAMILY-READS.md).
 *
 * Legacy: a family pays (M-Pesa prompt), submits payment proofs and opts in to the AI helper as a guardian of the learner
 * (`paysFor`: any guardian row of the caller for that learner). Staff cannot pay.
 *
 * The caller may pay for a learner only when they are a `parent` member of the school of the request AND the learner is
 * one of their children by `family_my_children()` (migration 099): a live account link, an active account, an active
 * guardian record, a live guardian-learner relationship and an active learner, all in this school, checked now. Any
 * linked guardian may pay (`is_primary_payer` is shown, not enforced), as in the legacy app. Everyone else, staff and
 * super administrators included, is refused with the same message. Student accounts do not exist yet (A4), so a learner
 * cannot pay for themselves. Every payer-facing finance path goes through this one function.
 */
export const PAYER_LINK_MISSING = "This account is not linked to the learner as a guardian.";

export async function assertMayPayFor(tx: Tx, authz: AuthzContext, learnerId: string): Promise<void> {
  if (authz.membership?.role !== "parent" || !authz.tenantId) throw forbidden(PAYER_LINK_MISSING);
  if (!(await isMyChild(tx, learnerId))) throw forbidden(PAYER_LINK_MISSING);
}
