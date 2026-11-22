import type { FastifyInstance } from "fastify";
import type { AppPool } from "../../db/pool.js";
import { createIdentityHandle } from "../../db/sql.js";
import { withSystemTenantTransaction } from "../../db/systemTenantTransaction.js";
import { logWarn } from "../../log.js";
import { parseStkCallback, recordCallbackReceived, settlePrompt } from "../../modules/finance/mpesa.js";
import { maskMsisdn } from "../../modules/finance/money.js";
import { secretsMatch } from "../../modules/finance/mpesaProvider.js";
import { consumeAuthToken } from "../../modules/auth/rateLimit.js";
import { AppError } from "../errors.js";
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
/**
 * The address a junk sender is accounted under. An IPv6 sender controls a whole /64, so addresses are grouped by their first
 * 64 bits (otherwise one sender could mint a fresh bucket per address); IPv4 and unknown addresses are used as they are.
 */
export function junkBucketAddress(ip: string | null): string | null {
  if (!ip || !ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...new Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right].slice(0, 8);
  if (groups.length < 4) return ip;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/**
 * Consume one token of a callback policy. A refusal is logged as an observable, secret-free event (the policy that
 * refused, never the address or the token) and answered 429 with Retry-After by the standard error handler.
 */
async function consumeCallbackToken(
  pool: AppPool,
  policy: { authRateCapacity: number; authRateRefill: number; authRateIntervalMs: number },
  bucketKey: string,
  label: "invalid_secret" | "authenticated",
): Promise<void> {
  try {
    await consumeAuthToken(createIdentityHandle(pool), policy, bucketKey);
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 429) logWarn("mpesa_callback_rate_limited", { outcome: label });
    throw err;
  }
}

export async function registerMpesaRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.post("/v1/mpesa/callback", async (request, reply) => {
    const config = app.appConfig;
    // 1. The secret is checked FIRST (constant time, no database), so anonymous junk can never consume the bucket that
    //    legitimate provider callbacks use. Only the URL secret authenticates a callback.
    const token = (request.query as { token?: unknown }).token;
    const secretOk = Boolean(config.mpesaCallbackSecret) && typeof token === "string" && secretsMatch(token, config.mpesaCallbackSecret as string);
    if (!secretOk) {
      // junk traffic is bounded per client address, in a bucket of its own
      await consumeCallbackToken(
        pool,
        {
          authRateCapacity: config.mpesaCallbackInvalidRateCapacity,
          authRateRefill: config.mpesaCallbackInvalidRateRefill,
          authRateIntervalMs: config.mpesaCallbackInvalidRateIntervalMs,
        },
        rateLimitBucketForIp("mpesa_callback_invalid:ip", junkBucketAddress(clientIp(request))),
        "invalid_secret",
      );
      logWarn("mpesa_callback_rejected", { outcome: "bad_secret" });
      return reply.status(403).send({ error: { code: "forbidden", message: "Access denied", request_id: request.id } });
    }
    // 2. Authenticated callbacks share one platform-wide, burst-sized bucket (a last-resort bound, not a per-school quota).
    await consumeCallbackToken(
      pool,
      {
        authRateCapacity: config.mpesaCallbackRateCapacity,
        authRateRefill: config.mpesaCallbackRateRefill,
        authRateIntervalMs: config.mpesaCallbackRateIntervalMs,
      },
      "mpesa_callback:auth",
      "authenticated",
    );

    const parsed = parseStkCallback(request.body);
    if (!parsed) return reply.status(400).send({ error: { code: "validation_error", message: "Invalid callback", request_id: request.id } });
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
      // Persist the authenticated callback BEFORE asking the provider: a query that fails, a 503 or a stopped process
      // must not lose the receipt it carried (the settle job and the operator reuse this evidence).
      await withSystemTenantTransaction(pool, { tenantId }, (tx) =>
        recordCallbackReceived(tx, { tenantId, paymentId: payment.id, checkoutRequestId, evidence }),
      );
      let queried;
      try {
        queried = await app.mpesaProvider.stkQuery(checkoutRequestId);
      } catch {
        return reply.status(503).header("Retry-After", "5").send({ error: { code: "service_unavailable", message: "Try again", request_id: request.id } });
      }
      const outcome = await withSystemTenantTransaction(pool, { tenantId }, (tx) =>
        settlePrompt(tx, { tenantId, paymentId: payment.id, source: "callback", query: queried, evidence }),
      );
      if (outcome === "provider_pending") {
        return reply.status(503).header("Retry-After", "5").send({ error: { code: "service_unavailable", message: "Try again", request_id: request.id } });
      }
    } else {
      await withSystemTenantTransaction(pool, { tenantId }, (tx) =>
        settlePrompt(tx, { tenantId, paymentId: payment.id, source: "callback", query: { done: true, resultCode: 0 }, evidence }),
      );
    }
    return reply.status(200).send({ ResultCode: 0, ResultDesc: "Accepted" });
  });
}
