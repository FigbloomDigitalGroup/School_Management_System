import type { FastifyInstance } from "fastify";
import type { AppPool } from "../../db/pool.js";
import { createIdentityHandle } from "../../db/sql.js";
import { withSystemTenantTransaction } from "../../db/systemTenantTransaction.js";
import { logWarn } from "../../log.js";
import { parseStkCallback, settlePrompt } from "../../modules/finance/mpesa.js";
import { maskMsisdn } from "../../modules/finance/money.js";
import { secretsMatch } from "../../modules/finance/mpesaProvider.js";
import { consumeAuthToken } from "../../modules/auth/rateLimit.js";
import { clientIp } from "../clientIp.js";
import { rateLimitBucketForIp } from "../../modules/auth/rateLimitBuckets.js";

/**
 * Public M-Pesa callback (legacy mpesa-callback, redesigned). Safaricom sends no session, so the route
 * is authenticated by a shared secret in the callback URL (`?token=`, constant-time compare). The body is
 * NEVER trusted for money:
 *   1. the secret must match (else 403, nothing parsed or stored);
 *   2. the CheckoutRequestID must belong to a prompt we sent: it alone resolves the school, invoice and
 *      learner (finance_mpesa_tenant_for_checkout, the only cross-tenant step; returns a tenant id only);
 *      an unknown id is quarantined (operator-only table) and answered 200 so the provider stops retrying;
 *   3. the outcome is confirmed with the provider's STK query, outside any transaction;
 *   4. settlement runs in a transaction scoped to the prompt's own school, credits the PROMPT'S own
 *      amount (a different callback amount is logged, never credited) and is a no-op if the prompt is
 *      already settled (duplicate or replayed callbacks).
 * A provider query that fails or is still processing answers 503 so the provider redelivers; the settle
 * job also settles it independently.
 */
export async function registerMpesaRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.post("/v1/mpesa/callback", async (request, reply) => {
    const config = app.appConfig;
    // Abuse bound for every attempt (including wrong tokens), before any body is trusted.
    await consumeAuthToken(createIdentityHandle(pool), config, rateLimitBucketForIp("mpesa_callback:ip", clientIp(request)));
    const token = (request.query as { token?: unknown }).token;
    if (!config.mpesaCallbackSecret || typeof token !== "string" || !secretsMatch(token, config.mpesaCallbackSecret)) {
      return reply.status(403).send({ error: { code: "forbidden", message: "Access denied" } });
    }

    const parsed = parseStkCallback(request.body);
    if (!parsed) return reply.status(400).send({ error: { code: "validation_error", message: "Invalid callback" } });
    const { checkoutRequestId, merchantRequestId, evidence } = parsed;

    const found = await createIdentityHandle(pool).query<{ tenant_id: string | null }>(
      `SELECT finance_mpesa_tenant_for_checkout($1) AS tenant_id`,
      [checkoutRequestId],
    );
    const tenantId = found.rows[0]?.tenant_id ?? null;
    if (!tenantId) {
      await createIdentityHandle(pool).query(`SELECT finance_mpesa_record_unmatched($1, $2, $3, $4, $5, $6)`, [
        checkoutRequestId,
        merchantRequestId,
        evidence.resultCode,
        evidence.amountMinor,
        evidence.receipt && /^[A-Z0-9]{6,20}$/.test(evidence.receipt) ? evidence.receipt : null,
        evidence.msisdn && /^254\d{9}$/.test(evidence.msisdn) ? maskMsisdn(evidence.msisdn) : null,
      ]);
      logWarn("mpesa_callback_unmatched", { outcome: "quarantined" });
      return reply.status(200).send({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    const payment = await withSystemTenantTransaction(pool, { tenantId }, async (tx) => {
      const res = await tx.query<{ id: string; status: string }>(
        `SELECT id, status FROM finance_payments WHERE tenant_id = $1 AND checkout_request_id = $2 AND method = 'mpesa'`,
        [tenantId, checkoutRequestId],
      );
      return res.rows[0] ?? null;
    });
    if (!payment) return reply.status(200).send({ ResultCode: 0, ResultDesc: "Accepted" });

    if (payment.status === "pending") {
      let queried;
      try {
        queried = await app.mpesaProvider.stkQuery(checkoutRequestId);
      } catch {
        return reply.status(503).header("Retry-After", "5").send({ error: { code: "service_unavailable", message: "Try again" } });
      }
      const outcome = await withSystemTenantTransaction(pool, { tenantId }, (tx) =>
        settlePrompt(tx, { tenantId, paymentId: payment.id, source: "callback", query: queried, evidence }),
      );
      if (outcome === "provider_pending") {
        return reply.status(503).header("Retry-After", "5").send({ error: { code: "service_unavailable", message: "Try again" } });
      }
    } else {
      await withSystemTenantTransaction(pool, { tenantId }, (tx) =>
        settlePrompt(tx, { tenantId, paymentId: payment.id, source: "callback", query: { done: true, resultCode: 0 }, evidence }),
      );
    }
    return reply.status(200).send({ ResultCode: 0, ResultDesc: "Accepted" });
  });
}
