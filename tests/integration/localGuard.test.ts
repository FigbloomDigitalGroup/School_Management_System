import { afterEach, describe, expect, it, vi } from "vitest";

// signInAs() must refuse before it builds a client, so the real createClient is replaced to prove it is never reached.
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));

import { createClient } from "@supabase/supabase-js";
import { assertLocalSupabaseUrl } from "./support/localGuard";
import { signInAs } from "./support/signInAs";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("assertLocalSupabaseUrl", () => {
  it.each([
    "http://127.0.0.1:58321",
    "http://127.0.0.1:54321",
    "http://localhost:54321",
    "http://[::1]:58321",
  ])("accepts %s", (url) => {
    expect(() => assertLocalSupabaseUrl(url)).not.toThrow();
  });

  it.each([
    ["a hosted Supabase project", "https://abcdefghijklmnop.supabase.co"],
    ["any other host", "https://example.com"],
    ["a look-alike of 127.0.0.1", "http://127.0.0.1.example.com"],
    ["a look-alike of localhost", "http://localhost.example.com"],
    ["a URL whose user part says 127.0.0.1", "http://127.0.0.1@example.com"],
    ["a LAN address", "http://192.168.1.20:54321"],
    ["a wildcard address", "http://0.0.0.0:54321"],
  ])("refuses %s", (_name, url) => {
    expect(() => assertLocalSupabaseUrl(url)).toThrow(/Refusing/);
  });

  it("refuses a missing or malformed URL", () => {
    expect(() => assertLocalSupabaseUrl(undefined)).toThrow(/not set/);
    expect(() => assertLocalSupabaseUrl("")).toThrow(/not set/);
    expect(() => assertLocalSupabaseUrl("not a url")).toThrow(/not a valid URL/);
  });
});

describe("signInAs", () => {
  it("refuses a non-local SUPABASE_URL before creating any client", async () => {
    vi.stubEnv("SUPABASE_URL", "https://abcdefghijklmnop.supabase.co");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anything");
    await expect(signInAs("teacher")).rejects.toThrow(/Refusing/);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("guards VITE_SUPABASE_URL too, when SUPABASE_URL is not set", async () => {
    vi.stubEnv("SUPABASE_URL", undefined);
    vi.stubEnv("VITE_SUPABASE_URL", "https://abcdefghijklmnop.supabase.co");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anything");
    await expect(signInAs("teacher")).rejects.toThrow(/Refusing/);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("treats an empty SUPABASE_URL as not set, never as permission to use another URL", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_URL", "http://127.0.0.1:58321");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anything");
    await expect(signInAs("teacher")).rejects.toThrow(/not set/);
    expect(createClient).not.toHaveBeenCalled();
  });
});
