import type { FastifyRequest } from "fastify";
import type { Db } from "../../db/pool.js";
import { bearerToken, requireSession, type SessionRow } from "../../modules/auth/session.js";
import { loadUser, type PublicUser } from "../../modules/auth/service.js";
import { buildAuthzContext, type AuthzContext } from "../../modules/rbac/authorize.js";
import { forbidden, validationError } from "../errors.js";

export interface SessionAuth {
  session: SessionRow;
  user: PublicUser;
}

export interface RequestAuth extends SessionAuth {
  authz: AuthzContext;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: RequestAuth;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Identity only: a valid, unexpired, unrevoked session whose user is active.
 * Used by endpoints that must keep working when the session's school is no
 * longer usable (logout, select-tenant, /me) — AUD-06.
 */
/** Routes allowed while must_change_password is true (R2-07). */
const PASSWORD_CHANGE_ALLOWLIST = new Set([
  "POST /v1/auth/logout",
  "GET /v1/auth/me",
  "POST /v1/auth/password/change",
]);

export function routeKey(request: FastifyRequest): string {
  const method = request.method.toUpperCase();
  // Fastify routerPath when available; fall back to URL without query.
  const path =
    (request as { routeOptions?: { url?: string } }).routeOptions?.url ??
    request.url.split("?")[0] ??
    "";
  return `${method} ${path}`;
}

export async function requireSessionAuth(db: Db, request: FastifyRequest): Promise<SessionAuth> {
  const token = bearerToken(request.headers.authorization);
  const session = await requireSession(db, token);
  const user = await loadUser(db, session.user_id);
  return { session, user };
}

/** Block normal application routes until password is changed. */
export function assertPasswordChangeNotRequired(user: PublicUser, request: FastifyRequest): void {
  if (!user.must_change_password) return;
  if (PASSWORD_CHANGE_ALLOWLIST.has(routeKey(request))) return;
  throw forbidden("Password change required");
}

/**
 * Establish identity AND authorization context. The tenant is the session's
 * active tenant, or an X-Tenant-Id the caller proves access to: buildAuthzContext
 * re-derives access from membership / organisation / platform tables on every
 * request and throws 403 otherwise. A client role/permission list is never read.
 */
export async function authenticateRequest(db: Db, request: FastifyRequest): Promise<RequestAuth> {
  const { session, user } = await requireSessionAuth(db, request);
  assertPasswordChangeNotRequired(user, request);

  let tenantId = session.active_tenant_id;
  const headerTenant = request.headers["x-tenant-id"];
  if (headerTenant !== undefined) {
    const requested = typeof headerTenant === "string" ? headerTenant.trim() : "";
    if (!UUID_RE.test(requested)) throw validationError("X-Tenant-Id must be a UUID");
    tenantId = requested.toLowerCase();
  }

  // Authorization never reads role/permissions from the request body. A client
  // sending `permissions` as evidence of access is rejected explicitly.
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

  const authz = await buildAuthzContext(db, { userId: session.user_id, tenantId });
  const auth: RequestAuth = { session, user, authz };
  request.auth = auth;
  return auth;
}

export async function requireTenantAuth(db: Db, request: FastifyRequest): Promise<RequestAuth> {
  const auth = await authenticateRequest(db, request);
  if (!auth.authz.tenantId) throw forbidden("Tenant context required");
  return auth;
}
