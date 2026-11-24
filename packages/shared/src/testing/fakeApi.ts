import { createApiClient, type ApiClient, type ApiClientConfig } from "../api/client";
import { createMemoryTokenStore, type StoredSession, type TokenStore } from "../api/tokenStore";

/**
 * A stand-in for apps/api in tests: a `fetch` that answers by "METHOD /path" and records what it was sent. Nothing here
 * knows the real API's rules; a test says what the server answers and checks what the client asked.
 */

export interface FakeReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Never answers (until the request is aborted): for timeouts. */
  hang?: boolean;
  /** Throws as fetch does when the network is down. */
  networkError?: boolean;
}

export interface FakeCall {
  method: string;
  /** Path and query, as sent (no host). */
  url: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

export type FakeRoute = FakeReply | ((call: FakeCall) => FakeReply | Promise<FakeReply>);

export interface FakeApi {
  fetch: typeof fetch;
  calls: FakeCall[];
  /** Calls to one route, in order. */
  callsTo(route: string): FakeCall[];
  /** Replaces the answer of a route. */
  on(route: string, reply: FakeRoute): void;
}

export const BASE = "https://api.test";

export function createFakeApi(routes: Record<string, FakeRoute> = {}): FakeApi {
  const table = new Map<string, FakeRoute>(Object.entries(routes));
  const calls: FakeCall[] = [];

  const fake = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const raw = init?.body;
    const call: FakeCall = {
      method, url: u.pathname + u.search, path: u.pathname, query: u.searchParams, headers,
      body: typeof raw === "string" ? JSON.parse(raw) : undefined,
    };
    calls.push(call);

    const route = table.get(`${method} ${u.pathname}`);
    if (!route) return new Response(JSON.stringify({ error: { code: "not_found", message: `fake: no route ${method} ${u.pathname}` } }), { status: 404, headers: { "content-type": "application/json" } });
    const reply = typeof route === "function" ? await route(call) : route;

    if (reply.networkError) throw new TypeError("fetch failed");
    if (reply.hang) {
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    const status = reply.status ?? 200;
    const text = reply.body === undefined ? "" : JSON.stringify(reply.body);
    return new Response(status === 204 ? null : text, { status, headers: { "content-type": "application/json", ...(reply.headers ?? {}) } });
  }) as typeof fetch;

  return {
    fetch: fake,
    calls,
    callsTo: (route) => calls.filter((c) => `${c.method} ${c.path}` === route),
    on: (route, reply) => { table.set(route, reply); },
  };
}

/** A client wired to a fake API and a memory token store, signed in unless `session` is null. */
export function createTestClient(
  routes: Record<string, FakeRoute> = {},
  opts: { session?: StoredSession | null; config?: Partial<ApiClientConfig> } = {},
): { client: ApiClient; api: FakeApi; store: TokenStore } {
  const api = createFakeApi(routes);
  const store = createMemoryTokenStore(opts.session === undefined ? { token: "tok-1", expiresAt: "2099-01-01T00:00:00.000Z", userId: "u-1" } : opts.session);
  const client = createApiClient({ baseUrl: BASE, store, fetch: api.fetch, newRequestId: () => "req-test-0001", ...opts.config });
  return { client, api, store };
}
