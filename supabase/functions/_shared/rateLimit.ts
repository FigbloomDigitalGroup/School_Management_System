/**
 * Per-caller rate limits for the public (no-JWT) edge functions, and for the
 * sign-in emails the account functions send (_shared/email.ts). Each call is
 * noted in login_lookups through note_login_lookup() (20261022000002), which
 * answers false once a caller has made more than `limit` calls in `window`.
 * resolve-login-id and request-password-reset carry their own copies of the same
 * two pieces; search-schools and signup-organization share this one.
 */

/**
 * The caller's address, from the one header this deployment's own edge sets
 * (FIG-1336). Any other header is the caller's to write, so trusting the
 * first that happened to be there let a script take a fresh allowance on
 * every request. CLIENT_IP_HEADER names it: cf-connecting-ip (the default)
 * on hosted Supabase, which Cloudflare overwrites; a deployment behind its
 * own proxy can name x-forwarded-for, and then the last address counts, the
 * one that proxy appended. Without it every caller shares one "unknown"
 * allowance, which the overall limits below still bound.
 */
export function clientAddress(req: Request): string {
  const header = (Deno.env.get("CLIENT_IP_HEADER") ?? "cf-connecting-ip").trim().toLowerCase();
  const parts = (req.headers.get(header) ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? "unknown";
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Who is asking: a hash of the caller's address and the function being called, so the limit works without keeping the address and one function's traffic never counts against another's. */
export function callerKey(req: Request, scope: string): Promise<string> {
  return sha256(`${scope}:${clientAddress(req)}`);
}

/**
 * A key no request header can change, for a second, coarser limit on the
 * whole function (or one school's share of it): however many addresses a
 * caller claims, together they stop here.
 */
export function overallKey(scope: string, part = "all"): Promise<string> {
  return sha256(`${scope}:overall:${part}`);
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
export function dbLimiter(admin: any, scope: string, limit: number, window: string, { failClosed = false } = {}): Limiter {
  return async (key) => {
    const { data, error } = await admin.rpc("note_login_lookup", { p_key: key, p_limit: limit, p_window: window });
    if (error) { console.error(`${scope}: rate limiter failed:`, error.message); return !failClosed; }
    return data !== false;
  };
}

/** Lets everything through: the default in tests for a limit they aren't about. */
export const unlimited: Limiter = () => Promise.resolve(true);
