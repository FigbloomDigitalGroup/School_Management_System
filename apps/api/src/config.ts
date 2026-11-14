import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseCidr } from "./http/ip.js";

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

/** Load apps/api/.env if present without printing values. */
function loadDotEnv(): void {
  const path = resolve(apiRoot, ".env");
  if (!existsSync(path)) return;
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
}

loadDotEnv();

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

const ConfigSchema = z.object({
  databaseUrl: z.string().min(1),
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().positive().default(4100),
  sessionTtlSeconds: z.coerce.number().int().positive().default(43_200),
  authRateCapacity: z.coerce.number().positive().default(5),
  authRateRefill: z.coerce.number().positive().default(2),
  authRateIntervalMs: z.coerce.number().int().positive().default(5_000),
  /** Runtime login role. DATABASE_URL must be this role, never the migrator. */
  runtimeRole: z.string().min(1).default("figbloom_app"),
  poolMax: z.coerce.number().int().positive().default(10),
  /** Acquisition budget only. Not a transaction or statement timeout. */
  poolAcquireTimeoutMs: z.coerce.number().int().positive().max(30_000).default(2_000),
  statementTimeoutMs: z.coerce.number().int().positive().max(120_000).default(15_000),
  lockTimeoutMs: z.coerce.number().int().positive().max(120_000).default(5_000),
  idleInTransactionSessionTimeoutMs: z.coerce.number().int().positive().max(120_000).default(15_000),
  applicationName: z.string().min(1).max(63).default("figbloom-api"),
  /**
   * Number of trusted reverse-proxy hops (R2-01). 0 = do not honour X-Forwarded-For.
   * When > 0, API_TRUST_PROXY_CIDRS must list the addresses/CIDRs of those proxies.
   */
  trustProxyHops: z.coerce.number().int().min(0).max(32).default(0),
  /** Comma-separated CIDRs / addresses of trusted proxies (required when hops > 0). */
  trustProxyCidrs: z.array(z.string()).default([]),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

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
    authRateCapacity: env.AUTH_RATE_CAPACITY,
    authRateRefill: env.AUTH_RATE_REFILL,
    authRateIntervalMs: env.AUTH_RATE_INTERVAL_MS,
    runtimeRole: env.RUNTIME_ROLE,
    poolMax: env.POOL_MAX,
    poolAcquireTimeoutMs: env.POOL_ACQUIRE_TIMEOUT_MS,
    statementTimeoutMs: env.STATEMENT_TIMEOUT_MS,
    lockTimeoutMs: env.LOCK_TIMEOUT_MS,
    idleInTransactionSessionTimeoutMs: env.IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS,
    applicationName: env.APPLICATION_NAME,
    trustProxyHops: hopsRaw === undefined || hopsRaw === "" ? 0 : hopsRaw,
    trustProxyCidrs: cidrs,
  });
  if (!parsed.success) {
    throw new Error(
      `Invalid API config: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}. ` +
        "Copy apps/api/env.example to apps/api/.env and set DATABASE_URL for an isolated local database.",
    );
  }

  const config = parsed.data;
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

  return config;
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
  return { migrationDatabaseUrl: url, migrationLockTimeoutMs, runtimeRole };
}

export const MIGRATIONS_DIR = resolve(apiRoot, "migrations");
export const API_ROOT = apiRoot;
