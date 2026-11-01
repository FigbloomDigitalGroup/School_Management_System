import { describe, it } from "jsr:@std/testing/bdd";
import { assert, assertEquals } from "jsr:@std/assert";
import {
  aiFromEnv, ANTHROPIC_WEB_SEARCH_TOOL, anthropicContinue, anthropicParams, anthropicReply, DEFAULT_MODEL, openAiParams, openAiReply, safeSourceUrl,
  type AiRequest, type AnthropicMessage,
} from "./providers.ts";

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
    assertEquals(ok, { model: "gpt-6-astra", outcome: "ok", text: '{"subject":"Hi"}', inputTokens: 50, outputTokens: 9, sources: [], searches: 0 });

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
    assertEquals(r, { model: "claude-opus-5-5", outcome: "ok", text: "Hello", inputTokens: 100, outputTokens: 5, sources: [], searches: 0 });
    assertEquals(anthropicReply({ model: "m", stop_reason: "refusal", content: [], usage: { input_tokens: 1, output_tokens: 0 } }).outcome, "refused");
  });
});

const SEARCH: AiRequest = { ...CHAT, webSearch: { maxUses: 5, country: "KE", timezone: "Africa/Nairobi" } };

describe("web search (OpenAI Responses API)", () => {
  it("sends the web_search tool, localised and capped, only when asked", () => {
    const p = openAiParams("gpt-6-astra", SEARCH);
    assertEquals(p.tools, [{ type: "web_search", user_location: { type: "approximate", country: "KE", timezone: "Africa/Nairobi" } }]);
    assertEquals(p.tool_choice, "auto");
    assertEquals(p.max_tool_calls, 5);
    for (const req of [CHAT, DRAFT, { ...CHAT, webSearch: null }]) {
      const q = openAiParams("gpt-6-astra", req);
      assert(!("tools" in q) && !("max_tool_calls" in q), "no tool unless the request asks for search");
    }
  });

  it("turns url_citation annotations into numbered markers and sources, and counts search calls", () => {
    const text = "Term 1 opens on 4 January 2027 ([education.go.ke](https://www.education.go.ke/dates?utm_source=openai)). KCSE starts in November.";
    const linkStart = text.indexOf(" ([") + 1, linkEnd = text.indexOf(")).") + 2;
    const r = openAiReply({
      model: "gpt-6-astra", status: "completed",
      output: [
        { type: "web_search_call", action: { type: "search" } },
        { type: "web_search_call", action: { type: "open_page" } },
        { type: "web_search_call", action: { type: "search" } },
        { type: "reasoning" },
        { type: "message", content: [{ type: "output_text", text, annotations: [
          { type: "url_citation", url: "https://www.education.go.ke/dates?utm_source=openai", title: "2027 term dates", start_index: linkStart, end_index: linkEnd },
          // a span that isn't the link: the marker goes at its end and the text stays
          { type: "url_citation", url: "https://www.knec.ac.ke/kcse", title: "KCSE timetable", start_index: text.indexOf("KCSE"), end_index: text.length - 1 },
          { type: "url_citation", url: "javascript:alert(1)", title: "x", start_index: 0, end_index: 4 },
        ] }] },
      ],
      usage: { input_tokens: 900, output_tokens: 80 },
    });
    assertEquals(r.text, "Term 1 opens on 4 January 2027[^1]. KCSE starts in November[^2].");
    assertEquals(r.sources, [
      { title: "2027 term dates", url: "https://www.education.go.ke/dates" },
      { title: "KCSE timetable", url: "https://www.knec.ac.ke/kcse" },
    ]);
    assertEquals(r.searches, 2, "open_page is a step within a search, not a billed call");
  });

  it("numbers a source cited twice once, and lists it even when the indices don't fit the text", () => {
    const r = openAiReply({ model: "m", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "A. B.", annotations: [
      { type: "url_citation", url: "https://tsc.go.ke/a", title: "TSC", start_index: 1, end_index: 1 },
      { type: "url_citation", url: "https://tsc.go.ke/a", title: "TSC", start_index: 4, end_index: 4 },
      { type: "url_citation", url: "https://kicd.ac.ke/", title: "", start_index: 3, end_index: 99 },
    ] }] }] });
    assertEquals(r.text, "A[^1]. B[^1].");
    assertEquals(r.sources, [{ title: "TSC", url: "https://tsc.go.ke/a" }, { title: "kicd.ac.ke", url: "https://kicd.ac.ke/" }]);
  });
});

describe("web search (Anthropic Messages API)", () => {
  it(`sends the pinned ${ANTHROPIC_WEB_SEARCH_TOOL} server tool, localised and capped, only when asked`, () => {
    const p = anthropicParams("claude-opus-5-5", SEARCH);
    assertEquals(p.tools, [{
      type: "web_search_20260209", name: "web_search", max_uses: 5,
      user_location: { type: "approximate", country: "KE", timezone: "Africa/Nairobi" },
    }]);
    for (const req of [CHAT, DRAFT, { ...CHAT, webSearch: null }]) assert(!("tools" in anthropicParams("claude-opus-5-5", req)));
  });

  const searched: AnthropicMessage = {
    model: "claude-opus-5-5", stop_reason: "end_turn",
    content: [
      { type: "text", text: "I'll look up the dates." },
      { type: "server_tool_use" },
      { type: "web_search_tool_result" },
      { type: "text", text: "Term 1 opens on 4 January 2027", citations: [
        { type: "web_search_result_location", url: "https://www.education.go.ke/dates", title: "2027 term dates" },
        { type: "web_search_result_location", url: "ftp://evil.example/x", title: "bad" },
      ] },
      { type: "text", text: ", and KCSE starts in November", citations: [
        { type: "web_search_result_location", url: "https://www.knec.ac.ke/kcse", title: "KCSE timetable" },
        { type: "web_search_result_location", url: "https://www.education.go.ke/dates", title: "2027 term dates" },
      ] },
      { type: "text", text: "." },
    ],
    usage: { input_tokens: 2000, output_tokens: 100, server_tool_use: { web_search_requests: 2 } },
  };

  it("reads the answer after the searches, with markers after cited blocks, and counts searches", () => {
    const r = anthropicReply(searched);
    assertEquals(r.text, "Term 1 opens on 4 January 2027[^1], and KCSE starts in November[^2][^1].");
    assertEquals(r.sources, [
      { title: "2027 term dates", url: "https://www.education.go.ke/dates" },
      { title: "KCSE timetable", url: "https://www.knec.ac.ke/kcse" },
    ]);
    assertEquals(r.searches, 2);
    assertEquals(r.outcome, "ok");
  });

  it("carries a paused turn on with the searches left, and adds up every page", () => {
    const paused: AnthropicMessage = {
      model: "claude-opus-5-5", stop_reason: "pause_turn",
      content: [{ type: "server_tool_use" }, { type: "web_search_tool_result" }],
      usage: { input_tokens: 500, output_tokens: 20, server_tool_use: { web_search_requests: 3 } },
    };
    const next = anthropicContinue("claude-opus-5-5", SEARCH, [paused], 3);
    // deno-lint-ignore no-explicit-any
    assertEquals((next.tools as any)[0].max_uses, 2);
    assertEquals((next.messages as unknown[]).slice(-1), [{ role: "assistant", content: paused.content }]);

    const r = anthropicReply(paused, searched);
    assertEquals([r.searches, r.inputTokens, r.outputTokens, r.outcome], [5, 2500, 120, "ok"]);
    assertEquals(anthropicReply(paused).outcome, "too_long", "still paused at the end: it ran out of room");
  });
});

describe("source addresses", () => {
  it("lets through http(s) only", () => {
    assertEquals(safeSourceUrl("https://kenyalaw.org/x?y=1"), "https://kenyalaw.org/x?y=1");
    assertEquals(safeSourceUrl("http://example.com"), "http://example.com/");
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "ftp://x.org", "not a url", 42, null, `https://a.com/${"x".repeat(2100)}`]) {
      assertEquals(safeSourceUrl(bad), null);
    }
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
