# Rate-limit policy (D-1 / R3-04)

**Status:** IMPLEMENTED · PostgreSQL token bucket · no Redis

## Defaults (approved)

| Parameter | Value |
|---|---|
| Capacity | 5 |
| Initial tokens | 5 |
| Refill | 2 tokens / 5 seconds |
| Standard cost | 1 |

## Endpoint categories

| Category | Bucket keys | Notes |
|---|---|---|
| Login | `login:ip:<ip\|unknown>` then account key | IP first (R2-03) |
| Password change | `password_change:ip:<ip\|unknown>` then `password_change:user:<id>` | Authenticated |
| Future: recovery / bulk / export | Documented placeholders | Add when endpoints exist |

## Audit flooding (D-6)

Permission-denial events are audited. Login 429s are **not** individually
audited at INFO volume (response-only). When a general request limiter lands,
prefer sampled denial audit (e.g. first denial per bucket window) to avoid floods.

## Unknown client IP (R3-04)

- Canonical bucket: `*:unknown` via `rateLimitBucketForIp`.
- **Fail closed:** cannot bypass limits by omitting IP.
- **Trade-off:** shared bucket can be saturated (DoS of the unknown-IP class only). Fix proxy trust (`API_TRUST_PROXY_HOPS` + CIDRs) rather than inventing client-controlled bucket IDs.
- Audit: login failures remain audited; avoid per-429 audit floods (denials are not individually audited at INFO volume).

## IPv4-mapped IPv6 (R3-03)

- `::ffff:a.b.c.d` normalises to `a.b.c.d` before CIDR match and bucket identity.
