import { validationError } from "../../http/errors.js";

export type SupportedImageMime = "image/jpeg" | "image/png" | "image/webp";

export const SUPPORTED_OCR_MIMES: readonly SupportedImageMime[] = ["image/jpeg", "image/png", "image/webp"];
export const MAX_OCR_IMAGE_BYTES = 6 * 1024 * 1024; // 6 MB decoded

export interface HandwritingOcrRequest {
  imageBase64: string;
  mimeType: SupportedImageMime;
  reportType?: string;
  contextHint?: string;
}

export type HandwritingOcrResult =
  | {
      status: "ok";
      transcribed_text: string;
      suggested_title: string | null;
      confidence: number | null;
      provider: string;
    }
  | { status: "not_configured"; reason: "ocr_provider_not_configured" }
  | { status: "unavailable"; reason: string };

export interface HandwritingOcrProvider {
  readonly configured: boolean;
  readonly name: string;
  interpret(req: HandwritingOcrRequest): Promise<HandwritingOcrResult>;
}

/**
 * Validates and strips any `data:image/...;base64,` prefix from a captured image payload.
 */
export function normalizeImageBase64(raw: string, mimeType: string): { base64: string; mimeType: SupportedImageMime; byteLength: number } {
  if (!(SUPPORTED_OCR_MIMES as readonly string[]).includes(mimeType)) {
    throw validationError("mime_type must be image/jpeg, image/png, or image/webp");
  }
  const stripped = raw.trim().replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "").replace(/\s+/g, "");
  if (!stripped || !/^[A-Za-z0-9+/=]+$/.test(stripped)) {
    throw validationError("image_base64 must be a valid base64-encoded image");
  }
  const byteLength = Math.floor((stripped.length * 3) / 4) - (stripped.endsWith("==") ? 2 : stripped.endsWith("=") ? 1 : 0);
  if (byteLength < 64) throw validationError("Image is too small to interpret");
  if (byteLength > MAX_OCR_IMAGE_BYTES) throw validationError("Image exceeds the 6 MB maximum size");
  return { base64: stripped, mimeType: mimeType as SupportedImageMime, byteLength };
}

function buildOcrPrompt(req: HandwritingOcrRequest): string {
  const hint = [
    req.reportType ? `Report type: ${req.reportType}.` : "",
    req.contextHint ? `Context: ${req.contextHint}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    "You are assisting a school teacher who photographed a handwritten teacher report. " +
    "Accurately transcribe all handwritten text into clean, well-structured paragraphs or bullet points, " +
    "fixing obvious line-break splits while preserving the teacher's exact meaning, names, dates, and numbers. " +
    "If any word is illegible, mark it as [illegible]. " +
    (hint ? `${hint} ` : "") +
    'Respond strictly as JSON with keys: {"suggested_title": string, "transcribed_text": string, "confidence": number between 0 and 1}.'
  );
}

function parseOcrJsonReply(rawText: string, provider: string): HandwritingOcrResult {
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as { transcribed_text?: unknown; suggested_title?: unknown; confidence?: unknown };
    if (typeof parsed.transcribed_text === "string" && parsed.transcribed_text.trim().length > 0) {
      const conf =
        typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
          ? Math.max(0, Math.min(1, Number(parsed.confidence.toFixed(3))))
          : null;
      return {
        status: "ok",
        transcribed_text: parsed.transcribed_text.trim(),
        suggested_title: typeof parsed.suggested_title === "string" && parsed.suggested_title.trim() ? parsed.suggested_title.trim().slice(0, 200) : null,
        confidence: conf,
        provider,
      };
    }
  } catch {
    // Fall back to plain text if the model returned clean transcription without JSON wrapping.
  }
  if (cleaned.length > 0) {
    return { status: "ok", transcribed_text: cleaned, suggested_title: null, confidence: null, provider };
  }
  return { status: "unavailable", reason: "empty_ocr_response" };
}

class GeminiVisionOcrProvider implements HandwritingOcrProvider {
  readonly configured = true;
  readonly name = "gemini_vision";

  constructor(
    private readonly apiKey: string,
    private readonly model = "gemini-2.5-flash",
  ) {}

  async interpret(req: HandwritingOcrRequest): Promise<HandwritingOcrResult> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: buildOcrPrompt(req) },
                { inline_data: { mime_type: req.mimeType, data: req.imageBase64 } },
              ],
            },
          ],
          generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
        }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) return { status: "unavailable", reason: `gemini_http_${res.status}` };
      const body = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      return parseOcrJsonReply(text, this.name);
    } catch {
      return { status: "unavailable", reason: "gemini_network_error" };
    }
  }
}

class OpenAiVisionOcrProvider implements HandwritingOcrProvider {
  readonly configured = true;
  readonly name = "openai_vision";

  constructor(
    private readonly apiKey: string,
    private readonly model = "gpt-4o-mini",
  ) {}

  async interpret(req: HandwritingOcrRequest): Promise<HandwritingOcrResult> {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.1,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: buildOcrPrompt(req) },
                { type: "image_url", image_url: { url: `data:${req.mimeType};base64,${req.imageBase64}` } },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) return { status: "unavailable", reason: `openai_http_${res.status}` };
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = body.choices?.[0]?.message?.content ?? "";
      return parseOcrJsonReply(text, this.name);
    } catch {
      return { status: "unavailable", reason: "openai_network_error" };
    }
  }
}

class NotConfiguredOcrProvider implements HandwritingOcrProvider {
  readonly configured = false;
  readonly name = "not_configured";

  async interpret(): Promise<HandwritingOcrResult> {
    return { status: "not_configured", reason: "ocr_provider_not_configured" };
  }
}

let testOverrideOcrProvider: HandwritingOcrProvider | null = null;
export function setHandwritingOcrProviderForTesting(p: HandwritingOcrProvider | null): void {
  testOverrideOcrProvider = p;
}

export function getHandwritingOcrProvider(env: NodeJS.ProcessEnv = process.env): HandwritingOcrProvider {
  if (testOverrideOcrProvider) return testOverrideOcrProvider;
  const geminiKey = env.GEMINI_API_KEY?.trim();
  if (geminiKey) return new GeminiVisionOcrProvider(geminiKey, env.GEMINI_OCR_MODEL?.trim() || "gemini-2.5-flash");
  const openaiKey = env.OPENAI_API_KEY?.trim();
  if (openaiKey) return new OpenAiVisionOcrProvider(openaiKey, env.OPENAI_OCR_MODEL?.trim() || "gpt-4o-mini");
  return new NotConfiguredOcrProvider();
}
