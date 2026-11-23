import type { Tx } from "../../db/sql.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import { pgCode, pgMessage } from "../academics/pgError.js";
import { normalizeIp } from "../../http/ip.js";

/**
 * Operator cancellation of a queued settlement job (docs/WORKER-ISOLATION-PROPOSAL.md §6; migration 041).
 *
 * A settlement job is a SYSTEM obligation (enqueued without a user): it is never cancelled because the
 * person who started the prompt was disabled or left the school. Cancelling is an explicit, reasoned,
 * audited act of a finance administrator, and the database refuses it while the payment is still pending
 * (cancelling would abandon real money; the payment is reconciled instead). Only a queued job can be
 * cancelled; the audit row is written by the database function in the same transaction as the change.
 */
export async function cancelSettlementJob(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; paymentId: string; reason: string; ip?: string | null },
): Promise<{ job: { id: string; status: "cancelled"; payment_id: string } }> {
  const reason = input.reason.trim();
  const length = [...reason].length; // code points, as the database counts them
  if (length < 10 || length > 300) throw validationError("reason must be 10–300 characters");
  const found = await tx.query<{ id: string }>(
    `SELECT id FROM jobs WHERE tenant_id = $1 AND job_type = 'mpesa.stk_settle' AND idempotency_key = $2`,
    [input.tenantId, `settle:${input.paymentId}`],
  );
  const job = found.rows[0];
  if (!job) throw notFound("Settlement job not found");
  try {
    await tx.query(`SELECT public.jobs_operator_cancel($1, $2, $3, $4::inet)`, [job.id, input.actorUserId, reason, normalizeIp(input.ip)]);
  } catch (err) {
    const code = pgCode(err);
    if (code === "P0002") throw notFound("Settlement job not found");
    if (code === "23514") throw conflict(pgMessage(err));
    if (code === "22023") throw validationError("reason must be 10–300 characters");
    throw err;
  }
  return { job: { id: job.id, status: "cancelled", payment_id: input.paymentId } };
}
