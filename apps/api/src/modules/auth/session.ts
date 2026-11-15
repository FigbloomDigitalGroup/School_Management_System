import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../../db/pool.js";
import type { AppConfig } from "../../config.js";
import { unauthorized } from "../../http/errors.js";
import { normalizeIp } from "../../http/ip.js";

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
  },
): Promise<{ token: string; session: SessionRow }> {
  const token = mintSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000);
  const result = await db.query<SessionRow>(
    `INSERT INTO sessions (
       user_id, token_hash, active_tenant_id, active_organization_id,
       expires_at, user_agent, ip
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::inet)
     RETURNING id, user_id, active_tenant_id, active_organization_id, expires_at, revoked_at`,
    [
      input.userId,
      tokenHash,
      input.activeTenantId ?? null,
      input.activeOrganizationId ?? null,
      expiresAt.toISOString(),
      input.userAgent ?? null,
      normalizeIp(input.ip),
    ],
  );
  return { token, session: result.rows[0]! };
}

/**
 * Validate a session and, at most once per interval, record that it was seen (FIG-1624).
 *
 * Validity (not revoked, not expired) is evaluated by every call, in the same single
 * statement that may write, so throttling can never extend a revoked or expired session.
 * The write is one conditional UPDATE: `last_seen_at` moves only when it is older than
 * the interval, and the staleness test is re-checked against the locked row, so
 * concurrent requests on a stale session produce one write, not several (no
 * read-modify-write race). An interval of 0 restores a write on every request.
 */
export async function findValidSession(
  db: Db,
  token: string,
  lastSeenIntervalSeconds = 0,
): Promise<SessionRow | null> {
  const tokenHash = hashSessionToken(token);
  const result = await db.query<SessionRow>(
    `WITH valid AS (
       SELECT id, user_id, active_tenant_id, active_organization_id, expires_at, revoked_at
         FROM sessions
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND expires_at > now()
     ), touched AS (
       UPDATE sessions s
          SET last_seen_at = now()
         FROM valid v
        WHERE s.id = v.id
          AND s.last_seen_at <= now() - make_interval(secs => $2::double precision)
       RETURNING s.id
     )
     SELECT id, user_id, active_tenant_id, active_organization_id, expires_at, revoked_at FROM valid`,
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

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.query(
    `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId],
  );
}

export async function revokeAllUserSessions(db: Db, userId: string): Promise<number> {
  const result = await db.query(
    `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return result.rowCount ?? 0;
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}
