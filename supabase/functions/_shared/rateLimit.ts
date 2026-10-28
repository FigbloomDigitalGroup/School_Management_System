/**
 * Per-caller rate limits for the public (no-JWT) edge functions, and for the
 * sign-in emails the account functions send (_shared/email.ts). Each call is
 * noted in login_lookups through note_login_lookup() (20261022000002), which
 * answers false once a caller has made more than `limit` calls in `window`.
 * resolve-login-id and request-password-reset carry their own copies of the same
 * two pieces; search-schools and signup-organization share this one.
 */

/** Who is asking: a hash of the caller's address and the function being called, so the limit works without keeping the address and one function's traffic never counts against another's. */
export async function callerKey(req: Request, scope: string): Promise<string> {
  const ip = req.headers.get("cf-connecting-ip")
    ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${scope}:${ip}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The same for a signed-in caller: a hash of their profile id and the scope, so one person's allowance follows them whatever address they call from. */
export async function userKey(userId: string, scope: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${scope}:user:${userId}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Records a call by this caller and says whether it is still within its allowance. */
export type Limiter = (callerKey: string) => Promise<boolean>;

/**
 * The limiter the deployed functions use. If the limiter itself fails (the
 * database is down, the migration wasn't applied) the call goes through: the
 * page matters more than the limit, and the failure is logged.
 */
// deno-lint-ignore no-explicit-any
export function dbLimiter(admin: any, scope: string, limit: number, window: string): Limiter {
  return async (key) => {
    const { data, error } = await admin.rpc("note_login_lookup", { p_key: key, p_limit: limit, p_window: window });
    if (error) { console.error(`${scope}: rate limiter failed:`, error.message); return true; }
    return data !== false;
  };
}
