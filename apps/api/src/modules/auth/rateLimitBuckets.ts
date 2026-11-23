/**
 * Rate-limit bucket identity helpers (R3-04 / D-1).
 *
 * Bucket keys are never taken from client-controlled tenant/role claims.
 * Unknown / unresolvable client IP uses a single shared bucket so:
 * - rate-limit cannot be bypassed by omitting an address
 * - misconfigured trusted proxies fail closed (shared throttle)
 * Documented trade-off: that shared bucket can be saturated (avoidable DoS
 * of the "unknown IP" class only). Prefer fixing proxy trust config.
 */
export function rateLimitBucketForIp(prefix: string, ip: string | null | undefined): string {
  if (ip == null || ip === "") return `${prefix}:unknown`;
  return `${prefix}:${ip}`;
}
