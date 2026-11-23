import { createHmac, createHash, randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * Bloom AI <-> FigBloom AI integration contract, version 1 ("bloom-school/1").
 * See apps/api/docs/FIGBLOOM-AI-INTEGRATION.md. FigBloom AI is the central AI platform; Bloom AI is the
 * School Management System's client of it. This file is the single source of the wire format.
 */
export const CONTRACT_NAME = "bloom-school";
export const CONTRACT_VERSION = "1";
export const QUERY_PATH = "/v1/bloom/query";
export const HEALTH_PATH = "/v1/health";
export const PRODUCT = "bloom_school";
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const MAX_ANSWER_CHARS = 20_000;

export const KNOWLEDGE_SCOPES = ["public", "school", "internal_figbloom"] as const;
export type KnowledgeScope = (typeof KNOWLEDGE_SCOPES)[number];

/** Live application tools the AI may call back into. None exist yet: adding one requires an explicit allowlist entry here. */
export const ALLOWED_TOOLS: readonly string[] = [];

export interface WireRequest {
  contract_version: typeof CONTRACT_VERSION;
  request_id: string;
  conversation_id: string;
  product: typeof PRODUCT;
  capability: "chat";
  tenant: { id: string; school_id: string };
  actor: { user_id: string; role: string; platform_admin: boolean };
  knowledge: { requested_scope: KnowledgeScope; allowed_scopes: KnowledgeScope[] };
  tools: { allowed: string[] };
  prompt: string;
}

export const WireResponseSchema = z.object({
  contract_version: z.literal(CONTRACT_VERSION),
  request_id: z.string().min(1).max(100),
  scope: z.enum(KNOWLEDGE_SCOPES),
  answer: z.string().min(1).max(MAX_ANSWER_CHARS),
  provider: z.string().max(80).optional(),
  usage: z
    .object({ input_tokens: z.number().int().min(0).optional(), output_tokens: z.number().int().min(0).optional() })
    .optional(),
  citations: z.array(z.object({ title: z.string().max(300), source: z.string().max(500).optional() })).max(50).optional(),
});
export type WireResponse = z.infer<typeof WireResponseSchema>;

export function newRequestId(): string {
  return randomUUID();
}

/**
 * HMAC-SHA256 over `${timestamp}.${sha256(body)}` — lets FigBloom AI verify the sender, the tenant/user
 * context in the body and freshness (reject skew > 5 minutes) without the client being able to forge identity.
 */
export function signRequest(secret: string, timestampSeconds: number, rawBody: string): string {
  const digest = createHash("sha256").update(rawBody).digest("hex");
  return "v1=" + createHmac("sha256", secret).update(`${timestampSeconds}.${digest}`).digest("hex");
}
