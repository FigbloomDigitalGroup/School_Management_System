import { describe, it } from "jsr:@std/testing/bdd";
import { assert, assertEquals } from "jsr:@std/assert";
import { aiFromEnv, anthropicParams, anthropicReply, DEFAULT_MODEL, openAiParams, openAiReply, type AiRequest } from "./providers.ts";

const SCHEMA = { type: "object", properties: { subject: { type: "string" } }, required: ["subject"], additionalProperties: false };
const DRAFT: AiRequest = { system: "You draft messages.", messages: [{ role: "user", content: "Notes" }], schema: SCHEMA, effort: "low" };
const CHAT: AiRequest = { ...DRAFT, schema: null };

describe("OpenAI", () => {
  it("asks the Responses API for strict JSON, with nothing stored", () => {
    const p = openAiParams("gpt-6-astra", DRAFT);
    assertEquals(p.model, "gpt-6-astra");
    assertEquals(p.instructions, "You draft messages.");
    assertEquals(p.input, DRAFT.messages);
    assertEquals(p.reasoning, { effort: "low" });
    assertEquals(p.store, false);
    assertEquals(p.text, { format: { type: "json_schema", name: "bloom_draft", schema: SCHEMA, strict: true } });
    assert(!("text" in openAiParams("gpt-6-astra", CHAT)), "the study helper answers in plain text");
  });

  it("sends a paper's PDF and page photos as file and image inputs", () => {
    const p = openAiParams("gpt-6-astra", { ...DRAFT, messages: [{ role: "user", content: [
      { type: "pdf", name: "paper.pdf", data: "JVBERi0=" },
      { type: "image", mediaType: "image/png", data: "iVBORw==" },
      { type: "text", text: "Read it." },
    ] }] });
    assertEquals(p.input, [{ role: "user", content: [
      { type: "input_file", filename: "paper.pdf", file_data: "data:application/pdf;base64,JVBERi0=" },
      { type: "input_image", image_url: "data:image/png;base64,iVBORw==", detail: "high" },
      { type: "input_text", text: "Read it." },
    ] }]);
  });

  it("reads the answer, a refusal, and a cut-off answer", () => {
    const ok = openAiReply({
      model: "gpt-6-astra", status: "completed",
      output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: '{"subject":"Hi"}' }] }],
      usage: { input_tokens: 50, output_tokens: 9 },
    });
    assertEquals(ok, { model: "gpt-6-astra", outcome: "ok", text: '{"subject":"Hi"}', inputTokens: 50, outputTokens: 9 });

    const refused = openAiReply({ model: "m", status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "No." }] }] });
    assertEquals(refused.outcome, "refused");

    const cut = openAiReply({ model: "m", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] });
    assertEquals(cut.outcome, "too_long");
  });
});

describe("Anthropic", () => {
  it("asks for JSON with server-side refusal fallbacks", () => {
    const p = anthropicParams("claude-opus-5-5", DRAFT);
    assertEquals(p.fallbacks, "default");
    assertEquals(p.betas, ["server-side-fallback-2026-07-01"]);
    // deno-lint-ignore no-explicit-any
    assertEquals((p.output_config as any).format, { type: "json_schema", schema: SCHEMA });
    assert(!("thinking" in p), "thinking can't be turned off on this model; leave it out");
  });

  it("sends a paper's PDF and page photos as document and image blocks", () => {
    const p = anthropicParams("claude-opus-5-5", { ...DRAFT, messages: [{ role: "user", content: [
      { type: "pdf", name: "paper.pdf", data: "JVBERi0=" },
      { type: "image", mediaType: "image/jpeg", data: "/9j/" },
      { type: "text", text: "Read it." },
    ] }] });
    assertEquals(p.messages, [{ role: "user", content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/" } },
      { type: "text", text: "Read it." },
    ] }]);
  });

  it("reads the answer and counts cached input", () => {
    const r = anthropicReply({
      model: "claude-opus-5-5", stop_reason: "end_turn",
      content: [{ type: "thinking" }, { type: "text", text: "Hello" }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90 },
    });
    assertEquals(r, { model: "claude-opus-5-5", outcome: "ok", text: "Hello", inputTokens: 100, outputTokens: 5 });
    assertEquals(anthropicReply({ model: "m", stop_reason: "refusal", content: [], usage: { input_tokens: 1, output_tokens: 0 } }).outcome, "refused");
  });
});

describe("choosing the provider", () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];

  it("uses OpenAI by default, with its default model", () => {
    const ai = aiFromEnv(env({ OPENAI_API_KEY: "sk-test" }));
    assert("call" in ai);
    assertEquals(ai.model, DEFAULT_MODEL.openai);
  });

  it("switches to Anthropic and a chosen model by setting", () => {
    const ai = aiFromEnv(env({ AI_PROVIDER: "Anthropic", AI_MODEL: "claude-sonnet-5-5", ANTHROPIC_API_KEY: "sk-ant" }));
    assert("call" in ai);
    assertEquals(ai.model, "claude-sonnet-5-5");
  });

  it("says what's missing instead of failing later", () => {
    const missing = aiFromEnv(env({ AI_PROVIDER: "anthropic", OPENAI_API_KEY: "sk-test" }));
    assert("error" in missing && missing.error.includes("ANTHROPIC_API_KEY"));
    const wrong = aiFromEnv(env({ AI_PROVIDER: "gemini" }));
    assert("error" in wrong);
  });
});
