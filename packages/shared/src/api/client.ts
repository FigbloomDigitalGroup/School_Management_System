import { apiBaseUrl } from "../backend";
import { ApiError, apiErrorFromResponse } from "./errors";
import type { paths } from "./schema";
import { createMemoryTokenStore, type StoredSession, type TokenStore } from "./tokenStore";

/**
 * The one way the apps call apps/api (FIG-1890). Every request carries the bearer token, the school (X-Tenant-Id, per
 * request: two tabs on two schools must not overwrite each other, so select-tenant is never used), a request id, and a
 * 30 s limit (the server cuts requests at 30 s too). Paths and bodies are typed from the OpenAPI file through
 * `schema.d.ts` (npm run api:types), so a path that is not in the API does not compile.
 */

// ---------------------------------------------------------------- the types that come from the schema

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

type PathsFor<M extends HttpMethod> = { [P in keyof paths]: paths[P] extends { [K in M]: object } ? P : never }[keyof paths];
type OperationOf<P extends keyof paths, M extends HttpMethod> = paths[P] extends { [K in M]: infer O } ? O : never;

type PathParamsOf<O> = O extends { parameters: { path: infer P } } ? P : undefined;
type QueryOf<O> = O extends { parameters: { query?: infer Q } } ? Exclude<Q, undefined | never> : undefined;
type JsonBodyOf<O> =
  O extends { requestBody?: never } ? undefined
  : O extends { requestBody: { content: { "application/json": infer B } } } ? B
  : O extends { requestBody?: { content: { "application/json": infer B } } } ? B
  : undefined;
type SuccessOf<O> =
  O extends { responses: { 200: { content: { "application/json": infer R } } } } ? R
  : O extends { responses: { 201: { content: { "application/json": infer R } } } } ? R
  : O extends { responses: { 202: { content: { "application/json": infer R } } } } ? R
  : unknown;

/** What a call to path `P` with method `M` returns. */
export type ApiResponse<M extends HttpMethod, P extends PathsFor<M>> = SuccessOf<OperationOf<P, M>>;
/** The JSON body a call to path `P` with method `M` takes. */
export type ApiBody<M extends HttpMethod, P extends PathsFor<M>> = JsonBodyOf<OperationOf<P, M>>;

type Maybe<K extends string, T> = [T] extends [undefined] ? { [Q in K]?: undefined } : { [Q in K]: T };
type Querying<O> = [QueryOf<O>] extends [undefined] ? { query?: undefined } : { query?: QueryOf<O> };

/** What a call needs besides the path: its path parameters and body when it has them, optionally a query. */
export type CallOptions<M extends HttpMethod, P extends PathsFor<M>> =
  Maybe<"path", PathParamsOf<OperationOf<P, M>>> & Querying<OperationOf<P, M>> & Maybe<"body", JsonBodyOf<OperationOf<P, M>>> & CommonOptions;

export interface CommonOptions {
  /** The school for this call. Undefined: the client's active school. Null: none (identity calls). */
  tenantId?: string | null;
  signal?: AbortSignal;
  /** Replaces the 30 s default. */
  timeoutMs?: number;
  /** For the few POSTs the API deduplicates; the same key on a retry makes it one effect. */
  idempotencyKey?: string;
  /** False for calls made before there is a session (sign-in): no token is sent and a 401 does not end anything. */
  auth?: boolean;
  /**
   * True where a 401 means "that password or code was wrong" and not "your session is gone" (reauth, password change,
   * MFA codes): the error is thrown and the session is kept.
   */
  keepSessionOn401?: boolean;
}

// ---------------------------------------------------------------- the handlers the app registers

export interface AuthHandlers {
  /** The session is gone: the server answered 401 to a signed-in call, or the token's own expiry passed. The app returns to sign-in. */
  onSignedOut?: (reason: "unauthorized" | "expired") => void;
  /** The call needs the password confirmed (reauth_required). Ask, call POST /v1/auth/reauth, and resolve true to retry the call once. */
  onReauthRequired?: () => Promise<boolean>;
  /** The call needs two-step verification (mfa_required): enrol or answer the challenge, then resolve true to retry once. */
  onMfaRequired?: (err: ApiError) => Promise<boolean>;
}

// ---------------------------------------------------------------- the client

/** The one shape of fetch the client needs (an address string, never a Request), so it type-checks in the phone's lib too. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientConfig {
  baseUrl: string;
  store: TokenStore;
  /** Defaults to the global fetch. */
  fetch?: FetchLike;
  /** Defaults to Date.now. */
  now?: () => number;
  /** Defaults to 30 000. */
  timeoutMs?: number;
  /** Defaults to a random UUID. The API honours an inbound id only if it is 8-64 of [A-Za-z0-9._-]. */
  newRequestId?: () => string;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface ApiClient {
  get<P extends PathsFor<"get">>(path: P, opts: CallOptions<"get", P>): Promise<ApiResponse<"get", P>>;
  post<P extends PathsFor<"post">>(path: P, opts: CallOptions<"post", P>): Promise<ApiResponse<"post", P>>;
  put<P extends PathsFor<"put">>(path: P, opts: CallOptions<"put", P>): Promise<ApiResponse<"put", P>>;
  patch<P extends PathsFor<"patch">>(path: P, opts: CallOptions<"patch", P>): Promise<ApiResponse<"patch", P>>;
  delete<P extends PathsFor<"delete">>(path: P, opts: CallOptions<"delete", P>): Promise<ApiResponse<"delete", P>>;
  /** The school sent with every call that does not say otherwise (one per tab). */
  setActiveTenant(tenantId: string | null): void;
  activeTenant(): string | null;
  setAuthHandlers(handlers: AuthHandlers): void;
  /** The stored session, or null. One whose own expiry has passed is cleared and counts as none. */
  session(): StoredSession | null;
  readonly store: TokenStore;
}

function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Puts each `{name}` of a path template in place, encoded. A missing value throws: a hole in a URL is a bug, not a request. */
export function fillPath(template: string, params: Record<string, unknown> | undefined): string {
  return template.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const v = params?.[name];
    if (v === undefined || v === null || v === "") throw new Error(`Missing path parameter "${name}" for ${template}`);
    return encodeURIComponent(String(v));
  });
}

/** `?a=1&b=2` from a query object; undefined and null values are left out, arrays repeat the name. Empty when there is nothing. */
export function queryString(query: Record<string, unknown> | undefined): string {
  if (!query) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    for (const item of Array.isArray(v) ? v : [v]) {
      if (item === undefined || item === null) continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(item))}`);
    }
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/** What the typed calls reduce to once the types have done their work. */
interface SendOptions extends CommonOptions {
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
}

export function createApiClient(config: ApiClientConfig): ApiClient {
  const store = config.store;
  const now = config.now ?? (() => Date.now());
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const doFetch: FetchLike = config.fetch ?? ((url, init) => fetch(url, init));
  const defaultTimeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const newRequestId = config.newRequestId ?? randomId;

  let tenant: string | null = null;
  let handlers: AuthHandlers = {};
  // One prompt at a time: several calls refused for the same reason must not each open a password box.
  let reauthInFlight: Promise<boolean> | null = null;
  let mfaInFlight: Promise<boolean> | null = null;

  function session(): StoredSession | null {
    const s = store.get();
    if (!s) return null;
    if (Date.parse(s.expiresAt) <= now()) {
      store.clear();
      handlers.onSignedOut?.("expired");
      return null;
    }
    return s;
  }

  function sharedPrompt(kind: "reauth" | "mfa", run: () => Promise<boolean>): Promise<boolean> {
    const current = kind === "reauth" ? reauthInFlight : mfaInFlight;
    if (current) return current;
    const p = run().catch(() => false).finally(() => { if (kind === "reauth") reauthInFlight = null; else mfaInFlight = null; });
    if (kind === "reauth") reauthInFlight = p; else mfaInFlight = p;
    return p;
  }

  async function send(method: HttpMethod, template: string, opts: SendOptions, retried: boolean): Promise<unknown> {
    const authed = opts.auth !== false;
    const current = authed ? session() : null;
    if (authed && !current) throw new ApiError({ status: 401, code: "unauthorized", message: "You are not signed in." });

    const url = baseUrl + fillPath(template, opts.path) + queryString(opts.query);
    const headers: Record<string, string> = { Accept: "application/json", "X-Request-Id": newRequestId() };
    if (current) headers.Authorization = `Bearer ${current.token}`;
    const tenantId = opts.tenantId === undefined ? tenant : opts.tenantId;
    if (authed && tenantId) headers["X-Tenant-Id"] = tenantId;
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    let body: string | undefined;
    if (opts.body !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(opts.body); }

    // Our own limit, and the caller's signal: either one cancels the call.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, opts.timeoutMs ?? defaultTimeout);
    const onCallerAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", onCallerAbort, { once: true });
    }

    let res: Response;
    try {
      res = await doFetch(url, { method: method.toUpperCase(), headers, body, signal: controller.signal });
    } catch (err) {
      if (timedOut) throw new ApiError({ status: 0, code: "timeout", message: "The server took too long to answer." });
      if (opts.signal?.aborted || (err instanceof Error && err.name === "AbortError")) throw new ApiError({ status: 0, code: "aborted", message: "The request was cancelled." });
      throw new ApiError({ status: 0, code: "network_error", message: "Can't reach the server." });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onCallerAbort);
    }

    let parsed: unknown;
    const text = await res.text().catch(() => "");
    if (text) { try { parsed = JSON.parse(text); } catch { parsed = undefined; } }

    if (res.ok) return parsed;

    const err = apiErrorFromResponse(res.status, parsed, res.headers);

    if (res.status === 401 && authed && !opts.keepSessionOn401) {
      // Only end the session this call was made with: another tab may have signed in again since.
      if (store.get()?.token === current?.token) store.clear();
      handlers.onSignedOut?.("unauthorized");
      throw err;
    }
    if (!retried && err.code === "reauth_required" && handlers.onReauthRequired) {
      const ok = await sharedPrompt("reauth", () => handlers.onReauthRequired!());
      if (ok) return send(method, template, opts, true);
    }
    if (!retried && err.code === "mfa_required" && handlers.onMfaRequired) {
      const ok = await sharedPrompt("mfa", () => handlers.onMfaRequired!(err));
      if (ok) return send(method, template, opts, true);
    }
    throw err;
  }

  const call = (method: HttpMethod) => (path: string, opts: object) => send(method, path, opts as SendOptions, false);

  return {
    get: call("get") as ApiClient["get"],
    post: call("post") as ApiClient["post"],
    put: call("put") as ApiClient["put"],
    patch: call("patch") as ApiClient["patch"],
    delete: call("delete") as ApiClient["delete"],
    setActiveTenant(id) { tenant = id; },
    activeTenant: () => tenant,
    setAuthHandlers(h) { handlers = h; },
    session,
    store,
  };
}

// ---------------------------------------------------------------- the app's client

let shared: ApiClient | null = null;
let pendingStore: TokenStore | null = null;
let pendingHandlers: AuthHandlers = {};
let pendingTenant: string | null = null;

/** Chooses where the token is kept. Call once at start-up on an API build, before the first call. */
export function setApiTokenStore(store: TokenStore): void {
  pendingStore = store;
  shared = null;
}

/** Registers what the app does when a call needs a new sign-in, the password again, or two-step verification. */
export function setApiAuthHandlers(handlers: AuthHandlers): void {
  pendingHandlers = handlers;
  shared?.setAuthHandlers(handlers);
}

/** The school every call of this tab is for, unless a call says otherwise. Set when the school at the address is known. */
export function setApiActiveTenant(tenantId: string | null): void {
  pendingTenant = tenantId;
  shared?.setActiveTenant(tenantId);
}

/** The app's one client, made on first use from the backend's address and the chosen token store. */
export function apiClient(): ApiClient {
  if (!shared) {
    shared = createApiClient({ baseUrl: apiBaseUrl(), store: (pendingStore ??= createMemoryTokenStore()) });
    shared.setAuthHandlers(pendingHandlers);
    shared.setActiveTenant(pendingTenant);
  }
  return shared;
}

/** Forgets the shared client (tests; and a change of token store). */
export function resetApiClient(): void {
  shared = null;
  pendingStore = null;
  pendingHandlers = {};
  pendingTenant = null;
}
