import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../../db/pool.js";
import type { AppConfig } from "../../config.js";
import { forbidden, unauthorized } from "../../http/errors.js";
import { normalizeIp } from "../../http/ip.js";
import {
  buildMintPayload,
  buildRevokeAllPayload,
  buildRevokePayload,
  buildSetTenantPayload,
  newProofNonce,
  sessionMintHmacKey,
  signSessionProof,
} from "./sessionProof.js";

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function mintSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface SessionRow {
  id: string;
  user_id: string;
  active_tenant_id: string | null;
  active_organization_id: string | null;
  expires_at: Date;
  revoked_at: Date | null;
}

export async function createSession(
  db: Db,
  config: AppConfig,
  input: {
    userId: string;
    activeTenantId?: string | null;
    activeOrganizationId?: string | null;
    userAgent?: string | null;
    ip?: string | null;
    mintedBy?: "login" | "refresh";
  },
): Promise<{ token: string; session: SessionRow }> {
  const token = mintSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000);
  const issuedAt = new Date();
  // Align microseconds with PostgreSQL to_char used in the mint payload.
  const expiresAtAligned = new Date(Math.floor(expiresAt.getTime() / 1000) * 1000);
  const issuedAtAligned = new Date(Math.floor(issuedAt.getTime() / 1000) * 1000);
  // Prefer microsecond-stable instants: use the ISO-expanded forms in the SQL args too.
  const nonce = newProofNonce();
  const mintedBy = input.mintedBy ?? "login";
  const activeTenantId = input.activeTenantId ?? null;
  const activeOrganizationId = input.activeOrganizationId ?? null;
  const secret = sessionMintHmacKey(config);
  const payload = buildMintPayload({
    userId: input.userId,
    tokenHash,
    expiresAt: expiresAtAligned,
    issuedAt: issuedAtAligned,
    nonce,
    mintedBy,
    actorUserId: input.userId,
    activeTenantId,
    activeOrganizationId,
  });
  const mac = signSessionProof(secret, payload);

  const result = await db.query<SessionRow>(
    `SELECT id, user_id, active_tenant_id, active_organization_id, expires_at, revoked_at
       FROM public.auth_mint_session(
         $1::uuid, $2::text, $3::timestamptz, $4::uuid, $5::uuid, $6::text, $7::inet,
         $8::text, $9::uuid, $10::timestamptz, $11::text, $12::text
       )`,
    [
      input.userId,
      tokenHash,
      // Pass the same microsecond text the HMAC payload used.
      payload.split("|")[4],
      activeTenantId,
      activeOrganizationId,
      input.userAgent ?? null,
      normalizeIp(input.ip),
      mintedBy,
      input.userId,
      payload.split("|")[5],
      nonce,
      mac,
    ],
  );
  const session = result.rows[0];
  if (!session) {
    throw unauthorized("Unable to create session");
  }
  return { token, session };
}

/**
 * Validate a session and, at most once per interval, record that it was seen (FIG-1624).
 *
 * Validity (not revoked, not expired) is evaluated by every call, in the same single
 * statement that may write, so throttling can never extend a revoked or expired session.
 * The write is one conditional UPDATE inside auth_touch_session.
 */
export async function findValidSession(
  db: Db,
  token: string,
  lastSeenIntervalSeconds = 0,
): Promise<SessionRow | null> {
  const tokenHash = hashSessionToken(token);
  const result = await db.query<SessionRow>(
    `SELECT id, user_id, active_tenant_id, active_organization_id, expires_at, revoked_at
       FROM public.auth_touch_session($1::text, $2::double precision)`,
    [tokenHash, lastSeenIntervalSeconds],
  );
  return result.rows[0] ?? null;
}

export async function requireSession(
  db: Db,
  token: string | undefined | null,
  lastSeenIntervalSeconds = 0,
): Promise<SessionRow> {
  if (!token) throw unauthorized();
  const session = await findValidSession(db, token, lastSeenIntervalSeconds);
  if (!session) throw unauthorized("Invalid or expired session");
  return session;
}

export async function revokeSession(
  db: Db,
  config: AppConfig,
  sessionId: string,
  actorUserId: string,
): Promise<void> {
  const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  const nonce = newProofNonce();
  const payload = buildRevokePayload({
    sessionId,
    issuedAt,
    nonce,
    actorUserId,
  });
  const mac = signSessionProof(sessionMintHmacKey(config), payload);
  await db.query(
    `SELECT public.auth_revoke_session($1::uuid, $2::uuid, $3::timestamptz, $4::text, $5::text)`,
    [sessionId, actorUserId, payload.split("|")[3], nonce, mac],
  );
}

export async function revokeAllUserSessions(
  db: Db,
  config: AppConfig,
  userId: string,
  keepSessionId: string | null = null,
): Promise<number> {
  const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  const nonce = newProofNonce();
  const payload = buildRevokeAllPayload({
    userId,
    keepSessionId,
    issuedAt,
    nonce,
    actorUserId: userId,
  });
  const mac = signSessionProof(sessionMintHmacKey(config), payload);
  const result = await db.query<{ auth_revoke_all_user_sessions: number }>(
    `SELECT public.auth_revoke_all_user_sessions(
       $1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::text, $6::text
     ) AS auth_revoke_all_user_sessions`,
    [userId, userId, keepSessionId, payload.split("|")[4], nonce, mac],
  );
  return result.rows[0]?.auth_revoke_all_user_sessions ?? 0;
}

export async function setSessionTenant(
  db: Db,
  config: AppConfig,
  input: {
    sessionId: string;
    tenantId: string;
    organizationId: string;
    actorUserId: string;
  },
): Promise<SessionRow> {
  const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  const nonce = newProofNonce();
  const payload = buildSetTenantPayload({
    sessionId: input.sessionId,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    issuedAt,
    nonce,
    actorUserId: input.actorUserId,
  });
  const mac = signSessionProof(sessionMintHmacKey(config), payload);
  let result;
  try {
    result = await db.query<SessionRow>(
      `SELECT id, user_id, active_tenant_id, active_organization_id, expires_at, revoked_at
         FROM public.auth_set_session_tenant(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, $6::text, $7::text
         )`,
      [
        input.sessionId,
        input.tenantId,
        input.organizationId,
        input.actorUserId,
        payload.split("|")[5],
        nonce,
        mac,
      ],
    );
  } catch (err) {
    // 42501: the database's own eligibility check refused this tenant (migration 015).
    if ((err as { code?: string } | null)?.code === "42501") {
      throw forbidden("No membership for this school");
    }
    throw err;
  }
  const row = result.rows[0];
  if (!row) throw unauthorized("Invalid or expired session");
  return row;
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}
