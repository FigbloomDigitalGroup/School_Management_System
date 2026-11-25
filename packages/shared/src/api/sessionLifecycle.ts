/**
 * Pure session-lifecycle helpers for API builds (FIG-1890):
 * - 8-hour session-end warning (warns in the final 10 minutes before `expiresAt`)
 * - 15-minute idle sign-out tracking
 * - Safe return-to-page (`next`) validation so signing back in restores the exact school page
 */

/** Staff sessions sign out after 15 minutes with no interaction. */
export const IDLE_TIMEOUT_MS = 15 * 60_000;

/** Show a countdown warning during the last 10 minutes of the 8-hour session. */
export const SESSION_WARN_BEFORE_MS = 10 * 60_000;

export type SignOutReason = "idle" | "expired" | "unauthorized";

/** Milliseconds left before `expiresAt`, clamped to >= 0 (returns null for invalid dates). */
export function msUntilExpiry(expiresAt: string | null | undefined, nowMs = Date.now()): number | null {
  if (!expiresAt) return null;
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, parsed - nowMs);
}

/**
 * Returns remaining whole minutes (rounded up, minimum 1) when the session is inside the
 * warning window (`0 < remaining <= warnBeforeMs`), or `null` otherwise.
 */
export function sessionExpiryWarningMinutes(
  expiresAt: string | null | undefined,
  nowMs = Date.now(),
  warnBeforeMs = SESSION_WARN_BEFORE_MS,
): number | null {
  const left = msUntilExpiry(expiresAt, nowMs);
  if (left === null || left <= 0 || left > warnBeforeMs) return null;
  return Math.max(1, Math.ceil(left / 60_000));
}

/**
 * Validates a post-sign-in return path so open redirects are impossible.
 * Accepts in-app console routes (`/s/<slug>...`, `/org/<slug>...`, `/org-picker`, `/platform/...`),
 * never protocol-relative `//` or external URLs.
 */
export function safeReturnPath(raw: string | null | undefined, expectedPrefix?: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const isConsole =
    trimmed.startsWith("/s/") ||
    trimmed.startsWith("/org/") ||
    trimmed === "/org-picker" ||
    trimmed.startsWith("/platform/") ||
    trimmed === "/platform";
  if (!isConsole || trimmed.startsWith("//") || trimmed.includes("\\")) return null;
  if (expectedPrefix) {
    const rawBase = expectedPrefix.replace(/\/+$/, "");
    // Platform home is `/platform/tenants`, but any `/platform/...` page belongs to the same console.
    const base = rawBase.startsWith("/platform/") ? "/platform" : rawBase;
    if (trimmed !== base && !trimmed.startsWith(`${base}/`) && !trimmed.startsWith(`${base}?`)) return null;
  }
  return trimmed;
}

/** Builds `/signin?...` preserving the return path (if safe) and reason notice. */
export function buildSignInRedirect(opts: { next?: string | null; reason?: SignOutReason | null }): string {
  const params = new URLSearchParams();
  if (opts.reason) params.set("reason", opts.reason);
  const safe = safeReturnPath(opts.next);
  if (safe) params.set("next", safe);
  const qs = params.toString();
  return qs ? `/signin?${qs}` : "/signin";
}

/** Human-readable notice shown on `/signin` after an automatic sign-out. */
export function signOutReasonNotice(reason: string | null | undefined): string {
  if (reason === "idle") return "You were signed out after 15 minutes without activity. Sign in again to return where you left off.";
  if (reason === "expired") return "Your 8-hour session ended. Sign in again to continue.";
  if (reason === "unauthorized") return "Your session ended. Sign in again to continue.";
  if (reason === "password_reset") return "Your password was changed and you were signed out everywhere. Sign in with the new password.";
  return "";
}
