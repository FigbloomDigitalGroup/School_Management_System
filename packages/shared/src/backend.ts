/**
 * Which backend the app talks to (FIG-1890). The whole app is on one or the other: Supabase (the demo, and everything
 * until each area is ported) or the new API in apps/api. The two have separate accounts, so a build never mixes them.
 *
 * The web decides at build time from VITE_BACKEND (apps/web/src/lib/client.ts); the phone will do the same from its
 * own config. Shared code asks `onApi()`; a function not yet ported keeps its Supabase body and is not reachable on an
 * API build (see capabilities.ts).
 */

export type BackendKind = "supabase" | "api";

export interface BackendConfig {
  kind: BackendKind;
  /** The API's address with no trailing slash, e.g. https://api.example.com. Required when kind is "api". */
  apiUrl?: string;
}

let current: BackendKind = "supabase";
let url = "";

/** Reads a backend name from a build setting. Anything but "api" (including nothing) is Supabase. */
export function backendKindFrom(value: string | undefined | null): BackendKind {
  return value?.trim().toLowerCase() === "api" ? "api" : "supabase";
}

/** Normalises the API's address: trimmed, no trailing slashes, and only http(s). Throws on anything else. */
export function normaliseApiUrl(value: string | undefined | null): string {
  const raw = (value ?? "").trim().replace(/\/+$/, "");
  if (!raw) throw new Error("The API address is not set (VITE_API_URL).");
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error(`The API address is not a valid URL: ${raw}`); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`The API address must be http or https: ${raw}`);
  if (parsed.search || parsed.hash) throw new Error("The API address must not carry a query or fragment.");
  return raw;
}

export function initBackend(cfg: BackendConfig): void {
  if (cfg.kind === "api") {
    url = normaliseApiUrl(cfg.apiUrl);
    current = "api";
  } else {
    url = "";
    current = "supabase";
  }
}

export function backendKind(): BackendKind {
  return current;
}

/** True on an API build. */
export function onApi(): boolean {
  return current === "api";
}

/** The API's address. Throws off an API build, so a stray call fails loudly instead of hitting the wrong place. */
export function apiBaseUrl(): string {
  if (current !== "api") throw new Error("initBackend({ kind: \"api\" }) must run before the API is used.");
  return url;
}
