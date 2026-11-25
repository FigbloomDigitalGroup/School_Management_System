import type { AppConfig } from "../config.js";
import { deadline, isRecord, parseJson, readBodyText } from "./http.js";
import type { PlatformTokenClient } from "./platformClient.js";

/**
 * Calling Figbloom HR's integration API with the platform token (docs/MY-HR.md). Ported from the Supabase function's
 * `_shared/hrApi.ts`. HR_MY_HR_URL is HR's base, e.g. https://hr.example/api/integrations/my-hr; every call names the school
 * (x-figbloom-school) and, for a person's own record, the person (x-figbloom-person).
 *
 *   - a 401 is retried once with a fresh token (the token was revoked or rotated early);
 *   - redirects are never followed (the platform token is only ever sent to the configured address);
 *   - every call has a timeout, which also covers reading the answer;
 *   - an answer is read up to HR_MAX_ANSWER_BYTES;
 *   - nothing HR sends is logged or put in an error: a failure carries a reason, never HR's words.
 *
 * Mapping HR's answers to the API's own is the caller's job (My HR does it in modules/hr/myHr.ts); this file does not know
 * what any route means, so the leave and hand-off slices can use it as it is.
 */

export const HR_MAX_ANSWER_BYTES = 1024 * 1024;
export const HR_DEFAULT_TIMEOUT_MS = 15_000;

/** HR_MY_HR_URL: an https address without a trailing slash (loopback http in local and test), or null when unset. */
export function hrBaseUrlFrom(config: Pick<AppConfig, "hrMyHrUrl">): string | null {
  return config.hrMyHrUrl ?? null;
}

export interface HrCall {
  method?: "GET" | "POST";
  /** x-figbloom-school: the school (tenants.id). */
  school: string;
  /** x-figbloom-person: the person (users.id); left out for school-level calls. */
  person?: string | null;
  /** Sent as JSON. */
  body?: unknown;
  /** For the call, including reading the answer. */
  timeoutMs?: number;
  /** The caller going away (the HTTP request was dropped) cancels the call. */
  signal?: AbortSignal;
}

export interface HrAnswer {
  status: number;
  /** HR's JSON as it sent it; undefined when the body was empty, not JSON or too large. */
  json: unknown;
  tooLarge: boolean;
  /** HR's Retry-After, whole seconds from 1 to 300. */
  retryAfterSeconds: number | null;
}

/** HR was not reached or did not answer in time (a redirect counts: it is never followed). */
export class HrCallError extends Error {
  constructor(readonly reason: "timeout" | "network" | "aborted") {
    super(`HR could not be reached (${reason}).`);
    this.name = "HrCallError";
  }
}

/**
 * One call to HR. Throws PlatformError when there is no platform token, HrCallError when HR is not reached; any answer
 * from HR, a refusal included, is returned.
 */
export async function callHr(
  tokens: PlatformTokenClient,
  url: string,
  call: HrCall,
  fetchFn: typeof fetch = fetch,
): Promise<HrAnswer> {
  let token = await tokens.accessToken();
  let answer = await once(fetchFn, token, url, call);
  if (answer.status === 401) {
    tokens.forgetToken(token);
    token = await tokens.accessToken();
    answer = await once(fetchFn, token, url, call);
  }
  return answer;
}

async function once(
  fetchFn: typeof fetch,
  token: string,
  url: string,
  { method = "GET", school, person, body, timeoutMs = HR_DEFAULT_TIMEOUT_MS, signal }: HrCall,
): Promise<HrAnswer> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "x-figbloom-school": school,
  };
  if (person) headers["x-figbloom-person"] = person;
  if (body !== undefined) headers["content-type"] = "application/json";
  const limit = deadline(timeoutMs, signal);
  try {
    const res = await fetchFn(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: limit.signal,
      redirect: "error",
    });
    const read = await readBodyText(res, HR_MAX_ANSWER_BYTES);
    return {
      status: res.status,
      json: read.text === null ? undefined : parseJson(read.text),
      tooLarge: read.tooLarge,
      retryAfterSeconds: retryAfter(res.headers.get("retry-after")),
    };
  } catch {
    throw new HrCallError(limit.timedOut() ? "timeout" : signal?.aborted ? "aborted" : "network");
  } finally {
    limit.cleanup();
  }
}

function retryAfter(header: string | null): number | null {
  if (!header || !/^\d{1,6}$/.test(header.trim())) return null;
  return Math.min(300, Math.max(1, Number(header.trim())));
}

/** HR's own sentence for a refusal ({error: {message}} or {message}), when it is a short plain one. */
export function hrMessage(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const m = isRecord(body.error) && body.error.message !== undefined && body.error.message !== null
    ? body.error.message
    : typeof body.message === "string" ? body.message : undefined;
  return typeof m === "string" && m.trim() && m.length <= 300 ? m.trim() : null;
}

/** HR's error code: {error: {code}}, {code}, {status: "pending_hr"} or {error: "<code>"}. */
export function hrErrorCode(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (isRecord(body.error) && typeof body.error.code === "string") return body.error.code;
  if (typeof body.code === "string") return body.code;
  if (body.status === "pending_hr") return "pending_hr";
  if (typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error)) return body.error;
  return null;
}
