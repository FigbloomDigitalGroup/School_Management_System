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
 *
 * Web search (Bloom chat only, when the request asks for it) is each
 * provider's own hosted tool: OpenAI's Responses API `web_search`, Anthropic's
 * `web_search_20260209` server tool. Either way the reply comes back as text
 * with [^n] markers where the provider cited a source, the numbered sources
 * (http(s) only), and how many searches ran, which the school pays for.
 */

import Anthropic from "npm:@anthropic-ai/sdk@0.133.0";
import OpenAI from "npm:openai@7.32.0";

/** A document or page photo sent with a message (importing a paper), base64-encoded. */
export type AiPart =
  | { type: "text"; text: string }
  | { type: "pdf"; name: string; data: string }
  | { type: "image"; mediaType: "image/jpeg" | "image/png"; data: string };

export interface AiRequest {
  system: string;
  /** Text, or for a document task, the document's parts followed by the instructions. */
  messages: { role: "user" | "assistant"; content: string | AiPart[] }[];
  /** JSON Schema the answer must follow, or null for plain text (the study helper). */
  schema: Record<string, unknown> | null;
  effort: "low" | "medium";
  /** Offer the provider's hosted web search (Bloom chat only); absent or null, no tool is sent. */
  webSearch?: WebSearch | null;
}

export interface WebSearch {
  /** Searches allowed for one message. */
  maxUses: number;
  /** Where results are localised: an ISO 3166-1 alpha-2 code, and an IANA time zone. */
  country: string;
  timezone?: string;
}

/** A page an answer cites; [^n] in the text is sources[n - 1]. */
export interface AiSource { title: string; url: string }

export interface AiReply {
  model: string;
  outcome: "ok" | "refused" | "too_long";
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** Cited pages, in marker order; empty when nothing was searched. */
  sources: AiSource[];
  /** Web searches the provider ran (and bills for). */
  searches: number;
}

export type AiCall = (req: AiRequest) => Promise<AiReply>;

const MAX_OUTPUT_TOKENS = 16000;

export const DEFAULT_MODEL = { openai: "gpt-6-astra", anthropic: "claude-opus-5-5" } as const;

/** Anthropic's web search with dynamic filtering (Claude 4.6 and later), pinned so a new version is a deliberate change. */
export const ANTHROPIC_WEB_SEARCH_TOOL = "web_search_20260209";

/** Sources kept for one answer; matches the ai_chat_messages.sources check. */
const MAX_SOURCES = 20;

// ------------------------------------------------------------------ sources

/** An http(s) address a person can safely open, without OpenAI's utm_source tag, or null. */
export function safeSourceUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.searchParams.get("utm_source") === "openai") u.searchParams.delete("utm_source");
  return u.toString();
}

/** Numbers sources in the order they're first cited, one number per address. */
export class SourceList {
  readonly list: AiSource[] = [];
  /** The source's number (1-based), or null for an unsafe address or one past the cap. */
  add(url: unknown, title: unknown): number | null {
    const safe = safeSourceUrl(url);
    if (!safe) return null;
    const seen = this.list.findIndex((s) => s.url === safe);
    if (seen >= 0) return seen + 1;
    if (this.list.length >= MAX_SOURCES) return null;
    const t = typeof title === "string" ? title.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    this.list.push({ title: t || new URL(safe).hostname, url: safe });
    return this.list.length;
  }
}

const marks = (ns: number[]) => [...new Set(ns)].map((n) => `[^${n}]`).join("");

// ------------------------------------------------------------------ OpenAI (Responses API)

export interface OpenAiAnnotation { type: string; url?: string; title?: string; start_index?: number; end_index?: number }

/** The parts of a Responses API response this reads. */
export interface OpenAiResponse {
  model: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: {
    type: string;
    content?: { type: string; text?: string; refusal?: string; annotations?: OpenAiAnnotation[] }[];
    /** web_search_call: "search" is a billed call; "open_page" and "find_in_page" are steps within one. */
    action?: { type?: string } | null;
  }[];
  usage?: { input_tokens?: number; output_tokens?: number } | null;
}

export function openAiReply(r: OpenAiResponse): AiReply {
  const parts = (r.output ?? []).filter((o) => o.type === "message").flatMap((o) => o.content ?? []);
  const refused = parts.some((c) => c.type === "refusal") || r.incomplete_details?.reason === "content_filter";
  const tooLong = r.status === "incomplete" && r.incomplete_details?.reason === "max_output_tokens";
  const sources = new SourceList();
  return {
    model: r.model,
    outcome: refused ? "refused" : tooLong ? "too_long" : "ok",
    text: parts.filter((c) => c.type === "output_text").map((c) => openAiCited(c.text ?? "", c.annotations ?? [], sources)).join("").trim(),
    inputTokens: r.usage?.input_tokens ?? 0,
    outputTokens: r.usage?.output_tokens ?? 0,
    sources: sources.list,
    // Usage has no search count; each search action in the output is one billed call.
    searches: (r.output ?? []).filter((o) => o.type === "web_search_call" && (o.action?.type ?? "search") === "search").length,
  };
}

/**
 * The text with each url_citation turned into a [^n] marker. A citation's
 * span is usually the inline link the model wrote, e.g. "([kenyalaw.org](…))",
 * and that span is replaced by the marker. If the span doesn't look like the
 * link (the indices count characters, read here as code points), the marker
 * goes at its end and the text is left alone; if the indices don't fit the
 * text at all, the source is still listed, without a marker.
 */
export function openAiCited(text: string, annotations: OpenAiAnnotation[], sources: SourceList): string {
  const chars = Array.from(text);
  const edits: { start: number; end: number; n: number }[] = [];
  for (const a of annotations) {
    if (a.type !== "url_citation") continue;
    const n = sources.add(a.url, a.title);
    if (n === null) continue;
    const start = a.start_index, end = a.end_index;
    if (typeof start !== "number" || typeof end !== "number" || !Number.isInteger(start) || !Number.isInteger(end)
      || start < 0 || end < start || end > chars.length) continue;
    const span = chars.slice(start, end).join("");
    const host = new URL(sources.list[n - 1]!.url).hostname.replace(/^www\./, "");
    edits.push(span.includes("](") || span.includes(host) ? { start, end, n } : { start: end, end, n });
  }
  // From the end, so earlier indices still point at the same characters; of overlapping spans the later one wins.
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let limit = Infinity;
  for (const e of edits) {
    if (e.end > limit) continue;
    // a replaced " (link)" loses its leading space, so the marker sits on the word
    const start = e.end > e.start && chars[e.start - 1] === " " ? e.start - 1 : e.start;
    chars.splice(start, e.end - start, `[^${e.n}]`);
    limit = start;
  }
  return chars.join("");
}

function openAiContent(content: string | AiPart[]): unknown {
  if (typeof content === "string") return content;
  return content.map((p) =>
    p.type === "text" ? { type: "input_text", text: p.text }
    : p.type === "pdf" ? { type: "input_file", filename: p.name, file_data: `data:application/pdf;base64,${p.data}` }
    : { type: "input_image", image_url: `data:${p.mediaType};base64,${p.data}`, detail: "high" });
}

export function openAiParams(model: string, req: AiRequest): Record<string, unknown> {
  return {
    model,
    instructions: req.system,
    input: req.messages.map((m) => ({ role: m.role, content: openAiContent(m.content) })),
    max_output_tokens: MAX_OUTPUT_TOKENS,
    reasoning: { effort: req.effort },
    ...(req.schema ? { text: { format: { type: "json_schema", name: "bloom_draft", schema: req.schema, strict: true } } } : {}),
    ...(req.webSearch ? {
      tools: [{ type: "web_search", user_location: userLocation(req.webSearch) }],
      tool_choice: "auto",
      // Caps every built-in tool call in the response; web search is the only one offered.
      max_tool_calls: req.webSearch.maxUses,
    } : {}),
    // Nothing a school sends is kept on OpenAI's side for later turns; each request stands alone.
    store: false,
  };
}

const userLocation = (w: WebSearch) => ({ type: "approximate", country: w.country, ...(w.timezone ? { timezone: w.timezone } : {}) });

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
  content: { type: string; text?: string; citations?: { type: string; url?: string; title?: string }[] | null }[];
  usage: {
    input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null;
    server_tool_use?: { web_search_requests?: number } | null;
  };
}

/** A search turn the API pauses (pause_turn) is sent back to carry on, at most this many times. */
const MAX_CONTINUATIONS = 2;

const isSearchStep = (type: string) => type === "server_tool_use" || type.endsWith("_tool_result");

const anthropicSearches = (pages: AnthropicMessage[]) => pages.reduce((n, m) => n + (m.usage.server_tool_use?.web_search_requests ?? 0), 0);

/**
 * One reply from a message and any continuations of it (pause_turn), in
 * order. Text written before the last search ("I'll look that up") is left
 * out, and each cited text block is followed by its [^n] markers.
 */
export function anthropicReply(...pages: AnthropicMessage[]): AiReply {
  const last = pages[pages.length - 1]!;
  const blocks = pages.flatMap((p) => p.content);
  let from = 0;
  blocks.forEach((b, i) => { if (isSearchStep(b.type)) from = i + 1; });
  const answer = blocks.slice(from).some((b) => b.type === "text") ? blocks.slice(from) : blocks;
  const sources = new SourceList();
  const text = answer.filter((b) => b.type === "text").map((b) => {
    const cited = (b.citations ?? []).filter((c) => c.type === "web_search_result_location")
      .map((c) => sources.add(c.url, c.title)).filter((n): n is number => n !== null);
    return (b.text ?? "") + marks(cited);
  }).join("").trim();
  return {
    model: last.model,
    // still paused after the last continuation: the search ran out of room
    outcome: last.stop_reason === "refusal" ? "refused"
      : last.stop_reason === "max_tokens" || last.stop_reason === "pause_turn" ? "too_long" : "ok",
    text,
    inputTokens: pages.reduce((n, m) => n + m.usage.input_tokens + (m.usage.cache_creation_input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0), 0),
    outputTokens: pages.reduce((n, m) => n + m.usage.output_tokens, 0),
    sources: sources.list,
    searches: anthropicSearches(pages),
  };
}

function anthropicContent(content: string | AiPart[]): unknown {
  if (typeof content === "string") return content;
  return content.map((p) =>
    p.type === "text" ? { type: "text", text: p.text }
    : p.type === "pdf" ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: p.data } }
    : { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } });
}

/** `searchesUsed`: searches already run in this message, when a paused turn is carried on. */
export function anthropicParams(model: string, req: AiRequest, searchesUsed = 0): Record<string, unknown> {
  return {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    // A declined request is retried server-side on a fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
    messages: req.messages.map((m) => ({ role: m.role, content: anthropicContent(m.content) })),
    output_config: { effort: req.effort, ...(req.schema ? { format: { type: "json_schema", schema: req.schema } } : {}) },
    ...(req.webSearch ? {
      tools: [{ type: ANTHROPIC_WEB_SEARCH_TOOL, name: "web_search", max_uses: req.webSearch.maxUses - searchesUsed, user_location: userLocation(req.webSearch) }],
    } : {}),
  };
}

export function anthropicCall(apiKey: string, model: string): AiCall {
  const client = new Anthropic({ apiKey });
  return async (req) => {
    const pages: AnthropicMessage[] = [];
    let params = anthropicParams(model, req);
    for (;;) {
      // fallbacks/betas are newer than this SDK's request types; the API accepts them.
      // deno-lint-ignore no-explicit-any
      const m = await client.beta.messages.create(params as any) as unknown as AnthropicMessage;
      pages.push(m);
      if (m.stop_reason !== "pause_turn" || pages.length > MAX_CONTINUATIONS || !req.webSearch) break;
      // A long search turn pauses; sending the paused turn back unchanged carries it on,
      // unless the message's searches are used up (then it's answered as too long).
      const used = anthropicSearches(pages);
      if (used >= req.webSearch.maxUses) break;
      params = anthropicContinue(model, req, pages, used);
    }
    return anthropicReply(...pages);
  };
}

/** The request that carries on a paused turn: the conversation, then everything said so far, as it came back. */
export function anthropicContinue(model: string, req: AiRequest, pages: AnthropicMessage[], searchesUsed: number): Record<string, unknown> {
  const params = anthropicParams(model, req, searchesUsed);
  return { ...params, messages: [...(params.messages as unknown[]), ...pages.map((p) => ({ role: "assistant", content: p.content }))] };
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
