import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseCidr } from "./http/ip.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, "..");

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

const ConfigSchema = z.object({
  databaseUrl: z.string().min(1),
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().positive().default(4100),
  sessionTtlSeconds: z.coerce.number().int().positive().default(43_200),
  authRateCapacity: z.coerce.number().positive().default(5),
  authRateRefill: z.coerce.number().positive().default(2),
  authRateIntervalMs: z.coerce.number().int().positive().default(5_000),
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
  return config;
}

export const MIGRATIONS_DIR = resolve(apiRoot, "migrations");
export const API_ROOT = apiRoot;
