import { settlePrompt } from "../modules/finance/mpesa.js";
import type { MpesaProvider, StkQueryResult } from "../modules/finance/mpesaProvider.js";
import type { PushProvider } from "../modules/notifications/pushProvider.js";
import { processNotificationOutboxJob } from "../modules/notifications/service.js";
import type { StorageProvider } from "../modules/storage/storageProvider.js";
import { processExportJob } from "../modules/reporting/exportService.js";
import { PermanentJobError, RetryableJobError, type JobHandler } from "./runtime.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * mpesa.stk_settle (enqueued with every prompt, run after MPESA_SETTLE_DELAY_SECONDS): settles a prompt
 * whose callback never arrived, from the provider's STK query (legacy: stale pending prompts are settled
 * by STK query, never credited without it). The payment id in the payload is only a lookup key under
 * the job's tenant: a payload naming another school's payment finds nothing (RLS) and fails permanently.
 * This is a system obligation that records provider truth, so it runs even if the parent who started the
 * prompt has since lost access (it does not act on their behalf).
 *
 * announcement.push: records a delivery ledger row for a published announcement. FCM/provider send is
 * not wired in this slice; the job proves tenant-isolated enqueue + worker handling without inventing a
 * push vendor integration.
 */
export function workerHandlers(
  provider: MpesaProvider,
  deps?: { pushProvider?: PushProvider; storageProvider?: StorageProvider },
): Record<string, JobHandler> {
  return {
    "notification.dispatch": async (ctx) => {
      await processNotificationOutboxJob(ctx, deps?.pushProvider);
    },
    "export.generate": async (ctx) => {
      await processExportJob(ctx, deps?.storageProvider);
    },
    "announcement.push": async (ctx) => {
      const announcementId = ctx.payload.announcementId;
      if (typeof announcementId !== "string" || !UUID.test(announcementId)) {
        throw new PermanentJobError("invalid_payload");
      }
      await ctx.inTenant(async (tx) => {
        const ann = await tx.query<{ id: string; published_at: Date | null; channels: string[] }>(
          `SELECT id, published_at, channels FROM communications_announcements WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, announcementId],
        );
        const row = ann.rows[0];
        if (!row) throw new PermanentJobError("announcement_not_visible");
        if (!row.published_at) throw new PermanentJobError("announcement_not_published");
        if (!row.channels.includes("push")) throw new PermanentJobError("push_channel_absent");
        const prior = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM communications_announcement_deliveries
            WHERE tenant_id = $1 AND announcement_id = $2 AND channel = 'push'`,
          [ctx.tenantId, announcementId],
        );
        if ((prior.rows[0]?.n ?? 0) > 0) return;
        const elig = await tx.query<{ eligible_count: number }>(
          `SELECT public.communications_announcement_push_eligible_count($1) AS eligible_count`,
          [announcementId],
        );
        const eligibleRecipients = elig.rows[0]?.eligible_count ?? 0;
        await tx.query(
          `INSERT INTO communications_announcement_deliveries (tenant_id, announcement_id, channel, status, detail)
           VALUES ($1, $2, 'push', 'skipped_no_provider', $3::jsonb)`,
          [
            ctx.tenantId,
            announcementId,
            JSON.stringify({
              reason: "push_provider_not_configured",
              note: "Stage 12 records the delivery attempt; FCM/APNs wiring is a later operational slice",
              jobId: ctx.jobId,
              preferenceFlagConsulted: "general_notices",
              eligibleRecipients,
            }),
          ],
        );
      });
    },
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
      if (payment.status !== "pending" && !payment.checkout_request_id) return;
      if (!payment.checkout_request_id) {
        // The settle job is enqueued before stkPush returns. If we "succeed" here, the unique
        // settle:{paymentId} key prevents a later query after the checkout id is stored. Retry until
        // the id appears or the job is exhausted; payment stays pending for reconciliation.
        throw new RetryableJobError("awaiting_checkout_id");
      }
      if (!provider.configured) {
        if (payment.status !== "pending") return;
        throw new RetryableJobError("mpesa_not_configured");
      }
      let result: StkQueryResult;
      try {
        result = await provider.stkQuery(payment.checkout_request_id);
      } catch {
        if (payment.status !== "pending") return;
        throw new RetryableJobError("provider_error");
      }
      // fenced: a worker that lost the lease must not settle or audit anything (review R2/N2)
      const outcome = await ctx.fenced((tx) =>
        settlePrompt(tx, {
          tenantId: ctx.tenantId,
          paymentId,
          source: "status_query",
          query: result,
          job: { jobId: ctx.jobId, jobType: ctx.jobType, attempt: ctx.attempt, leaseToken: ctx.leaseToken },
        }),
      );
      if (outcome === "provider_pending") throw new RetryableJobError("provider_pending");
      if (outcome === "conflict") throw new PermanentJobError("settlement_conflict");
    },
  };
}
