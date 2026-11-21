import type { Tx } from "../../db/sql.js";
import { forbidden } from "../../http/errors.js";
import type { AuthzContext } from "../rbac/authorize.js";

/**
 * Payer authorization seam (Stage 11).
 *
 * Legacy: a family pays (M-Pesa prompt), submits payment proofs and opts in to the AI helper as a
 * guardian of the learner, or as the learner, through a link between the signed-in account and the
 * guardian/learner record. Staff cannot pay (legacy mpesa-stk-push `paysFor`).
 *
 * The new backend has NO account-to-guardian or account-to-learner link: guardians are directory
 * contacts and "login/invite provisioning" is a deferred Identity decision (GRAPH.md, School Directory).
 * Creating such a link would grant payment power and access to children's financial records, so it is
 * an owner/Identity decision and is NOT invented here.
 *
 * Until it exists, this check fails closed for every caller. When Identity provisions the link, only
 * this function changes; every payer-facing finance path already goes through it.
 */
export const PAYER_LINK_MISSING =
  "This account is not linked to the learner as a guardian. Family accounts are not provisioned yet.";

export async function assertMayPayFor(
  _tx: Tx,
  _authz: AuthzContext,
  _learnerId: string,
): Promise<void> {
  throw forbidden(PAYER_LINK_MISSING);
}
