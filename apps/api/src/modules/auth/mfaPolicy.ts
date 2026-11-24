import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/pool.js";
import type { IdentityDb } from "../../db/sql.js";
import { AppError, rateLimited } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { consumeAuthToken } from "./rateLimit.js";

export interface MfaState {
  required: boolean;
  assured: boolean;
  enrolled: boolean;
}

/**
 * Routes a session may call before it is MFA-assured: identity housekeeping and the enrolment / challenge flow
 * itself. Everything else (every tenant, platform and sensitive route) is refused with `mfa_required`.
 */
export const MFA_ALLOWLIST = new Set([
  "POST /v1/auth/logout",
  "GET /v1/auth/me",
  "POST /v1/auth/password/change",
  "POST /v1/auth/reauth",
  "POST /v1/auth/select-tenant",
  "GET /v1/auth/mfa/status",
  "POST /v1/auth/mfa/totp/enroll",
  "POST /v1/auth/mfa/totp/verify",
  "POST /v1/auth/mfa/challenge",
]);

export function mfaRequired(enrolled: boolean): AppError {
  return new AppError(
    403,
    "mfa_required",
    enrolled ? "Multi-factor verification required: POST /v1/auth/mfa/challenge" : "Multi-factor enrolment required: POST /v1/auth/mfa/totp/enroll",
  );
}

export async function loadMfaState(db: IdentityDb, config: AppConfig, sessionId: string, userId: string): Promise<MfaState> {
  if (config.mfaEnforcement === "off") {
    // Informational only: enforcement is disabled (refused in staging/production).
    const r = await db.query<MfaState>(`SELECT required, assured, enrolled FROM public.auth_mfa_state($1::uuid, $2::uuid, $3::text[])`, [sessionId, userId, config.mfaRequiredRoles]);
    const row = r.rows[0]!;
    return { ...row, required: false };
  }
  const r = await db.query<MfaState>(`SELECT required, assured, enrolled FROM public.auth_mfa_state($1::uuid, $2::uuid, $3::text[])`, [sessionId, userId, config.mfaRequiredRoles]);
  return r.rows[0]!;
}

/** Called from the one function every authenticated route uses (requireSessionAuth). */
export async function assertMfaAssurance(
  db: IdentityDb,
  config: AppConfig,
  input: { sessionId: string; userId: string; routeKey: string },
): Promise<void> {
  if (config.mfaEnforcement === "off" || MFA_ALLOWLIST.has(input.routeKey)) return;
  const state = await loadMfaState(db, config, input.sessionId, input.userId);
  if (state.required && !state.assured) throw mfaRequired(state.enrolled);
}

// ---------------------------------------------------------------------------------------------------------
// Wrong-code throttling. Both checks run in their own committed transactions so a failed attempt is counted
// and audited even though the attempt itself ends in a thrown 401 (which rolls its own transaction back).
// No permanent lockout: the failure window slides; only a holder of a valid session of that user can trigger it.
// ---------------------------------------------------------------------------------------------------------
export const MFA_MAX_FAILURES = 10;
export const MFA_FAILURE_WINDOW_MINUTES = 15;

/** The token bucket for code attempts and enrolments: from MFA_ATTEMPT_RATE_* (5 at once, then one a minute by default). */
export function mfaAttemptRatePolicy(
  config: Pick<AppConfig, "mfaAttemptRateCapacity" | "mfaAttemptRateRefill" | "mfaAttemptRateIntervalMs">,
): Pick<AppConfig, "authRateCapacity" | "authRateRefill" | "authRateIntervalMs"> {
  return {
    authRateCapacity: config.mfaAttemptRateCapacity,
    authRateRefill: config.mfaAttemptRateRefill,
    authRateIntervalMs: config.mfaAttemptRateIntervalMs,
  };
}

export async function guardMfaAttempt(db: IdentityDb, config: AppConfig, userId: string, scope: "attempt" | "enroll" = "attempt"): Promise<void> {
  // Per user: a burst of attempts, then a slow refill. Both numbers come from config; staging and production cannot loosen them.
  await consumeAuthToken(
    db as unknown as Db,
    mfaAttemptRatePolicy(config),
    scope === "attempt" ? `mfa:user:${userId}` : `mfa-enroll:user:${userId}`,
  );
  const r = await db.query<{ failed_count: number; remaining: number | null }>(
    `SELECT failed_count,
            GREATEST(0, ceil(extract(epoch FROM (failed_window_start + interval '${MFA_FAILURE_WINDOW_MINUTES} minutes' - now()))))::int AS remaining
       FROM mfa_factors WHERE user_id = $1 AND disabled_at IS NULL`,
    [userId],
  );
  const row = r.rows[0];
  if (row && row.failed_count >= MFA_MAX_FAILURES && (row.remaining ?? 0) > 0) {
    throw rateLimited("Too many incorrect verification codes. Try again later.", row.remaining ?? 60);
  }
}

export async function recordMfaFailure(db: IdentityDb, userId: string, method: string, ip: string | null): Promise<void> {
  await db.query(
    `UPDATE mfa_factors
        SET failed_count = CASE WHEN failed_window_start IS NULL OR failed_window_start < now() - interval '${MFA_FAILURE_WINDOW_MINUTES} minutes' THEN 1 ELSE failed_count + 1 END,
            failed_window_start = CASE WHEN failed_window_start IS NULL OR failed_window_start < now() - interval '${MFA_FAILURE_WINDOW_MINUTES} minutes' THEN now() ELSE failed_window_start END
      WHERE user_id = $1 AND disabled_at IS NULL`,
    [userId],
  );
  await recordSecurityEvent(db, { eventType: "auth.mfa.failed", actorUserId: userId, detail: { method, persisted: true }, ip });
}
