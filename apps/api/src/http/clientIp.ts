import type { FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import { isIpInCidrs, normalizeIp } from "./ip.js";

type TrustConfig = Pick<AppConfig, "trustProxyHops" | "trustProxyCidrs">;

function trustConfig(request: FastifyRequest, override?: TrustConfig): TrustConfig {
  if (override) return override;
  const cfg = request.server.appConfig;
  return { trustProxyHops: cfg.trustProxyHops, trustProxyCidrs: cfg.trustProxyCidrs };
}

/**
 * Resolve the caller address for rate limiting and audit (R2-01 / R2-02).
 *
 * - Proxy trust disabled (default): socket address only; X-Forwarded-For ignored.
 * - Proxy trust enabled: Fastify applies hop-count trust; we still require the
 *   immediate peer to match configured CIDRs before accepting a forwarded IP.
 * - Zone IDs / malformed values normalize to null (never throw, never hit inet).
 */
export function clientIp(request: FastifyRequest, override?: TrustConfig): string | null {
  const config = trustConfig(request, override);
  const socketIp = normalizeIp(request.socket.remoteAddress ?? null);

  if (config.trustProxyHops <= 0) {
    return socketIp;
  }

  if (!socketIp || !isIpInCidrs(socketIp, config.trustProxyCidrs)) {
    return socketIp;
  }

  return normalizeIp(request.ip);
}
