import type { Db } from "../../db/pool.js";
import type { AppConfig } from "../../config.js";
import { rateLimited, validationError } from "../../http/errors.js";

/**
 * PG-atomic token bucket (programme baseline: capacity 5, initial 5, +2 every 5 s).
 * All arithmetic runs inside consume_rate_token() under a row lock.
 *
 * `cost` is the weighted cost of the request (default 1). Returns the tokens
 * left; throws a 429 AppError carrying `retryAfterSeconds` when denied.
 * Costs above capacity are rejected without claiming a Retry-After that would
 * imply waiting helps for the same cost (R2-08).
 */
export async function consumeAuthToken(
  db: Db,
  config: Pick<AppConfig, "authRateCapacity" | "authRateRefill" | "authRateIntervalMs">,
  bucketKey: string,
  cost = 1,
): Promise<number> {
  if (!Number.isFinite(cost) || cost <= 0) {
    throw validationError("Invalid rate-limit cost");
  }
  if (cost > config.authRateCapacity) {
    // Can never succeed at this cost; do not suggest a short wait.
    throw rateLimited("Request cost exceeds rate-limit capacity", undefined);
  }

  const result = await db.query<{
    out_allowed: boolean;
    out_tokens: string;
    out_retry_after_ms: number | null;
  }>(`SELECT * FROM consume_rate_token($1, $2, $3, $4, $5)`, [
    bucketKey,
    cost,
    config.authRateCapacity,
    config.authRateRefill,
    config.authRateIntervalMs,
  ]);
  const row = result.rows[0]!;
  if (!row.out_allowed) {
    const ms = row.out_retry_after_ms;
    if (ms == null || ms <= 0) {
      throw rateLimited(undefined, undefined);
    }
    throw rateLimited(undefined, Math.max(1, Math.ceil(ms / 1000)));
  }
  return Number(row.out_tokens);
}
