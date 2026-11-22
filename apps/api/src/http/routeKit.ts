import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppPool } from "../db/pool.js";
import type { Tx } from "../db/sql.js";
import { clientIp } from "./clientIp.js";
import { validationError } from "./errors.js";
import type { RequestAuth } from "./middleware/authContext.js";
import { uuidString } from "./schemas.js";
import { withTenantRequest } from "./tenantRequest.js";
import { assertSameTenant } from "../modules/tenancy/context.js";
import { teacherClassIds } from "../modules/academics/structure.js";
import { hasPermission, requirePermission } from "../modules/rbac/authorize.js";
import { parsePage, type PageInput } from "../modules/academics/pagination.js";

export function assertUuid(value: string, field: string): void {
  if (!uuidString.safeParse(value).success) throw validationError(`${field} must be a UUID`);
}

export function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !uuidString.safeParse(value).success) {
    throw validationError(`${field} must be a UUID`);
  }
  return value;
}

/** `null` means the filter was omitted. */
export function optionalBool(value: unknown, field: string): boolean | null {
  if (value === undefined || value === null || value === "") return null;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw validationError(`${field} must be true or false`);
}

export async function inTenant<T>(
  app: FastifyInstance,
  pool: AppPool,
  request: FastifyRequest,
  tenantId: string,
  fn: (ctx: { tx: Tx; auth: RequestAuth; ip: string | null }) => Promise<T>,
): Promise<T> {
  assertUuid(tenantId, "tenantId");
  return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
    assertSameTenant(auth.authz.tenantId, tenantId);
    return fn({ tx, auth, ip: clientIp(request) });
  });
}

/**
 * OD-2 read scope. Holders of `readPermission` (admins, area holders, delegates) read every class:
 * null. Anyone else reads only the classes they teach (active teaching assignment or class teacher);
 * a user who teaches nothing gets the standard audited 403. This grants READ only: no write route
 * uses it.
 */
export async function classReadScope(
  tx: Tx,
  auth: RequestAuth,
  ip: string | null,
  readPermission: "resource.academics.read" | "resource.attendance.read",
): Promise<string[] | null> {
  if (await hasPermission(tx, auth.authz, readPermission)) return null;
  const classes = auth.authz.tenantId ? await teacherClassIds(tx, { tenantId: auth.authz.tenantId, userId: auth.user.id }) : [];
  if (classes.length === 0) {
    await requirePermission(tx, auth.authz, readPermission, { ip, deferAudit: true });
  }
  return classes;
}

/** `limit` and `cursor` query parameters of a paged list. */
export function pageFrom(request: FastifyRequest): PageInput {
  return parsePage(request.query);
}
