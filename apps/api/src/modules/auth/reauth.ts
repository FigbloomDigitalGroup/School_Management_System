import type { Db } from "../../db/pool.js";
import type { AppConfig } from "../../config.js";
import { AppError, unauthorized } from "../../http/errors.js";

/**
 * Sensitive-action re-authentication (migration 077). A session is "recent" when it was created, or the password was
 * re-confirmed, within the window. The check runs inside the caller's transaction (the user comes from the transaction context).
 */
export function reauthRequired(): AppError {
  return new AppError(403, "reauth_required", "Confirm your password to continue");
}

export async function assertRecentAuth(db: Db, config: AppConfig, sessionId: string): Promise<void> {
  const r = await db.query<{ ok: boolean }>(`SELECT public.auth_session_recent($1::uuid, $2::int) AS ok`, [sessionId, config.sensitiveReauthWindowSeconds]);
  if (r.rows[0]?.ok !== true) throw reauthRequired();
}

/** Stamp the caller's own session. Run in a user-scoped handle (the definer binds to the transaction user). */
export async function stampReauthenticated(db: Db, sessionId: string): Promise<void> {
  const ok = await db.query<{ ok: boolean }>(`SELECT public.auth_mark_reauthenticated($1::uuid) AS ok`, [sessionId]);
  if (ok.rows[0]?.ok !== true) throw unauthorized("Invalid credentials");
}
