import type { FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import type { AppPool } from "../db/pool.js";
import type { Tx } from "../db/sql.js";
import { withIdentityAccess } from "../db/identityAccess.js";
import { withTenantTransaction, type TransactionLimits } from "../db/tenantTransaction.js";
import { buildAuthzContext, type AuthzContext } from "../modules/rbac/authorize.js";
import { clientIp } from "./clientIp.js";
import { forbidden, validationError } from "./errors.js";
import {
  assertPasswordChangeNotRequired,
  requireSessionAuth,
  type RequestAuth,
} from "./middleware/authContext.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function transactionLimitsFromConfig(config: AppConfig): TransactionLimits {
  return {
    statementTimeoutMs: config.statementTimeoutMs,
    lockTimeoutMs: config.lockTimeoutMs,
    idleInTransactionSessionTimeoutMs: config.idleInTransactionSessionTimeoutMs,
  };
}

/**
 * One authorised tenant per request (AD-5).
 * Session lookup stays on the identity path so last_seen_at survives a rollback.
 * Tenant authorisation and the business operation share one transaction.
 * The callback must return data. Sending the HTTP reply inside it races the
 * COMMIT: the client can observe success before the write is durable.
 */
export async function withTenantRequest<T>(
  pool: AppPool,
  config: AppConfig,
  request: FastifyRequest,
  fn: (ctx: { tx: Tx; auth: RequestAuth }) => Promise<T>,
): Promise<T> {
  const sessionAuth = await withIdentityAccess(
    pool,
    (db) => requireSessionAuth(db, request),
    { acquireTimeoutMs: config.poolAcquireTimeoutMs },
  );
  assertPasswordChangeNotRequired(sessionAuth.user, request);

  const body = request.body as Record<string, unknown> | null | undefined;
  if (
    body &&
    typeof body === "object" &&
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    "permissions" in body
  ) {
    throw forbidden("Client-supplied permissions are not accepted");
  }

  let tenantId = sessionAuth.session.active_tenant_id;
  const headerTenant = request.headers["x-tenant-id"];
  if (headerTenant !== undefined) {
    const requested = typeof headerTenant === "string" ? headerTenant.trim() : "";
    if (!UUID_RE.test(requested)) throw validationError("X-Tenant-Id must be a UUID");
    tenantId = requested.toLowerCase();
  }
  if (!tenantId) throw forbidden("Tenant context required");

  let authz: AuthzContext | undefined;
  return withTenantTransaction(
    pool,
    {
      userId: sessionAuth.session.user_id,
      requestedTenantId: tenantId,
      ip: clientIp(request),
      limits: transactionLimitsFromConfig(config),
      acquireTimeoutMs: config.poolAcquireTimeoutMs,
      authorize: async (db) => {
        authz = await buildAuthzContext(db, {
          userId: sessionAuth.session.user_id,
          tenantId,
        });
      },
    },
    async (tx) => {
      if (!authz) throw forbidden("No membership for this school");
      const auth: RequestAuth = {
        session: sessionAuth.session,
        user: sessionAuth.user,
        authz,
      };
      request.auth = auth;
      return fn({ tx, auth });
    },
  );
}
