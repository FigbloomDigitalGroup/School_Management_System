/**
 * Runs one of supabase/functions/<name> on AWS Lambda (Node 24) unchanged, behind an API Gateway HTTP API (payload 2.0).
 * Moving Schools off Supabase: the functions keep their code; only what the edge runtime gave them comes from here.
 *
 * On a cold start, before the function's module is loaded (some read a setting at load, e.g. _shared/daraja.ts):
 *   1. settings: the server's keys (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY; SUPABASE_JWT_SECRET is kept
 *      here, for checking tokens, never handed to the function) and the function-settings secret (DARAJA_*, FCM, Resend,
 *      AI keys, ...), the same two Secrets Manager entries the database server gives its edge functions today
 *   2. a `Deno` with what the functions use: Deno.env.get and Deno.serve (which hands this adapter the request handler)
 * Then every request: the token check the edge runtime did (config.toml verify_jwt), the event as a Request, the
 * function's Response as API Gateway's answer.
 *
 * The token check accepts what the server's edge runtime accepts (JWT_SECRET and SUPABASE_JWKS there): people's sign-in
 * tokens, which the server's auth signs with an EC key (ES256, its public keys at <SUPABASE_URL>/auth/v1/.well-known/
 * jwks.json, fetched and cached here), and the legacy HS256 keys (anon, service role) signed with the JWT secret. A refusal
 * carries the functions' CORS headers, so a browser shows it as the 401 it is rather than "failed to send".
 *
 * The caller's address is API Gateway's own (requestContext.http.sourceIp), written into x-forwarded-for over anything the
 * caller sent, so the functions' rate limits (CLIENT_IP_HEADER=x-forwarded-for, TRUSTED_PROXY_HOPS=1) can't be fooled.
 */

export interface LambdaHttpEvent {
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string; sourceIp: string }; domainName?: string };
}

export interface LambdaHttpResult {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
  body: string;
  isBase64Encoded: boolean;
}

type Handler = (req: Request) => Response | Promise<Response>;

export interface AdapterOptions {
  /** The function's folder name, e.g. "mpesa-callback" */
  name: string;
  /** config.toml verify_jwt for this function (true when it isn't listed, as on Supabase) */
  verifyJwt: boolean;
  /** Reads the settings: every key becomes an environment variable for the function */
  loadSettings: () => Promise<Record<string, string>>;
  /** Imports the function's index.ts, which calls Deno.serve */
  loadFunction: () => Promise<unknown>;
  /** Fetches the server's signing keys (tests pass their own); default: GET <SUPABASE_URL>/auth/v1/.well-known/jwks.json */
  fetchJwks?: (supabaseUrl: string) => Promise<JsonWebKey[]>;
}

/** What supabase/functions/_shared/cors.ts puts on every answer, so a browser can read a refusal from here too. */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export interface TokenKeys {
  /** The JWT secret, for HS256 tokens (the anon and service-role keys) */
  secret?: string;
  /** The server's public signing keys, for ES256 tokens (people's sign-ins); `refresh` asks again (a key we don't know) */
  jwks?: (refresh?: boolean) => Promise<JsonWebKey[]>;
}

async function defaultFetchJwks(supabaseUrl: string): Promise<JsonWebKey[]> {
  const res = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/auth/v1/.well-known/jwks.json`, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`jwks.json answered ${res.status}`);
  return ((await res.json()) as { keys?: JsonWebKey[] }).keys ?? [];
}

/** The keys, fetched once and kept ten minutes; a token naming a key we don't have asks again (at most once a minute). */
function cachedJwks(load: () => Promise<JsonWebKey[]>): (refresh?: boolean) => Promise<JsonWebKey[]> {
  let keys: JsonWebKey[] | null = null;
  let at = 0;
  return async (refresh = false) => {
    const age = Date.now() - at;
    if (!keys || age > 10 * 60_000 || (refresh && age > 60_000)) {
      keys = await load();
      at = Date.now();
    }
    return keys;
  };
}

const RESERVED_FOR_ADAPTER = new Set(["SUPABASE_JWT_SECRET"]);

export function createLambdaHandler(o: AdapterOptions) {
  let ready: Promise<{ serve: Handler; keys: TokenKeys }> | null = null;

  async function start() {
    const settings = await o.loadSettings();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(settings)) if (!RESERVED_FOR_ADAPTER.has(k)) env[k] = v;
    // The functions' rate limits read the caller's address from here (see the top of this file)
    env.CLIENT_IP_HEADER = "x-forwarded-for";
    env.TRUSTED_PROXY_HOPS = "1";
    let serve: Handler | null = null;
    (globalThis as { Deno?: unknown }).Deno = {
      env: {
        get: (k: string) => env[k] ?? process.env[k],
        toObject: () => ({ ...env }),
      },
      serve: (h: Handler) => {
        serve = h;
        return { finished: new Promise(() => {}), shutdown: async () => {} };
      },
    };
    await o.loadFunction();
    if (!serve) throw new Error(`${o.name} never called Deno.serve`);
    const url = settings.SUPABASE_URL;
    const keys: TokenKeys = {
      secret: settings.SUPABASE_JWT_SECRET,
      jwks: url ? cachedJwks(() => (o.fetchJwks ?? defaultFetchJwks)(url)) : undefined,
    };
    return { serve: serve as Handler, keys };
  }

  return async function handler(event: LambdaHttpEvent): Promise<LambdaHttpResult> {
    if (!ready) ready = start().catch((err) => { ready = null; throw err; });
    const { serve, keys } = await ready;
    const req = toRequest(o.name, event);
    if (o.verifyJwt && req.method !== "OPTIONS") {
      if (!(await validJwt(req.headers.get("authorization"), keys))) {
        return json(401, { code: 401, message: "Invalid JWT" });
      }
    }
    return toResult(await serve(req));
  };
}

export function toRequest(name: string, event: LambdaHttpEvent): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers ?? {})) if (v !== undefined) headers.set(k, v);
  if (event.cookies?.length) headers.set("cookie", event.cookies.join("; "));
  headers.set("x-forwarded-for", event.requestContext.http.sourceIp);
  const method = event.requestContext.http.method.toUpperCase();
  const host = event.requestContext.domainName ?? headers.get("host") ?? "localhost";
  // the path the edge runtime gave a function: /<name>, then anything after it, and the query (mpesa-callback's ?token=)
  const rest = event.rawPath.replace(/^\/functions\/v1\/[^/]+/, "");
  const url = `https://${host}/${name}${rest}${event.rawQueryString ? `?${event.rawQueryString}` : ""}`;
  const hasBody = method !== "GET" && method !== "HEAD" && event.body !== undefined;
  const body = hasBody ? (event.isBase64Encoded ? Buffer.from(event.body!, "base64") : event.body) : undefined;
  return new Request(url, { method, headers, body });
}

const TEXTUAL = /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded)|image\/svg\+xml)/i;

export async function toResult(res: Response): Promise<LambdaHttpResult> {
  const headers: Record<string, string> = {};
  const cookies: string[] = [];
  res.headers.forEach((v, k) => {
    if (k === "set-cookie") cookies.push(v);
    else headers[k] = v;
  });
  const type = res.headers.get("content-type") ?? "";
  const bytes = Buffer.from(await res.arrayBuffer());
  const textual = bytes.length === 0 || TEXTUAL.test(type);
  return {
    statusCode: res.status,
    headers,
    ...(cookies.length ? { cookies } : {}),
    body: textual ? bytes.toString("utf8") : bytes.toString("base64"),
    isBase64Encoded: !textual,
  };
}

function json(status: number, body: unknown): LambdaHttpResult {
  return { statusCode: status, headers: { ...CORS_HEADERS, "content-type": "application/json" }, body: JSON.stringify(body), isBase64Encoded: false };
}

/**
 * What the edge runtime's verify_jwt checked: a token signed by the server, not expired. People's sign-ins are ES256 (the
 * server's EC key, from its jwks.json); the anon and service-role keys are HS256 (the JWT secret). Any role passes; the
 * function itself decides what the caller may do.
 */
export async function validJwt(authorization: string | null, keys: TokenKeys, now = Date.now()): Promise<boolean> {
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [h, p, s] = parts as [string, string, string];
  try {
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: string; kid?: string };
    const signed = new TextEncoder().encode(`${h}.${p}`);
    const signature = Buffer.from(s, "base64url");
    let ok = false;
    if (header.alg === "HS256" && keys.secret) {
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(keys.secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
      ok = await crypto.subtle.verify("HMAC", key, signature, signed);
    } else if (header.alg === "ES256" && keys.jwks) {
      const find = (list: JsonWebKey[]) => list.find((k) => k.kty === "EC" && k.crv === "P-256" && (!header.kid || (k as { kid?: string }).kid === header.kid));
      const jwk = find(await keys.jwks()) ?? find(await keys.jwks(true));
      if (!jwk) return false;
      const { kty, crv, x, y } = jwk;
      const key = await crypto.subtle.importKey("jwk", { kty, crv, x, y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      // JWS ES256 signatures are r || s (64 bytes), the form WebCrypto verifies
      ok = signature.length === 64 && await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, signed);
    }
    if (!ok) return false;
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as { exp?: number };
    return typeof payload.exp !== "number" || payload.exp * 1000 > now;
  } catch {
    return false;
  }
}
