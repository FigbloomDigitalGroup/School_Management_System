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
import { TEACHING_READ, teachingClassIds, teachingYearIds } from "../modules/academics/teaching.js";
import { hasPermission, loadEffectivePermissions, requirePermission } from "../modules/rbac/authorize.js";
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

/**
 * Teacher reads (docs/TEACHER-READS.md): the classes the caller teaches. Requires `resource.teaching.read` (the standard
 * audited 403 for a parent, a student or a driver); an empty list when the caller teaches nothing or has no linked staff
 * record. Read only: no write route uses it.
 */
export async function myTeachingClassIds(tx: Tx, auth: RequestAuth, ip: string | null): Promise<string[]> {
  await requirePermission(tx, auth.authz, TEACHING_READ, { ip, deferAudit: true });
  return auth.authz.tenantId ? teachingClassIds(tx, { tenantId: auth.authz.tenantId, userId: auth.user.id }) : [];
}

/**
 * Academic calendar read scope (docs/TEACHER-READS.md). Holders of `resource.academics.read` read every year and term: null.
 * A holder of `resource.teaching.read` who teaches reads only the academic years of the classes they teach (and those years'
 * terms). Anyone else, including a teacher who teaches nothing, gets the standard audited 403. Read only.
 */
export async function calendarReadScope(tx: Tx, auth: RequestAuth, ip: string | null): Promise<string[] | null> {
  const perms = await loadEffectivePermissions(tx, auth.authz);
  if (perms.has("resource.academics.read")) return null;
  const tenantId = auth.authz.tenantId;
  const years =
    tenantId && perms.has(TEACHING_READ)
      ? await teachingYearIds(tx, { tenantId, classIds: await teachingClassIds(tx, { tenantId, userId: auth.user.id }) })
      : [];
  if (years.length === 0) await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
  return years;
}

/** `limit` and `cursor` query parameters of a paged list. */
export function pageFrom(request: FastifyRequest): PageInput {
  return parsePage(request.query);
}
