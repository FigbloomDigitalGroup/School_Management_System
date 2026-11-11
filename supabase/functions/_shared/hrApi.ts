/**
 * Calling Figbloom HR's integration API (/api/integrations/my-hr/*) with Schools' platform token: my-hr (a person's
 * own record, leave and approvals) and platform-sync (the one-off leave history import). HR_MY_HR_URL is HR's base,
 * e.g. https://hr.example/api/integrations/my-hr. Redirects are never followed; every call has a timeout.
 */

import type { PlatformClient } from "./platformClient.ts";

const DEFAULT_TIMEOUT_MS = 15_000;

/** HR_MY_HR_URL: an https address without a trailing slash, or null. */
export function hrUrlFromEnv(env: { get(name: string): string | undefined } = Deno.env): string | null {
  const raw = env.get("HR_MY_HR_URL")?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return raw.replace(/\/+$/, "");
}

export interface HrCall {
  method?: "GET" | "POST";
  /** x-figbloom-school: the school (tenants.id). */
  school: string;
  /** x-figbloom-person: the person (profiles.id); left out for school-level calls (the history import). */
  person?: string | null;
  /** Sent as JSON. */
  body?: unknown;
  timeoutMs?: number;
}

/** One call to HR. A 401 is retried once with a fresh token (the token was revoked or rotated early). */
export async function callHr(fetchFn: typeof fetch, client: PlatformClient, url: string, call: HrCall): Promise<Response> {
  let res = await once(fetchFn, client, url, call);
  if (res.status === 401) {
    await res.body?.cancel();
    client.forgetToken();
    res = await once(fetchFn, client, url, call);
  }
  return res;
}

async function once(fetchFn: typeof fetch, client: PlatformClient, url: string, { method = "GET", school, person, body, timeoutMs = DEFAULT_TIMEOUT_MS }: HrCall): Promise<Response> {
  const token = await client.accessToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "x-figbloom-school": school,
  };
  if (person) headers["x-figbloom-person"] = person;
  if (body !== undefined) headers["content-type"] = "application/json";
  try {
    return await fetchFn(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });
  } finally {
    clearTimeout(timer);
  }
}

/** The body as JSON, or undefined (empty, or not JSON). */
export async function readJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

/** HR's own sentence for a refusal ({error: {message}} or {message}), when it is a short plain one. */
export function hrMessage(body: unknown): string | null {
  // deno-lint-ignore no-explicit-any
  const b = body as any;
  const m = b?.error?.message ?? (typeof b?.message === "string" ? b.message : undefined);
  return typeof m === "string" && m.trim() && m.length <= 300 ? m.trim() : null;
}

/** HR's error code: {error: {code}}, {code} or {error: "<code>"}. */
export function errorCode(body: unknown): string | null {
  // deno-lint-ignore no-explicit-any
  const b = body as any;
  if (typeof b?.error?.code === "string") return b.error.code;
  if (typeof b?.code === "string") return b.code;
  if (typeof b?.status === "string" && b.status === "pending_hr") return "pending_hr";
  if (typeof b?.error === "string" && /^[a-z_]{1,40}$/.test(b.error)) return b.error;
  return null;
}
