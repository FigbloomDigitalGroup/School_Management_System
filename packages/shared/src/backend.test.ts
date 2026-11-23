import { afterEach, describe, expect, it } from "vitest";
import { apiBaseUrl, backendKind, backendKindFrom, initBackend, normaliseApiUrl, onApi } from "./backend";

afterEach(() => initBackend({ kind: "supabase" }));

describe("backendKindFrom", () => {
  it("is the API only when the setting says api", () => {
    expect(backendKindFrom("api")).toBe("api");
    expect(backendKindFrom(" API ")).toBe("api");
    expect(backendKindFrom("supabase")).toBe("supabase");
    expect(backendKindFrom("")).toBe("supabase");
    expect(backendKindFrom(undefined)).toBe("supabase");
    expect(backendKindFrom("apis")).toBe("supabase");
  });
});

describe("normaliseApiUrl", () => {
  it("trims and drops trailing slashes", () => {
    expect(normaliseApiUrl(" https://api.example.com/// ")).toBe("https://api.example.com");
    expect(normaliseApiUrl("http://localhost:4199")).toBe("http://localhost:4199");
  });
  it("keeps a path prefix", () => {
    expect(normaliseApiUrl("https://example.com/api/")).toBe("https://example.com/api");
  });
  it("refuses nothing, junk, other schemes, and a query or fragment", () => {
    expect(() => normaliseApiUrl("")).toThrow(/not set/);
    expect(() => normaliseApiUrl(undefined)).toThrow(/not set/);
    expect(() => normaliseApiUrl("not a url")).toThrow(/valid URL/);
    expect(() => normaliseApiUrl("ftp://x.test")).toThrow(/http or https/);
    expect(() => normaliseApiUrl("https://x.test?a=1")).toThrow(/query/);
    expect(() => normaliseApiUrl("https://x.test#f")).toThrow(/query/);
  });
});

describe("initBackend", () => {
  it("starts on Supabase and has no API address", () => {
    expect(backendKind()).toBe("supabase");
    expect(onApi()).toBe(false);
    expect(() => apiBaseUrl()).toThrow(/initBackend/);
  });
  it("switches to the API with its address", () => {
    initBackend({ kind: "api", apiUrl: "https://api.example.com/" });
    expect(onApi()).toBe(true);
    expect(apiBaseUrl()).toBe("https://api.example.com");
  });
  it("refuses the API without an address, and stays as it was", () => {
    expect(() => initBackend({ kind: "api" })).toThrow(/not set/);
    expect(onApi()).toBe(false);
  });
  it("goes back to Supabase", () => {
    initBackend({ kind: "api", apiUrl: "https://api.example.com" });
    initBackend({ kind: "supabase" });
    expect(onApi()).toBe(false);
    expect(() => apiBaseUrl()).toThrow();
  });
});
