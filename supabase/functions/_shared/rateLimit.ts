/**
 * Per-caller rate limits for the public (no-JWT) edge functions, and for the
 * sign-in emails the account functions send (_shared/email.ts). Each call is
 * noted in login_lookups through note_login_lookup() (20261022000002), which
 * answers false once a caller has made more than `limit` calls in `window`.
 * resolve-login-id and request-password-reset carry their own copies of the same
 * two pieces; search-schools and signup-organization share this one.
 */

/**
 * Where the caller's address comes from, and how far to trust it (FIG-1336, then this).
 *
 * The address is read from ONE header, CLIENT_IP_HEADER, and from the entry
 * TRUSTED_PROXY_HOPS places from its right-hand end: each proxy we run
 * appends the address it received the request from, so the client's own
 * address is the one our outermost proxy appended, and everything to the left
 * of it is whatever the client chose to send. The leftmost entry is never
 * read, nor any header the client can set unchecked.
 *
 *   Supabase Cloud (the default): CLIENT_IP_HEADER=cf-connecting-ip,
 *     TRUSTED_PROXY_HOPS=1. Cloudflare sets CF-Connecting-IP to the address
 *     that connected to it; a request coming from another Cloudflare zone's
 *     Worker gets a fixed Cloudflare address instead, never one the caller
 *     wrote. (X-Forwarded-For there keeps what the client sent and appends.)
 *   Self-hosted on AWS (figbloom-platform: ALB -> Envoy gateway -> edge
 *     runtime): CLIENT_IP_HEADER=x-forwarded-for, TRUSTED_PROXY_HOPS=2. The
 *     ALB appends the client's address (its default "append" mode), then
 *     Envoy (use_remote_address: true) appends the ALB's, so the client is
 *     second from the right.
 *
 * TRUSTED_PROXY_HOPS must never be more than the proxies that really append:
 * one too many reads an entry the client wrote. One too few is safe (everyone
 * behind the same proxy shares one allowance). An invalid value counts as 1.
 *
 * No usable address (header missing, fewer entries than hops, not an IP):
 * the caller gets "unknown", one allowance shared by everyone in that state
 * for that function. Never unlimited; the overall limits bound it as well.
 */
export interface ClientIpConfig {
  /** Lower-case header name. */
  header: string;
  /** Entries from the right-hand end: 1 is the last. */
  hops: number;
}

export const UNKNOWN_CLIENT = "unknown";
const DEFAULT_HEADER = "cf-connecting-ip";
const DEFAULT_HOPS = 1;

export function clientIpConfig(env: { get(name: string): string | undefined } = Deno.env): ClientIpConfig {
  const header = (env.get("CLIENT_IP_HEADER") ?? "").trim().toLowerCase() || DEFAULT_HEADER;
  const raw = (env.get("TRUSTED_PROXY_HOPS") ?? "").trim();
  let hops = DEFAULT_HOPS;
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 10) hops = n;
    else console.error(`rate limit: TRUSTED_PROXY_HOPS="${raw}" is not a whole number from 1 to 10; using ${DEFAULT_HOPS}`);
  }
  return { header, hops };
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}(%[0-9a-z]+)?$|^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,6}:\d{1,3}(\.\d{1,3}){3}$/i;

/** An address as a proxy wrote it ("1.2.3.4", "1.2.3.4:8080", "[2001:db8::1]:8080", "2001:db8::1"), or null if it isn't one. */
export function normaliseAddress(entry: string): string | null {
  let a = entry.trim().replace(/^"|"$/g, "");
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(a);
  if (bracketed) a = bracketed[1];
  else if (/^[\d.]+:\d+$/.test(a)) a = a.slice(0, a.lastIndexOf(":"));
  a = a.toLowerCase();
  return IPV4.test(a) || IPV6.test(a) ? a : null;
}

let warnedUnknown = false;

/** The caller's address, as the deployment's own proxies recorded it; UNKNOWN_CLIENT when they didn't. */
export function clientAddress(req: Request, config: ClientIpConfig = clientIpConfig()): string {
  const parts = (req.headers.get(config.header) ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const entry = parts.length >= config.hops ? parts[parts.length - config.hops] : undefined;
  const address = entry === undefined ? null : normaliseAddress(entry);
  if (address) return address;
  if (!warnedUnknown) {
    warnedUnknown = true;
    console.warn(`rate limit: no usable client address in ${config.header} (${parts.length} entries, ${config.hops} trusted hops); such callers share one allowance per function`);
  }
  return UNKNOWN_CLIENT;
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
