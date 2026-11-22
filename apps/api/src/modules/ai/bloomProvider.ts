import type { AppConfig } from "../../config.js";
import type { TxOrIdentity } from "../../db/sql.js";
import { forbidden, rateLimited } from "../../http/errors.js";
import {
  ALLOWED_TOOLS,
  CONTRACT_NAME,
  CONTRACT_VERSION,
  HEALTH_PATH,
  MAX_RESPONSE_BYTES,
  PRODUCT,
  QUERY_PATH,
  WireResponseSchema,
  newRequestId,
  signRequest,
  type KnowledgeScope,
  type WireRequest,
} from "./contract.js";

export type { KnowledgeScope } from "./contract.js";

export interface BloomPromptRequest {
  tenantId: string;
  actorUserId: string;
  actorRole?: string;
  isSuperAdmin: boolean;
  requestedScope: KnowledgeScope;
  /** Server-derived, never client supplied. */
  allowedScopes?: KnowledgeScope[];
  prompt: string;
  requestId?: string;
  conversationId?: string;
}

export type UnavailableReason = "provider_unreachable" | "provider_error" | "circuit_open" | "contract_error";

export type BloomPromptResult =
  | { status: "ok"; scope: KnowledgeScope; answer: string; provider: string; request_id?: string; citations?: Array<{ title: string; source?: string }> }
  | { status: "not_configured"; scope: KnowledgeScope; reason: "llm_provider_not_configured" }
  | { status: "unavailable"; scope: KnowledgeScope; reason: UnavailableReason; retry_after_seconds: number; request_id?: string };

/**
 * Role-to-scope eligibility policy (server-side facts only):
 *  - platform super_admin: public, school, internal_figbloom
 *  - org_admin, school_admin, teacher, staff: public + school (when school AI is enabled)
 *  - parent, student: public only (school-internal context restricted by default)
 *  - driver / unknown: none (not eligible for Bloom AI)
 */
export const BLOOM_SCHOOL_SCOPE_ROLES = new Set(["super_admin", "org_admin", "school_admin", "teacher", "staff"]);
export const BLOOM_PUBLIC_ONLY_ROLES = new Set(["parent", "student"]);

export function resolveAllowedScopes(input: {
  isSuperAdmin: boolean;
  schoolAiEnabled: boolean;
  role?: string;
}): KnowledgeScope[] {
  if (input.isSuperAdmin) return ["public", "school", "internal_figbloom"];
  if (!input.schoolAiEnabled) return [];
  const role = input.role ?? "school_admin";
  if (BLOOM_SCHOOL_SCOPE_ROLES.has(role)) return ["public", "school"];
  if (BLOOM_PUBLIC_ONLY_ROLES.has(role)) return ["public"];
  // Roles such as 'driver' are not eligible for Bloom AI
  return [];
}

export function assertKnowledgeBoundary(input: {
  requestedScope: KnowledgeScope;
  isSuperAdmin: boolean;
  allowedScopes?: KnowledgeScope[];
}): void {
  const allowed = input.allowedScopes ?? resolveAllowedScopes({ isSuperAdmin: input.isSuperAdmin, schoolAiEnabled: false });
  if (!allowed.includes(input.requestedScope)) {
    throw forbidden("The requested knowledge scope is not available to this account");
  }
  if (input.requestedScope === "internal_figbloom" && !input.isSuperAdmin) {
    throw forbidden("School users cannot access internal FigBloom knowledge");
  }
}

export interface BloomAiProvider {
  readonly configured: boolean;
  generate(req: BloomPromptRequest): Promise<BloomPromptResult>;
}

export class NotConfiguredBloomAiProvider implements BloomAiProvider {
  readonly configured = false;

  async generate(req: BloomPromptRequest): Promise<BloomPromptResult> {
    assertKnowledgeBoundary(req);
    return { status: "not_configured", scope: req.requestedScope, reason: "llm_provider_not_configured" };
  }
}

// ---------------------------------------------------------------------------------------------------------
// Circuit breaker: no retry storms against a failing AI platform (state is per process).
// ---------------------------------------------------------------------------------------------------------
const BREAKER_THRESHOLD = 5;
const BREAKER_OPEN_MS = 30_000;
interface BreakerState { failures: number; openUntil: number }
const breakers = new Map<string, BreakerState>();
const breakerFor = (key: string): BreakerState => {
  let b = breakers.get(key);
  if (!b) breakers.set(key, (b = { failures: 0, openUntil: 0 }));
  return b;
};
export function bloomCircuitState(baseUrl: string | undefined): "closed" | "open" | "unconfigured" {
  if (!baseUrl) return "unconfigured";
  return breakerFor(baseUrl).openUntil > Date.now() ? "open" : "closed";
}
export function resetBloomCircuitForTesting(): void {
  breakers.clear();
  userWindows.clear();
}

// ---------------------------------------------------------------------------------------------------------
// Shared PostgreSQL token-bucket rate limiter (reuses consume_rate_token / auth_rate_buckets).
// Works across multiple API instances with row-level concurrency safety.
// ---------------------------------------------------------------------------------------------------------
const USER_LIMIT = 20;
const TENANT_LIMIT = 120;
const PLATFORM_LIMIT = 600;
const WINDOW_MS = 60_000;

async function consumeSharedBucket(
  db: TxOrIdentity,
  bucketKey: string,
  capacity: number,
  message: string,
): Promise<void> {
  const res = await db.query<{ out_allowed: boolean; out_retry_after_ms: number | null }>(
    `SELECT out_allowed, out_retry_after_ms FROM public.consume_rate_token($1, 1, $2, $2, $3)`,
    [bucketKey, capacity, WINDOW_MS],
  );
  const row = res.rows[0];
  if (row && !row.out_allowed) {
    const retryAfter = row.out_retry_after_ms && row.out_retry_after_ms > 0 ? Math.max(1, Math.ceil(row.out_retry_after_ms / 1000)) : 5;
    throw rateLimited(message, retryAfter);
  }
}

export async function assertSharedBloomRateLimit(
  db: TxOrIdentity,
  input: { userId: string; tenantId: string },
): Promise<void> {
  await consumeSharedBucket(db, `bloom:user:${input.userId}`, USER_LIMIT, "Too many Bloom AI requests for this user. Try again shortly.");
  await consumeSharedBucket(db, `bloom:tenant:${input.tenantId}`, TENANT_LIMIT, "School Bloom AI rate limit reached. Try again shortly.");
  await consumeSharedBucket(db, "bloom:platform", PLATFORM_LIMIT, "Platform Bloom AI rate limit reached. Try again shortly.");
}

// Legacy in-process helper kept for unit test compatibility
const userWindows = new Map<string, number[]>();
export function assertBloomRateLimit(userId: string, now = Date.now()): void {
  const hits = (userWindows.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= USER_LIMIT) {
    userWindows.set(userId, hits);
    throw rateLimited("Too many Bloom AI requests. Try again shortly.", Math.ceil((WINDOW_MS - (now - hits[0]!)) / 1000));
  }
  hits.push(now);
  userWindows.set(userId, hits);
  if (userWindows.size > 10_000) {
    for (const [k, v] of userWindows) if (v.every((t) => now - t >= WINDOW_MS)) userWindows.delete(k);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const RETRYABLE_STATUS = new Set([502, 503, 504]);

/**
 * HTTP adapter for FigBloom AI (contract bloom-school/1). Activated when BLOOM_AI_BASE_URL is configured.
 * Signs every request (when a signing secret is configured), propagates tenant/user/request identity,
 * validates the response against the contract, retries once on transient failure and trips a breaker.
 */
export class HttpBloomAiProvider implements BloomAiProvider {
  readonly configured = true;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    private readonly timeoutMs: number,
    private readonly signingSecret?: string,
  ) {}

  async generate(req: BloomPromptRequest): Promise<BloomPromptResult> {
    assertKnowledgeBoundary(req);
    const requestId = req.requestId ?? newRequestId();
    const breaker = breakerFor(this.baseUrl);
    const now = Date.now();
    if (breaker.openUntil > now) {
      return { status: "unavailable", scope: req.requestedScope, reason: "circuit_open", retry_after_seconds: Math.ceil((breaker.openUntil - now) / 1000), request_id: requestId };
    }
    const body: WireRequest = {
      contract_version: CONTRACT_VERSION,
      request_id: requestId,
      conversation_id: req.conversationId ?? requestId,
      product: PRODUCT,
      capability: "chat",
      tenant: { id: req.tenantId, school_id: req.tenantId },
      actor: { user_id: req.actorUserId, role: req.actorRole ?? "unknown", platform_admin: req.isSuperAdmin },
      knowledge: { requested_scope: req.requestedScope, allowed_scopes: req.allowedScopes ?? ["public"] },
      tools: { allowed: [...ALLOWED_TOOLS] },
      prompt: req.prompt,
    };
    const raw = JSON.stringify(body);

    let lastReason: UnavailableReason = "provider_unreachable";
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(150 + Math.floor(Math.random() * 200));
      const out = await this.attempt(raw, requestId, req.requestedScope);
      if (out.kind === "ok") {
        breaker.failures = 0;
        return out.result;
      }
      if (out.kind === "rate_limited") throw rateLimited("Bloom AI is rate limiting requests. Try again shortly.", out.retryAfter);
      lastReason = out.reason;
      if (!out.retryable) break;
    }
    breaker.failures += 1;
    if (breaker.failures >= BREAKER_THRESHOLD) breaker.openUntil = Date.now() + BREAKER_OPEN_MS;
    return { status: "unavailable", scope: req.requestedScope, reason: lastReason, retry_after_seconds: 5, request_id: requestId };
  }

  private async attempt(
    raw: string,
    requestId: string,
    scope: KnowledgeScope,
  ): Promise<
    | { kind: "ok"; result: BloomPromptResult }
    | { kind: "rate_limited"; retryAfter: number }
    | { kind: "fail"; reason: UnavailableReason; retryable: boolean }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const ts = Math.floor(Date.now() / 1000);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-figbloom-contract": `${CONTRACT_NAME}/${CONTRACT_VERSION}`,
        "x-request-id": requestId,
        "x-figbloom-timestamp": String(ts),
      };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      if (this.signingSecret) headers["x-figbloom-signature"] = signRequest(this.signingSecret, ts, raw);
      const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${QUERY_PATH}`, {
        method: "POST",
        headers,
        body: raw,
        signal: controller.signal,
      });
      if (res.status === 429) {
        const ra = Number(res.headers.get("retry-after"));
        return { kind: "rate_limited", retryAfter: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 300) : 30 };
      }
      if (RETRYABLE_STATUS.has(res.status)) return { kind: "fail", reason: "provider_error", retryable: true };
      if (!res.ok) return { kind: "fail", reason: res.status >= 500 ? "provider_error" : "contract_error", retryable: false };
      const text = await res.text();
      if (text.length > MAX_RESPONSE_BYTES) return { kind: "fail", reason: "contract_error", retryable: false };
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { kind: "fail", reason: "contract_error", retryable: false };
      }
      const v = WireResponseSchema.safeParse(parsed);
      // The AI platform may not answer under a different scope or correlation id than the one requested.
      if (!v.success || v.data.scope !== scope || v.data.request_id !== requestId) {
        return { kind: "fail", reason: "contract_error", retryable: false };
      }
      return {
        kind: "ok",
        result: {
          status: "ok",
          scope,
          answer: v.data.answer,
          provider: v.data.provider ?? "figbloom_ai",
          request_id: requestId,
          ...(v.data.citations ? { citations: v.data.citations } : {}),
        },
      };
    } catch {
      return { kind: "fail", reason: "provider_unreachable", retryable: true };
    } finally {
      clearTimeout(timer);
    }
  }
}

let testOverrideProvider: BloomAiProvider | null = null;

export function getBloomAiProvider(config?: AppConfig): BloomAiProvider {
  if (testOverrideProvider) return testOverrideProvider;
  if (config?.bloomAiBaseUrl) {
    return new HttpBloomAiProvider(config.bloomAiBaseUrl, config.bloomAiApiKey, config.bloomAiTimeoutMs, config.bloomAiSigningSecret);
  }
  return new NotConfiguredBloomAiProvider();
}

export function setBloomAiProviderForTesting(provider: BloomAiProvider | null): void {
  testOverrideProvider = provider;
}

export const BLOOM_HEALTH_PATH = HEALTH_PATH;
