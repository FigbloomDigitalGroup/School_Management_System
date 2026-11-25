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
 *   PLATFORM_API_URL                            the platform's own API: not used here, reserved for registration and hand-off
 *
 * The token is kept until a minute before it expires. Concurrent callers share one fetch. Redirects are never followed,
 * every call has a timeout, and the secret and the platform's answers never reach a log or an error message.
 * This file knows nothing about My HR: another module may build on `PlatformTokenClient` (and add the platform's own
 * API calls beside it) without touching My HR.
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
  /** For the one call, including reading the answer. */
  timeoutMs: number;
}

/** The token client's settings, or null unless the client id, the secret and the token address are all set. */
export function platformTokenConfigFrom(
  config: Pick<AppConfig, "platformClientId" | "platformClientSecret" | "platformTokenUrl" | "myHrHttpTimeoutMs">,
): PlatformTokenConfig | null {
  const { platformClientId: clientId, platformClientSecret: clientSecret, platformTokenUrl: tokenUrl } = config;
  if (!clientId || !clientSecret || !tokenUrl) return null;
  return { clientId, clientSecret, tokenUrl, timeoutMs: config.myHrHttpTimeoutMs };
}

/** The platform could not give a token: `status` 0 means it was never reached (network, timeout). */
export class PlatformError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: "token_failed" | "unreachable",
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
