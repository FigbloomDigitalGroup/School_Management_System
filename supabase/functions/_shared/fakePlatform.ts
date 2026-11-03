/**
 * An in-memory Figbloom platform for tests: the Cognito token endpoint and
 * the product routes Schools calls (figbloomHR-platform PR #20), behind a
 * fetch function to hand to PlatformClient. Not deployed (the "_shared"
 * prefix keeps the CLI from treating it as a function).
 */

import { PlatformClient, type PlatformConfig } from "./platformClient.ts";

export const PLATFORM_CONFIG: PlatformConfig = {
  clientId: "schools-client",
  clientSecret: "schools-secret",
  tokenUrl: "https://auth.platform.test/oauth2/token",
  apiUrl: "https://api.platform.test",
};

export interface FakeOrganization { organization_id: string; name: string; owner_email: string | null; status: string; status_reason: string | null; decided_on_platform: boolean }
export interface FakeTenant { tenant_id: string; name: string; local_slug: string; organization_local_id: string }

export class FakePlatform {
  organizations = new Map<string, FakeOrganization>();
  tenants = new Map<string, FakeTenant>();
  webhookUrl: string | null = null;
  /** Every call to the API (not the token endpoint), in order. */
  calls: { method: string; path: string; body: unknown; token: string }[] = [];
  tokensIssued = 0;
  /** Answer every API call with this status (0: unreachable). */
  down: number | null = null;
  /** Answer the next API calls with 401, as if the token had been revoked. */
  revokeNext = 0;
  autoApprove = false;
  /** Runs as each API call arrives, before it is answered: something changing in Schools meanwhile. */
  onCall: ((method: string, path: string) => void) | null = null;
  tokenSeconds = 3600;
  private seq = 0;

  client(now?: () => number): PlatformClient {
    return new PlatformClient(PLATFORM_CONFIG, { fetch: this.fetch, now });
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (url.href === PLATFORM_CONFIG.tokenUrl) return this.token(headers, String(init?.body ?? ""));
    if (this.down === 0) throw new TypeError("connection refused");
    if (this.down) return json({ error: { code: "unavailable", message: "Down" } }, this.down);
    const token = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
    if (!token.startsWith("token-")) return json({ error: { code: "unauthorized", message: "No token" } }, 401);
    if (this.revokeNext > 0) { this.revokeNext--; return json({ error: { code: "unauthorized", message: "Revoked" } }, 401); }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path: url.pathname, body, token });
    this.onCall?.(method, url.pathname);

    let m = /^\/products\/schools\/organizations\/([^/]+)$/.exec(url.pathname);
    if (m && method === "PUT") return this.putOrganization(decodeURIComponent(m[1]), body);
    if (m && method === "GET") {
      const o = this.organizations.get(decodeURIComponent(m[1]));
      return o ? json({ organization_id: o.organization_id, status: o.status, status_reason: o.status_reason, cache_seconds: 300 })
        : json({ error: { code: "not_found", message: "No such organisation" } }, 404);
    }
    m = /^\/products\/schools\/tenants\/([^/]+)$/.exec(url.pathname);
    if (m && method === "PUT") {
      const local = decodeURIComponent(m[1]);
      if (!this.organizations.has(body.organization_local_id)) {
        return json({ error: { code: "organization_not_registered", message: "Register the organisation first" } }, 409);
      }
      const existing = this.tenants.get(local);
      const t = { tenant_id: existing?.tenant_id ?? `pt-${++this.seq}`, name: body.name, local_slug: body.slug, organization_local_id: body.organization_local_id };
      this.tenants.set(local, t);
      return json({ tenant_id: t.tenant_id, slug: t.local_slug, local_slug: t.local_slug }, existing ? 200 : 201);
    }
    if (url.pathname === "/products/schools/decision-webhook" && method === "PUT") {
      this.webhookUrl = body.url;
      return json({ url: body.url });
    }
    return json({ error: { code: "not_found", message: "No route" } }, 404);
  };

  /** Staff decide in the console: the backfill may no longer set this organisation's status. */
  decide(localId: string, status: string, reason: string | null = null) {
    const o = this.organizations.get(localId)!;
    Object.assign(o, { status, status_reason: reason, decided_on_platform: true });
  }

  private token(headers: Headers, body: string): Response {
    const params = new URLSearchParams(body);
    const expected = `Basic ${btoa(`${PLATFORM_CONFIG.clientId}:${PLATFORM_CONFIG.clientSecret}`)}`;
    if (headers.get("authorization") !== expected || params.get("grant_type") !== "client_credentials") {
      return json({ error: "invalid_client" }, 400);
    }
    if (params.get("scope") !== "platform/tenants.read platform/tenants.write") return json({ error: "invalid_scope" }, 400);
    this.tokensIssued++;
    return json({ access_token: `token-${this.tokensIssued}`, expires_in: this.tokenSeconds, token_type: "Bearer" });
  }

  // deno-lint-ignore no-explicit-any
  private putOrganization(local: string, body: any): Response {
    const existing = this.organizations.get(local);
    if ((body.status !== undefined || body.status_reason !== undefined) && !body.backfill) {
      return json({ error: { code: "validation_failed", message: "status only with backfill" } }, 400);
    }
    if (body.backfill && body.status !== undefined && existing?.decided_on_platform) {
      return json({ error: { code: "decided_on_platform", message: "Staff have decided this organisation" } }, 409);
    }
    const o: FakeOrganization = existing ?? {
      organization_id: `po-${++this.seq}`, name: body.name, owner_email: null,
      status: this.autoApprove ? "active" : "pending", status_reason: null, decided_on_platform: false,
    };
    o.name = body.name;
    o.owner_email = body.owner_email ?? o.owner_email;
    if (body.backfill && body.status) { o.status = body.status; o.status_reason = body.status_reason ?? null; }
    this.organizations.set(local, o);
    return json({ organization_id: o.organization_id, status: o.status, status_reason: o.status_reason }, existing ? 200 : 201);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
