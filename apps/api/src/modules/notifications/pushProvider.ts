import { createSign } from "node:crypto";

export interface PushMessage {
  token: string;
  platform: "android" | "ios";
  title: string;
  body: string;
  data?: Record<string, string>;
}

export type PushSendResult =
  | { status: "delivered"; messageId: string; provider: string }
  | { status: "invalid_token"; errorCode: string; provider: string }
  | { status: "retryable_error"; errorCode: string; provider: string }
  | { status: "permanent_error"; errorCode: string; provider: string }
  | { status: "not_configured"; provider: string };

/**
 * Provider-neutral push notification interface.
 * Live FCM calls are never made unless explicitly configured by environment credentials.
 */
export interface PushProvider {
  readonly configured: boolean;
  readonly name: string;
  send(message: PushMessage): Promise<PushSendResult>;
}

/** Provider-neutral interface for deferred channels (SMS / email pending D-4 owner decision). */
export interface DeferredChannelProvider {
  readonly channel: "sms" | "email";
  readonly configured: false;
  readonly name: "not_configured";
  send(): Promise<{ status: "not_configured"; provider: "not_configured" }>;
}

export class NotConfiguredPushProvider implements PushProvider {
  readonly configured = false;
  readonly name = "not_configured";

  async send(): Promise<PushSendResult> {
    return { status: "not_configured", provider: this.name };
  }
}

export interface FcmProviderConfig {
  projectId: string;
  /** Optional static OAuth2 access token (e.g. for local mock/test fixtures). */
  accessToken?: string;
  /** Service account client_email + private_key (PEM) for Google OAuth2 JWT exchange. */
  clientEmail?: string;
  privateKeyPem?: string;
  /** Override base URL for local mock HTTP servers; defaults to https://fcm.googleapis.com. */
  endpointBaseUrl?: string;
  /** Override token exchange URL for local mock HTTP servers; defaults to https://oauth2.googleapis.com/token. */
  tokenUrl?: string;
  timeoutMs?: number;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signServiceAccountJwt(clientEmail: string, privateKeyPem: string, tokenUrl: string, nowSec: number): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(
    JSON.stringify({
      iss: clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: tokenUrl,
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const signingInput = `${header}.${claim}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const sig = signer.sign(privateKeyPem).toString("base64url");
  return `${signingInput}.${sig}`;
}

/**
 * Genuine Firebase Cloud Messaging (FCM) HTTP v1 adapter.
 * Supports OAuth2 service-account JWT exchange (RS256) or an explicit bearer token,
 * enforces timeouts, classifies FCM error codes safely without leaking device tokens or secrets.
 */
export class FcmPushProvider implements PushProvider {
  readonly configured = true;
  readonly name = "fcm_v1";

  private readonly baseUrl: string;
  private readonly tokenUrl: string;
  private readonly timeoutMs: number;
  private cachedToken: { token: string; expiresAtMs: number } | null = null;

  constructor(private readonly cfg: FcmProviderConfig) {
    this.baseUrl = (cfg.endpointBaseUrl ?? "https://fcm.googleapis.com").replace(/\/+$/, "");
    this.tokenUrl = cfg.tokenUrl ?? "https://oauth2.googleapis.com/token";
    this.timeoutMs = cfg.timeoutMs ?? 8_000;
  }

  private async resolveBearerToken(): Promise<string | null> {
    if (this.cfg.accessToken) return this.cfg.accessToken;
    if (this.cachedToken && this.cachedToken.expiresAtMs > Date.now() + 60_000) {
      return this.cachedToken.token;
    }
    if (!this.cfg.clientEmail || !this.cfg.privateKeyPem) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    const assertion = signServiceAccountJwt(this.cfg.clientEmail, this.cfg.privateKeyPem, this.tokenUrl, nowSec);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!body.access_token) return null;
      this.cachedToken = {
        token: body.access_token,
        expiresAtMs: Date.now() + Math.max(60, Number(body.expires_in ?? 3600)) * 1000,
      };
      return this.cachedToken.token;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async send(message: PushMessage): Promise<PushSendResult> {
    const bearer = await this.resolveBearerToken();
    if (!bearer) {
      return { status: "retryable_error", errorCode: "fcm_auth_unavailable", provider: this.name };
    }
    const url = `${this.baseUrl}/v1/projects/${encodeURIComponent(this.cfg.projectId)}/messages:send`;
    const payload = {
      message: {
        token: message.token,
        notification: {
          title: message.title,
          body: message.body,
        },
        ...(message.data ? { data: message.data } : {}),
        ...(message.platform === "android"
          ? { android: { priority: "HIGH" } }
          : { apns: { headers: { "apns-priority": "10" } } }),
      },
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (res.ok) {
        const json = (await res.json().catch(() => ({}))) as { name?: string };
        return {
          status: "delivered",
          messageId: typeof json.name === "string" && json.name.length > 0 ? json.name : "fcm_accepted",
          provider: this.name,
        };
      }
      const errJson = (await res.json().catch(() => ({}))) as {
        error?: { status?: string; details?: Array<{ errorCode?: string }> };
      };
      const fcmCode =
        errJson.error?.details?.find((d) => typeof d.errorCode === "string")?.errorCode ??
        errJson.error?.status ??
        `http_${res.status}`;
      if (res.status === 404 || fcmCode === "UNREGISTERED" || fcmCode === "NOT_FOUND") {
        return { status: "invalid_token", errorCode: "fcm_unregistered", provider: this.name };
      }
      if (res.status === 400 && fcmCode === "INVALID_ARGUMENT") {
        return { status: "invalid_token", errorCode: "fcm_invalid_token", provider: this.name };
      }
      if (res.status === 429 || res.status >= 500) {
        return { status: "retryable_error", errorCode: `fcm_${res.status}`, provider: this.name };
      }
      return { status: "permanent_error", errorCode: `fcm_${res.status}`, provider: this.name };
    } catch {
      return { status: "retryable_error", errorCode: "fcm_network_error", provider: this.name };
    } finally {
      clearTimeout(timer);
    }
  }
}

export class MockPushProvider implements PushProvider {
  readonly configured = true;
  readonly name = "mock_push";
  readonly sent: PushMessage[] = [];
  private readonly outcomes = new Map<string, PushSendResult[]>();
  private defaultOutcome: PushSendResult = { status: "delivered", messageId: "mock-msg-1", provider: "mock_push" };

  setOutcomeForToken(token: string, outcomes: PushSendResult | PushSendResult[]): void {
    this.outcomes.set(token, Array.isArray(outcomes) ? [...outcomes] : [outcomes]);
  }

  setDefaultOutcome(outcome: PushSendResult): void {
    this.defaultOutcome = outcome;
  }

  async send(message: PushMessage): Promise<PushSendResult> {
    this.sent.push(message);
    const queue = this.outcomes.get(message.token);
    if (queue && queue.length > 0) {
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    }
    if (this.defaultOutcome.status === "delivered") {
      return {
        status: "delivered",
        messageId: `mock-msg-${this.sent.length}`,
        provider: this.name,
      };
    }
    return this.defaultOutcome;
  }
}

export function pushProviderFromEnv(env: NodeJS.ProcessEnv = process.env): PushProvider {
  const projectId = env.FCM_PROJECT_ID?.trim();
  const accessToken = env.FCM_ACCESS_TOKEN?.trim();
  const clientEmail = env.FCM_CLIENT_EMAIL?.trim();
  const privateKeyPem = env.FCM_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (projectId && (accessToken || (clientEmail && privateKeyPem))) {
    return new FcmPushProvider({
      projectId,
      accessToken,
      clientEmail,
      privateKeyPem,
      endpointBaseUrl: env.FCM_ENDPOINT_BASE_URL?.trim() || undefined,
      tokenUrl: env.FCM_TOKEN_URL?.trim() || undefined,
    });
  }
  return new NotConfiguredPushProvider();
}

let testOverridePushProvider: PushProvider | null = null;

export function getPushProvider(): PushProvider {
  return testOverridePushProvider ?? pushProviderFromEnv();
}

export function setPushProviderForTesting(provider: PushProvider | null): void {
  testOverridePushProvider = provider;
}
