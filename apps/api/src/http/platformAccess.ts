import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppPool } from "../db/pool.js";
import type { IdentityDb } from "../db/sql.js";
import { withIdentityAccess, withIdentityUserScope } from "../db/identityAccess.js";
import { assertRecentAuth } from "../modules/auth/reauth.js";
import { buildAuthzContext, requirePermission } from "../modules/rbac/authorize.js";
import { clientIp } from "./clientIp.js";
import { requireSessionAuth } from "./middleware/authContext.js";

/**
 * The one way a platform console route that WRITES (or reads Figbloom's own records) reaches the database: the session,
 * then the platform permission with NO school (`tenantId: null`, so `X-Tenant-Id` and the session's school are ignored and
 * a school user cannot reach the route by sending a header), then the work in a short transaction that sets only the
 * acting user (`app.user_id`), where the SECURITY DEFINER functions re-check the super administrator.
 *
 * Authentication and the permission run before anything else is looked at, so a refused caller learns nothing from a 400
 * and nothing about re-authentication. A refusal is audited inline by `requirePermission`.
 */
export interface PlatformActor {
  userId: string;
  sessionId: string;
  ip: string | null;
}

export async function requirePlatformActor(
  app: FastifyInstance,
  pool: AppPool,
  request: FastifyRequest,
  permission: string,
): Promise<PlatformActor> {
  const ip = clientIp(request);
  return withIdentityAccess(
    pool,
    async (db) => {
      const { user, session } = await requireSessionAuth(db, request);
      const authz = await buildAuthzContext(db, { userId: user.id, tenantId: null });
      await requirePermission(db, authz, permission, { ip });
      return { userId: user.id, sessionId: session.id, ip };
    },
    { acquireTimeoutMs: app.appConfig.poolAcquireTimeoutMs },
  );
}

/**
 * Runs `fn` as the actor. `sensitive` writes first ask for a recent sign-in (`assertRecentAuth`, the 300 s window), in the
 * same transaction, so a stale session changes nothing and gets 403 `reauth_required`.
 */
export async function asPlatformActor<T>(
  app: FastifyInstance,
  pool: AppPool,
  actor: PlatformActor,
  fn: (db: IdentityDb) => Promise<T>,
  opts: { sensitive: boolean },
): Promise<T> {
  return withIdentityUserScope(
    pool,
    actor.userId,
    async (db) => {
      if (opts.sensitive) await assertRecentAuth(db, app.appConfig, actor.sessionId);
      return fn(db);
    },
    { acquireTimeoutMs: app.appConfig.poolAcquireTimeoutMs },
  );
}
