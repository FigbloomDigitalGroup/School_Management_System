import { createHmac } from "node:crypto";
import type { Tx } from "../../db/sql.js";
import type { AppConfig } from "../../config.js";
import { conflict, idempotencyKeyReused, validationError } from "../../http/errors.js";

/**
 * Optional Idempotency-Key for side-effecting POSTs (FIG-1623, AD-10).
 *
 * Guarantee: for a given (tenant, actor, key) within the validity window there is at most one
 * committed effect. It is NOT exactly-once across client, network or process failures; a
 * client that never learned the outcome retries with the same key and gets either the original
 * outcome (replay) or, if the first attempt rolled back, a fresh execution.
 *
 * Order inside the single tenant transaction: authorisation and permission checks (done by the
 * route) -> claim -> business effect and its audit event -> complete -> commit. A denied actor
 * never reaches the claim, so nothing is stored for them and a replay re-authorises with the
 * actor's CURRENT permissions.
 */
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export function parseIdempotencyKey(header: unknown): string | undefined {
  if (header === undefined) return undefined;
  if (typeof header !== "string" || !KEY_RE.test(header)) {
    throw validationError("Idempotency-Key must be 8-128 characters from A-Z a-z 0-9 . _ : -");
  }
  return header;
}

const LOCAL_FALLBACK_KEY = "figbloom-local-test-idempotency-key-not-for-production-0000";

/** Canonical JSON: object keys sorted recursively, so key order in the body never changes the fingerprint. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(",")}}`;
}

/** Keyed fingerprint of the request (HMAC-SHA256, hex). Never stored: the body; only this. */
export function requestFingerprint(config: AppConfig, input: unknown): string {
  const secret = config.idempotencyFingerprintKey ?? LOCAL_FALLBACK_KEY;
  return createHmac("sha256", secret).update(canonical(input), "utf8").digest("hex");
}

export interface IdempotentResult<T> {
  value: T;
  status: number;
  replayed: boolean;
}

export async function runIdempotent<T>(
  tx: Tx,
  opts: {
    key: string | undefined;
    config: AppConfig;
    /** "POST /v1/tenants/:tenantId/learners" - the route template, not the concrete URL. */
    routeTemplate: string;
    /** Everything that defines "the same request": path params and body. */
    fingerprintInput: unknown;
    /** Status of the original success (201). Replays return the stored status. */
    status: number;
    execute: () => Promise<{ value: T; resourceType: string; resourceId: string }>;
    /** Re-read the resource by reference. Reflects its CURRENT state. */
    replay: (resourceType: string, resourceId: string) => Promise<T | null>;
  },
): Promise<IdempotentResult<T>> {
  if (opts.key === undefined) {
    const done = await opts.execute();
    return { value: done.value, status: opts.status, replayed: false };
  }

  const fingerprint = requestFingerprint(opts.config, {
    r: opts.routeTemplate,
    t: tx.tenantId,
    q: opts.fingerprintInput,
  });

  // A concurrent duplicate blocks here until the first transaction commits or rolls back.
  // An EXPIRED row for the same key is replaced atomically; a live row is left untouched.
  const claimed = await tx.query<{ id: string }>(
    `INSERT INTO idempotency_keys (tenant_id, actor_user_id, idempotency_key, route, fingerprint, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6::double precision))
     ON CONFLICT (tenant_id, actor_user_id, idempotency_key) DO UPDATE
        SET route = EXCLUDED.route, fingerprint = EXCLUDED.fingerprint,
            resource_type = NULL, resource_id = NULL, response_status = NULL,
            created_at = now(), expires_at = EXCLUDED.expires_at
      WHERE idempotency_keys.expires_at <= now()
     RETURNING id`,
    [tx.tenantId, tx.userId, opts.key, opts.routeTemplate, fingerprint, opts.config.idempotencyTtlSeconds],
  );

  if (claimed.rowCount === 1) {
    const done = await opts.execute();
    await tx.query(
      `UPDATE idempotency_keys SET resource_type = $2, resource_id = $3, response_status = $4 WHERE id = $1`,
      [claimed.rows[0]!.id, done.resourceType, done.resourceId, opts.status],
    );
    return { value: done.value, status: opts.status, replayed: false };
  }

  const existing = await tx.query<{
    route: string;
    fingerprint: string;
    resource_type: string | null;
    resource_id: string | null;
    response_status: number | null;
  }>(
    `SELECT route, fingerprint, resource_type, resource_id, response_status
       FROM idempotency_keys
      WHERE tenant_id = $1 AND actor_user_id = $2 AND idempotency_key = $3`,
    [tx.tenantId, tx.userId, opts.key],
  );
  const row = existing.rows[0];
  if (!row || row.route !== opts.routeTemplate || row.fingerprint !== fingerprint) {
    throw idempotencyKeyReused();
  }
  if (!row.resource_type || !row.resource_id) {
    // Cannot happen for a committed row (claim and completion share a transaction); fail safe.
    throw conflict("The original request with this Idempotency-Key did not complete");
  }
  const value = await opts.replay(row.resource_type, row.resource_id);
  if (value === null) {
    throw conflict("The resource created by the original request is no longer available");
  }
  return { value, status: row.response_status ?? opts.status, replayed: true };
}
