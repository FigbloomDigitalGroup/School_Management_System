import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseCidr } from "./http/ip.js";
import { LOCAL_SESSION_MINT_HMAC_KEY } from "./modules/auth/sessionProof.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the `@figbloom/api` package root from `src/` or `dist/` layouts
 * (FIG-1610 / P2-01: migrations must resolve after compile).
 */
function resolveApiRoot(startDir: string = __dirname): string {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const pkgPath = resolve(dir, "package.json");
    const migrations = resolve(dir, "migrations");
    if (existsSync(pkgPath) && existsSync(migrations)) {
      try {
        const name = JSON.parse(readFileSync(pkgPath, "utf8")).name as string | undefined;
        if (name === "@figbloom/api") return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(__dirname, "..");
}

const apiRoot = resolveApiRoot();

export type AppEnvironment = "local" | "test" | "staging" | "production";
const APP_ENVIRONMENTS: readonly AppEnvironment[] = ["local", "test", "staging", "production"];

/**
 * Explicit environment mode (FIG-1618). APP_ENV selects it. Unset means `local`, except that
 * NODE_ENV=production without APP_ENV is refused so a deployment cannot silently run with
 * local-development relaxations. Error text names the variable, never a value.
 */
export function resolveAppEnvironment(env: NodeJS.ProcessEnv, kind: "API" | "migrate" = "API"): AppEnvironment {
  const raw = env.APP_ENV?.trim();
  if (raw) {
    if ((APP_ENVIRONMENTS as readonly string[]).includes(raw)) return raw as AppEnvironment;
    throw new Error(`Invalid ${kind} config: APP_ENV must be one of ${APP_ENVIRONMENTS.join(", ")}.`);
  }
  if (env.NODE_ENV === "production") {
    throw new Error(`Invalid ${kind} config: APP_ENV is required when NODE_ENV=production.`);
  }
  return "local";
}

const isStrict = (e: AppEnvironment) => e === "staging" || e === "production";

/**
 * Load apps/api/.env (names and values are never printed). Called explicitly by an entrypoint,
 * not at import time, and only in local/test: staging and production read the process
 * environment only, so a stray file cannot change what a deployed process trusts.
 * Returns whether a file was read.
 */
export function loadDotEnvForLocal(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isStrict(resolveAppEnvironment(env))) return false;
  return loadDotEnv();
}

function loadDotEnv(): boolean {
  const path = resolve(apiRoot, ".env");
  if (!existsSync(path)) return false;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

/**
 * Per-process safety ceiling for POOL_MAX. This is not a production pool size.
 * Size production from the database budget:
 *   pool_max <= floor((max_connections - reserved_superuser - migrator_sessions)
 *                     / api_task_count)
 * when a transaction-mode pooler is in front, divide by the pooler pool size
 * instead of opening one server connection per client. Do not invent a
 * production number without that topology.
 */
export const POOL_MAX_CAP = 20;

/**
 * The throttle on two-step (TOTP) code attempts and enrolments, per account: a burst, then a slow refill. It is what
 * stops a stolen password plus a guessing script from walking through the 10^6 codes, so staging and production
 * refuse to run with it looser than this (see `assertStrictApiConfig`). Local and test may loosen it, so that a
 * browser-test run that signs in as the same administrator many times is not starved.
 */
export const MFA_ATTEMPT_RATE_DEFAULTS = { capacity: 5, refill: 1, intervalMs: 60_000 } as const;

const ConfigSchema = z.object({
  databaseUrl: z.string().min(1),
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().positive().default(4100),
  /** Absolute session lifetime: approved policy is 8 h; a larger value is rejected at startup (migration 069 also constrains new rows). */
  sessionTtlSeconds: z.coerce.number().int().positive().max(28_800).default(28_800),
  /**
   * last_seen_at is written at most once per interval per session (FIG-1624, AD-11).
   * Validity checks (expiry, revocation, user and tenant state) run on every request regardless.
   * 0 = write on every request.
   */
  sessionLastSeenIntervalSeconds: z.coerce.number().int().min(0).max(120).default(60),
  /** Sensitive actions need a login or password re-confirmation within this many seconds (owner decision 6.5). */
  sensitiveReauthWindowSeconds: z.coerce.number().int().min(30).max(3600).default(300),
  authRateCapacity: z.coerce.number().positive().default(5),
  authRateRefill: z.coerce.number().positive().default(2),
  authRateIntervalMs: z.coerce.number().int().positive().default(5_000),
  /**
   * Two-step code attempts and enrolments, per account (MFA_ATTEMPT_RATE_*): `capacity` attempts at once, then `refill`
   * more every `intervalMs`. Every attempt counts, right or wrong. Only local and test may set these looser than
   * MFA_ATTEMPT_RATE_DEFAULTS; staging and production refuse that at startup. Whole numbers of at least 1, so a bad
   * value fails loudly instead of locking everyone out (capacity 0) or switching the limit off.
   */
  mfaAttemptRateCapacity: z.coerce.number().int().min(1).max(100_000).default(MFA_ATTEMPT_RATE_DEFAULTS.capacity),
  mfaAttemptRateRefill: z.coerce.number().int().min(1).max(100_000).default(MFA_ATTEMPT_RATE_DEFAULTS.refill),
  mfaAttemptRateIntervalMs: z.coerce.number().int().min(100).max(3_600_000).default(MFA_ATTEMPT_RATE_DEFAULTS.intervalMs),
  /**
   * M-Pesa callback throttling (remediation batch 6). The callback is NOT a login: Safaricom calls it from a few
   * addresses, in bursts at fee deadlines, and a throttled callback may never be redelivered. Two separate policies:
   *   * AUTHENTICATED (the URL secret matched): one platform-wide bucket, sized for provider bursts. A last-resort
   *     bound, not a per-school quota. Default 200 burst, +100 per second (engineering defaults: Safaricom's real
   *     callback rate and retry behaviour are NOT verified here and must be measured in a Daraja sandbox).
   *   * INVALID SECRET: a per-client-address bucket that only junk traffic can drain. Default 10 burst, +2 per 5 s.
   * The secret is checked first (no database), so junk can never consume the authenticated bucket.
   */
  // Bounded on purpose: a capacity below 2 (or a fractional one) would refuse EVERY valid callback with no Retry-After, and an
  // absurd value would switch the limit off. The API refuses to start with a value outside these ranges.
  mpesaCallbackRateCapacity: z.coerce.number().int().min(2).max(100_000).default(200),
  mpesaCallbackRateRefill: z.coerce.number().int().min(1).max(100_000).default(100),
  mpesaCallbackRateIntervalMs: z.coerce.number().int().min(100).max(3_600_000).default(1_000),
  mpesaCallbackInvalidRateCapacity: z.coerce.number().int().min(1).max(1_000).default(10),
  mpesaCallbackInvalidRateRefill: z.coerce.number().int().min(1).max(1_000).default(2),
  mpesaCallbackInvalidRateIntervalMs: z.coerce.number().int().min(100).max(3_600_000).default(5_000),
  /** Runtime login role. DATABASE_URL must be this role, never the migrator. */
  runtimeRole: z.string().min(1).default("figbloom_app"),
  poolMax: z.coerce.number().int().positive().default(10),
  /** Acquisition budget only. Not a transaction or statement timeout. */
  poolAcquireTimeoutMs: z.coerce.number().int().positive().max(30_000).default(2_000),
  statementTimeoutMs: z.coerce.number().int().positive().max(120_000).default(15_000),
  lockTimeoutMs: z.coerce.number().int().positive().max(120_000).default(5_000),
  idleInTransactionSessionTimeoutMs: z.coerce.number().int().positive().max(120_000).default(15_000),
  /**
   * Autocommit identity path (login, session lookup, rate limiting, readiness): short point
   * statements, so tighter than the tenant transaction limits. Installed as the baseline of every
   * pooled connection (WP-A1 review R-01).
   */
  identityStatementTimeoutMs: z.coerce.number().int().positive().max(120_000).default(5_000),
  identityLockTimeoutMs: z.coerce.number().int().positive().max(120_000).default(2_000),
  /** Client-side per-query backstop for a stalled network. Must exceed every server-side statement timeout. */
  clientQueryTimeoutMs: z.coerce.number().int().positive().max(180_000).default(20_000),
  applicationName: z.string().min(1).max(63).default("figbloom-api"),
  /** /readyz database probe: result cache window and hard time budget (FIG-1617). */
  readinessCacheMs: z.coerce.number().int().min(0).max(60_000).default(1_000),
  readinessTimeoutMs: z.coerce.number().int().positive().max(30_000).default(2_000),
  /** Shutdown sequence (FIG-1617): drain delay, in-flight grace, absolute hard limit. */
  shutdownDrainDelayMs: z.coerce.number().int().min(0).max(60_000).default(0),
  shutdownGraceMs: z.coerce.number().int().positive().max(120_000).default(10_000),
  shutdownHardTimeoutMs: z.coerce.number().int().positive().max(180_000).default(15_000),
  /**
   * Number of trusted reverse-proxy hops (R2-01). 0 = do not honour X-Forwarded-For.
   * When > 0, API_TRUST_PROXY_CIDRS must list the addresses/CIDRs of those proxies.
   */
  trustProxyHops: z.coerce.number().int().min(0).max(32).default(0),
  /** Comma-separated CIDRs / addresses of trusted proxies (required when hops > 0). */
  trustProxyCidrs: z.array(z.string()).default([]),
  /**
   * Browser origins allowed to call the API (FIG-1622, AD-12). Exact origins only
   * (scheme://host[:port], no path, no wildcard). Empty (default) = no CORS headers at all.
   * The API authenticates with a bearer token, not cookies, so credentials are never allowed.
   */
  /** Selected by APP_ENV; strict (staging/production) refuses unsafe settings below. */
  appEnv: z.enum(["local", "test", "staging", "production"]).default("local"),
  /**
   * Secret for keyed idempotency-request fingerprints (HMAC), so a stored fingerprint of a child's
   * data is not a plain hash an attacker can test guesses against. Required outside local/test.
   */
  idempotencyFingerprintKey: z.string().min(32).max(256).optional(),
  /**
   * HMAC key for session mint/revoke proofs (migration 014 / R-02). Required outside
   * local/test. Local/test may omit and receive the documented local default.
   */
  sessionMintHmacKey: z.string().min(32).max(256).optional(),
  /** Idempotency-Key validity (AD-10): 24 h, enforced at lookup. */
  idempotencyTtlSeconds: z.coerce.number().int().positive().max(604_800).default(86_400),
  corsAllowedOrigins: z.array(z.string()).default([]),
  corsMaxAgeSeconds: z.coerce.number().int().min(0).max(86_400).default(600),
  /** Send Strict-Transport-Security. Enable only where TLS terminates for this host. */
  hstsEnabled: z.boolean().default(false),
  /** Node HTTP server timeouts. keep-alive must exceed the load balancer's idle timeout. */
  serverKeepAliveTimeoutMs: z.coerce.number().int().positive().max(600_000).default(65_000),
  serverHeadersTimeoutMs: z.coerce.number().int().positive().max(600_000).default(66_000),
  serverRequestTimeoutMs: z.coerce.number().int().positive().max(600_000).default(30_000),
  // Stage 11 M-Pesa (Daraja) & PayHero Kenya v2. Select active gateway via PAYMENT_PROVIDER ("daraja" | "payhero").
  // All credentials optional: STK push is disabled until every credential for the active provider is set. Never logged.
  paymentProvider: z.enum(["daraja", "payhero"]).default("daraja"),
  mpesaEnv: z.enum(["sandbox", "production"]).default("sandbox"),
  mpesaConsumerKey: z.string().min(1).optional(),
  mpesaConsumerSecret: z.string().min(1).optional(),
  mpesaShortcode: z.string().regex(/^\d{5,7}$/).optional(),
  mpesaPasskey: z.string().min(1).optional(),
  mpesaCallbackUrl: z.string().url().optional(),
  mpesaCallbackSecret: z.string().min(32).max(256).optional(),
  mpesaHttpTimeoutMs: z.coerce.number().int().positive().max(60_000).default(10_000),
  /** Delay before the worker asks the provider about a prompt with no callback yet. */
  mpesaSettleDelaySeconds: z.coerce.number().int().min(30).max(3_600).default(120),
  payheroBaseUrl: z.string().url().default("https://backend.payhero.co.ke/api/v2"),
  payheroBasicAuthToken: z.string().min(1).optional(),
  payheroApiUsername: z.string().min(1).optional(),
  payheroApiPassword: z.string().min(1).optional(),
  payheroChannelId: z.coerce.number().int().positive().optional(),
  payheroCallbackUrl: z.string().url().optional(),
  payheroCallbackSecret: z.string().min(32).max(256).optional(),
  payheroHttpTimeoutMs: z.coerce.number().int().positive().max(60_000).default(10_000),
  bloomAiBaseUrl: z.string().url().optional(),
  bloomAiApiKey: z.string().min(1).optional(),
  bloomAiTimeoutMs: z.coerce.number().int().positive().max(60_000).default(10_000),
  /** HMAC key shared with FigBloom AI to sign every request (contract bloom-school/1). Optional until provisioned. */
  bloomAiSigningSecret: z.string().min(32).max(256).optional(),
  /** MFA enforcement (migration 088). `off` is refused in staging/production. */
  mfaEnforcement: z.enum(["enforce", "off"]).default("enforce"),
  /**
   * Extra school roles for which MFA is mandatory (platform/org/school admins and finance-area holders always are).
   * `student` is not accepted: learners never get two-step sign-in (owner decision 2026-11-25, docs/STUDENT-ACCOUNTS.md).
   */
  mfaRequiredRoles: z.array(z.enum(["teacher", "staff", "driver", "parent"])).default([]),
  /** Dedicated key for TOTP secrets at rest; must differ from the session HMAC key. Required in staging/production. */
  mfaEncryptionKey: z.string().min(32).max(256).optional(),
  /**
   * "My HR" (docs/MY-HR.md): a staff member's own payslips, leave, attendance and KPIs from Figbloom HR. Everything below is
   * optional and the feature is OFF unless MY_HR_ENABLED=true AND PLATFORM_CLIENT_ID, PLATFORM_CLIENT_SECRET,
   * PLATFORM_TOKEN_URL and HR_MY_HR_URL are all set. The names are the ones the Supabase `my-hr` function uses. Never logged.
   */
  myHrEnabled: z.boolean().default(false),
  platformClientId: z.string().min(1).max(256).optional(),
  platformClientSecret: z.string().min(1).max(1024).optional(),
  /** The platform's token endpoint (client-credentials grant). */
  platformTokenUrl: z.string().min(1).max(2048).optional(),
  /** The platform's own API (school registration, hand-off). My HR does not call it; it is read so those slices share the name. */
  platformApiUrl: z.string().min(1).max(2048).optional(),
  /** HR's base address for My HR, e.g. https://hr.example/api/integrations/my-hr (https, no trailing slash). */
  hrMyHrUrl: z.string().min(1).max(2048).optional(),
  /** Per call to the platform token endpoint or to HR (including reading the answer). */
  myHrHttpTimeoutMs: z.coerce.number().int().min(100).max(30_000).default(15_000),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/**
 * An address the API may call out to for My HR: https, no credentials, query or fragment. http is accepted only for a
 * loopback host in local and test, so that a fake HR on this machine can be used; staging and production are https only.
 */
export function isAllowedPlatformUrl(value: string, appEnv: AppEnvironment): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (appEnv === "local" || appEnv === "test") && isLoopbackHost(url.hostname);
}

/** True only for `http(s)://host[:port]` with nothing after it. `*`, `null`, paths and slashes are refused. */
export function isExactHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

function parseCidrList(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Legacy boolean trust is unsafe (R2-01): refuse rather than silently honour all XFF.
  const legacy = (env.API_TRUST_PROXY ?? "").trim().toLowerCase();
  if (legacy === "true" || legacy === "1" || legacy === "yes") {
    throw new Error(
      "Invalid API config: API_TRUST_PROXY=true is no longer supported. " +
        "Set API_TRUST_PROXY_HOPS (positive integer) and API_TRUST_PROXY_CIDRS " +
        "(comma-separated proxy CIDRs) instead, or omit both to disable proxy trust.",
    );
  }

  const hopsRaw = env.API_TRUST_PROXY_HOPS;
  const cidrs = parseCidrList(env.API_TRUST_PROXY_CIDRS);

  const parsed = ConfigSchema.safeParse({
    databaseUrl: env.DATABASE_URL,
    host: env.API_HOST,
    port: env.API_PORT,
    sessionTtlSeconds: env.SESSION_TTL_SECONDS,
    sessionLastSeenIntervalSeconds: env.SESSION_LAST_SEEN_INTERVAL_SECONDS,
    sensitiveReauthWindowSeconds: env.SENSITIVE_REAUTH_WINDOW_SECONDS,
    authRateCapacity: env.AUTH_RATE_CAPACITY,
    authRateRefill: env.AUTH_RATE_REFILL,
    authRateIntervalMs: env.AUTH_RATE_INTERVAL_MS,
    mfaAttemptRateCapacity: env.MFA_ATTEMPT_RATE_CAPACITY,
    mfaAttemptRateRefill: env.MFA_ATTEMPT_RATE_REFILL,
    mfaAttemptRateIntervalMs: env.MFA_ATTEMPT_RATE_INTERVAL_MS,
    mpesaCallbackRateCapacity: env.MPESA_CALLBACK_RATE_CAPACITY,
    mpesaCallbackRateRefill: env.MPESA_CALLBACK_RATE_REFILL,
    mpesaCallbackRateIntervalMs: env.MPESA_CALLBACK_RATE_INTERVAL_MS,
    mpesaCallbackInvalidRateCapacity: env.MPESA_CALLBACK_INVALID_RATE_CAPACITY,
    mpesaCallbackInvalidRateRefill: env.MPESA_CALLBACK_INVALID_RATE_REFILL,
    mpesaCallbackInvalidRateIntervalMs: env.MPESA_CALLBACK_INVALID_RATE_INTERVAL_MS,
    runtimeRole: env.RUNTIME_ROLE,
    poolMax: env.POOL_MAX,
    poolAcquireTimeoutMs: env.POOL_ACQUIRE_TIMEOUT_MS,
    statementTimeoutMs: env.STATEMENT_TIMEOUT_MS,
    lockTimeoutMs: env.LOCK_TIMEOUT_MS,
    idleInTransactionSessionTimeoutMs: env.IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS,
    identityStatementTimeoutMs: env.IDENTITY_STATEMENT_TIMEOUT_MS,
    identityLockTimeoutMs: env.IDENTITY_LOCK_TIMEOUT_MS,
    clientQueryTimeoutMs: env.CLIENT_QUERY_TIMEOUT_MS,
    applicationName: env.APPLICATION_NAME,
    readinessCacheMs: env.READINESS_CACHE_MS,
    readinessTimeoutMs: env.READINESS_TIMEOUT_MS,
    shutdownDrainDelayMs: env.SHUTDOWN_DRAIN_DELAY_MS,
    shutdownGraceMs: env.SHUTDOWN_GRACE_MS,
    shutdownHardTimeoutMs: env.SHUTDOWN_HARD_TIMEOUT_MS,
    trustProxyHops: hopsRaw === undefined || hopsRaw === "" ? 0 : hopsRaw,
    trustProxyCidrs: cidrs,
    appEnv: resolveAppEnvironment(env),
    idempotencyFingerprintKey: env.IDEMPOTENCY_FINGERPRINT_KEY || undefined,
    sessionMintHmacKey: env.SESSION_MINT_HMAC_KEY || undefined,
    idempotencyTtlSeconds: env.IDEMPOTENCY_TTL_SECONDS,
    corsAllowedOrigins: parseCidrList(env.CORS_ALLOWED_ORIGINS),
    corsMaxAgeSeconds: env.CORS_MAX_AGE_SECONDS,
    hstsEnabled: (env.HSTS_ENABLED ?? "").trim().toLowerCase() === "true",
    serverKeepAliveTimeoutMs: env.SERVER_KEEP_ALIVE_TIMEOUT_MS,
    serverHeadersTimeoutMs: env.SERVER_HEADERS_TIMEOUT_MS,
    serverRequestTimeoutMs: env.SERVER_REQUEST_TIMEOUT_MS,
    paymentProvider: env.PAYMENT_PROVIDER || undefined,
    mpesaEnv: env.MPESA_ENV || undefined,
    mpesaConsumerKey: env.MPESA_CONSUMER_KEY || undefined,
    mpesaConsumerSecret: env.MPESA_CONSUMER_SECRET || undefined,
    mpesaShortcode: env.MPESA_SHORTCODE || undefined,
    mpesaPasskey: env.MPESA_PASSKEY || undefined,
    mpesaCallbackUrl: env.MPESA_CALLBACK_URL || undefined,
    mpesaCallbackSecret: env.MPESA_CALLBACK_SECRET || undefined,
    mpesaHttpTimeoutMs: env.MPESA_HTTP_TIMEOUT_MS,
    mpesaSettleDelaySeconds: env.MPESA_SETTLE_DELAY_SECONDS,
    payheroBaseUrl: env.PAYHERO_BASE_URL || undefined,
    payheroBasicAuthToken: env.PAYHERO_BASIC_AUTH_TOKEN || undefined,
    payheroApiUsername: env.PAYHERO_API_USERNAME || undefined,
    payheroApiPassword: env.PAYHERO_API_PASSWORD || undefined,
    payheroChannelId: env.PAYHERO_CHANNEL_ID || undefined,
    payheroCallbackUrl: env.PAYHERO_CALLBACK_URL || undefined,
    payheroCallbackSecret: env.PAYHERO_CALLBACK_SECRET || undefined,
    payheroHttpTimeoutMs: env.PAYHERO_HTTP_TIMEOUT_MS,
    bloomAiBaseUrl: env.BLOOM_AI_BASE_URL || undefined,
    bloomAiApiKey: env.BLOOM_AI_API_KEY || undefined,
    bloomAiTimeoutMs: env.BLOOM_AI_TIMEOUT_MS,
    bloomAiSigningSecret: env.BLOOM_AI_SIGNING_SECRET || undefined,
    mfaEnforcement: env.MFA_ENFORCEMENT || undefined,
    mfaRequiredRoles: (env.MFA_REQUIRED_ROLES ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    mfaEncryptionKey: env.MFA_ENCRYPTION_KEY || undefined,
    myHrEnabled: (env.MY_HR_ENABLED ?? "").trim().toLowerCase() === "true",
    platformClientId: env.PLATFORM_CLIENT_ID?.trim() || undefined,
    platformClientSecret: env.PLATFORM_CLIENT_SECRET?.trim() || undefined,
    platformTokenUrl: env.PLATFORM_TOKEN_URL?.trim() || undefined,
    platformApiUrl: env.PLATFORM_API_URL?.trim() || undefined,
    hrMyHrUrl: env.HR_MY_HR_URL?.trim() || undefined,
    myHrHttpTimeoutMs: env.MY_HR_HTTP_TIMEOUT_MS || undefined,
  });
  if (!parsed.success) {
    throw new Error(
      `Invalid API config: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}. ` +
        "Copy apps/api/env.example to apps/api/.env and set DATABASE_URL for an isolated local database.",
    );
  }

  let config = parsed.data;
  if (config.trustProxyHops > 0 && config.trustProxyCidrs.length === 0) {
    throw new Error(
      "Invalid API config: API_TRUST_PROXY_HOPS > 0 requires API_TRUST_PROXY_CIDRS " +
        "listing the trusted proxy addresses or CIDRs.",
    );
  }
  if (config.trustProxyHops === 0 && config.trustProxyCidrs.length > 0) {
    throw new Error(
      "Invalid API config: API_TRUST_PROXY_CIDRS is set but API_TRUST_PROXY_HOPS is 0. " +
        "Set a positive hop count or clear the CIDR list.",
    );
  }
  for (const c of config.trustProxyCidrs) {
    if (!parseCidr(c)) {
      throw new Error(`Invalid API config: bad CIDR in API_TRUST_PROXY_CIDRS: ${c}`);
    }
  }
  for (const origin of config.corsAllowedOrigins) {
    if (!isExactHttpOrigin(origin)) {
      throw new Error(
        "Invalid API config: CORS_ALLOWED_ORIGINS entries must be exact http(s) origins " +
          "(scheme://host[:port], no path, no trailing slash, no wildcard).",
      );
    }
  }
  // My HR: a value that is set but unusable stops the start (names only, never the value); an unset one just leaves the
  // feature off. A trailing slash on the two base addresses is dropped, so paths can be appended.
  for (const [name, value] of [
    ["PLATFORM_TOKEN_URL", config.platformTokenUrl],
    ["PLATFORM_API_URL", config.platformApiUrl],
    ["HR_MY_HR_URL", config.hrMyHrUrl],
  ] as const) {
    if (value !== undefined && !isAllowedPlatformUrl(value, config.appEnv)) {
      throw new Error(
        `Invalid API config: ${name} must be an https address with no credentials, query or fragment ` +
          "(http is accepted only for a loopback host in local and test).",
      );
    }
  }
  config = {
    ...config,
    platformApiUrl: config.platformApiUrl?.replace(/\/+$/, ""),
    hrMyHrUrl: config.hrMyHrUrl?.replace(/\/+$/, ""),
  };
  const longestServerStatementMs = Math.max(config.statementTimeoutMs, config.identityStatementTimeoutMs);
  if (config.clientQueryTimeoutMs <= longestServerStatementMs) {
    throw new Error(
      "Invalid API config: CLIENT_QUERY_TIMEOUT_MS must exceed STATEMENT_TIMEOUT_MS and IDENTITY_STATEMENT_TIMEOUT_MS " +
        "(the server-side timers must fire first; the client timer is only the backstop for a stalled network).",
    );
  }
  if (config.serverHeadersTimeoutMs <= config.serverKeepAliveTimeoutMs) {
    throw new Error(
      "Invalid API config: SERVER_HEADERS_TIMEOUT_MS must exceed SERVER_KEEP_ALIVE_TIMEOUT_MS.",
    );
  }
  if (config.shutdownHardTimeoutMs <= config.shutdownGraceMs + config.shutdownDrainDelayMs) {
    throw new Error(
      "Invalid API config: SHUTDOWN_HARD_TIMEOUT_MS must exceed SHUTDOWN_GRACE_MS plus SHUTDOWN_DRAIN_DELAY_MS.",
    );
  }
  if (
    config.mpesaCallbackUrl &&
    config.appEnv !== "local" &&
    config.appEnv !== "test" &&
    !config.mpesaCallbackUrl.startsWith("https://")
  ) {
    throw new Error("Invalid API config: MPESA_CALLBACK_URL must be https outside local and test.");
  }
  if (
    config.payheroCallbackUrl &&
    config.appEnv !== "local" &&
    config.appEnv !== "test" &&
    !config.payheroCallbackUrl.startsWith("https://")
  ) {
    throw new Error("Invalid API config: PAYHERO_CALLBACK_URL must be https outside local and test.");
  }
  if (config.mpesaEnv === "production" && config.appEnv !== "production") {
    throw new Error("Invalid API config: MPESA_ENV=production is only allowed when APP_ENV=production.");
  }
  if (config.poolMax > POOL_MAX_CAP) {
    throw new Error(
      `Invalid API config: POOL_MAX exceeds the per-process safety cap ${POOL_MAX_CAP}. ` +
        "The cap is not a production sizing recommendation; derive pool size from the database connection budget.",
    );
  }

  // DATABASE_URL must be the dedicated runtime login, never the migrator/owner.
  let databaseUser: string;
  try {
    databaseUser = decodeURIComponent(new URL(config.databaseUrl).username);
  } catch {
    throw new Error("Invalid API config: DATABASE_URL is not a valid URL");
  }
  if (!databaseUser) {
    throw new Error("Invalid API config: DATABASE_URL must include the runtime role as the username");
  }
  if (databaseUser !== config.runtimeRole) {
    throw new Error(
      `Invalid API config: DATABASE_URL user (${databaseUser}) must equal RUNTIME_ROLE (${config.runtimeRole}). ` +
        "Use MIGRATION_DATABASE_URL for the migrator/owner connection.",
    );
  }

  // Local/test default for session mint HMAC (migration 014). A documented development
  // key for disposable databases only: it is rejected in staging/production below, and the
  // provisioning script refuses to install it.
  if (!config.sessionMintHmacKey && !isStrict(config.appEnv)) {
    config = { ...config, sessionMintHmacKey: LOCAL_SESSION_MINT_HMAC_KEY };
  }

  if (isStrict(config.appEnv)) assertStrictApiConfig(config, env);
  return config;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/** TLS must be verified for any database that is not on this machine. Names only in errors. */
function assertVerifiedTls(url: string, variable: string, kind: "API" | "migrate"): void {
  const parsed = new URL(url);
  if (isLoopbackHost(parsed.hostname)) return;
  const mode = parsed.searchParams.get("sslmode");
  if (mode !== "verify-full" && mode !== "verify-ca") {
    throw new Error(
      `Invalid ${kind} config: ${variable} must set sslmode=verify-full (or verify-ca) for a database that is not on loopback outside local/test.`,
    );
  }
}

/** Staging and production: refuse settings that weaken security instead of silently accepting them. */
function assertStrictApiConfig(config: AppConfig, env: NodeJS.ProcessEnv): void {
  if (config.mfaEnforcement !== "enforce") {
    throw new Error("Invalid API config: MFA_ENFORCEMENT must be 'enforce' outside local/test.");
  }
  // Tightening the two-step attempt limit is fine; loosening it is not. Compared as whole numbers
  // (refill per interval, cross-multiplied) so there is no rounding to argue about.
  const d = MFA_ATTEMPT_RATE_DEFAULTS;
  if (
    config.mfaAttemptRateCapacity > d.capacity ||
    config.mfaAttemptRateRefill * d.intervalMs > d.refill * config.mfaAttemptRateIntervalMs
  ) {
    throw new Error(
      "Invalid API config: MFA_ATTEMPT_RATE_* may not be looser than the default outside local/test " +
        `(at most ${d.capacity} attempts, refilling no faster than ${d.refill} every ${d.intervalMs / 1000} seconds).`,
    );
  }
  if (!config.mfaEncryptionKey) {
    throw new Error("Invalid API config: MFA_ENCRYPTION_KEY is required outside local/test (at least 32 characters).");
  }
  if (config.mfaEncryptionKey === config.sessionMintHmacKey) {
    throw new Error("Invalid API config: MFA_ENCRYPTION_KEY must differ from SESSION_MINT_HMAC_KEY.");
  }
  assertVerifiedTls(config.databaseUrl, "DATABASE_URL", "API");
  if (!config.idempotencyFingerprintKey) {
    throw new Error("Invalid API config: IDEMPOTENCY_FINGERPRINT_KEY is required outside local/test (at least 32 characters).");
  }
  if (!config.sessionMintHmacKey) {
    throw new Error("Invalid API config: SESSION_MINT_HMAC_KEY is required outside local/test (at least 32 characters).");
  }
  if (config.sessionMintHmacKey === LOCAL_SESSION_MINT_HMAC_KEY) {
    throw new Error("Invalid API config: SESSION_MINT_HMAC_KEY is the documented local/test development key; generate a random key (see docs/SESSION-HMAC-PROVISIONING.md).");
  }
  // The serving process must not hold the migrator's credentials (AD-1): that would make
  // the least-privilege runtime role pointless if the process were compromised.
  if (env.MIGRATION_DATABASE_URL?.trim()) {
    throw new Error("Invalid API config: MIGRATION_DATABASE_URL must not be set in the API process outside local/test.");
  }
  if (config.poolMax > POOL_MAX_CAP) {
    throw new Error("Invalid API config: POOL_MAX exceeds the per-process safety cap.");
  }
}

export interface MigrationConfig {
  migrationDatabaseUrl: string;
  migrationLockTimeoutMs: number;
  runtimeRole: string;
}

function connectionUser(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid migrate config: MIGRATION_DATABASE_URL is not a valid URL");
  }
  return decodeURIComponent(parsed.username);
}

/**
 * Migrator entrypoint config. Reads MIGRATION_DATABASE_URL only.
 * The URL must be a direct or session-mode connection, never the runtime role
 * and never a transaction-mode pooler (advisory locks are session-scoped).
 */
export function loadMigrationConfig(env: NodeJS.ProcessEnv = process.env): MigrationConfig {
  const url = env.MIGRATION_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "Invalid migrate config: MIGRATION_DATABASE_URL is required. " +
        "Use a direct or session-mode migrator connection. DATABASE_URL is the runtime role and is not read here.",
    );
  }
  const runtimeRole = (env.RUNTIME_ROLE ?? "figbloom_app").trim() || "figbloom_app";
  const user = connectionUser(url);
  if (user === runtimeRole) {
    throw new Error(
      `Invalid migrate config: MIGRATION_DATABASE_URL must not connect as the runtime role ${runtimeRole}.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid migrate config: MIGRATION_DATABASE_URL is not a valid URL");
  }
  if (parsed.searchParams.get("pgbouncer") === "true") {
    throw new Error(
      "Invalid migrate config: transaction-mode pooler URLs are refused. Use a direct or session-mode connection.",
    );
  }
  const lockRaw = env.MIGRATION_LOCK_TIMEOUT_MS;
  const migrationLockTimeoutMs =
    lockRaw === undefined || lockRaw === "" ? 15_000 : Number(lockRaw);
  if (!Number.isInteger(migrationLockTimeoutMs) || migrationLockTimeoutMs <= 0 || migrationLockTimeoutMs > 120_000) {
    throw new Error("Invalid migrate config: MIGRATION_LOCK_TIMEOUT_MS must be a positive integer up to 120000");
  }
  if (isStrict(resolveAppEnvironment(env, "migrate"))) {
    assertVerifiedTls(url, "MIGRATION_DATABASE_URL", "migrate");
  }
  return { migrationDatabaseUrl: url, migrationLockTimeoutMs, runtimeRole };
}

export const MIGRATIONS_DIR = resolve(apiRoot, "migrations");
export const API_ROOT = apiRoot;
