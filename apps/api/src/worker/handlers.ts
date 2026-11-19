import { settlePrompt } from "../modules/finance/mpesa.js";
import type { MpesaProvider, StkQueryResult } from "../modules/finance/mpesaProvider.js";
import { PermanentJobError, RetryableJobError, type JobHandler } from "./runtime.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * mpesa.stk_settle (enqueued with every prompt, run after MPESA_SETTLE_DELAY_SECONDS): settles a prompt
 * whose callback never arrived, from the provider's STK query (legacy: stale pending prompts are settled
 * by STK query, never credited without it). The payment id in the payload is only a lookup key under
 * the job's tenant: a payload naming another school's payment finds nothing (RLS) and fails permanently.
 * This is a system obligation that records provider truth, so it runs even if the parent who started the
 * prompt has since lost access (it does not act on their behalf).
 */
export function workerHandlers(provider: MpesaProvider): Record<string, JobHandler> {
  return {
    "mpesa.stk_settle": async (ctx) => {
      const paymentId = ctx.payload.paymentId;
      if (typeof paymentId !== "string" || !UUID.test(paymentId)) throw new PermanentJobError("invalid_payload");
      const payment = await ctx.inTenant(async (tx) => {
        const res = await tx.query<{ status: string; checkout_request_id: string | null }>(
          `SELECT status, checkout_request_id FROM finance_payments WHERE tenant_id = $1 AND id = $2 AND method = 'mpesa'`,
          [ctx.tenantId, paymentId],
        );
        return res.rows[0] ?? null;
      });
      if (!payment) throw new PermanentJobError("payment_not_visible");
      if (payment.status !== "pending") return;
      if (!payment.checkout_request_id) {
        // The settle job is enqueued before stkPush returns. If we "succeed" here, the unique
        // settle:{paymentId} key prevents a later query after the checkout id is stored. Retry until
        // the id appears or the job is exhausted; payment stays pending for reconciliation.
        throw new RetryableJobError("awaiting_checkout_id");
      }
      if (!provider.configured) throw new RetryableJobError("mpesa_not_configured");
      let result: StkQueryResult;
      try {
        result = await provider.stkQuery(payment.checkout_request_id);
      } catch {
        throw new RetryableJobError("provider_error");
      }
      const outcome = await ctx.inTenant((tx) => settlePrompt(tx, { tenantId: ctx.tenantId, paymentId, source: "status_query", query: result }));
      if (outcome === "provider_pending") throw new RetryableJobError("provider_pending");
    },
  };
}
