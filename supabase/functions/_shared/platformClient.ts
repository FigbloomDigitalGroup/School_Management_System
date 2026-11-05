/**
 * The Figbloom platform's API, as Figbloom Schools calls it (design 5.8;
 * figbloomHR-platform README, "Organisations and product registration").
 *
 * Schools signs in as its own machine client, schools-service-<env>, with
 * the client-credentials grant at the platform's Cognito token endpoint, and
 * may only read and write Schools' records (/products/schools/...).
 *
 * Function secrets:
 *   PLATFORM_CLIENT_ID, PLATFORM_CLIENT_SECRET  the schools-service client
 *   PLATFORM_TOKEN_URL  the TokenEndpoint output (…/oauth2/token)
 *   PLATFORM_API_URL    the PlatformApiUrl output
 *
 * The token is kept (per warm isolate) until a minute before it expires,
 * and dropped and fetched again once if the API answers 401.
 */

export const PLATFORM_MODULE = "schools";
const SCOPE = "platform/tenants.read platform/tenants.write";
const TIMEOUT_MS = 10_000;
/** Fetch a new token this long before the old one runs out. */
const EXPIRY_MARGIN_MS = 60_000;

export type PlatformOrganizationStatus = "pending" | "active" | "rejected" | "suspended";

export interface PlatformConfig {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  apiUrl: string;
}

export interface OrganizationBody {
  name: string;
  owner_email?: string | null;
  created_at?: string;
  /** Only with backfill: true (copying today's state once). */
  status?: PlatformOrganizationStatus;
  status_reason?: string | null;
  backfill?: boolean;
}

export interface OrganizationAnswer {
  organization_id: string;
  status: PlatformOrganizationStatus;
  status_reason: string | null;
  cache_seconds?: number;
}

export interface TenantBody {
  name: string;
  slug: string;
  organization_local_id: string;
  created_at?: string;
}

/** POST /events (contract section 1): a product's event for the platform to relay to its subscribers. */
export interface PlatformEvent {
  /** Starts with "schools.". */
  type: string;
  /** Unique per sender: a repeat is accepted and not delivered again. */
  id: string;
  occurred_at: string;
  /** Schools' own id for the customer: the school's tenants.id. */
  tenant_local_id: string;
  data: Record<string, unknown>;
}

export interface EventAnswer {
  deliveries?: number;
}

/** POST /handoffs (SCHOOLS_HR_HANDOFF_CONTRACT.md section 1): a one-time sign-in link into another product. */
export interface HandoffBody {
  /** The product to sign in to, e.g. "hr". */
  target: string;
  /** Schools' own id for the customer: the school's tenants.id. */
  tenant_local_id: string;
  person: {
    /** Schools' id for the person: profiles.id. */
    external_id: string;
    name: string;
    /** A real contact email, or null (never a synthetic sign-in address). */
    email: string | null;
    role: string;
  };
  return_to?: string;
}

export interface HandoffAnswer {
  url: string;
  expires_at: string;
}

export interface TenantAnswer {
  tenant_id?: string;
  id?: string;
  slug?: string;
  local_slug?: string;
}

/** A refusal or failure from the platform: `status` 0 means it was never reached (network, timeout). */
export class PlatformError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "PlatformError";
  }
  /** Worth trying again later: unreachable, throttled, or the platform's own trouble. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export function platformConfigFromEnv(env: { get(name: string): string | undefined } = Deno.env): PlatformConfig | null {
  const clientId = env.get("PLATFORM_CLIENT_ID")?.trim();
  const clientSecret = env.get("PLATFORM_CLIENT_SECRET")?.trim();
  const tokenUrl = env.get("PLATFORM_TOKEN_URL")?.trim();
  const apiUrl = env.get("PLATFORM_API_URL")?.trim();
  if (!clientId || !clientSecret || !tokenUrl || !apiUrl) return null;
  return { clientId, clientSecret, tokenUrl, apiUrl: apiUrl.replace(/\/+$/, "") };
}

export interface PlatformClientDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

export class PlatformClient {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly config: PlatformConfig, deps: PlatformClientDeps = {}) {
    this.fetchFn = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  // ---------------------------------------------------------------- the calls
  putOrganization(localId: string, body: OrganizationBody): Promise<OrganizationAnswer> {
    return this.call("PUT", `/products/${PLATFORM_MODULE}/organizations/${encodeURIComponent(localId)}`, body);
  }

  putTenant(localId: string, body: TenantBody): Promise<TenantAnswer> {
    return this.call("PUT", `/products/${PLATFORM_MODULE}/tenants/${encodeURIComponent(localId)}`, body);
  }

  getOrganization(localId: string): Promise<OrganizationAnswer> {
    return this.call("GET", `/products/${PLATFORM_MODULE}/organizations/${encodeURIComponent(localId)}`);
  }

  putDecisionWebhook(url: string | null): Promise<unknown> {
    return this.call("PUT", `/products/${PLATFORM_MODULE}/decision-webhook`, { url });
  }

  postEvent(event: PlatformEvent): Promise<EventAnswer> {
    return this.call("POST", "/events", event);
  }

  /** 409 target_not_enabled / target_not_linked / target_no_handoff_url when the target can't take the person; 404 for a school the platform doesn't know. */
  createHandoff(body: HandoffBody): Promise<HandoffAnswer> {
    return this.call("POST", "/handoffs", body);
  }

  putEventWebhook(url: string | null): Promise<unknown> {
    return this.call("PUT", `/products/${PLATFORM_MODULE}/event-webhook`, { url });
  }

  // ---------------------------------------------------------------- token
  /** A client-credentials token, kept until shortly before it expires. */
  async accessToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt - EXPIRY_MARGIN_MS) return this.token.value;
    const basic = btoa(`${this.config.clientId}:${this.config.clientSecret}`);
    const res = await this.send(this.config.tokenUrl, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: SCOPE }).toString(),
    });
    // deno-lint-ignore no-explicit-any
    let data: any = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok || typeof data?.access_token !== "string") {
      // never the secret, and never Cognito's body verbatim beyond its error code
      throw new PlatformError(`Could not get a platform token (${res.status}${data?.error ? ` ${data.error}` : ""}).`, res.status || 0, "token_failed");
    }
    const seconds = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600;
    this.token = { value: data.access_token, expiresAt: this.now() + seconds * 1000 };
    return this.token.value;
  }

  // ---------------------------------------------------------------- plumbing
  private async call<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const token = await this.accessToken();
    const res = await this.send(`${this.config.apiUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && !retried) {
      // the token was revoked or rotated early: once more with a fresh one
      await res.body?.cancel();
      this.token = null;
      return this.call<T>(method, path, body, true);
    }
    // deno-lint-ignore no-explicit-any
    let data: any = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch { /* not JSON */ } }
    if (!res.ok) {
      const code = typeof data?.error?.code === "string" ? data.error.code : `http_${res.status}`;
      const message = typeof data?.error?.message === "string" ? data.error.message : `The platform answered ${res.status}.`;
      throw new PlatformError(message, res.status, code);
    }
    return data as T;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal, redirect: "error" });
    } catch (err) {
      const why = controller.signal.aborted ? "timed out" : err instanceof Error ? err.message : String(err);
      throw new PlatformError(`The platform could not be reached (${why}).`, 0, "unreachable");
    } finally {
      clearTimeout(timer);
    }
  }
}
