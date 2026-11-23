import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getHandwritingOcrProvider,
  normalizeImageBase64,
  setHandwritingOcrProviderForTesting,
} from "../src/modules/reporting/handwritingOcr.js";

const SAMPLE_BASE64 = Buffer.alloc(128, 0x42).toString("base64");

describe("Teacher Reports Handwriting OCR", () => {
  afterEach(() => {
    setHandwritingOcrProviderForTesting(null);
    vi.restoreAllMocks();
  });

  it("validates mime types and strips data-URL prefixes", () => {
    const res = normalizeImageBase64(`data:image/jpeg;base64,${SAMPLE_BASE64}`, "image/jpeg");
    expect(res.base64).toBe(SAMPLE_BASE64);
    expect(res.mimeType).toBe("image/jpeg");
    expect(res.byteLength).toBe(128);

    expect(() => normalizeImageBase64(SAMPLE_BASE64, "application/pdf")).toThrow("mime_type");
    expect(() => normalizeImageBase64("not!!valid", "image/png")).toThrow("valid base64");
  });

  it("returns not_configured when no OCR API key is set", async () => {
    const provider = getHandwritingOcrProvider({});
    expect(provider.configured).toBe(false);
    const out = await provider.interpret({ imageBase64: SAMPLE_BASE64, mimeType: "image/jpeg" });
    expect(out).toEqual({ status: "not_configured", reason: "ocr_provider_not_configured" });
  });

  it("interprets handwriting via Gemini Vision and parses structured JSON reply", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      suggested_title: "Grade 5 Daily Attendance & Reading Log",
                      transcribed_text: "All 32 learners present. Completed Chapter 4 reading exercises.",
                      confidence: 0.94,
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const provider = getHandwritingOcrProvider({ GEMINI_API_KEY: "test-key" });
    expect(provider.configured).toBe(true);
    const out = await provider.interpret({
      imageBase64: SAMPLE_BASE64,
      mimeType: "image/jpeg",
      reportType: "daily",
    });

    expect(out).toEqual({
      status: "ok",
      suggested_title: "Grade 5 Daily Attendance & Reading Log",
      transcribed_text: "All 32 learners present. Completed Chapter 4 reading exercises.",
      confidence: 0.94,
      provider: "gemini_vision",
    });
  });

  it("interprets handwriting via OpenAI Vision fallback when OPENAI_API_KEY is set", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  suggested_title: "Science Lab Incident Note",
                  transcribed_text: "Minor beaker spill cleaned immediately. No injuries.",
                  confidence: 0.89,
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const provider = getHandwritingOcrProvider({ OPENAI_API_KEY: "sk-test" });
    expect(provider.configured).toBe(true);
    const out = await provider.interpret({
      imageBase64: SAMPLE_BASE64,
      mimeType: "image/png",
      reportType: "incident",
    });

    expect(out).toEqual({
      status: "ok",
      suggested_title: "Science Lab Incident Note",
      transcribed_text: "Minor beaker spill cleaned immediately. No injuries.",
      confidence: 0.89,
      provider: "openai_vision",
    });
  });
});
