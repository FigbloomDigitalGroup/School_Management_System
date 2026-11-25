import type { AppConfig } from "../config.js";
import { deadline, isRecord, parseJson, readBodyText } from "./http.js";

/**
 * The Figbloom platform, as the API signs in to it (docs/MY-HR.md). Ported from the Supabase function's
 * `_shared/platformClient.ts`, token part only: the API signs in as the schools service client with the
 * client-credentials grant at the platform's token endpoint, and the token it gets is what Figbloom HR accepts from Schools.
 *
 * Settings (all optional; with any of the first three missing there is no client and nothing calls out):
 *   PLATFORM_CLIENT_ID, PLATFORM_CLIENT_SECRET  the schools service client
 *   PLATFORM_TOKEN_URL                          the token endpoint (…/oauth2/token)
 *   PLATFORM_API_URL                            the platform's own API, for `call()` (registration, hand-off); My HR does not use it
 *
 * The token is kept until a minute before it expires. Concurrent callers share one fetch. Redirects are never followed,
 * every call has a timeout, and the secret and the platform's answers never reach a log or an error message.
 * This file knows nothing about My HR. `call(method, path, body)` is the generic call to the platform's own API
 * (PLATFORM_API_URL) with the same token, the same 401 retry and the same rules, for the hand-off and school registration
 * slices to build typed calls on; the API does not make any such call yet.
 */

export const PLATFORM_TOKEN_SCOPE = "platform/tenants.read platform/tenants.write";

/** Fetch a new token this long before the old one runs out. */
const EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_LIFETIME_SECONDS = 3_600;
const MAX_LIFETIME_SECONDS = 86_400;
const MAX_ANSWER_BYTES = 64 * 1024;

export interface PlatformTokenConfig {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  /** PLATFORM_API_URL, without a trailing slash; only `call()` needs it. */
  apiUrl?: string;
  /** For the one call, including reading the answer. */
  timeoutMs: number;
}

/** The token client's settings, or null unless the client id, the secret and the token address are all set. */
export function platformTokenConfigFrom(
  config: Pick<AppConfig, "platformClientId" | "platformClientSecret" | "platformTokenUrl" | "platformApiUrl" | "myHrHttpTimeoutMs">,
): PlatformTokenConfig | null {
  const { platformClientId: clientId, platformClientSecret: clientSecret, platformTokenUrl: tokenUrl } = config;
  if (!clientId || !clientSecret || !tokenUrl) return null;
  return { clientId, clientSecret, tokenUrl, apiUrl: config.platformApiUrl, timeoutMs: config.myHrHttpTimeoutMs };
}

/**
 * A refusal or failure from the platform: `status` 0 means it was never reached (network, timeout). `code` is
 * `token_failed` (no token could be had), `unreachable`, `not_configured` (no PLATFORM_API_URL), or the platform's own error
 * code (`http_<status>` when it gave none).
 */
export class PlatformError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "PlatformError";
  }
  /** Worth trying again later: unreachable, throttled, or the platform's own trouble. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface PlatformTokenClientDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

export class PlatformTokenClient {
  private token: { value: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly config: PlatformTokenConfig,
    deps: PlatformTokenClientDeps = {},
  ) {
    this.fetchFn = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  /** A client-credentials token, kept until shortly before it expires. Throws PlatformError when there is none to be had. */
  async accessToken(): Promise<string> {
    const cached = this.token;
    if (cached && this.now() < cached.expiresAt - EXPIRY_MARGIN_MS) return cached.value;
    // One fetch at a time: a burst of requests after the token expired must not become a burst at the token endpoint.
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * One call to the platform's own API with the platform token: `path` starts with `/` and is appended to PLATFORM_API_URL;
   * `body` is sent as JSON. A 401 is retried once with a fresh token. Returns the platform's JSON (undefined for an empty
   * answer). Throws PlatformError: `status` and `code` say what went wrong (the platform's own `error.code`, else
   * `http_<status>`), `status` 0 when it was not reached, `not_configured` without PLATFORM_API_URL.
   */
  async call<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const { apiUrl, timeoutMs } = this.config;
    if (!apiUrl) throw new PlatformError("The platform's API address is not set.", 0, "not_configured");
    let token = await this.accessToken();
    let answer = await this.send(method, `${apiUrl}${path}`, token, body, timeoutMs, signal);
    if (answer.status === 401) {
      this.forgetToken(token);
      token = await this.accessToken();
      answer = await this.send(method, `${apiUrl}${path}`, token, body, timeoutMs, signal);
    }
    if (answer.status < 200 || answer.status >= 300) {
      const error = isRecord(answer.json) && isRecord(answer.json.error) ? answer.json.error : null;
      const code = error && typeof error.code === "string" && /^[a-z_]{1,64}$/.test(error.code) ? error.code : `http_${answer.status}`;
      const message = error && typeof error.message === "string" && error.message.length <= 300 ? error.message : `The platform answered ${answer.status}.`;
      throw new PlatformError(message, answer.status, code);
    }
    return answer.json as T;
  }

  private async send(
    method: string,
    url: string,
    token: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ status: number; json: unknown }> {
    const limit = deadline(timeoutMs, signal);
    try {
      const res = await this.fetchFn(url, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: limit.signal,
        redirect: "error",
      });
      const read = await readBodyText(res, MAX_ANSWER_BYTES);
      return { status: res.status, json: read.text === null ? undefined : parseJson(read.text) };
    } catch {
      throw new PlatformError(limit.timedOut() ? "The platform timed out." : "The platform could not be reached.", 0, "unreachable");
    } finally {
      limit.cleanup();
    }
  }

  /**
   * Drops the kept token, so the next accessToken() fetches a new one (an API answered 401 to it). Pass the token that
   * was refused: if another caller already replaced it, the new one is kept.
   */
  forgetToken(refused?: string): void {
    if (refused === undefined || this.token?.value === refused) this.token = null;
  }

  private async fetchToken(): Promise<string> {
    const { clientId, clientSecret, tokenUrl, timeoutMs } = this.config;
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const limit = deadline(timeoutMs);
    try {
      let res: Response;
      let text: string | null;
      try {
        res = await this.fetchFn(tokenUrl, {
          method: "POST",
          headers: {
            authorization: `Basic ${basic}`,
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: new URLSearchParams({ grant_type: "client_credentials", scope: PLATFORM_TOKEN_SCOPE }).toString(),
          signal: limit.signal,
          redirect: "error",
        });
        text = (await readBodyText(res, MAX_ANSWER_BYTES)).text;
      } catch {
        throw new PlatformError(
          limit.timedOut() ? "The platform timed out." : "The platform could not be reached.",
          0,
          "unreachable",
        );
      }
      const data = text === null ? undefined : parseJson(text);
      const accessToken = isRecord(data) && typeof data.access_token === "string" && data.access_token ? data.access_token : null;
      if (!res.ok || accessToken === null) {
        // never the secret, and never the platform's body beyond its short error code
        const oauthError = isRecord(data) && typeof data.error === "string" && /^[a-z_]{1,40}$/.test(data.error) ? ` ${data.error}` : "";
        throw new PlatformError(`Could not get a platform token (${res.status}${oauthError}).`, res.status, "token_failed");
      }
      const seconds = isRecord(data) ? Number(data.expires_in) : Number.NaN;
      const lifetime = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_LIFETIME_SECONDS) : DEFAULT_LIFETIME_SECONDS;
      this.token = { value: accessToken, expiresAt: this.now() + lifetime * 1000 };
      return accessToken;
    } finally {
      limit.cleanup();
    }
  }
}
