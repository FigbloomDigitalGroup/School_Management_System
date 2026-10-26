/**
 * The one call Bloom makes to a model, behind the same shape for each
 * provider, so index.ts never cares which one is in use. Chosen by secrets:
 *
 *   AI_PROVIDER   "openai" (default) or "anthropic"
 *   AI_MODEL      optional; defaults below
 *   OPENAI_API_KEY / ANTHROPIC_API_KEY
 *
 * Both answer in JSON fixed by the task's schema when there is one (OpenAI
 * strict structured outputs; Anthropic output_config.format), and both report
 * a declined request as "refused" and a cut-off answer as "too_long".
 */

import Anthropic from "npm:@anthropic-ai/sdk@0.133.0";
import OpenAI from "npm:openai@7.32.0";

export interface AiRequest {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  /** JSON Schema the answer must follow, or null for plain text (the study helper). */
  schema: Record<string, unknown> | null;
  effort: "low" | "medium";
}

export interface AiReply {
  model: string;
  outcome: "ok" | "refused" | "too_long";
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export type AiCall = (req: AiRequest) => Promise<AiReply>;

const MAX_OUTPUT_TOKENS = 16000;

export const DEFAULT_MODEL = { openai: "gpt-6-astra", anthropic: "claude-opus-5-5" } as const;

// ------------------------------------------------------------------ OpenAI (Responses API)

/** The parts of a Responses API response this reads. */
export interface OpenAiResponse {
  model: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: { type: string; content?: { type: string; text?: string; refusal?: string }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number } | null;
}

export function openAiReply(r: OpenAiResponse): AiReply {
  const parts = (r.output ?? []).filter((o) => o.type === "message").flatMap((o) => o.content ?? []);
  const refused = parts.some((c) => c.type === "refusal") || r.incomplete_details?.reason === "content_filter";
  const tooLong = r.status === "incomplete" && r.incomplete_details?.reason === "max_output_tokens";
  return {
    model: r.model,
    outcome: refused ? "refused" : tooLong ? "too_long" : "ok",
    text: parts.filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("").trim(),
    inputTokens: r.usage?.input_tokens ?? 0,
    outputTokens: r.usage?.output_tokens ?? 0,
  };
}

export function openAiParams(model: string, req: AiRequest): Record<string, unknown> {
  return {
    model,
    instructions: req.system,
    input: req.messages,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    reasoning: { effort: req.effort },
    ...(req.schema ? { text: { format: { type: "json_schema", name: "bloom_draft", schema: req.schema, strict: true } } } : {}),
    // Nothing a school sends is kept on OpenAI's side for later turns; each request stands alone.
    store: false,
  };
}

export function openAiCall(apiKey: string, model: string): AiCall {
  const client = new OpenAI({ apiKey });
  return async (req) => {
    // deno-lint-ignore no-explicit-any
    const r = await client.responses.create(openAiParams(model, req) as any);
    return openAiReply(r as unknown as OpenAiResponse);
  };
}

// ------------------------------------------------------------------ Anthropic (Messages API)

export interface AnthropicMessage {
  model: string;
  stop_reason: string | null;
  content: { type: string; text?: string }[];
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null };
}

export function anthropicReply(m: AnthropicMessage): AiReply {
  return {
    model: m.model,
    outcome: m.stop_reason === "refusal" ? "refused" : m.stop_reason === "max_tokens" ? "too_long" : "ok",
    text: m.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim(),
    inputTokens: m.usage.input_tokens + (m.usage.cache_creation_input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0),
    outputTokens: m.usage.output_tokens,
  };
}

export function anthropicParams(model: string, req: AiRequest): Record<string, unknown> {
  return {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    // A declined request is retried server-side on a fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
    messages: req.messages,
    output_config: { effort: req.effort, ...(req.schema ? { format: { type: "json_schema", schema: req.schema } } : {}) },
  };
}

export function anthropicCall(apiKey: string, model: string): AiCall {
  const client = new Anthropic({ apiKey });
  return async (req) => {
    // fallbacks/betas are newer than this SDK's request types; the API accepts them.
    // deno-lint-ignore no-explicit-any
    const m = await client.beta.messages.create(anthropicParams(model, req) as any);
    return anthropicReply(m as unknown as AnthropicMessage);
  };
}

// ------------------------------------------------------------------ choosing

/** The configured provider, or a clear reason it can't run. */
export function aiFromEnv(env: (name: string) => string | undefined): { call: AiCall; model: string } | { error: string } {
  const provider = (env("AI_PROVIDER") ?? "openai").trim().toLowerCase();
  if (provider !== "openai" && provider !== "anthropic") return { error: `AI_PROVIDER must be "openai" or "anthropic", not "${provider}".` };
  const model = env("AI_MODEL")?.trim() || DEFAULT_MODEL[provider];
  const key = env(provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY");
  if (!key) return { error: `Bloom isn't set up yet (${provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} is missing).` };
  return { call: provider === "openai" ? openAiCall(key, model) : anthropicCall(key, model), model };
}
