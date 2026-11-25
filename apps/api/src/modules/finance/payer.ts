import type { Tx } from "../../db/sql.js";
import { forbidden } from "../../http/errors.js";
import { isMyChild } from "../family/children.js";
import { isMyOwnLearner } from "../student/self.js";
import type { AuthzContext } from "../rbac/authorize.js";

/**
 * Payer authorization seam (Stage 11; family link since A1, docs/FAMILY-READS.md; learners since docs/STUDENT-ACCOUNTS.md).
 *
 * Legacy: a family pays (M-Pesa prompt), submits payment proofs and opts in to the AI helper as a guardian of the learner
 * (`paysFor`: any guardian row of the caller for that learner); a learner with a login may pay their own fees (adult
 * higher-education learners have no guardian, `student/Fees.tsx`). Staff cannot pay.
 *
 * The caller may pay for a learner only when, in the school of the request and checked now:
 *   - they are a `parent` member and the learner is one of their children by `family_my_children()` (migration 099): a live
 *     account link, an active account, an active guardian record, a live guardian-learner relationship, an active learner.
 *     Any linked guardian may pay (`is_primary_payer` is shown, not enforced), as in the legacy app; or
 *   - they are a `student` member and the learner is their OWN learner by `student_my_learner()` (migration 110): a live
 *     login link, an active account, an active learner. Never another learner.
 * Everyone else, staff and super administrators included, is refused with the same message. Every payer-facing finance
 * path (and the payment-proof upload) goes through this one function.
 */
export const PAYER_LINK_MISSING = "This account is not linked to the learner as a guardian.";

export async function mayPayFor(tx: Tx, authz: AuthzContext, learnerId: string): Promise<boolean> {
  if (!authz.tenantId) return false;
  const role = authz.membership?.role;
  if (role === "parent") return (await isMyChild(tx, learnerId)) !== null;
  if (role === "student") return isMyOwnLearner(tx, learnerId);
  return false;
}

export async function assertMayPayFor(tx: Tx, authz: AuthzContext, learnerId: string): Promise<void> {
  if (!(await mayPayFor(tx, authz, learnerId))) throw forbidden(PAYER_LINK_MISSING);
}
