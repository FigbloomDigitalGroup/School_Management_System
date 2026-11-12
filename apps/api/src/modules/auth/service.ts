import type { Db } from "../../db/pool.js";
import type { AppConfig } from "../../config.js";
import { unauthorized, validationError, forbidden, notFound } from "../../http/errors.js";
import { hashPassword, verifyPassword } from "../identity/password.js";
import { assertPasswordPolicy } from "../identity/passwordPolicy.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { consumeAuthToken } from "./rateLimit.js";
import { rateLimitBucketForIp } from "./rateLimitBuckets.js";
import { createSession, revokeSession, type SessionRow } from "./session.js";
import { listMembershipsForUser } from "../tenancy/context.js";

export interface PublicUser {
  id: string;
  full_name: string;
  email: string | null;
  must_change_password: boolean;
  platform_role: string | null;
}

async function loadUser(db: Db, userId: string): Promise<PublicUser> {
  const result = await db.query<{
    id: string;
    full_name: string;
    email: string | null;
    must_change_password: boolean;
    status: string;
    platform_role: string | null;
  }>(
    `SELECT u.id, u.full_name, u.email, u.must_change_password, u.status,
            pr.role AS platform_role
     FROM users u
     LEFT JOIN platform_roles pr ON pr.user_id = u.id
     WHERE u.id = $1`,
    [userId],
  );
  const user = result.rows[0];
  if (!user || user.status !== "active") throw unauthorized("Invalid credentials");
  return {
    id: user.id,
    full_name: user.full_name,
    email: user.email,
    must_change_password: user.must_change_password,
    platform_role: user.platform_role,
  };
}

/**
 * AUD-04: verify against a throwaway hash when no usable account exists, so
 * "unknown account" costs the same scrypt time as "wrong password" and response
 * timing cannot be used to enumerate emails / login IDs.
 */
let decoyHash: Promise<string> | null = null;
async function burnVerify(password: string): Promise<void> {
  decoyHash ??= hashPassword("figbloom-decoy-credential");
  await verifyPassword(password, await decoyHash);
}

async function failLogin(
  db: Db,
  detail: Record<string, unknown>,
  ip?: string | null,
): Promise<never> {
  await recordSecurityEvent(db, {
    eventType: "auth.login.failure",
    detail,
    ip: ip ?? null,
  });
  throw unauthorized("Invalid credentials");
}

export async function loginWithEmail(
  db: Db,
  config: AppConfig,
  input: { email: string; password: string; ip?: string | null; userAgent?: string | null },
): Promise<{ token: string; user: PublicUser; session: SessionRow }> {
  const email = input.email.trim().toLowerCase();
  if (!email || !input.password) throw validationError("Email and password are required");

  // R2-03: IP bucket first so an exhausted IP limit never creates/consumes
  // an account bucket row for this attempt. R3-04: null IP → shared unknown bucket.
  await consumeAuthToken(db, config, rateLimitBucketForIp("login:ip", input.ip));
  await consumeAuthToken(db, config, `login:email:${email}`);

  const result = await db.query<{ id: string; password_hash: string; status: string }>(
    `SELECT id, password_hash, status FROM users WHERE email = $1`,
    [email],
  );
  const row = result.rows[0];
  if (!row || row.status !== "active") {
    await burnVerify(input.password);
    return await failLogin(db, { method: "email", reason: "unknown_or_disabled" }, input.ip);
  }
  const ok = await verifyPassword(input.password, row.password_hash);
  if (!ok) {
    return await failLogin(db, { method: "email", reason: "bad_password", userId: row.id }, input.ip);
  }

  const memberships = await listMembershipsForUser(db, row.id);
  const activeTenantId = memberships.length === 1 ? memberships[0]!.tenant_id : null;
  const org = await db.query<{ organization_id: string }>(
    `SELECT organization_id FROM organization_memberships WHERE user_id = $1 LIMIT 1`,
    [row.id],
  );

  const { token, session } = await createSession(db, config, {
    userId: row.id,
    activeTenantId,
    activeOrganizationId: org.rows[0]?.organization_id ?? null,
    userAgent: input.userAgent,
    ip: input.ip,
  });

  const user = await loadUser(db, row.id);
  await recordSecurityEvent(db, {
    eventType: "auth.login.success",
    actorUserId: user.id,
    tenantId: activeTenantId,
    detail: { method: "email" },
    ip: input.ip ?? null,
  });
  return { token, user, session };
}

export async function loginWithLoginId(
  db: Db,
  config: AppConfig,
  input: {
    tenantId: string;
    loginId: string;
    password: string;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<{ token: string; user: PublicUser; session: SessionRow }> {
  const loginId = input.loginId.trim().toUpperCase();
  if (!input.tenantId || !loginId || !input.password) {
    throw validationError("tenantId, loginId and password are required");
  }

  // R2-03: IP bucket first (see loginWithEmail). R3-04: shared unknown bucket.
  await consumeAuthToken(db, config, rateLimitBucketForIp("login:ip", input.ip));
  await consumeAuthToken(db, config, `login:login_id:${input.tenantId}:${loginId}`);

  const tenant = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM tenants WHERE id = $1`,
    [input.tenantId],
  );
  if (!tenant.rows[0] || tenant.rows[0].status === "suspended") {
    await burnVerify(input.password);
    return await failLogin(db, { method: "login_id", reason: "tenant_unavailable" }, input.ip);
  }

  const membership = await db.query<{ user_id: string; password_hash: string; status: string }>(
    `SELECT m.user_id, u.password_hash, u.status
     FROM school_memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = $1
       AND lower(m.login_id) = lower($2)
       AND m.archived_at IS NULL`,
    [input.tenantId, loginId],
  );
  const row = membership.rows[0];
  if (!row || row.status !== "active") {
    await burnVerify(input.password);
    return await failLogin(db, { method: "login_id", reason: "unknown_or_disabled" }, input.ip);
  }
  const ok = await verifyPassword(input.password, row.password_hash);
  if (!ok) {
    return await failLogin(db, { method: "login_id", reason: "bad_password", userId: row.user_id }, input.ip);
  }

  const { token, session } = await createSession(db, config, {
    userId: row.user_id,
    activeTenantId: input.tenantId,
    userAgent: input.userAgent,
    ip: input.ip,
  });
  const user = await loadUser(db, row.user_id);
  await recordSecurityEvent(db, {
    eventType: "auth.login.success",
    actorUserId: user.id,
    tenantId: input.tenantId,
    detail: { method: "login_id" },
    ip: input.ip ?? null,
  });
  return { token, user, session };
}

export async function logout(
  db: Db,
  session: SessionRow,
  ip?: string | null,
): Promise<void> {
  await revokeSession(db, session.id);
  await recordSecurityEvent(db, {
    eventType: "auth.logout",
    actorUserId: session.user_id,
    tenantId: session.active_tenant_id,
    ip: ip ?? null,
  });
}

/**
 * Authenticated password change (R2-07).
 * - Verifies current password.
 * - Enforces password policy.
 * - Clears must_change_password only after success.
 * - Revokes all other sessions; keeps the current session active.
 * - Never logs passwords or hashes.
 */
export async function changePassword(
  db: Db,
  config: AppConfig,
  input: {
    session: SessionRow;
    currentPassword: string;
    newPassword: string;
    ip?: string | null;
  },
): Promise<PublicUser> {
  try {
    assertPasswordPolicy(input.newPassword);
  } catch (err) {
    throw validationError(err instanceof Error ? err.message : "Invalid password");
  }
  if (input.newPassword === input.currentPassword) {
    throw validationError("New password must differ from the current password");
  }

  await consumeAuthToken(db, config, rateLimitBucketForIp("password_change:ip", input.ip));
  await consumeAuthToken(db, config, `password_change:user:${input.session.user_id}`);

  const row = await db.query<{ password_hash: string; status: string }>(
    `SELECT password_hash, status FROM users WHERE id = $1`,
    [input.session.user_id],
  );
  const userRow = row.rows[0];
  if (!userRow || userRow.status !== "active") throw unauthorized("Invalid credentials");

  const ok = await verifyPassword(input.currentPassword, userRow.password_hash);
  if (!ok) {
    await recordSecurityEvent(db, {
      eventType: "auth.login.failure",
      actorUserId: input.session.user_id,
      detail: { method: "password_change", reason: "bad_current_password" },
      ip: input.ip ?? null,
    });
    throw unauthorized("Invalid credentials");
  }

  const newHash = await hashPassword(input.newPassword);
  await db.query(
    `UPDATE users
     SET password_hash = $2, must_change_password = false, updated_at = now()
     WHERE id = $1`,
    [input.session.user_id, newHash],
  );

  // Revoke every other session; current session remains valid (documented).
  await db.query(
    `UPDATE sessions SET revoked_at = now()
     WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2`,
    [input.session.user_id, input.session.id],
  );

  await recordSecurityEvent(db, {
    eventType: "auth.password.changed",
    actorUserId: input.session.user_id,
    tenantId: input.session.active_tenant_id,
    detail: { revokedOtherSessions: true, keptSessionId: input.session.id },
    ip: input.ip ?? null,
  });

  return loadUser(db, input.session.user_id);
}

export async function selectTenant(
  db: Db,
  session: SessionRow,
  tenantId: string,
  ip?: string | null,
): Promise<SessionRow> {
  // R2-08: resolve existence before access — nonexistent must be 404, not
  // "no membership" / "suspended".
  const tenant = await db.query<{ status: string; organization_id: string }>(
    `SELECT status, organization_id FROM tenants WHERE id = $1`,
    [tenantId],
  );
  if (!tenant.rows[0]) throw notFound("School not found");

  const membership = await db.query(
    `SELECT 1 FROM school_memberships
     WHERE user_id = $1 AND tenant_id = $2 AND archived_at IS NULL`,
    [session.user_id, tenantId],
  );
  const platform = await db.query(
    `SELECT 1 FROM platform_roles WHERE user_id = $1 AND role = 'super_admin'`,
    [session.user_id],
  );
  const org = await db.query(
    `SELECT 1
     FROM organization_memberships om
     JOIN tenants t ON t.organization_id = om.organization_id
     JOIN organizations o ON o.id = om.organization_id
     WHERE om.user_id = $1 AND t.id = $2 AND o.status = 'active'`,
    [session.user_id, tenantId],
  );

  if (
    (membership.rowCount ?? 0) === 0 &&
    (platform.rowCount ?? 0) === 0 &&
    (org.rowCount ?? 0) === 0
  ) {
    throw forbidden("No membership for this school");
  }

  const isSuperAdmin = (platform.rowCount ?? 0) > 0;
  // Members and org admins cannot select a suspended school. Platform
  // super_admin may select it for ops (aligned with buildAuthzContext acting-as;
  // does not grant school members any new privilege).
  if (tenant.rows[0].status === "suspended" && !isSuperAdmin) {
    throw forbidden("School is suspended");
  }

  const updated = await db.query<SessionRow>(
    `UPDATE sessions
     SET active_tenant_id = $2,
         active_organization_id = $3,
         last_seen_at = now()
     WHERE id = $1
     RETURNING id, user_id, active_tenant_id, active_organization_id, expires_at, revoked_at`,
    [session.id, tenantId, tenant.rows[0].organization_id],
  );
  await recordSecurityEvent(db, {
    eventType: "auth.tenant.selected",
    actorUserId: session.user_id,
    tenantId,
    ip: ip ?? null,
  });
  return updated.rows[0]!;
}

export { loadUser };
