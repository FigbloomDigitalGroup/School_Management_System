import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pointFunctionsAt } from "./functionsService";

// The real supabase-js, not a fake: the switch relies on how it builds its functions client, and an upgrade that changes
// that must fail here rather than quietly keep calling the old address.
afterEach(() => { vi.unstubAllGlobals(); });

describe("pointing supabase-js's functions at Lambda", () => {
  it("sends every invoke to the new address, with the same headers", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input instanceof Request ? input.url : input), headers: new Headers(init?.headers) });
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = createClient("https://schools-db.example", "anon-key", { global: { fetch: fetchStub as unknown as typeof fetch }, auth: { persistSession: false } });

    await client.functions.invoke("send-push", { body: { a: 1 } });
    expect(seen[0]!.url).toBe("https://schools-db.example/functions/v1/send-push");

    pointFunctionsAt(client, "https://lambda.example/functions/v1/");
    const { data } = await client.functions.invoke("send-push", { body: { a: 1 } });
    expect(data).toEqual({ ok: true });
    expect(seen[1]!.url).toBe("https://lambda.example/functions/v1/send-push");
    expect(seen[1]!.headers.get("apikey")).toBe("anon-key");
    expect(seen[1]!.headers.get("authorization")).toBe("Bearer anon-key");
  });

  it("says so if supabase-js stops keeping the address where this expects", () => {
    expect(() => pointFunctionsAt({} as never, "https://lambda.example")).toThrow("functionsService.ts needs updating");
  });
});
